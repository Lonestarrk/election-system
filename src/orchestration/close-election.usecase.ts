import { Prisma } from '.prisma/votes'
import { hashLeaf, merkleRoot } from '@/lib/merkle'
import { verifyEncryptedBallotOnServer } from '@/lib/crypto/server'
import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { votesDb } from '@/modules/ballot-box/db'
import { votersDb } from '@/modules/eligibility/db'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import { closeStateOf } from '@/modules/eligibility/election.service'
import { clearPendingVotes } from '@/modules/eligibility/pending-vote.service'
import {
  readEnvelopes,
  validateEnvelopes,
  type ValidationReport,
} from './validate-before-close.usecase'

/**
 * SKALNINGEN: ATT TA BORT DET YTTRE KUVERTET.
 *
 * Ordningen är noga vald och kan inte kastas om.
 *
 *   1. läs kuverten EN gång och validera just den läsningen — avbryt vid avvikelse
 *   2. beräkna Merkleroten över kuverten (skrivs i steg 6, se nedan)
 *   3. verifiera varje valsedel EN GÅNG TILL
 *   4. infoga i votes_db, sorterat på chifferhash
 *   5. kontrollera att antalet stämmer
 *   6. först då, odelbart: skriv roten, radera exakt de flyttade kuverten,
 *      kontrollera att inget annat ligger kvar, växla fas
 *
 * Steg 1 är en SPÄRR, inte en rapport. Att skala ändå vore att kasta bort
 * bevismaterialet för det problem man just hittat: efter steg 6 finns ingen
 * väljare att fråga och ingen signatur att kontrollera.
 *
 * STEG 1 OCH 6 GÄLLER SAMMA RADER (granskningen av uppgift 14f, K1). Varje steg
 * efter läsningen arbetar på just de rader som validerades. Stängningen läste
 * tidigare pending_vote en gång för det som flyttades och en gång till i
 * valideringen, och raderade sedan allt som låg på valsedlarna. En förfalskad
 * rad som fanns vid den första läsningen men inte vid den andra flyttades då
 * utan att ha validerats. Nu raderas kuverten efter id och chifferhash, och
 * antalet raderade ska vara antalet flyttade innan transaktionen får gå
 * igenom. Se `readEnvelopes` och `EnvelopesChangedError`.
 *
 * Steg 2 MÅSTE ligga före steg 6. Merkleroten över (ciphertextHash,
 * bankIdSignature) är det enda som överlever raderingen av signaturerna:
 * beräknas den efter raderingen finns ingenting att beräkna den över. Den är
 * ett åtagande om exakt den mängd kuvert som fanns när valet stängde — läggs
 * ett kuvert till, ändras eller försvinner efteråt blir roten en annan. Roten
 * avslöjar ingenting själv; den är en hash.
 *
 * VAD ROTEN INTE GER, så att ingen bygger vidare på ett löfte som inte finns:
 * en väljare kan i dag inte visa att just hennes kuvert ingick. Det kräver en
 * inklusionsväg — syskonhasharna upp genom trädet — och `merkle.ts` varken
 * lagrar eller exporterar någon sådan. Efter skalningen är dessutom
 * signaturerna borta, så ingen utomstående kan räkna om roten alls.
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
 * Vad som är känt om kopplingen mellan väljare och röst när stängningen
 * avbrutits.
 *
 * `untouched` — kontrollerat: ingenting är raderat, och det går att säga rakt
 *   ut. Så är det på varje väg som bryter FÖRE transaktionen, på den väg där
 *   efterkontrollen visar att transaktionen rullade tillbaka, och när
 *   transaktionen själv avbröt för att kuverten ändrats medan stängningen
 *   pågick och fasen efteråt står kvar i OPEN (se `settleChangedEnvelopes`).
 *
 * `unknown` — OKONTROLLERAT. Transaktionen kan ha commitat; vi kunde bara inte
 *   läsa tillbaka utfallet. Det enda ärliga beskedet är att stängningen KAN ha
 *   gått igenom.
 */
export type LinkState = 'untouched' | 'unknown'

/**
 * Stängningen bröts, och felet BÄR sitt eget säkerhetspåstående.
 *
 * VARFÖR EN EGEN FELTYP OCH INTE EN NY GREN I `CloseOutcome`.
 *
 * Samma resonemang som när efterkontrollen infördes: varje gren i
 * `CloseOutcome` beskriver ett begripligt tillstånd hos OMRÖSTNINGEN — för
 * tidigt, redan stängd, en avvikelse att utreda — och rutten har ett eget svar
 * för var och en. Ett brutet antagande om systemet självt är inte ett sådant
 * tillstånd. Det som däremot ändrades i fixrunda 3 är att de brutna
 * antagandena inte längre är utbytbara: "ingenting är raderat" och "jag vet
 * inte om något raderats" är två olika besked till en administratör, och
 * skillnaden måste bäras av felet självt — rutten kan inte gissa den ur en
 * felsträng.
 *
 * Att låta fältet vara `unknown` som förval för allt ANNAT som kastar är
 * avsiktligt försiktigt: påståendet "ORÖRD" ska bara ges där koden vet det.
 */
export class CloseAbortedError extends Error {
  readonly linkState: LinkState

  constructor(linkState: LinkState, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CloseAbortedError'
    this.linkState = linkState
  }
}

/**
 * Vad som är känt om kopplingen efter ett kast.
 *
 * Allt som INTE är en `CloseAbortedError` räknas som `unknown`: påståendet att
 * ingenting raderats får bara ges där koden vet det.
 *
 * Fältet hör hemma i svaret, inte bara i prosan — en klient som grenar på
 * status behöver veta om den får köra om utan att först titta i databasen, och
 * den frågan besvaras av just det här.
 */
export function linkStateOf(error: unknown): LinkState {
  return error instanceof CloseAbortedError ? error.linkState : 'unknown'
}

/**
 * Beskedet som ska visas när stängningen kastat.
 *
 * Bor här och inte i rutten: det är ett påstående om vad som hänt med
 * kopplingen mellan väljare och röst, alltså en domänfråga, och det är den
 * enda platsen där påståendets sanning går att härleda. Rutten väljer bara
 * statuskod.
 */
export function abortedMessageFor(error: unknown): string {
  const linkState = linkStateOf(error)

  if (linkState === 'untouched') {
    return (
      'Stängningen avbröts innan något raderades. Kopplingen mellan väljare och röst är ' +
      'ORÖRD, ingen röst är förlorad, och omröstningen kan stängas om när felet är utrett. ' +
      'Vad som gick fel framgår av serverloggen — svaret gissar medvetet inte.'
    )
  }

  return (
    'Stängningen kunde inte bekräftas. Den KAN ha gått igenom — kontrollera omröstningens ' +
    'fas innan du gör något annat. Står den i STRIPPED är kopplingen mellan väljare och röst ' +
    'raderad och stängningen klar; står den kvar i OPEN gick den inte igenom. En omkörning är ' +
    'ofarlig i båda fallen: en redan stängd omröstning svarar att den är stängd utan att röra ' +
    'någonting. Vad som gick fel framgår av serverloggen.'
  )
}

/**
 * Ett blad per kuvert.
 *
 * Bladet binder BÅDE hashen och signaturen: bara hashen hade låtit en signatur
 * bytas ut obemärkt, bara signaturen hade inte pekat ut vilken röst den hörde
 * till.
 */
export function envelopeLeaf(envelope: { ciphertextHash: string; bankIdSignature: string }): string {
  return hashLeaf(`${envelope.ciphertextHash}|${envelope.bankIdSignature}`)
}

/**
 * Kuvertroten.
 *
 * ORDNINGEN I TRÄDET ÄR LÖVHASHORDNING — INTE CHIFFERHASHORDNING.
 *
 * Det är `merkleRoot` som sorterar, och den sorterar på lövens egna
 * hashvärden (se resonemanget i `merkle.ts` om varför ordningen måste komma ur
 * innehållet). En försortering på chifferhash här hade därför inte haft någon
 * effekt alls på roten — men den stod i vägen som dokumentation: den som
 * bygger om trädet enligt beskrivningen "sorterat på chifferhash" parar ihop
 * löven i fel ordning och får en annan rot i så gott som varje val.
 *
 * DEN SOM RÄKNAR OM ROTEN gör alltså: ett löv per kuvert enligt
 * `envelopeLeaf`, och lämnar därefter både sortering och ihopparning åt
 * `merkleRoot`. Ordningen kuverten kommer i spelar ingen roll — vilket är hela
 * poängen: roten säger ingenting om i vilken ordning väljarna röstade.
 */
export function envelopeRootOf(
  envelopes: ReadonlyArray<{ ciphertextHash: string; bankIdSignature: string }>,
): string {
  return merkleRoot(envelopes.map(envelopeLeaf))
}

/**
 * Det skalningen behöver ur ett kuvert. Raderna kommer ur `readEnvelopes`, som
 * läser mer, eftersom valideringen prövar samma läsning.
 */
type Envelope = {
  id: string
  ballotId: string
  ciphertext: unknown
  proofs: unknown
  ciphertextHash: string
  bankIdSignature: string
}

/**
 * Har kopplingen redan raderats, att döma av fasen?
 *
 * I dag skrivs bara OPEN och STRIPPED, och STRIPPED bara i skalningens
 * transaktion, tillsammans med raderingen. Allt som inte är OPEN betyder
 * därför att kopplingen är raderad. Villkoret står på ett ställe, eftersom både
 * förberedelsen och transaktionens avbrott avgör `already_closed` med det.
 * Uppgift 11d skriver CLOSED och VALIDATED före skalningen, och då ska svaret
 * bli STRIPPED eller senare, här och ingen annanstans.
 */
function linkAlreadyCleared(phase: string): boolean {
  return phase !== 'OPEN'
}

/**
 * Raderingen träffade inte exakt de kuvert som flyttats (granskningen av
 * uppgift 14f, K1).
 *
 * Två saker kan ha hänt efter att kuverten lästes och validerades, och båda
 * betyder att det som raderas inte längre är det som flyttats:
 *
 *   `removed < moved`  ett kuvert som flyttats fanns inte kvar oförändrat. Det
 *                      har tagits bort, eller bytts ut, som när en väljare
 *                      ändrar sig i sista stund. Raderingen görs efter id och
 *                      chifferhash, så ett utbytt kuvert är inte längre samma.
 *   `left > 0`         ett kuvert har lagts till. Det är varken validerat eller
 *                      flyttat, och en radering som låtit det ligga kvar hade
 *                      gjort `already_closed` osant.
 *
 * Före rättelsen märktes ingetdera. Raderingen tog allt som låg på
 * valsedlarna, och en väljare som ändrade sig efter läsningen förlorade sin
 * nya röst medan den gamla räknades.
 *
 * KASTAS INIFRÅN TRANSAKTIONEN, FÖRE COMMIT. Prisma skickar då ingen COMMIT
 * utan rullar tillbaka och lämnar vidare just det här felet, så raderingen
 * försvinner tillsammans med roten, fasen och revisionsposten. Att det är en
 * egen klass gör att `closeElection` kan skilja det från ett fel vid COMMIT,
 * där ingen vet om transaktionen gick igenom.
 */
class EnvelopesChangedError extends Error {
  readonly moved: number
  readonly removed: number
  readonly left: number

  constructor(counts: { moved: number; removed: number; left: number }) {
    super(describeChangedEnvelopes(counts))
    this.name = 'EnvelopesChangedError'
    this.moved = counts.moved
    this.removed = counts.removed
    this.left = counts.left
  }
}

/**
 * Vad som hänt, i siffror, för loggen och för den som ska utreda. Texten säger
 * bara det som alltid är sant. Vad det betyder för kopplingen avgörs av
 * `settleChangedEnvelopes`, som läser fasen.
 */
function describeChangedEnvelopes({
  moved,
  removed,
  left,
}: {
  moved: number
  removed: number
  left: number
}): string {
  const rolledBack =
    'Transaktionen rullades tillbaka före COMMIT, så den här körningen har inte raderat något.'

  if (removed !== moved) {
    return (
      `Stängningen avbröts: ${moved} kuvert flyttades, men bara ${removed} av dem fanns kvar med ` +
      'samma innehåll när kopplingen skulle raderas. Resten har tagits bort eller bytts ut efter ' +
      `att kuverten lästes och validerades. ${rolledBack}`
    )
  }

  return (
    `Stängningen avbröts: ${left} kuvert i röstlängden lästes inte före valideringen. Kuvert ` +
    'som läggs till medan stängningen pågår är varken validerade eller flyttade. ' +
    rolledBack
  )
}

/** Vad en administratör kan vänta sig av en omkörning, när kopplingen är orörd. */
function afterChangedEnvelopes(change: EnvelopesChangedError): string {
  if (change.removed !== change.moved) {
    return (
      'Chiffren för alla flyttade kuvert ligger redan i röstdatabasen, så en omkörning stoppas ' +
      'av antalskontrollen tills det som saknas eller bytts ut är utrett.'
    )
  }
  return 'En omkörning validerar och flyttar också de tillkomna kuverten.'
}

/**
 * Vad ett `EnvelopesChangedError` betyder för kopplingen.
 *
 * Den här körningen raderade ingenting, eftersom transaktionen avbröt sig själv
 * före COMMIT. Men att raderingen inte träffade rätt kuvert kan ha två helt
 * olika orsaker, och bara fasen skiljer dem åt:
 *
 *   Fasen står kvar i OPEN. Någon har tagit bort, bytt ut eller lagt till ett
 *   kuvert medan stängningen pågick, och kopplingen ligger kvar. Det är en
 *   avvikelse att utreda, och beskedet är att kopplingen är orörd.
 *
 *   Fasen har lämnat OPEN. En annan stängning, till exempel efter ett
 *   dubbelklick, hann före och raderade kopplingen i sin egen transaktion.
 *   Kuverten saknades för att de redan var raderade. Då vore "orörd" falskt,
 *   och svaret är detsamma som för en omkörning.
 *
 * Går fasen inte att läsa vet vi inte vilket, och då blir beskedet det
 * försiktiga.
 */
async function settleChangedEnvelopes(
  electionId: string,
  change: EnvelopesChangedError,
): Promise<CloseOutcome> {
  let state
  try {
    state = await closeStateOf(electionId)
  } catch (error) {
    throw new CloseAbortedError(
      'unknown',
      `${change.message} Fasen gick sedan inte att läsa, så det går inte att säga om en annan ` +
        'stängning hunnit radera kopplingen.',
      { cause: error },
    )
  }

  if (state === null) {
    throw new CloseAbortedError(
      'unknown',
      `${change.message} Omröstningen fanns sedan inte längre i röstlängden.`,
    )
  }

  if (linkAlreadyCleared(state.phase)) return { status: 'already_closed' }

  throw new CloseAbortedError(
    'untouched',
    `${change.message} Fasen står kvar i OPEN, så kopplingen är orörd. ` +
      afterChangedEnvelopes(change),
  )
}

/**
 * Sorterar på chifferhash med samma jämförelse som `Array.prototype.sort` gör
 * på strängar.
 *
 * Avsiktligt INTE `localeCompare`: det som skrivs till databasen måste hamna i
 * en ordning som en observatör kan räkna fram igen utan att känna till
 * serverns språkinställning.
 *
 * Det här är den ENDA sorteringen i filen som har någon effekt. Roten sorterar
 * `merkleRoot` själv, på lövhashar — se `envelopeRootOf`.
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
 *
 * FUNKTIONEN HÄVDAR SIN EGEN FÖRUTSÄTTNING. Hela invarianten — att
 * primärnyckelns ordning är innehållets ordning — vilar på att indata är
 * gemen hex av fast längd. En kortare eller blandad sträng skulle ge id:n vars
 * lexikala ordning inte längre följer chifferhashens, och felet skulle inte
 * synas någonstans förrän någon läser tabellen sorterad och drar fel slutsats.
 */
export function idForEnvelope(ciphertextHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(ciphertextHash)) {
    throw new Error('Chifferhashen är inte 64 gemena hextecken — id:t kan inte härledas ur den.')
  }

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
 * Raden kommer direkt ur databasen, förbi varje Zod-schema. Verifieringen
 * tolkar därför själv varje tal strikt, och ett missformat eller förfalskat
 * chiffer pekar ut raden i stället för att krascha stängningen. Före
 * fixrunda 1 av uppgift 14b godkändes här en valsedel med +1000 för ett parti
 * och −999 för blankt, eftersom en negativ utmaning räknades som 1.
 * Verifieringen kan fortfarande kasta, på en trasig nyckel eller ett internt
 * fel, och `await` står innanför `try` av samma skäl som där: kastet kommer
 * som ett avvisat löfte.
 */
async function ballotVerifies(
  shape: { publicKey: string; optionCount: number },
  electionId: string,
  envelope: Envelope,
): Promise<boolean> {
  try {
    return await verifyEncryptedBallotOnServer(
      shape.publicKey,
      electionId,
      envelope.ballotId,
      shape.optionCount,
      {
        ciphertext: envelope.ciphertext as EncryptedBallot['ciphertext'],
        proofs: envelope.proofs as EncryptedBallot['proofs'],
        ciphertextHash: envelope.ciphertextHash,
      },
    )
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
  envelopes: readonly Envelope[],
): Promise<string | null> {
  const shapes = new Map<string, Awaited<ReturnType<typeof getEncryptedBallotShape>>>()

  for (const envelope of [...envelopes].sort(byCiphertextHash)) {
    let shape = shapes.get(envelope.ballotId)
    if (shape === undefined) {
      shape = await getEncryptedBallotShape(envelope.ballotId)
      shapes.set(envelope.ballotId, shape)
    }

    if (!shape || !(await ballotVerifies(shape, electionId, envelope))) {
      return envelope.ciphertextHash
    }
  }

  return null
}

/**
 * Vad förberedelsen kom fram till.
 *
 * Antingen är stängningen redan avgjord — för tidigt, redan stängd, en
 * avvikelse — eller så är allt klart för den oåterkalleliga transaktionen.
 */
type Preparation =
  | { kind: 'settled'; outcome: CloseOutcome }
  | {
      kind: 'ready'
      envelopeRoot: string
      moved: number
      /** Exakt de kuvert som validerades och flyttades. Bara dem raderar transaktionen. */
      envelopes: ReadonlyArray<{ id: string; ciphertextHash: string }>
    }

/**
 * Steg 1–5: allt som sker INNAN transaktionen.
 *
 * Utbruten ur `closeElection` för att gränsen mot transaktionen ska vara en
 * plats i koden och inte en överenskommelse — se `closeElection` för varför
 * den gränsen bestämmer vad som får sägas om kopplingen. Ingenting härifrån
 * skriver i röstlängden.
 */
async function prepareClose(electionId: string): Promise<Preparation> {
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
  if (linkAlreadyCleared(election.phase)) {
    return { kind: 'settled', outcome: { status: 'already_closed' } }
  }

  if (election.closesAt > new Date()) {
    return { kind: 'settled', outcome: { status: 'too_early', closesAt: election.closesAt } }
  }

  // --- 1. En läsning, och valideringen av just den, som spärr -------------
  /**
   * EN LÄSNING, OCH ALLT EFTER DEN ARBETAR PÅ DEN (granskningen av uppgift
   * 14f, K1).
   *
   * `envelopes` är de rader valideringen prövar. Roten, omverifieringen,
   * infogningen, antalskontrollen och raderingen använder samma rader och
   * läser aldrig pending_vote igen. Förut läste valideringen en gång till för
   * sig, och en rad som fanns vid den ena läsningen men inte vid den andra
   * flyttades utan att ha validerats. Det som ändras efter läsningen fångas i
   * stället av raderingen, som bara tar exakt de här raderna.
   */
  const snapshot = await readEnvelopes(electionId)
  const envelopes: readonly Envelope[] = snapshot.envelopes
  const ballotIds = snapshot.ballots.map((ballot) => ballot.id)

  const report = await validateEnvelopes(snapshot)

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
    if (broken !== null) {
      return { kind: 'settled', outcome: { status: 'invalid_ballot', ciphertextHash: broken } }
    }

    return { kind: 'settled', outcome: { status: 'validation_failed', summary: report.summary } }
  }

  // --- 2. Kuvertroten, medan signaturerna fortfarande finns ---------------
  /**
   * BERÄKNAS HÄR, SKRIVS SENARE — OCH BÅDA DELARNA ÄR KRAV.
   *
   * Beräkningen måste ske medan signaturerna finns: roten är det enda som
   * överlever raderingen, och efter steg 6 finns ingenting att räkna den över.
   * `envelopes` är läst ovan, alltså före varje skrivning.
   *
   * SKRIVNINGEN däremot hör hemma i samma transaktion som raderingen, och
   * skälet är ett krascherfönster som annars förstör roten permanent: kraschar
   * processen efter att kopplingen raderats men innan fasövergången skrivits,
   * står omröstningen kvar i OPEN utan ett enda `PendingVote`. En omkörning
   * läser då noll kuvert, passerar valideringen (noll rader ger noll
   * avvikelser) — och skulle med en tidig skrivning ha ersatt den äkta roten
   * med `envelopeRootOf([])` innan antalskontrollen hinner avbryta. Den
   * förlusten går inte att reparera: signaturerna är borta.
   *
   * Skrivningen är dessutom skriv-en-gång (`envelopeRoot: null` i villkoret),
   * så att inte heller en oförutsedd väg hit kan skriva över en publicerad
   * rot.
   */
  const envelopeRoot = envelopeRootOf(envelopes)

  // --- 3. Varje valsedel verifieras en gång till --------------------------
  const broken = await firstUnverifiableEnvelope(electionId, envelopes)
  if (broken !== null) {
    return { kind: 'settled', outcome: { status: 'invalid_ballot', ciphertextHash: broken } }
  }

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
    throw new CloseAbortedError(
      'untouched',
      `Stängningen avbröts: ${envelopes.length} kuvert skulle flyttas men ${moved} finns i ` +
        'röstdatabasen. Kopplingen är orörd.',
    )
  }

  return { kind: 'ready', envelopeRoot, moved, envelopes }
}

/**
 * Stänger omröstningen och skalar bort identitetslagret.
 *
 * ATT STÄNGNINGEN ÄR ETT ANROP OCH INTE EN TIDPUNKT ÄR AVSIKTLIGT — se
 * `Election.phase`s dokumentation i schemat: en klocka som går fel ändrar
 * beteendet tyst, medan en fasövergång är en händelse någon utfört.
 */
export async function closeElection(electionId: string): Promise<CloseOutcome> {
  /**
   * ALLT SOM KASTAR INUTI `prepareClose` LÄMNAR KOPPLINGEN BEVISBART ORÖRD.
   *
   * Det är en egenskap hos VAR I FLÖDET felet uppstod, inte hos vilken
   * funktion som råkade kasta — `prepareClose` läser, validerar, verifierar
   * och skriver till den anonyma sidan, men rör aldrig `pending_vote`. Därför
   * sätts påståendet här, på gränsen, i stället för vid varje enskilt
   * anropsställe. En uppräkning av anropsställen hade ruttnat vid nästa
   * ändring; gränsen gör det inte.
   *
   * GRÄNSEN ÄR `prepareClose`, INTE TRANSAKTIONEN. Det är anropet nedan som
   * drar den. En framtida rad som hamnar mellan det här catch-blocket och
   * `$transaction` ligger utanför skyddet: kastar den blir felet inte en
   * `CloseAbortedError`, och `linkStateOf` räknar det som `unknown`. Det felar
   * åt det försiktiga hållet och gör ingen skada — men ska en sådan rad få
   * säga "orörd" hör den hemma inuti `prepareClose`.
   *
   * Det spelar roll för att de vanligaste verkliga felen bor här — databasen
   * nere under valideringen är långt mer sannolikt än ett avbrott vid COMMIT.
   * Att ge det vanligaste felet det försiktiga "kan ha gått igenom" hade fått
   * en administratör att tveka i onödan just när systemet är som mest stressat.
   */
  let preparation: Preparation

  try {
    preparation = await prepareClose(electionId)
  } catch (error) {
    if (error instanceof CloseAbortedError) throw error

    throw new CloseAbortedError(
      'untouched',
      'Stängningen avbröts innan transaktionen inleddes. Kopplingen mellan väljare och röst ' +
        'är orörd.',
      { cause: error },
    )
  }

  if (preparation.kind === 'settled') return preparation.outcome

  const { envelopeRoot, moved, envelopes } = preparation

  /**
   * --- 6. Först nu raderas kopplingen mellan väljare och röst -------------
   *
   * DE TRE SKRIVNINGARNA ÄR ODELBARA, OCH DET ÄR INGEN DETALJ.
   *
   * Flytten mellan databaserna kan omöjligt vara en transaktion — men de här
   * tre ligger alla i röstlängden och kunde alltså vara det. Var de inte det
   * fanns ett fönster mellan raderingen och fasövergången där en krasch lämnar
   * omröstningen i OPEN utan kuvert: ett tillstånd en omkörning inte kan
   * skilja från "ingen har röstat", och som utan roten skriven här hade fått
   * omkörningen att publicera roten över en tom mängd.
   *
   * RADERINGEN TAR EXAKT DE FLYTTADE KUVERTEN, OCH ANTALET PRÖVAS FÖRE COMMIT
   * (granskningen av uppgift 14f, K1). Kuverten raderas efter id och
   * chifferhash, och antalet raderade ska vara antalet flyttade, med ingenting
   * kvar på omröstningens valsedlar. Varje avvikelse kastar inifrån
   * transaktionen, och då följer raderingen med i rollbacken. Se
   * `EnvelopesChangedError`.
   *
   * Revisionsposten ligger med inuti, efter fasövergången. En rollback tar
   * då posten med sig — en logg som påstår att kopplingen raderats när den
   * ligger kvar vore värre än ingen logg alls.
   */
  let cleared: number

  try {
    cleared = await votersDb.$transaction(
      async (tx) => {
        // Skriv-en-gång: en redan publicerad rot får aldrig ersättas.
        // `updateMany` och inte `update`, eftersom en träfflös `update` kastar
        // — här ska en redan satt rot hoppas över, inte fälla körningen.
        await tx.election.updateMany({
          where: { id: electionId, envelopeRoot: null },
          data: { envelopeRoot },
        })

        // Exakt de kuvert som validerades och flyttades, och inga andra.
        const { removed, left } = await clearPendingVotes(electionId, envelopes, tx)
        if (removed !== moved || left !== 0) {
          throw new EnvelopesChangedError({ moved, removed, left })
        }

        await tx.election.update({
          where: { id: electionId },
          data: { phase: 'STRIPPED', linkClearedAt: new Date() },
        })

        await recordAuditEvent(AUDIT_EVENTS.LINK_CLEARED, tx)

        return removed
      },
      /**
       * TIDSGRÄNSEN ÄR VALD, INTE ÄRVD (fixrunda 2, uppgift 11).
       *
       * Prismas standard är 5 sekunder, och `db.ts` sätter ingen
       * `transactionOptions`. Raderingen går över samtliga kuvert i
       * omröstningen, i omgångar om tusen — i ett riktigt val hundratusentals
       * rader — och den kan mycket väl ta längre tid än så. En P2028 hade
       * rullat tillbaka allt, men det är en felväg som inte fanns när
       * raderingen låg utanför en transaktion, och den ska inte uppstå av att
       * ingen valde något.
       *
       * Två minuter är tilltaget för att rymma en radering i den storleken
       * utan att vara obegränsat: en transaktion som hänger håller lås på
       * `pending_vote` och `election`, så den får inte tillåtas leva hur länge
       * som helst. `maxWait` är tiden att få en anslutning ur poolen, inte tid
       * i transaktionen.
       */
      { timeout: 120_000, maxWait: 20_000 },
    )
  } catch (error) {
    /**
     * TRANSAKTIONEN ÄR DÄR KUNSKAPEN TAR SLUT — MED ETT UNDANTAG.
     *
     * Ett kast här betyder oftast en rollback, alltså att ingenting raderats —
     * men inte alltid. En tappad anslutning i samma ögonblick som COMMIT
     * skickas ger samma undantag oavsett om servern hann genomföra den eller
     * inte, och den skillnaden går inte att läsa ur felet. Då är `unknown` det
     * enda ärliga svaret, även om det oftare är försiktigt än nödvändigt.
     *
     * Undantaget är `EnvelopesChangedError`. Det kastar transaktionen själv,
     * inifrån, och då skickar Prisma aldrig någon COMMIT utan rullar tillbaka
     * och lämnar vidare just det felet. Att den här körningen inte raderat
     * något är alltså känt. Om en annan körning har gjort det avgör fasen, se
     * `settleChangedEnvelopes`.
     */
    if (error instanceof EnvelopesChangedError) return settleChangedEnvelopes(electionId, error)

    throw new CloseAbortedError(
      'unknown',
      'Stängningen kunde inte bekräftas: transaktionen avbröts utan besked om den hann ' +
        'genomföras. Kontrollera omröstningens fas innan stängningen körs om.',
      { cause: error },
    )
  }

  /**
   * --- 7. STÄNGNINGEN KONTROLLERAR SITT EGET UTFALL ----------------------
   *
   * ATT SÄGA ATT KOPPLINGEN ÄR RADERAD ÄR DET MEST KONSEKVENSRIKA BESKED
   * SYSTEMET KAN GE. Det måste vara kontrollerat, aldrig antaget.
   *
   * Bakgrunden är konkret (fixrunda 2): en revisionsskrivning som fallerade
   * inuti transaktionen sveptes undan av `recordAuditEvent`s svälj-gren.
   * Callbacken returnerade normalt, PostgreSQL gjorde om COMMIT till ROLLBACK
   * utan att fela, och `$transaction` RESOLVADE — varpå den här funktionen
   * svarade `closed` medan kuverten låg kvar, roten var oskriven och fasen
   * stod i OPEN. Administratören fick veta att valhemligheten uppstått när den
   * inte hade det.
   *
   * `recordAuditEvent` kastar numera i det läget, men det rättar bara den
   * kända vägen. Den här kontrollen stänger hela klassen: vilken framtida väg
   * som helst som får transaktionen att tyst rulla tillbaka fångas här, av att
   * det påstådda tillståndet inte finns i databasen.
   *
   * KASTAR I STÄLLET FÖR EN NY `CloseOutcome`-GREN. Varje gren i `CloseOutcome`
   * beskriver ett begripligt tillstånd hos omröstningen — för tidigt, redan
   * stängd, en avvikelse att utreda. "Skrivningen försvann utan att någon
   * felade" är inget sådant tillstånd; det är ett brutet antagande, samma sort
   * som antalskontrollen i steg 5 redan kastar på, och rutten har en gren som
   * svarar 409 med beskedet att kopplingen ligger kvar.
   */
  /**
   * LÄSNINGEN LIGGER EFTER COMMITEN, OCH DESS EGET FEL BETYDER NÅGOT HELT
   * ANNAT ÄN DESS SVAR (fixrunda 3).
   *
   * Fallerar den här läsningen — tappad anslutning, pool-timeout, en
   * omstart mellan COMMIT och SELECT — har transaktionen redan gått igenom
   * eller inte, och vi kan inte veta vilket. Att låta det felet falla i samma
   * gren som "kontrollen visade rollback" hade fått stängningen att påstå att
   * kopplingen är ORÖRD i ett läge där den mycket väl kan vara raderad. Det är
   * samma överdrivna löfte som resten av den här uppgiften handlat om, fast i
   * ett körtidsmeddelande i stället för i dokumentationen — och det visas för
   * en administratör i precis det ögonblick beskedet betyder som mest.
   *
   * Ingen dataförlust sker i något av fallen, och en omkörning är ofarlig: har
   * stängningen gått igenom står fasen i STRIPPED och nästa körning svarar
   * `already_closed`.
   */
  let after
  try {
    after = await closeStateOf(electionId)
  } catch (error) {
    throw new CloseAbortedError(
      'unknown',
      'Stängningen kunde inte bekräftas: transaktionen har skickats men utfallet gick inte ' +
        'att läsa tillbaka. Kontrollera omröstningens fas innan stängningen körs om.',
      { cause: error },
    )
  }

  /**
   * En försvunnen omröstning är inte heller ett kontrollerat "ingenting
   * hände" — raden fanns när transaktionen skickades, så dess frånvaro säger
   * ingenting om huruvida raderingen commitade.
   */
  if (after === null) {
    throw new CloseAbortedError(
      'unknown',
      'Stängningen kunde inte bekräftas: omröstningen finns inte längre i röstlängden.',
    )
  }

  if (after.phase !== 'STRIPPED' || after.envelopeRoot === null) {
    throw new CloseAbortedError(
      'untouched',
      'Stängningen gick inte igenom: skrivningarna i röstlängden finns inte kvar efter ' +
        `transaktionen (fas ${after.phase}, rot ${after.envelopeRoot === null ? 'oskriven' : 'skriven'}). ` +
        'Kopplingen mellan väljare och röst ligger kvar och stängningen kan köras om.',
    )
  }

  return { status: 'closed', moved, cleared, envelopeRoot }
}
