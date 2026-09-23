import { Prisma } from '.prisma/votes'
import { hashLeaf, merkleRoot } from '@/lib/merkle'
import { verifyEncryptedBallot, type EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { votesDb } from '@/modules/ballot-box/db'
import { votersDb } from '@/modules/eligibility/db'
import { clearPendingVotes } from '@/modules/eligibility/pending-vote.service'
import { validateBeforeClose, type ValidationReport } from './validate-before-close.usecase'

/**
 * SKALNINGEN: ATT TA BORT DET YTTRE KUVERTET.
 *
 * Ordningen är noga vald och kan inte kastas om.
 *
 *   1. validera enligt uppgift 10 — avbryt vid avvikelse
 *   2. beräkna och spara Merkleroten över kuverten
 *   3. verifiera varje valsedel EN GÅNG TILL
 *   4. infoga i votes_db, sorterat på chifferhash
 *   5. kontrollera att antalet stämmer
 *   6. först då radera kopplingen
 *
 * Steg 1 är en SPÄRR, inte en rapport. Att skala ändå vore att kasta bort
 * bevismaterialet för det problem man just hittat: efter steg 6 finns ingen
 * väljare att fråga och ingen signatur att kontrollera.
 *
 * Steg 2 MÅSTE ligga före steg 6. Merkleroten över (ciphertextHash,
 * bankIdSignature), sorterade på chifferhash, är det enda som överlever
 * raderingen av signaturerna — och det som låter en väljare med sparat kuvert
 * bevisa i efterhand att det räknades. Beräknas den efter raderingen finns
 * ingenting att beräkna den över. Roten avslöjar ingenting själv; den är en
 * hash.
 *
 * Steg 3 känns överflödigt — bevisen kontrollerades ju när rösten lades. Det är
 * ändå rätt: det är den sista punkt där ett fel kan pekas ut.
 *
 * Steg 4 före 6 är inte en smaksak. Raderade vi först och kraschade skulle
 * rösterna vara borta utan att finnas i räkningen — ingen kan återskapa dem.
 * Flyttar vi först och kraschar är chiffren redan trygga, och omkörningen ser
 * dem som befintliga tack vare det unika indexet på ciphertextHash.
 *
 * SORTERINGEN PÅ INNEHÅLL är inte kosmetik. Skulle raderna infogas i den
 * ordning väljarna röstade kunde den som vet när någon legitimerade sig peka
 * ut hens rad, och skalningen vore verkningslös.
 */

export type CloseOutcome =
  | { status: 'closed'; moved: number; cleared: number; envelopeRoot: string }
  | { status: 'too_early'; closesAt: Date }
  | { status: 'already_closed' }
  | { status: 'validation_failed'; summary: ValidationReport['summary'] }
  | { status: 'invalid_ballot'; ciphertextHash: string }

/**
 * Ett blad per kuvert, sorterat på chifferhash.
 *
 * Sorteringen gör roten oberoende av i vilken ordning väljarna röstade — samma
 * skäl som infogningen i votes_db sorteras. Bladet binder BÅDE hashen och
 * signaturen: bara hashen hade låtit en signatur bytas ut obemärkt, bara
 * signaturen hade inte pekat ut vilken röst den hörde till.
 */
export function envelopeLeaf(envelope: { ciphertextHash: string; bankIdSignature: string }): string {
  return hashLeaf(`${envelope.ciphertextHash}|${envelope.bankIdSignature}`)
}

export function envelopeRootOf(
  envelopes: Array<{ ciphertextHash: string; bankIdSignature: string }>,
): string {
  const sorted = [...envelopes].sort((a, b) => a.ciphertextHash.localeCompare(b.ciphertextHash))
  return merkleRoot(sorted.map(envelopeLeaf))
}

/** Det som läses ur röstlängden för att kunna skalas. */
type Envelope = {
  ballotId: string
  ciphertext: unknown
  proofs: unknown
  ciphertextHash: string
  bankIdSignature: string
}

/**
 * Sorterar på chifferhash med samma jämförelse som `Array.prototype.sort` gör
 * på strängar.
 *
 * Avsiktligt INTE `localeCompare` här: det som skrivs till databasen måste
 * hamna i en ordning som en observatör kan räkna fram igen utan att känna till
 * serverns språkinställning. (`envelopeRootOf` får använda `localeCompare`
 * eftersom `merkleRoot` sorterar löven om på egen hand — där påverkar
 * jämförelsen ingenting som lämnar funktionen.)
 */
function byCiphertextHash(a: Envelope, b: Envelope): number {
  if (a.ciphertextHash < b.ciphertextHash) return -1
  if (a.ciphertextHash > b.ciphertextHash) return 1
  return 0
}

/**
 * Radens id, härlett ur chifferhashen i stället för slumpat.
 *
 * ETT SLUMPAT UUID HADE GJORT SORTERINGEN VERKNINGSLÖS I PRAKTIKEN.
 *
 * Raderna infogas i innehållets ordning just för att tabellens egen ordning
 * inte ska avslöja i vilken ordning väljarna röstade. Men den som läser
 * tabellen sorterar på primärnyckeln, inte på fysisk radordning — och ett
 * slumpat id ger en ordning som varken säger något om innehållet eller går
 * att räkna fram igen. Ett härlett id gör primärnyckelns ordning identisk med
 * innehållets: samma egenskap som sorteringen finns för, men bevarad även för
 * den som läser tabellen senare.
 *
 * Det avslöjar ingenting nytt: chifferhashen står redan i raden. Och det är
 * deterministiskt, vilket gör en omkörning till en konflikt på primärnyckeln
 * precis som på det unika indexet.
 */
function idForEnvelope(ciphertextHash: string): string {
  const hex = ciphertextHash.slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/**
 * Steg 3, per kuvert — skyddad mot kast av samma skäl som `proofHoldsSafely` i
 * `validate-before-close.usecase.ts`.
 *
 * Raden kommer direkt ur databasen, förbi varje Zod-schema, och
 * `verifyEncryptedBallot` gör `BigInt(...)` på chiffer- och bevisfälten utan
 * eget felfång. Ett missformat chiffer ska peka ut raden, inte krascha
 * stängningen.
 */
function ballotVerifies(
  shape: { publicKey: string; optionCount: number },
  electionId: string,
  envelope: Envelope,
): boolean {
  try {
    return verifyEncryptedBallot(shape.publicKey, electionId, envelope.ballotId, shape.optionCount, {
      ciphertext: envelope.ciphertext as EncryptedBallot['ciphertext'],
      proofs: envelope.proofs as EncryptedBallot['proofs'],
      ciphertextHash: envelope.ciphertextHash,
    })
  } catch {
    return false
  }
}

/**
 * Chifferhashen för det första kuvert som inte längre verifierar, eller null.
 *
 * Kuverten prövas i innehållets ordning, så att svaret inte beror på i vilken
 * ordning väljarna röstade.
 */
async function firstUnverifiableEnvelope(
  electionId: string,
  envelopes: Envelope[],
): Promise<string | null> {
  const shapes = new Map<string, Awaited<ReturnType<typeof getEncryptedBallotShape>>>()

  for (const envelope of [...envelopes].sort(byCiphertextHash)) {
    let shape = shapes.get(envelope.ballotId)
    if (shape === undefined) {
      shape = await getEncryptedBallotShape(envelope.ballotId)
      shapes.set(envelope.ballotId, shape)
    }

    if (!shape || !ballotVerifies(shape, electionId, envelope)) {
      return envelope.ciphertextHash
    }
  }

  return null
}

/**
 * Stänger omröstningen och skalar bort identitetslagret.
 *
 * ATT STÄNGNINGEN ÄR ETT ANROP OCH INTE EN TIDPUNKT ÄR AVSIKTLIGT — se
 * `Election.phase`s dokumentation i schemat: en klocka som går fel ändrar
 * beteendet tyst, medan en fasövergång är en händelse någon utfört.
 */
export async function closeElection(electionId: string): Promise<CloseOutcome> {
  const election = await votersDb.election.findUniqueOrThrow({
    where: { id: electionId },
    select: { closesAt: true, phase: true },
  })

  /**
   * FASEN AVGÖR, INTE KLOCKAN — I DEN HÄR RIKTNINGEN.
   *
   * En omröstning som lämnat OPEN har redan skalats: kopplingen är raderad
   * och det finns ingenting kvar att flytta. Att i stället låta klockan avgöra
   * hade gjort en omkörning omöjlig att skilja från en förstagångskörning.
   */
  if (election.phase !== 'OPEN') return { status: 'already_closed' }

  if (election.closesAt > new Date()) {
    return { status: 'too_early', closesAt: election.closesAt }
  }

  const ballots = await votersDb.electionBallot.findMany({
    where: { electionId },
    select: { id: true },
  })
  const ballotIds = ballots.map((ballot) => ballot.id)

  const envelopes: Envelope[] = await votersDb.pendingVote.findMany({
    where: { ballotId: { in: ballotIds } },
    select: {
      ballotId: true,
      ciphertext: true,
      proofs: true,
      ciphertextHash: true,
      bankIdSignature: true,
    },
  })

  // --- 1. Valideringen, som spärr ----------------------------------------
  const report = await validateBeforeClose(electionId)

  if (!report.summary.passed) {
    /**
     * SPÄRREN HAR REDAN STOPPAT SKALNINGEN — DET SOM ÅTERSTÅR ÄR DIAGNOSEN.
     *
     * Steg 3 finns, med kommentarens egna ord, för att vara "den sista punkt
     * där ett fel kan pekas ut": den namnger ETT kuvert vid dess chifferhash,
     * där valideringen svarar med en rapport över hela omröstningen. Ett
     * lagrat kuvert som ändrats i efterhand bryter både signaturen och
     * hashen, alltså båda kontrollerna — och av de två svaren är det
     * utpekande det som hjälper den som ska utreda.
     *
     * Ingenting skrivs i någotdera fallet, så den här prövningen kan inte
     * släppa igenom något valideringen stoppat. Den avgör bara vad
     * administratören får veta.
     */
    const broken = await firstUnverifiableEnvelope(electionId, envelopes)
    if (broken !== null) return { status: 'invalid_ballot', ciphertextHash: broken }

    return { status: 'validation_failed', summary: report.summary }
  }

  // --- 2. Kuvertroten, medan signaturerna fortfarande finns ---------------
  const envelopeRoot = envelopeRootOf(envelopes)
  await votersDb.election.update({ where: { id: electionId }, data: { envelopeRoot } })

  // --- 3. Varje valsedel verifieras en gång till --------------------------
  const broken = await firstUnverifiableEnvelope(electionId, envelopes)
  if (broken !== null) return { status: 'invalid_ballot', ciphertextHash: broken }

  // --- 4. Infogningen i votes_db, sorterad på chifferhash -----------------
  /**
   * `skipDuplicates` är hela idempotensen.
   *
   * Flytten går över en databasgräns och kan därför omöjligt vara en
   * transaktion. En körning som avbryts mellan infogningen och raderingen
   * lämnar chiffren på plats — och nästa körning ser dem som befintliga tack
   * vare det unika indexet på `ciphertextHash`, i stället för att skapa
   * dubbletter.
   */
  const sorted = [...envelopes].sort(byCiphertextHash)

  await votesDb.encryptedVote.createMany({
    data: sorted.map((envelope) => ({
      id: idForEnvelope(envelope.ciphertextHash),
      ballotId: envelope.ballotId,
      ciphertext: envelope.ciphertext as Prisma.InputJsonValue,
      proofs: envelope.proofs as Prisma.InputJsonValue,
      ciphertextHash: envelope.ciphertextHash,
    })),
    skipDuplicates: true,
  })

  // --- 5. Antalet måste stämma FÖRE raderingen ----------------------------
  const moved = await votesDb.encryptedVote.count({ where: { ballotId: { in: ballotIds } } })

  if (moved !== envelopes.length) {
    /**
     * KASTAR I STÄLLET FÖR ATT RADERA.
     *
     * Kommer vi hit har infogningen inte gett de rader den skulle. Att ändå
     * fortsätta till steg 6 vore att radera de enda kopior som finns av de
     * röster som saknas. Ett undantag lämnar kopplingen orörd, och stängningen
     * kan köras om när felet är utrett.
     */
    throw new Error(
      `Stängningen avbröts: ${envelopes.length} kuvert skulle flyttas men ${moved} finns i ` +
        'röstdatabasen. Kopplingen är orörd.',
    )
  }

  // --- 6. Först nu raderas kopplingen mellan väljare och röst -------------
  const cleared = await clearPendingVotes(electionId)

  await votersDb.election.update({
    where: { id: electionId },
    data: { phase: 'STRIPPED', linkClearedAt: new Date() },
  })

  return { status: 'closed', moved, cleared, envelopeRoot }
}
