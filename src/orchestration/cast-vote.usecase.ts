import { secureRandomBytes } from '@/lib/crypto'
import { logger } from '@/lib/logger'
import { castAnonymousVote, isKnownParty, VoteRecordingError } from '@/modules/anonymous-vote'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import { markAsVotedAndConsumeSession } from '@/modules/eligibility/voter-status.service'
import type { VotingSession } from '@/modules/eligibility/voting-session.service'

/**
 * ORKESTRERINGSLAGRET
 *
 * Detta är den enda filen i systemet där en identifierad väljare och ett
 * partival finns i samma anropsstack. Två andra filer importerar från båda
 * modulerna — adminstatistiken och demosidans databasvy — men de rör bara
 * aggregat respektive avkortade värden och ser aldrig en enskild väljares val.
 *
 * Ett arkitekturtest (tests/security/module-boundaries.test.ts) läser
 * källkoden och misslyckas om någon fil utanför den listan börjar importera
 * från båda sidorna, eller om modulerna börjar importera varandra.
 *
 * Filen är kort med flit. Ju mindre kod som ser båda sidorna samtidigt, desto
 * mindre yta finns det för en koppling att uppstå på.
 */

/**
 * Slumpmässig fördröjning mellan de två skrivningarna.
 *
 * Utan den skulle skrivningen till röstlängden och skrivningen till
 * röstdatabasen ske med några millisekunders mellanrum, konsekvent och
 * mätbart. Den som kan observera båda databasernas transaktionsloggar eller
 * WAL-strömmar skulle då kunna para ihop dem.
 *
 * Detta är en dämpning, inte en lösning. Vid låg röstfrekvens räcker en
 * slumpfördröjning på några hundra millisekunder inte alls. Ett riktigt system
 * skulle behöva köa rösterna och skriva dem i blandade satser med garanterad
 * anonymitetsmängd. Se SECURITY.md.
 */
const MAX_JITTER_MS = 400

async function jitter(): Promise<void> {
  const [byte] = secureRandomBytes(1)
  const delayMs = Math.floor(((byte ?? 0) / 255) * MAX_JITTER_MS)
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}

export type CastVoteOutcome =
  | { status: 'success'; token: string }
  | { status: 'already_voted' }
  | { status: 'invalid_party' }
  | { status: 'recording_failed' }

/**
 * Genomför en röstning.
 *
 * ORDNINGEN ÄR ETT MEDVETET VAL MED EN KÄND SVAGHET.
 *
 * De två skrivningarna sker mot två olika databaser och kan därför inte ingå i
 * samma transaktion. Något måste ske först, och det finns ingen ordning utan
 * nackdel:
 *
 *   Rösta först, markera sedan → krasch emellan ger DUBBELRÖSTNING.
 *   Markera först, rösta sedan → krasch emellan ger en FÖRLORAD RÖST.
 *
 * Vi väljer "markera först". En förlorad röst är ett allvarligt fel, men ett
 * som drabbar en enskild väljare och som går att upptäcka. Dubbelröstning
 * angriper valets integritet och är svårare att upptäcka i efterhand.
 *
 * Den riktiga lösningen finns och används i forskningslitteraturen: blinda
 * signaturer. Väljaren får ett blint signerat röstintyg medan hen fortfarande
 * är legitimerad, och löser in det senare i den anonyma delen. Röstintyget kan
 * inte kopplas till legitimeringen, och inlösen är idempotent — vilket gör att
 * ordningen mellan de två stegen slutar spela roll. Det ligger utanför den här
 * POC:ens omfattning och är dokumenterat i SECURITY.md.
 */
export async function castVote(
  session: VotingSession,
  partyId: string,
): Promise<CastVoteOutcome> {
  // Steg 0: avvisa ogiltigt parti INNAN väljaren markeras som röstande.
  // Annars skulle en felformad begäran kunna bränna någons rösträtt utan att
  // en röst registrerades. Kontrollen ställer bara frågan "finns det här
  // partiet?" och skickar ingenting om väljaren vidare.
  if (!(await isKnownParty(partyId))) {
    return { status: 'invalid_party' }
  }

  // Steg 1: markera som röstad och konsumera sessionen, atomiskt.
  // Villkorat på hasVoted = false, vilket gör steget till dubbelröstningsspärr
  // även vid parallella begäranden.
  const marked = await markAsVotedAndConsumeSession(session.voterStatusId, session.id)

  if (!marked) {
    await recordAuditEvent(AUDIT_EVENTS.DOUBLE_VOTE_BLOCKED)
    return { status: 'already_voted' }
  }

  await jitter()

  // Steg 2: registrera den anonyma rösten.
  //
  // Härifrån och framåt finns ingen väg tillbaka till väljaren. `session` är
  // borta ur databasen och skickas medvetet inte vidare — anropet nedan får
  // bara ett parti-id, vilket är allt som behövs och allt som typen tillåter.
  try {
    const { token } = await castAnonymousVote({ partyId })

    await recordAuditEvent(AUDIT_EVENTS.VOTE_RECORDED)

    return { status: 'success', token }
  } catch (error) {
    await recordAuditEvent(AUDIT_EVENTS.VOTE_RECORDING_FAILED)

    // Loggen innehåller ingen identitet, inget parti och ingen token — bara
    // att ett fel av den här typen inträffat.
    logger.error('Röstregistrering misslyckades efter att väljaren markerats som röstande')

    if (error instanceof VoteRecordingError && error.message === 'Okänt parti.') {
      return { status: 'invalid_party' }
    }

    return { status: 'recording_failed' }
  }
}
