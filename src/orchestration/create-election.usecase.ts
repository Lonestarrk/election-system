import { generateElectionKeyPair } from '@/lib/blind-signature'
import { logger } from '@/lib/logger'
import {
  createElection as createElectionInVotesDb,
  deleteElection,
  type CreatedElection,
} from '@/modules/ballot-box'
import { votesDb } from '@/modules/ballot-box/db'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import { mirrorElection, removeMirroredElection } from '@/modules/eligibility/election.service'
import { generateKeyPair } from '@/lib/crypto/elgamal'
import { publicShare, splitSecret } from '@/lib/crypto/threshold'
import { encryptShare } from '@/lib/crypto/share-storage'

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
   * ETT NYCKELPAR PER VALSEDEL, SKAPAT HÄR.
   *
   * Orkestreringen är enda stället som håller båda halvorna samtidigt: den
   * publika går till röstdatabasen så att vem som helst kan verifiera
   * röstintyg, den privata till röstlängden där intygen signeras. Ingen av
   * modulerna genererar nyckeln själv — då skulle den privata halvan behöva
   * passera röstdatabasen för att nå röstlängden.
   */
  const keyPairs = input.ballots.map(() => generateElectionKeyPair())

  let created: CreatedElection

  try {
    created = await createElectionInVotesDb({
      ...input,
      ballots: input.ballots.map((ballot, index) => ({
        ...ballot,
        signingPublicKeyPem: keyPairs[index]!.publicKeyPem,
      })),
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
    const shares = splitSecret(keys.privateKey, 3, 2)

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
      opensAt: input.opensAt,
      closesAt: input.closesAt,
      ballots: created.ballotIds.map((ballot, index) => ({
        ...ballot,
        signingPrivateKeyPem: keyPairs[index]!.privateKeyPem,
        signingPublicKeyPem: keyPairs[index]!.publicKeyPem,
      })),
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
