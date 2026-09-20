import { secureRandomBytes } from '@/lib/crypto'
import { logger } from '@/lib/logger'
import { castAnonymousVote, validateBallotChoice } from '@/modules/anonymous-vote'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import { ballotsForVoter } from '@/modules/eligibility/election.service'
import {
  hasCompletedElection,
  markBallotAsVoted,
} from '@/modules/eligibility/voter-status.service'
import {
  destroyVotingSession,
  type VotingSession,
} from '@/modules/eligibility/voting-session.service'

/**
 * ORKESTRERINGSLAGRET
 *
 * Detta är den enda filen i systemet där en identifierad väljare och ett
 * partival finns i samma anropsstack. Tre andra filer importerar från båda
 * modulerna — omröstningsskapandet, adminstatistiken och demosidans
 * databasvy — men de rör metadata, aggregat respektive avkortade värden och
 * ser aldrig en enskild väljares val.
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

export type BallotChoice = {
  ballotId: string
  ballotPartyId?: string
  candidateId?: string
  optionId?: string
}

export type CastVoteOutcome =
  | { status: 'success'; token: string; electionComplete: boolean }
  | { status: 'already_voted' }
  | { status: 'invalid_choice'; reason: string }
  | { status: 'ballot_not_for_voter' }
  | { status: 'recording_failed' }

/**
 * Lägger en röst på EN valsedel.
 *
 * I ett riksdagsval anropas funktionen tre gånger under samma session — en
 * gång per valsedel — och varje anrop ger en egen token. De tre rösterna har
 * ingenting gemensamt som lagras. Det är avsiktligt: en gemensam identifierare
 * skulle binda ihop kommun-, landstings- och riksdagsvalet till en profil, och
 * tre partival tillsammans är betydligt mer identifierande än ett.
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
  choice: BallotChoice,
): Promise<CastVoteOutcome> {
  // Steg 0: avvisa ett ogiltigt val INNAN väljaren markeras som röstande.
  // Annars skulle en felformad begäran kunna bränna någons rösträtt på en
  // valsedel utan att en röst registrerades. Kontrollen ställer bara frågor om
  // valsedeln och skickar ingenting om väljaren vidare.
  const validation = await validateBallotChoice(choice, session.electionId)
  if (!validation.valid) {
    return { status: 'invalid_choice', reason: validation.reason }
  }

  // Steg 1: gäller valsedeln över huvud taget den här väljaren?
  //
  // En kommunvalsedel gäller bara den som är folkbokförd i kommunen. Utan den
  // här kontrollen skulle vem som helst kunna rösta i vilken kommun som helst
  // genom att skicka ett annat valsedels-id än det som visades.
  const applicable = await ballotsForVoter(session.voterStatusId, session.electionId)
  const ballot = applicable.find((entry) => entry.id === choice.ballotId)

  if (!ballot) return { status: 'ballot_not_for_voter' }
  if (ballot.hasVoted) {
    await recordAuditEvent(AUDIT_EVENTS.DOUBLE_VOTE_BLOCKED)
    return { status: 'already_voted' }
  }

  // Steg 2: markera valsedeln som röstad.
  //
  // Spärren ligger i databasens unika index, inte i kontrollen ovan: två
  // samtidiga begäranden kan båda passera steg 1, men bara en kan skapa raden.
  const marked = await markBallotAsVoted(session.voterStatusId, choice.ballotId)

  if (!marked) {
    await recordAuditEvent(AUDIT_EVENTS.DOUBLE_VOTE_BLOCKED)
    return { status: 'already_voted' }
  }

  await jitter()

  // Steg 3: registrera den anonyma rösten.
  //
  // Härifrån och framåt finns ingen väg tillbaka till väljaren. Anropet nedan
  // får bara valsedels- och alternativ-id, vilket är allt som behövs och allt
  // som typen tillåter.
  try {
    const { token } = await castAnonymousVote({
      ballotId: choice.ballotId,
      ballotPartyId: choice.ballotPartyId,
      candidateId: choice.candidateId,
      optionId: choice.optionId,
    })

    await recordAuditEvent(AUDIT_EVENTS.VOTE_RECORDED)

    // Sessionen lever bara så länge det finns valsedlar kvar. När sista
    // valsedeln är lagd raderas den omedelbart — varje extra sekund är en
    // extra sekund då identitet och pågående röstning finns samtidigt.
    const electionComplete = await hasCompletedElection(
      session.voterStatusId,
      session.electionId,
    )

    if (electionComplete) {
      await destroyVotingSession(session.id)
    }

    return { status: 'success', token, electionComplete }
  } catch {
    await recordAuditEvent(AUDIT_EVENTS.VOTE_RECORDING_FAILED)

    // Loggen innehåller ingen identitet, inget parti och ingen token — bara
    // att ett fel av den här typen inträffat. Felobjektet loggas medvetet
    // inte: ett Prisma-fel kan bära med sig radvärden, och här är raden en
    // röst.
    logger.error('Röstregistrering misslyckades efter att väljaren markerats som röstande')

    return { status: 'recording_failed' }
  }
}
