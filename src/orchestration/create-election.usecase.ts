import { logger } from '@/lib/logger'
import {
  createElection as createElectionInVotesDb,
  deleteElection,
  type CreatedElection,
} from '@/modules/ballot-box'
import { votesDb } from '@/modules/ballot-box/db'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import { mirrorElection, removeMirroredElection } from '@/modules/eligibility/election.service'
// Ur serverns ingång och inte ur de delade modulerna: den privata nyckeln och
// andelarna exponentieras då i OpenSSL, i konstant tid. Se src/lib/crypto/server.ts.
import { generateKeyPair, publicShare, splitSecret } from '@/lib/crypto/server'
import { TRUSTEE_COUNT, TRUSTEE_THRESHOLD } from '@/lib/crypto/threshold'
import { encryptShare } from '@/lib/crypto/share-storage'
import { isKnownDemoPassphrase } from '@/lib/demo-election'
import { runtimeMode } from '@/lib/mode-flag'

/**
 * Skapar en omröstning i båda databaserna.
 *
 * Filen ser båda sidorna, och står därför på undantagslistan i
 * tests/security/module-boundaries.test.ts. Motiveringen är att den bara rör
 * OFFENTLIG METADATA: omröstningens namn, dess valsedlar, när den öppnar och
 * stänger. Inget om en enskild väljare och inget om en enskild röst passerar
 * här — det finns inga sådana rader att skapa vid den här tidpunkten.
 *
 * VARFÖR SPEGLING I STÄLLET FÖR EN DELAD TABELL
 *
 * Båda sidorna behöver känna till omröstningen: röstlängden för att kunna
 * hålla "har röstat på valsedel X", röstdatabasen för att kunna knyta rösten
 * till rätt valsedel. En delad tabell skulle kräva att den ena databasen kan
 * läsa den andra, vilket är precis den koppling hela systemet är byggt för att
 * omöjliggöra. Speglingen — samma UUID i två databaser, utan foreign key
 * emellan — låter varje sida ha sina egna foreign keys internt.
 */

export type CreateElectionOutcome =
  | { status: 'created'; election: CreatedElection }
  | { status: 'failed'; message: string }

/**
 * ORDNINGEN OCH ÅTERSTÄLLNINGEN
 *
 * Röstdatabasen skrivs först, eftersom den tilldelar id:na. Misslyckas
 * speglingen därefter står vi med en omröstning som går att rösta i men som
 * röstlängden inte känner till — väljarna skulle avvisas med "ingen valsedel
 * gäller dig", och rösterna skulle aldrig kunna markeras.
 *
 * Det GÅR att backa här, och vi gör det: ingen har hunnit rösta i en omröstning
 * som just misslyckades med att skapas, så borttagningen kan inte radera någons
 * röst.
 */

/**
 * Omröstningen som administratören beskrivit den.
 *
 * Skiljer sig från modulens CreateElectionInput genom att sakna
 * signeringsnycklarna — de skapas här, inte av den som fyller i formuläret.
 */
export type CreateElectionRequest = {
  name: string
  kind: 'RIKSDAGSVAL' | 'ALLMAN_OMROSTNING'
  opensAt: Date
  closesAt: Date
  ballots: Array<{
    kind: 'KOMMUN' | 'LANDSTING' | 'RIKSDAG' | 'FRAGA'
    label: string
    areaCode?: string | null
    allowsCandidateVote?: boolean
    parties?: Array<{ partyId: string; candidates?: string[] }>
    options?: string[]
  }>

  /**
   * En lösenfras per förtroendeman, satt av personen själv och aldrig lagrad.
   *
   * Tre andelar, två krävs för att öppna resultatet — se
   * src/lib/crypto/threshold.ts. Fraserna lämnar den här funktionen bara som
   * krypteringsnycklar för respektive andel; klartexten sparas ingenstans.
   */
  trusteePassphrases: [string, string, string]
}

export async function createElection(
  input: CreateElectionRequest,
): Promise<CreateElectionOutcome> {
  /**
   * LÄGET OMRÖSTNINGEN SKAPAS I, OCH KÄNDA FRASER VÄGRAS I SKARPT LÄGE (uppgift 17).
   *
   * Läget läses här, ur serverns eget läge, och skrivs i båda databaserna.
   * Det kommer aldrig från den som fyller i formuläret. En omröstning bär sitt
   * läge, så att en demoomröstning aldrig kan fastställas i skarpt läge och
   * demoröster aldrig hamnar i en skarp.
   *
   * Demofraserna står i repot och är kända för alla som läser det. I skarpt läge
   * skulle de göra förtroendemännens andelar öppningsbara för vem som helst som
   * når röstdatabasen, så ett skapande med en av dem vägras, före allt skrivs.
   * Kontrollen hänger inte på en miljövariabel som driften måste komma ihåg att
   * sätta: den gäller fraserna själva. Den hindrar inte en svag fras som inte
   * står i repot, och är ingen bedömning av frasers styrka.
   */
  const mode = runtimeMode()
  if (mode === 'SHARP' && input.trusteePassphrases.some(isKnownDemoPassphrase)) {
    logger.warn('Skapandet av en omröstning vägrades: en av fraserna är en känd demofras')
    return {
      status: 'failed',
      message:
        'Omröstningen skapades inte. En av förtroendepersonernas fraser är en av demofraserna, ' +
        'som är kända för alla som läser koden. Välj egna fraser.',
    }
  }

  let created: CreatedElection

  try {
    created = await createElectionInVotesDb({
      ...input,
      mode,
    })
  } catch (error) {
    logger.error('Kunde inte skapa omröstningen i röstdatabasen', { error: String(error) })
    await recordAuditEvent(AUDIT_EVENTS.ELECTION_CREATION_FAILED)
    return { status: 'failed', message: 'Omröstningen kunde inte skapas.' }
  }

  try {
    /**
     * TRE ANDELAR, TVÅ KRÄVS.
     *
     * Nyckeln som öppnar resultatet får inte ligga hos en ensam administratör —
     * varken för att kunna läsa i förtid eller för att kunna vägra släppa
     * siffrorna.
     *
     * Den ursprungliga privata nyckeln raderas här och lämnar aldrig funktionen.
     * Att den existerar alls under ett ögonblick är den betrodda utdelarens
     * svaghet, och den står som känd begränsning — se kommentaren i
     * src/lib/crypto/threshold.ts.
     */
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, TRUSTEE_COUNT, TRUSTEE_THRESHOLD)

    await votesDb.election.update({
      where: { id: created.id },
      data: { encryptionPublicKey: keys.publicKey.toString() },
    })

    await votesDb.trusteeShare.createMany({
      data: shares.map((share) => ({
        electionId: created.id,
        trusteeIndex: share.index,
        publicShare: publicShare(share).toString(),
        encryptedShare: encryptShare(
          share.value,
          input.trusteePassphrases[share.index - 1]!,
          created.id,
          share.index,
        ),
      })),
    })
    // `keys.privateKey` och `shares` går nu ur skop. Ingen referens till den
    // sammansatta hemligheten finns kvar någonstans efter den här punkten.
  } catch (error) {
    logger.error('Kunde inte skapa tröskelnyckeln för omröstningen', { error: String(error) })

    // Ingen har hunnit rösta i en omröstning som just misslyckades med att
    // skapas, så borttagningen kan inte radera någons röst.
    await deleteElection(created.id).catch(() => undefined)

    await recordAuditEvent(AUDIT_EVENTS.ELECTION_CREATION_FAILED)
    return { status: 'failed', message: 'Omröstningen kunde inte skapas.' }
  }

  try {
    await mirrorElection({
      id: created.id,
      name: input.name,
      kind: input.kind,
      mode,
      opensAt: input.opensAt,
      closesAt: input.closesAt,
      ballots: created.ballotIds,
    })
  } catch (error) {
    logger.error('Kunde inte spegla omröstningen till röstlängden', { error: String(error) })

    // Backa båda sidorna. En halvskapad omröstning är värre än ingen alls: den
    // syns för väljarna men går inte att rösta i.
    await deleteElection(created.id).catch(() => undefined)
    await removeMirroredElection(created.id).catch(() => undefined)

    await recordAuditEvent(AUDIT_EVENTS.ELECTION_CREATION_FAILED)
    return { status: 'failed', message: 'Omröstningen kunde inte skapas.' }
  }

  await recordAuditEvent(AUDIT_EVENTS.ELECTION_CREATED)

  return { status: 'created', election: created }
}
