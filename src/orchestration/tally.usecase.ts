import type { Prisma } from '.prisma/votes'
import { multiply, type Ciphertext } from '@/lib/crypto/elgamal'
import { parseElement } from '@/lib/crypto/group'
// Ur serverns ingång och inte ur de delade modulerna: förtroendepersonens
// andel exponentieras då i OpenSSL, i konstant tid, och urnans
// undergruppskontroller räknas där. Se src/lib/crypto/server.ts.
import {
  combine,
  discreteLog,
  isInSubgroup,
  partiallyDecrypt,
  publicShare,
  verifyPartialDecryption,
} from '@/lib/crypto/server'
import { unlockShare } from '@/lib/crypto/share-storage'
import {
  parsePartialDecryptionProof,
  serialisePartialDecryptionProof,
  TRUSTEE_THRESHOLD,
  type PartialDecryption,
  type PartialDecryptionBinding,
} from '@/lib/crypto/threshold'
import { logger } from '@/lib/logger'
import { truncateToHour } from '@/lib/time'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { votesDb } from '@/modules/ballot-box/db'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import { votersDb } from '@/modules/eligibility/db'

/**
 * RÄKNINGEN: BARA SUMMAN ÖPPNAS, AV TVÅ AV TRE FÖRTROENDEPERSONER (uppgift 12).
 *
 * Varje röst i urnan är ett chiffer per alternativ, och chiffren multipliceras
 * ihop, alternativ för alternativ, till ett chiffer av summan (spec 4.2). Ingen
 * rad i urnan dekrypteras för sig: en förtroendeperson bidrar med en partiell
 * dekryptering av SUMMAN, och först när två har bidragit kombineras bidragen
 * och summan öppnas. Har valsedeln bara en röst är summan den rösten, och det
 * går inte att undvika. Det som sparas är bidragen, ett per alternativ och
 * förtroendeperson, och räkneverken, ett per alternativ. Ingenting sparas per
 * röst.
 *
 *   1. spärren: fasen står i STRIPPED, kuvertroten är skriven och inget kuvert
 *      ligger kvar i röstlängden (spec 6.1). Annars händer ingenting, och
 *      ingen andel låses upp
 *   2. summan räknas ur varje rad i urnan, med varje tal tolkat strikt och
 *      prövat mot undergruppen innan det multipliceras
 *   3. en förtroendeperson låser upp sin andel med sin fras, i minnet, och
 *      räknar sitt bidrag för varje alternativ, med ett bevis som binder det
 *      till valet, valsedeln, alternativet och summan (ruling 133)
 *   4. bidraget prövas och sparas, allt eller ingenting
 *   5. räkningen prövar varje sparat bidrag mot summan en gång till,
 *      kombinerar dem, tar den diskreta logaritmen och kräver att räkneverken
 *      summerar till antalet rader i urnan
 *   6. räkneverken sparas, och när den sista valsedeln i omröstningen är
 *      räknad skrivs TALLIED med jämför-och-sätt från STRIPPED
 *
 * ETT RÖSTETAL SOM INTE STÄMMER MED URNAN FÅR ALDRIG BLI TYST. Allt som läses
 * här kommer ur en databas som kan ha rörts efter stängningen: urnan,
 * andelarna, bidragen och räkneverken. Varje avvikelse kastar
 * `TallyAbortedError` med ett besked om vad som inte stämde, i stället för att
 * ge ett annat tal. Ett bidrag som en
 * förtroendeperson lämnar och som inte håller avvisas med `rejected`.
 *
 * VAD RÄKNINGEN INTE PRÖVAR. Den räknar exakt det som ligger i urnan, och den
 * prövar inte varje rösts bevis igen. Att urnan är de validerade kuverten
 * prövar stängningen före skalningen, och efter skalningen ska slutkontrollen
 * i uppgift 12b göra det, med varje rösts bevis och en urnrot. Till dess räknas
 * en rad som skrivits eller ändrats i urnan efter stängningen som den är, om
 * den har valsedelns form, dess tal är gruppelement och räkneverken ligger inom
 * taket och summerar till antalet rader. En sådan rad kan lägga till en röst,
 * men också flytta röster mellan alternativ: ett chiffer för +2 på ett
 * alternativ och −1 på ett annat klarar kraven, fast valsedelns bevis hade
 * underkänt det. Ändras summan efter att ett bidrag sparats avbryts räkningen,
 * eftersom bidraget då inte håller mot den nya summan. Se posten
 * `votes-db-writer-can-swap-ciphertext` i src/lib/known-limitations.ts.
 *
 * DETSAMMA GÄLLER VALHEMLIGHETEN. Det som öppnas är summan av det som ligger
 * i urnan när bidragen räknas. Den som kan skriva i röstdatabasen kan byta ut
 * alla rader utom en mot rader med känt innehåll innan förtroendepersonerna
 * bidrar, och då går den kvarvarande radens röst att räkna fram ur
 * resultatet. Räkningen kan inte skilja en sådan urna från en ärlig förrän
 * det finns en urnrot att pröva urnan mot, och den behöver prövas innan något
 * dekrypteras, inte först i slutkontrollen.
 *
 * FRASEN LAGRAS ALDRIG OCH LOGGAS ALDRIG. Den låser upp andelen i minnet, i
 * `submitPartialDecryption`, och ingenting mer. Den upplåsta andelen sparas
 * inte och ges inte tillbaka, och ingen av dem står i något svar, i något fel
 * eller i loggen. Andelen finns sparad låst, sedan valet skapades.
 * Att servern ser andelen medan den räknar står som en känd begränsning, se
 * posten `server-sees-trustee-share`.
 */

/** Hur många rader i urnan som läses per fråga. En rad är en valsedels chiffer. */
const URN_READ_BATCH_SIZE = 500

/**
 * Räkningen avbröts, och ingenting blev fel räknat.
 *
 * Meddelandet är ett besked till administratören och säger vad som inte
 * stämde och var: vilken rad i urnan, med dess chifferhash, vilken
 * förtroendeperson och vilket alternativ. Det innehåller aldrig en fras eller
 * en andel. Loggen maskerar chifferhashar, som den gör för stängningen.
 */
export class TallyAbortedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TallyAbortedError'
  }
}

function abort(message: string): never {
  throw new TallyAbortedError(`Räkningen avbröts: ${message}`)
}

/** Ett bidrag som räknats fram utanför servern, som det kommer på tråden eller ur databasen. */
export type SubmittedPartial = { optionIndex: number; value: unknown; proof: unknown }

/**
 * Spärrens besked: kopplingen mellan väljare och röst är inte bevisligen
 * borta, eller så är omröstningen redan räknad. Meddelandet säger vilket.
 */
export type WrongPhase = { status: 'wrong_phase'; phase: string | null; message: string }

export type PartialDecryptionOutcome =
  | { status: 'accepted' }
  | { status: 'rejected'; message: string }
  | { status: 'duplicate' }
  | { status: 'wrong_passphrase' }
  | WrongPhase
  | { status: 'unknown_ballot' }
  | { status: 'unknown_trustee' }

export type TallyOutcome =
  | {
      status: 'tallied'
      /** Röster per alternativ, i valsedelns kanoniska ordning: blankt först. */
      counts: number[]
      /** Omröstningens fas efter räkningen, STRIPPED eller TALLIED. */
      phase: string
    }
  | { status: 'needs_more_trustees'; have: number; need: number }
  | WrongPhase
  | { status: 'unknown_ballot' }

// ---------------------------------------------------------------------------
// 1. Spärren
// ---------------------------------------------------------------------------

type Gate =
  | { open: true; electionId: string; ballotId: string; optionCount: number }
  | { open: false; outcome: WrongPhase | { status: 'unknown_ballot' } }

function closedGate(phase: string | null, message: string): Gate {
  return { open: false, outcome: { status: 'wrong_phase', phase, message } }
}

/** Beskedet för en fas som inte är STRIPPED. */
function messageForPhase(phase: string): string {
  if (phase === 'OPEN') {
    return (
      'Röstningen pågår, och fasen står i OPEN. Ingenting dekrypteras förrän omröstningen är ' +
      'stängd och kopplingen mellan väljare och röst raderad (spec 6.1).'
    )
  }
  if (phase === 'CLOSED' || phase === 'VALIDATED') {
    return (
      `Omröstningen är stängd men inte skalad, och fasen står i ${phase}. Kopplingen mellan ` +
      'väljare och röst finns alltså kvar, och ingenting dekrypteras förrän skalningen har ' +
      'raderat den (spec 6.1).'
    )
  }
  if (phase === 'TALLIED' || phase === 'CERTIFIED') {
    return (
      `Omröstningen är redan räknad, och fasen står i ${phase}. Inga fler bidrag tas emot, och ` +
      'ingenting räknas om.'
    )
  }
  return (
    `Fasen står i ${phase}, som inte är någon av specens faser, så det går inte att säga om ` +
    'kopplingen mellan väljare och röst är raderad. Ingenting dekrypteras.'
  )
}

/**
 * DEKRYPTERINGEN KRÄVER ATT KOPPLINGEN BEVISLIGEN ÄR BORTA (spec 6.1).
 *
 * Före STRIPPED ligger kuverten bredvid väljarnas namn i röstlängden. En
 * dekryptering då, också av en summa, hade låtit den som styr vad som ligger i
 * urnan få en summa öppnad medan kopplingen finns, till exempel summan av en
 * enda väljares kuvert (spec 6.1 och 6.2). Spärren prövas därför först, före
 * allt annat, och innan någon andel låses upp.
 *
 * Tre villkor, och alla tre krävs:
 *   – fasen står i STRIPPED, som bara skalningens transaktion skriver
 *   – kuvertroten är skriven, eftersom STRIPPED bara skrivs tillsammans med
 *     roten. Utan rot har någon skrivit fasen förbi stängningen
 *   – inget kuvert ligger kvar på omröstningens valsedlar i röstlängden.
 *     Skalningen raderar dem i samma transaktion som den skriver STRIPPED,
 *     så ett kuvert här har skrivits dit efteråt, bredvid ett namn
 *
 * Fasen går bara framåt, med jämför-och-sätt, så att den stod i STRIPPED när
 * spärren läste den betyder att kopplingen var raderad ur röstlängden då och
 * fortsatt är det, så länge ingen skriver där förbi koden. En säkerhetskopia
 * från före stängningen har den kvar (spec 10). Omröstningar i TALLIED och
 * senare tar inte emot fler bidrag.
 */
async function tallyGate(ballotId: string): Promise<Gate> {
  const ballot = await votesDb.electionBallot.findUnique({
    where: { id: ballotId },
    select: { electionId: true },
  })
  if (!ballot) return { open: false, outcome: { status: 'unknown_ballot' } }

  const election = await votersDb.election.findUnique({
    where: { id: ballot.electionId },
    select: { phase: true, envelopeRoot: true, ballots: { select: { id: true } } },
  })
  if (!election) {
    return closedGate(
      null,
      'Omröstningen finns inte i röstlängden, så det går inte att se om kopplingen mellan väljare ' +
        'och röst är raderad. Ingenting dekrypteras.',
    )
  }

  if (election.phase !== 'STRIPPED') return closedGate(election.phase, messageForPhase(election.phase))

  if (election.envelopeRoot === null) {
    return closedGate(
      'STRIPPED',
      'Fasen står i STRIPPED men kuvertroten är oskriven. STRIPPED skrivs bara tillsammans med ' +
        'roten, så någon har skrivit i röstlängden förbi stängningen, och det går inte att säga om ' +
        'kopplingen mellan väljare och röst är raderad. Ingenting dekrypteras.',
    )
  }

  const envelopesLeft = await votersDb.pendingVote.count({
    where: { ballotId: { in: election.ballots.map((entry) => entry.id) } },
  })
  if (envelopesLeft > 0) {
    return closedGate(
      'STRIPPED',
      `Fasen står i STRIPPED, men ${envelopesLeft} kuvert ligger kvar i röstlängden bredvid ` +
        'väljarnas namn. Skalningen raderar kuverten i samma transaktion som den skriver STRIPPED, ' +
        'så de har skrivits dit förbi stängningen. Ingenting dekrypteras förrän det är utrett.',
    )
  }

  /**
   * Formen läses sist, efter fasen. En valsedel som saknar form finns inte i
   * kuvertmodellen: en fråga i en allmän omröstning räknas inte här förrän
   * uppgift 14c, och en omröstning utan krypteringsnyckel har inga kuvert.
   */
  const shape = await getEncryptedBallotShape(ballotId)
  if (!shape) return { open: false, outcome: { status: 'unknown_ballot' } }

  return { open: true, electionId: ballot.electionId, ballotId, optionCount: shape.optionCount }
}

// ---------------------------------------------------------------------------
// 2. Summan
// ---------------------------------------------------------------------------

/** Släpper fram väntande I/O mellan exponentieringarna, som verifieringen av valsedlarna gör. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Radens chifferhash i ett besked, eller dess id när hashen inte ens har formen av en. */
function describeRow(row: { id: string; ciphertextHash: string }): string {
  return /^[0-9a-f]{64}$/.test(row.ciphertextHash)
    ? `chifferhash ${row.ciphertextHash}`
    : `id ${row.id} och en chifferhash som inte är 64 små hextecken`
}

/** Ett par ur urnan, tolkat strikt, eller null. Formen prövas också, som för valsedeln. */
function parsePair(pair: unknown): Ciphertext | null {
  if (typeof pair !== 'object' || pair === null || Array.isArray(pair)) return null
  const c1 = parseElement((pair as Record<string, unknown>).c1)
  const c2 = parseElement((pair as Record<string, unknown>).c2)
  return c1 === null || c2 === null ? null : { c1, c2 }
}

/**
 * Summan av varje rad i urnan för valsedeln, alternativ för alternativ, och
 * antalet rader.
 *
 * VARJE RAD, INTE VARJE HASH (ruling 130). Två kuvert får ha samma chiffer, en
 * valsedel och en kopia av den, och båda är röster. Urnan har en rad per
 * kuvert, och här läses raderna efter id, i omgångar, utan att något slås ihop.
 *
 * VARJE TAL TOLKAS STRIKT OCH PRÖVAS INNAN DET MULTIPLICERAS (granskningen av
 * uppgift 1 och 14b). Chiffren prövades mot undergruppen när rösten lades,
 * men raden läses nu ur votes_db, och ingenting säger att ingen rört den
 * sedan. Ett element utanför undergruppen i summan hade läckt en bit av
 * förtroendepersonens andel vid den partiella dekrypteringen (REVIEW FOCUS 1),
 * och ett tal som inte går att tolka hade tidigare kastat ett SyntaxError.
 * Nu avbryts räkningen med ett besked som pekar ut raden, innan något räknas
 * med den. En valsedel utan rader ger summan (1, 1), inga röster.
 *
 * Antalet rader är taket för den diskreta logaritmen och det tal räkneverken
 * ska summera till, se `completeTally`. Det räknas ur samma läsning som
 * summan, så att de två alltid gäller samma rader.
 */
async function sumOfUrn(ballotId: string, optionCount: number): Promise<{ sums: Ciphertext[]; rows: number }> {
  let sums: Ciphertext[] = Array.from({ length: optionCount }, () => ({ c1: 1n, c2: 1n }))
  let rows = 0
  let after: string | null = null

  for (;;) {
    const batch: Array<{ id: string; ciphertext: unknown; ciphertextHash: string }> =
      await votesDb.encryptedVote.findMany({
        where: after === null ? { ballotId } : { ballotId, id: { gt: after } },
        select: { id: true, ciphertext: true, ciphertextHash: true },
        orderBy: { id: 'asc' },
        take: URN_READ_BATCH_SIZE,
      })

    for (const row of batch) {
      const { ciphertext } = row
      if (!Array.isArray(ciphertext) || ciphertext.length !== optionCount) {
        abort(
          `raden i urnan med ${describeRow(row)} har inte ett chiffer med ${optionCount} alternativ, ` +
            'som valsedeln har. Ingenting är räknat eller sparat.',
        )
      }

      const pairs: Ciphertext[] = []
      for (const [optionIndex, pair] of ciphertext.entries()) {
        const parsed = parsePair(pair)
        if (!parsed || !isInSubgroup(parsed.c1) || !isInSubgroup(parsed.c2)) {
          abort(
            `raden i urnan med ${describeRow(row)} har ett chiffer för alternativ ${optionIndex} ` +
              'som inte är två element i gruppens undergrupp. Stängningen prövade varje chiffer innan ' +
              'det flyttades, så raden har skrivits eller ändrats förbi den. Ingenting är räknat eller sparat.',
          )
        }
        pairs.push(parsed)
        await yieldToEventLoop()
      }

      sums = sums.map((sum, optionIndex) => multiply(sum, pairs[optionIndex]!))
      rows += 1
    }

    if (batch.length < URN_READ_BATCH_SIZE) break
    after = batch[batch.length - 1]!.id
  }

  return { sums, rows }
}

/**
 * Summan av valsedelns rader i urnan, per alternativ (spec 4.2).
 *
 * Summan är ett chiffer och öppnar ingenting. Den som vill se den kan räkna
 * fram den själv ur urnan.
 */
export async function aggregate(ballotId: string): Promise<Ciphertext[]> {
  const shape = await getEncryptedBallotShape(ballotId)
  if (!shape) abort('valsedeln finns inte i kuvertmodellen, och har ingen summa.')
  return (await sumOfUrn(ballotId, shape.optionCount)).sums
}

// ---------------------------------------------------------------------------
// Förtroendepersonerna
// ---------------------------------------------------------------------------

type TrusteeRow = { trusteeIndex: number; publicShare: string; encryptedShare: string }

async function trusteeOf(electionId: string, trusteeIndex: number): Promise<TrusteeRow | null> {
  if (!Number.isSafeInteger(trusteeIndex) || trusteeIndex < 1) return null
  return votesDb.trusteeShare.findUnique({
    where: { electionId_trusteeIndex: { electionId, trusteeIndex } },
    select: { trusteeIndex: true, publicShare: true, encryptedShare: true },
  })
}

/**
 * Förtroendepersonens publika andel, tolkad strikt och prövad mot
 * undergruppen, som varje annat gruppelement ur databasen.
 *
 * Det är den varje bidrag prövas mot. En publik andel som bytts ut hade låtit
 * ett bidrag som räknats med en annan nyckel godkännas, och en andel utanför
 * undergruppen hade gjort bevisets ekvationer meningslösa.
 */
function parsePublicShare(trustee: TrusteeRow): bigint {
  const value = parseElement(trustee.publicShare)
  if (value === null || !isInSubgroup(value)) {
    abort(
      `förtroendeperson ${trustee.trusteeIndex}:s publika andel i röstdatabasen är inte ett element ` +
        'i gruppens undergrupp, och ingenting räknas mot den.',
    )
  }
  return value
}

async function hasContributed(ballotId: string, trusteeIndex: number): Promise<boolean> {
  return (await votesDb.partialDecryption.count({ where: { ballotId, trusteeIndex } })) > 0
}

function bindingFor(gate: { electionId: string; ballotId: string }, optionIndex: number): PartialDecryptionBinding {
  return { electionId: gate.electionId, ballotId: gate.ballotId, optionIndex }
}

/** En unikhetskonflikt, P2002. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

/**
 * Bidraget prövas mot summan och förtroendepersonens publika andel, och
 * sparas bara om varje alternativ håller.
 *
 * ALLT ELLER INGENTING. Raderna skrivs i en enda sats, så ett bidrag finns
 * antingen för varje alternativ eller inte alls. Det unika indexet på
 * (valsedel, alternativ, förtroendeperson) gör att två samtidiga bidrag från
 * samma förtroendeperson inte båda kan sparas: den andra satsen avvisas hel,
 * och svaret är `duplicate`.
 */
async function verifyAndStore(
  gate: { electionId: string; ballotId: string },
  trusteeIndex: number,
  expectedPublicShare: bigint,
  partials: readonly PartialDecryption[],
  sums: readonly Ciphertext[],
): Promise<PartialDecryptionOutcome> {
  for (const [optionIndex, partial] of partials.entries()) {
    if (!verifyPartialDecryption(expectedPublicShare, sums[optionIndex]!, partial, bindingFor(gate, optionIndex))) {
      return {
        status: 'rejected',
        message:
          `Bidraget för alternativ ${optionIndex} håller inte mot förtroendepersonens publika andel ` +
          'och valsedelns summa. Ingenting sparades.',
      }
    }
    await yieldToEventLoop()
  }

  try {
    await votesDb.partialDecryption.createMany({
      data: partials.map((partial, optionIndex) => ({
        ballotId: gate.ballotId,
        optionIndex,
        trusteeIndex,
        value: partial.value.toString(),
        proof: serialisePartialDecryptionProof(partial.proof) as Prisma.InputJsonValue,
      })),
    })
  } catch (error) {
    if (isUniqueViolation(error)) return { status: 'duplicate' }
    throw error
  }

  await recordAuditEvent(AUDIT_EVENTS.PARTIAL_DECRYPTION_RECORDED)
  return { status: 'accepted' }
}

/**
 * Ett bidrag på tråden, tolkat strikt: exakt ett bidrag per alternativ, i
 * alternativens ordning. Ett tal som inte går att tolka underkänner bidraget,
 * och ingenting kastar.
 */
function parseSubmitted(
  partials: readonly SubmittedPartial[],
  optionCount: number,
  trusteeIndex: number,
): { ok: true; partials: PartialDecryption[] } | { ok: false; message: string } {
  if (!Array.isArray(partials) || partials.length !== optionCount) {
    return { ok: false, message: `Bidraget ska ha exakt ett värde per alternativ, ${optionCount} stycken.` }
  }

  const byOption = new Array<PartialDecryption | undefined>(optionCount)
  for (const partial of partials) {
    if (typeof partial !== 'object' || partial === null) {
      return { ok: false, message: 'Bidraget har ett värde som inte är ett alternativs bidrag.' }
    }
    const { optionIndex } = partial
    if (!Number.isSafeInteger(optionIndex) || optionIndex < 0 || optionIndex >= optionCount) {
      return { ok: false, message: 'Bidraget har ett alternativ som inte finns på valsedeln.' }
    }
    if (byOption[optionIndex]) {
      return { ok: false, message: `Bidraget har alternativ ${optionIndex} två gånger.` }
    }

    const value = parseElement(partial.value)
    const proof = parsePartialDecryptionProof(partial.proof)
    if (value === null || proof === null) {
      return {
        ok: false,
        message:
          `Bidraget för alternativ ${optionIndex} går inte att tolka: värdet ska vara ett tal i [1, p) ` +
          'och beviset ha formatet 2, med kanoniskt skrivna tal.',
      }
    }
    byOption[optionIndex] = { trusteeIndex, value, proof }
  }

  return { ok: true, partials: byOption as PartialDecryption[] }
}

/**
 * Ett bidrag som förtroendepersonen räknat fram själv, utanför servern.
 *
 * Så går det till i ett riktigt val: förtroendepersonen räknar på sin egen
 * enhet och skickar bara värdena med bevis, och servern ser aldrig någon
 * andel. Bidraget prövas mot summan som servern räknar ur urnan, och mot
 * förtroendepersonens publika andel, och sparas bara om varje alternativ
 * håller. REVIEW FOCUS 4: ett bevis som hör till ett annat chiffer, en annan
 * valsedel eller ett annat alternativ avvisas.
 */
export async function submitComputedPartialDecryption(
  ballotId: string,
  trusteeIndex: number,
  partials: readonly SubmittedPartial[],
): Promise<PartialDecryptionOutcome> {
  const gate = await tallyGate(ballotId)
  if (!gate.open) return gate.outcome

  const trustee = await trusteeOf(gate.electionId, trusteeIndex)
  if (!trustee) return { status: 'unknown_trustee' }
  const expectedPublicShare = parsePublicShare(trustee)

  if (await hasContributed(ballotId, trusteeIndex)) return { status: 'duplicate' }

  const parsed = parseSubmitted(partials, gate.optionCount, trusteeIndex)
  if (!parsed.ok) return { status: 'rejected', message: parsed.message }

  const { sums } = await sumOfUrn(ballotId, gate.optionCount)
  return verifyAndStore(gate, trusteeIndex, expectedPublicShare, parsed.partials, sums)
}

/**
 * Förtroendepersonens bidrag, räknat av servern med hennes fras.
 *
 * Så går det till i demon (spec 4.5). Frasen låser upp andelen i minnet, och
 * servern räknar bidraget för varje alternativ och prövar det som vilket
 * bidrag som helst innan det sparas. Frasen och den upplåsta andelen sparas
 * inte och ges inte tillbaka.
 *
 * ORDNINGEN ÄR VALD. Spärren först, så att andelen aldrig låses upp i en fas
 * där den inte får användas. Ett tidigare bidrag från samma förtroendeperson
 * därefter, så att inte heller en omsändning låser upp något. Först sedan
 * frasen, som kostar en scrypt-härledning.
 */
export async function submitPartialDecryption(
  ballotId: string,
  trusteeIndex: number,
  passphrase: string,
): Promise<PartialDecryptionOutcome> {
  const gate = await tallyGate(ballotId)
  if (!gate.open) return gate.outcome

  const trustee = await trusteeOf(gate.electionId, trusteeIndex)
  if (!trustee) return { status: 'unknown_trustee' }
  const expectedPublicShare = parsePublicShare(trustee)

  if (await hasContributed(ballotId, trusteeIndex)) return { status: 'duplicate' }

  const unlocked = unlockShare(trustee.encryptedShare, passphrase, gate.electionId, trusteeIndex)
  if (unlocked.status === 'wrong_passphrase') {
    // En angreppssignal, som syns i revisionsloggen (ruling 64). Posten säger
    // inte vem, och frasen står aldrig någonstans.
    await recordAuditEvent(AUDIT_EVENTS.TRUSTEE_PASSPHRASE_REJECTED)
    return { status: 'wrong_passphrase' }
  }
  if (unlocked.status === 'malformed') {
    abort(
      `förtroendeperson ${trusteeIndex}:s låsta andel i röstdatabasen har inte den form den skrevs med. ` +
        'Ingenting är räknat eller sparat.',
    )
  }

  const share = { index: trusteeIndex, value: unlocked.value }

  /**
   * Andelen ska höra till sin publika andel. Stämmer de inte har någon av dem
   * bytts ut i röstdatabasen, och bidraget hade underkänts ändå. Beskedet
   * säger det rakt ut i stället för att skylla på förtroendepersonen.
   */
  if (publicShare(share) !== expectedPublicShare) {
    abort(
      `förtroendeperson ${trusteeIndex}:s andel stämmer inte med hennes publika andel i röstdatabasen. ` +
        'De skrevs tillsammans när valet skapades, så en av dem har ändrats sedan dess. Ingenting är ' +
        'räknat eller sparat.',
    )
  }

  const { sums } = await sumOfUrn(ballotId, gate.optionCount)

  const partials: PartialDecryption[] = []
  for (const [optionIndex, sum] of sums.entries()) {
    partials.push(partiallyDecrypt(share, sum, bindingFor(gate, optionIndex)))
    await yieldToEventLoop()
  }

  return verifyAndStore(gate, trusteeIndex, expectedPublicShare, partials, sums)
}

// ---------------------------------------------------------------------------
// Räkningen
// ---------------------------------------------------------------------------

/**
 * De sparade bidragen, per förtroendeperson och i alternativens ordning,
 * tolkade strikt. En rad som inte går att tolka, eller ett bidrag som saknar
 * ett alternativ, avbryter räkningen: bidragen skrivs alltid hela, så ett
 * halvt bidrag har ändrats i röstdatabasen.
 */
async function storedContributions(
  ballotId: string,
  optionCount: number,
): Promise<Map<number, PartialDecryption[]>> {
  const rows = await votesDb.partialDecryption.findMany({
    where: { ballotId },
    select: { optionIndex: true, trusteeIndex: true, value: true, proof: true },
    orderBy: [{ trusteeIndex: 'asc' }, { optionIndex: 'asc' }],
  })

  const byTrustee = new Map<number, Array<PartialDecryption | undefined>>()
  for (const row of rows) {
    const { trusteeIndex, optionIndex } = row
    if (optionIndex < 0 || optionIndex >= optionCount) {
      abort(`förtroendeperson ${trusteeIndex}:s bidrag har ett alternativ ${optionIndex}, som inte finns på valsedeln.`)
    }

    const value = parseElement(row.value)
    const proof = parsePartialDecryptionProof(row.proof)
    if (value === null || proof === null) {
      abort(
        `förtroendeperson ${trusteeIndex}:s bidrag för alternativ ${optionIndex} i röstdatabasen går ` +
          'inte att tolka. Det prövades innan det sparades, så det har skrivits eller ändrats förbi ' +
          'räkningen. Ingenting är räknat.',
      )
    }

    const partials = byTrustee.get(trusteeIndex) ?? new Array<PartialDecryption | undefined>(optionCount)
    partials[optionIndex] = { trusteeIndex, value, proof }
    byTrustee.set(trusteeIndex, partials)
  }

  const contributions = new Map<number, PartialDecryption[]>()
  for (const [trusteeIndex, partials] of byTrustee) {
    const missing = [...partials.keys()].filter((optionIndex) => partials[optionIndex] === undefined)
    if (missing.length > 0) {
      abort(
        `förtroendeperson ${trusteeIndex}:s bidrag saknar ${missing.length === 1 ? 'alternativ' : 'alternativen'} ` +
          `${missing.join(', ')}. Bidrag sparas alltid hela, i en enda sats, så de rader som saknas har ` +
          'tagits bort förbi räkningen. Ingenting är räknat.',
      )
    }
    contributions.set(trusteeIndex, partials as PartialDecryption[])
  }
  return contributions
}

type StoredTally = { kind: 'none' } | { kind: 'complete'; counts: number[] }

/** Valsedelns sparade räkneverk. Räkneverken sparas alltid hela, som bidragen. */
async function storedTally(ballotId: string, optionCount: number): Promise<StoredTally> {
  const rows = await votesDb.ballotTally.findMany({
    where: { ballotId },
    select: { optionIndex: true, count: true },
    orderBy: { optionIndex: 'asc' },
  })
  if (rows.length === 0) return { kind: 'none' }

  const complete =
    rows.length === optionCount &&
    rows.every((row, index) => row.optionIndex === index && Number.isSafeInteger(row.count) && row.count >= 0)
  if (!complete) {
    abort(
      'valsedelns sparade räkneverk i röstdatabasen är ofullständiga eller har fel form. De sparas ' +
        'alltid hela, i en enda sats, en rad per alternativ, så de har ändrats förbi räkningen. ' +
        'Ingenting räknas om.',
    )
  }
  return { kind: 'complete', counts: rows.map((row) => row.count) }
}

/**
 * Räkneverken ska summera till antalet rader i urnan.
 *
 * Varje röst kodar exakt ett alternativ, också blankt, och summabeviset i
 * varje valsedel säger just det (ruling 67). Ett räkneverk som inte går ihop
 * betyder att något i urnan, i bidragen eller i kombinationen är fel, och då
 * ska räkningen avbrytas i stället för att ge ett tal.
 */
function requireSumOfCounts(counts: readonly number[], rows: number): void {
  const total = counts.reduce((sum, count) => sum + count, 0)
  if (total !== rows) {
    abort(
      `summan av räkneverken är ${total}, men urnan har ${rows} rader för valsedeln. Varje röst kodar ` +
        'exakt ett alternativ, också blankt, så de två ska vara lika. Ingenting är sparat.',
    )
  }
}

/**
 * Omröstningens fas, som den står i röstlängden.
 */
async function phaseOf(electionId: string): Promise<{ phase: string; envelopeRoot: string | null } | null> {
  return votersDb.election.findUnique({ where: { id: electionId }, select: { phase: true, envelopeRoot: true } })
}

/**
 * TALLIED SKRIVS NÄR DEN SISTA VALSEDELN ÄR RÄKNAD, MED JÄMFÖR-OCH-SÄTT FRÅN
 * STRIPPED (spec 6.1, som övergångarna i uppgift 11d).
 *
 * Villkoret är att varje valsedel i omröstningen har sina räkneverk, ett per
 * alternativ. Räkneverken skrivs innan villkoret prövas, så av två räkningar
 * som slutar samtidigt ser åtminstone den senare att båda är klara. Ingen fas
 * hoppar: övergången sker bara från STRIPPED, med kuvertroten skriven, och
 * ingen fas går baklänges. Av flera samtidiga räkningar skriver en TALLIED, och
 * de andra finner fasen redan där.
 *
 * `tallyCompletedAt` i röstdatabasen skrivs först, en gång, avrundad till hel
 * timme, som all tid i votes_db. Kraschar processen mellan den och fasen står
 * räkneverken och tidpunkten kvar, och nästa räkning av en av valsedlarna
 * skriver fasen.
 *
 * Returnerar fasen efteråt. Är varje valsedel räknad, och står fasen ändå i
 * något annat än STRIPPED, TALLIED eller CERTIFIED med roten skriven, har någon
 * skrivit i röstlängden förbi räkningen, och då avbryts den med ett besked.
 * Återstår en valsedel ges fasen tillbaka som den står. Ingen fas skrivs över.
 */
async function settleElectionPhase(electionId: string): Promise<string> {
  const ballots = await votesDb.electionBallot.findMany({ where: { electionId }, select: { id: true } })

  for (const ballot of ballots) {
    const shape = await getEncryptedBallotShape(ballot.id)
    const tallied = shape ? await votesDb.ballotTally.count({ where: { ballotId: ballot.id } }) : -1
    if (!shape || tallied !== shape.optionCount) {
      const current = await phaseOf(electionId)
      if (!current) abort('omröstningen finns inte längre i röstlängden. Räkneverken är sparade.')
      return current.phase
    }
  }

  await votesDb.election.updateMany({
    where: { id: electionId, tallyCompletedAt: null },
    data: { tallyCompletedAt: truncateToHour(new Date()) },
  })

  const moved = await votersDb.election.updateMany({
    where: { id: electionId, phase: 'STRIPPED', envelopeRoot: { not: null } },
    data: { phase: 'TALLIED' },
  })
  if (moved.count === 1) {
    await recordAuditEvent(AUDIT_EVENTS.ELECTION_TALLIED)
    return 'TALLIED'
  }

  const after = await phaseOf(electionId)
  if (after && (after.phase === 'TALLIED' || after.phase === 'CERTIFIED') && after.envelopeRoot !== null) {
    return after.phase
  }
  abort(
    'räkneverken för varje valsedel är sparade, men omröstningen gick inte att föra från STRIPPED ' +
      `till TALLIED: fasen står i ${after?.phase ?? '(omröstningen saknas i röstlängden)'}` +
      `${after && after.envelopeRoot === null ? ' och kuvertroten är oskriven' : ''}. Någon har skrivit ` +
      'i röstlängden förbi räkningen, och fasen skrivs inte över.',
  )
}

/**
 * Räknar en valsedel, när två förtroendepersoner har lämnat sina bidrag.
 *
 * Varje sparat bidrag prövas mot summan en gång till, eftersom det har legat i
 * röstdatabasen sedan det sparades, och eftersom urnan kan ha ändrats sedan
 * dess. Bidragen binder summan de räknades för, och en ny summa underkänner
 * dem. Alla prövade bidrag kombineras. Med tre gäller ekvationerna lika väl,
 * eftersom delningens polynom har grad ett.
 *
 * TAKET FÖR DEN DISKRETA LOGARITMEN ÄR ANTALET RADER I URNAN FÖR VALSEDELN
 * (ruling 67). Inget alternativ kan få fler röster än så, och taket är snävare
 * och säkrare än antalet röstberättigade: en summa utanför [0, rader] betyder
 * att något är fel, och sökningen stannar där i stället för att leta vidare.
 * Antalet ligger dessutom på den anonyma sidan, så ingen läsning av
 * röstlängden behövs. En valsedel utan röster har taket noll, och summan (1, 1)
 * ger noll direkt.
 *
 * EN REDAN RÄKNAD VALSEDEL RÄKNAS OM FRÅN GRUNDEN, ur urnan och bidragen, och
 * de sparade räkneverken ska vara exakt de omräknade. Att bara pröva deras
 * summa räcker inte: två räkneverk som bytt plats har samma summa, och hade
 * getts tillbaka som valsedelns resultat. Fasen prövas igen, så att en räkning
 * som avbröts innan TALLIED skrevs kan göras klart. Två samtidiga räkningar
 * ger samma resultat: den som hinner sist finner räkneverken sparade, och de
 * ska vara desamma som den själv räknade fram.
 */
export async function completeTally(ballotId: string): Promise<TallyOutcome> {
  const gate = await tallyGate(ballotId)
  if (!gate.open) return gate.outcome

  const stored = await storedTally(ballotId, gate.optionCount)
  const contributions = await storedContributions(ballotId, gate.optionCount)
  if (contributions.size < TRUSTEE_THRESHOLD) {
    if (stored.kind === 'complete') {
      abort(
        `valsedelns räkneverk är sparade, men bara ${contributions.size} av bidragen de räknades ur ` +
          'finns kvar, så de går inte att räkna om. Bidrag tas aldrig bort av räkningen, så de har ' +
          'tagits bort förbi den. Ingenting räknas.',
      )
    }
    return { status: 'needs_more_trustees', have: contributions.size, need: TRUSTEE_THRESHOLD }
  }

  const counts = await countFromContributions(gate, contributions)

  if (stored.kind === 'complete') {
    if (!sameCounts(stored.counts, counts)) {
      abort(
        'valsedelns sparade räkneverk stämmer inte med en omräkning ur urnan och bidragen. De har ' +
          'ändrats förbi räkningen, och ingenting skrivs över.',
      )
    }
    return { status: 'tallied', counts, phase: await settleElectionPhase(gate.electionId) }
  }

  try {
    await votesDb.ballotTally.createMany({
      data: counts.map((count, optionIndex) => ({ ballotId, optionIndex, count })),
    })
    await recordAuditEvent(AUDIT_EVENTS.BALLOT_TALLIED)
  } catch (error) {
    if (!isUniqueViolation(error)) throw error

    // En annan räkning av samma valsedel hann spara först. Den räknade ur
    // samma urna och samma bidrag, och räkneverken ska vara desamma.
    const theirs = await storedTally(ballotId, gate.optionCount)
    if (theirs.kind !== 'complete' || !sameCounts(theirs.counts, counts)) {
      abort('en annan räkning av valsedeln sparade andra räkneverk samtidigt. Ingenting skrevs över.')
    }
    logger.info('En annan räkning av valsedeln sparade samma räkneverk först')
  }

  return { status: 'tallied', counts, phase: await settleElectionPhase(gate.electionId) }
}

function sameCounts(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((count, index) => count === b[index])
}

/**
 * Räkneverken ur urnan och de sparade bidragen: varje bidrag prövat mot
 * summan, alla bidrag kombinerade, den diskreta logaritmen med taket och
 * kravet att räkneverken summerar till antalet rader. Se `completeTally`.
 */
async function countFromContributions(
  gate: { electionId: string; ballotId: string; optionCount: number },
  contributions: ReadonlyMap<number, PartialDecryption[]>,
): Promise<number[]> {
  const { sums, rows } = await sumOfUrn(gate.ballotId, gate.optionCount)

  for (const [trusteeIndex, partials] of contributions) {
    const trustee = await trusteeOf(gate.electionId, trusteeIndex)
    if (!trustee) {
      abort(`det finns ett bidrag från förtroendeperson ${trusteeIndex}, som inte har någon andel i omröstningen.`)
    }
    const expectedPublicShare = parsePublicShare(trustee)

    for (const [optionIndex, partial] of partials.entries()) {
      if (!verifyPartialDecryption(expectedPublicShare, sums[optionIndex]!, partial, bindingFor(gate, optionIndex))) {
        abort(
          `förtroendeperson ${trusteeIndex}:s sparade bidrag för alternativ ${optionIndex} håller inte mot ` +
            'hennes publika andel och valsedelns summa. Bidraget prövades innan det sparades, så ' +
            'bidraget eller urnan har skrivits eller ändrats förbi räkningen sedan dess. Ingenting är räknat.',
        )
      }
      await yieldToEventLoop()
    }
  }

  const counts: number[] = []
  for (const [optionIndex, sum] of sums.entries()) {
    const partials = [...contributions.values()].map((list) => list[optionIndex]!)
    const opened = combine(sum, partials)

    let count: number
    try {
      count = discreteLog(opened, rows)
    } catch {
      abort(
        `summan för alternativ ${optionIndex} ligger inte i [0, ${rows}]. Inget alternativ kan få fler ` +
          'röster än urnan har rader för valsedeln, så något i urnan eller i bidragen är fel. Ingenting är sparat.',
      )
    }
    counts.push(count)
  }

  requireSumOfCounts(counts, rows)
  return counts
}
