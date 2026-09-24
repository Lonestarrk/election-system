import { Prisma } from '.prisma/votes'
import { hashLeaf, merkleRoot } from '@/lib/merkle'
import { logger } from '@/lib/logger'
import { verifyEncryptedBallotOnServer } from '@/lib/crypto/server'
import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { votesDb } from '@/modules/ballot-box/db'
import { votersDb } from '@/modules/eligibility/db'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import { closeStateOf, type CloseState } from '@/modules/eligibility/election.service'
import {
  clearPendingVotes,
  markEnvelopesAsVoted,
} from '@/modules/eligibility/pending-vote.service'
import {
  ENVELOPE_READ_BATCH_SIZE,
  readEnvelopes,
  validateEnvelopes,
  type ValidationReport,
} from './validate-before-close.usecase'

/**
 * SKALNINGEN: ATT TA BORT DET YTTRE KUVERTET.
 *
 * Ordningen är noga vald och kan inte kastas om.
 *
 *   0. ta stängningens lås, så att bara en stängning kör åt gången
 *   1. skriv CLOSED, läs kuverten och validera just den läsningen, som spärr
 *   2. beräkna Merkleroten över kuverten (skrivs i steg 6, se nedan)
 *   3. verifiera varje valsedel EN GÅNG TILL
 *   4. skriv VALIDATED, ta bort rester i votes_db och infoga, sorterat på
 *      chifferhash
 *   5. läs tillbaka varje flyttat chiffer och kontrollera antalet
 *   6. först då, odelbart: skriv STRIPPED och roten, markera väljarna, radera
 *      exakt de flyttade kuverten och kontrollera att inget annat ligger kvar
 *
 * FASERNA ÄR TILLSTÅND (spec 6.1, uppgift 11d). Varje övergång är ett
 * jämför-och-sätt: en uppdatering med villkor på den fas raden står i, så att
 * ingen fas går baklänges. CLOSED skrivs innan kuverten läses, och från den
 * stunden tar läggningen inte emot något kuvert, inte heller om valideringen
 * hittar en avvikelse. VALIDATED skrivs när valideringen passerat, och STRIPPED
 * bara i transaktionen i steg 6. En omkörning från CLOSED eller VALIDATED går hela
 * vägen igen, eftersom en administratör som utrett en avvikelse kör om.
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
  | {
      status: 'closed'
      moved: number
      cleared: number
      envelopeRoot: string
      /**
       * Chifferhashen för varje chiffer i votes_db som togs bort före
       * infogningen, eftersom det inte hörde till något av de validerade
       * kuverten. Se `removeResidue`.
       */
      residueRemoved: string[]
    }
  | { status: 'too_early'; closesAt: Date }
  | { status: 'already_closed' }
  | { status: 'in_progress' }
  | { status: 'validation_failed'; summary: ValidationReport['summary'] }
  | { status: 'invalid_ballot'; ciphertextHash: string }

/**
 * Vad som är känt om kopplingen mellan väljare och röst när stängningen
 * avbrutits.
 *
 * `untouched` — kontrollerat: ingenting är raderat, och det går att säga rakt
 *   ut. Den här körningen har inte raderat något kuvert, och ingen annan
 *   stängning kan ha gjort det medan den hållit låset (se `withClosingLock`).
 *   Så är det på varje väg som bryter FÖRE transaktionen, på den väg där
 *   efterkontrollen visar att transaktionen rullade tillbaka, och när
 *   transaktionen själv avbröt och fasen efteråt visar att kopplingen finns
 *   kvar (se `settleRolledBack`).
 *
 * `unknown` — OKONTROLLERAT. Kopplingen kan vara raderad, av den här körningen
 *   eller av en annan. Transaktionen kan ha commitat utan att utfallet gick att
 *   läsa tillbaka, låset gick inte att ta eller gick förlorat, eller så stämmer
 *   inte fasen och kuvertroten med varandra. Det enda ärliga beskedet är att
 *   stängningen KAN ha gått igenom.
 */
export type LinkState = 'untouched' | 'unknown'

/**
 * Stängningen bröts, och felet BÄR sitt eget säkerhetspåstående.
 *
 * VARFÖR EN EGEN FELTYP OCH INTE EN NY GREN I `CloseOutcome`.
 *
 * Samma resonemang som när efterkontrollen infördes: varje gren i
 * `CloseOutcome` beskriver ett begripligt tillstånd hos OMRÖSTNINGEN — för
 * tidigt, redan stängd, en stängning som pågår, en avvikelse att utreda — och
 * rutten har ett eget svar för var och en. Ett brutet antagande om systemet
 * självt är inte ett sådant tillstånd. Det som däremot ändrades i fixrunda 3 är
 * att de brutna antagandena inte längre är utbytbara: "ingenting är raderat"
 * och "jag vet inte om något raderats" är två olika besked till en
 * administratör, och skillnaden måste bäras av felet självt — rutten kan inte
 * gissa den ur en felsträng.
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
 *
 * "INGET KUVERT", INTE "INGEN RÖST" (uppgift 11d). Före städningen av rester
 * sa beskedet att ingen röst var förlorad. En avbruten körning kan nu ha tagit
 * bort chiffer ur röstdatabasen, men bara chiffer som inte hörde till något av
 * de kuvert som ligger kvar, se `removeResidue`. Beskedet säger därför vad som
 * faktiskt är känt: att varje kuvert ligger kvar i röstlängden.
 */
export function abortedMessageFor(error: unknown): string {
  const linkState = linkStateOf(error)

  if (linkState === 'untouched') {
    return (
      'Stängningen avbröts innan något kuvert raderades. Kopplingen mellan väljare och röst är ' +
      'ORÖRD, och omröstningen kan stängas om när felet är utrett. Chiffer i röstdatabasen som ' +
      'inte hörde till något av de lästa kuverten kan ha tagits bort, och det står i ' +
      'serverloggen, liksom vad som gick fel — svaret gissar medvetet inte.'
    )
  }

  return (
    'Stängningen kunde inte bekräftas. Den KAN ha gått igenom — kontrollera omröstningens fas ' +
    'och kuvertrot innan du gör något annat. Står fasen i STRIPPED eller en senare fas är ' +
    'kopplingen mellan väljare och röst raderad och stängningen klar. Står den i OPEN, CLOSED ' +
    'eller VALIDATED med kuvertroten oskriven gick den inte igenom. Är roten skriven fast fasen ' +
    'står före STRIPPED har kopplingen raderats en gång, och någon har skrivit i röstlängden ' +
    'förbi stängningen. En omkörning är ofarlig i alla tre fallen: den rör ingenting i en ' +
    'omröstning där kopplingen redan är raderad. Vad som gick fel framgår av serverloggen.'
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
 * Faserna där kopplingen finns kvar, och faserna efter att den raderats
 * (spec 6.1).
 *
 * `already_closed` betyder fas STRIPPED eller senare, här och ingen
 * annanstans. STRIPPED skrivs bara i skalningens transaktion, tillsammans med
 * raderingen, och de senare faserna bara efter den. En omröstning i CLOSED
 * eller VALIDATED har kvar sina kuvert, och en omkörning ska ta dem. Fram till
 * uppgift 11d räknades allt som inte var OPEN som raderat, vilket stämde så
 * länge bara OPEN och STRIPPED skrevs.
 *
 * En fas som inte står i någon av listorna har skrivits förbi stängningen, och
 * då vet stängningen inte vad som gäller för kopplingen.
 */
const LINKED_PHASES: readonly string[] = ['OPEN', 'CLOSED', 'VALIDATED']
const CLEARED_PHASES: readonly string[] = ['STRIPPED', 'TALLIED', 'CERTIFIED']

function linkAlreadyCleared(phase: string): boolean {
  return CLEARED_PHASES.includes(phase)
}

function linkStillExists(state: CloseState): boolean {
  return LINKED_PHASES.includes(state.phase) && state.envelopeRoot === null
}

/**
 * Vad fasen och roten säger när de inte stämmer med varandra, eller fasen inte
 * är någon av specens. Alla utom det sista fallet kan bara komma av en
 * skrivning i röstlängden förbi stängningen: STRIPPED och roten skrivs i samma
 * sats, och ingenting annat skriver roten. En skriven rot betyder därför att
 * kopplingen raderats en gång, oavsett vad fasen säger.
 */
function describeUnexpectedState(state: CloseState): string {
  const linked = LINKED_PHASES.includes(state.phase)
  const cleared = CLEARED_PHASES.includes(state.phase)

  if (!linked && !cleared) {
    return (
      `Fasen står i ${state.phase}, som inte är någon av specens faser, så det går inte att ` +
      'säga om kopplingen raderats.'
    )
  }
  if (linked) {
    return (
      `Kuvertroten är skriven fast fasen står i ${state.phase}. Roten skrivs bara i skalningens ` +
      'transaktion, tillsammans med raderingen, så kopplingen har raderats en gång, och någon har ' +
      'skrivit i röstlängden förbi stängningen. Ingenting raderas nu.'
    )
  }
  if (state.envelopeRoot === null) {
    return (
      `Fasen står i ${state.phase} men kuvertroten är oskriven. STRIPPED skrivs bara tillsammans ` +
      'med roten, så någon har skrivit i röstlängden förbi stängningen.'
    )
  }
  return (
    `Fasen står i ${state.phase} och kuvertroten är skriven, så kopplingen är raderad, men fasen ` +
    'hade redan gått vidare när stängningen läste den.'
  )
}

/**
 * STÄNGNINGENS LÅS: BARA EN STÄNGNING ÅT GÅNGEN (uppgift 11d).
 *
 * VARFÖR ETT LÅS OCH INTE BARA JÄMFÖR-OCH-SÄTT. Städningen av rester i steg 4
 * tar bort chiffer ur votes_db, och fasen den villkoras på ligger i
 * röstlängden. Ett villkor i den ena databasen kan inte vara odelbart med en
 * radering i den andra. Omgranskningen av 14f visade vad det ger: en stängning
 * som läser kuverten efter att en annan skalat ser en tom läsning och tar bort
 * allt den andra just flyttat, när kopplingen redan är borta. Jämför-och-sätt på
 * fasen stoppar två stängningar från att båda skala, men inte från att den
 * ena städar medan den andra skalar. Låset gör att de inte kan köra samtidigt
 * alls, och att allt som kastar före transaktionen lämnar kopplingen orörd av
 * ett enkelt skäl: ingen annan stängning kan ha rört den under tiden.
 * Övergångarna är ändå jämför-och-sätt, så att en fas inte går baklänges om
 * låset en dag inte håller.
 *
 * VARFÖR I DATABASEN. Flera stängningar kan köra i olika processer, så minnet i
 * en process räcker inte. Låset är ett advisory lock i röstlängden, bundet till
 * en transaktion som bara finns för att hålla det. Dör processen stängs
 * anslutningen, och PostgreSQL släpper låset av sig själv, så ett lås kan aldrig
 * bli kvar efter en krasch. Nyckeln är 64 bitar ur md5 av omröstningens id, så
 * två omröstningar delar lås bara vid en krock i 64 bitar.
 *
 * `pg_try_advisory_xact_lock` VÄNTAR INTE. En andra stängning, till exempel efter
 * ett dubbelklick, får svaret att en stängning pågår, i stället för att vänta i
 * timmar på en stor validering.
 *
 * VAD SOM HÄNDER OM LÅSET GÅR FÖRLORAT. Transaktionen som håller låset har en
 * tidsgräns, och en anslutning kan tappas. Då släpps låset, men stängningen
 * märker det inte av sig själv. Den frågar därför transaktionen, med
 * `stillHeld`, precis före de två steg låset skyddar: städningen av rester och
 * skalningens transaktion. Har låset gått förlorat avbryts stängningen, och
 * beskedet om kopplingen kommer då ur fasen, inte ur låset.
 *
 * Går låset förlorat just efter en sådan fråga finns ett kort fönster, och så
 * här långt räcker skydden där. Skalningens transaktion låser omröstningens rad
 * i sin första sats, så en annan stängnings övergång till VALIDATED, och
 * därmed dess städning, väntar tills skalningen är klar och ser då STRIPPED,
 * se `closeUnderLock`. Städningen här är några satser, och en stängning som
 * tagit över låset måste först läsa och validera kuverten innan den infogar
 * något. För att den här städningen ändå ska ta bort något den andra flyttat
 * krävs dessutom ett kuvert som skrivits direkt i röstlängden efter den här
 * läsningen, och den andras återläsning märker det om raderingen hinner före
 * den.
 */
type ClosingLock = { stillHeld: () => Promise<boolean> }

/**
 * Tidsgränsen för låsets transaktion. Valideringen hashar ett personnummer per
 * väljare med scrypt, 37 ms, och verifierar bevisen två gånger, så ett stort
 * val kan ta timmar att stänga. Låset får inte gå ut under tiden.
 */
const CLOSING_LOCK_TIMEOUT_MS = 6 * 60 * 60 * 1000

type LockedRun<T> = { taken: false } | { taken: true; value: T }

async function withClosingLock<T>(
  electionId: string,
  run: (lock: ClosingLock) => Promise<T>,
): Promise<LockedRun<T>> {
  const holder: { result?: { value: T } | { error: unknown } } = {}

  try {
    await votersDb.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(
            ('x' || substr(md5(${`close-election:${electionId}`}), 1, 16))::bit(64)::bigint
          ) AS locked`
        if (row?.locked !== true) return

        const lock: ClosingLock = {
          stillHeld: async () => {
            try {
              await tx.$queryRaw`SELECT 1`
              return true
            } catch {
              return false
            }
          },
        }

        try {
          holder.result = { value: await run(lock) }
        } catch (error) {
          holder.result = { error }
        }
      },
      { timeout: CLOSING_LOCK_TIMEOUT_MS, maxWait: 20_000 },
    )
  } catch (lockError) {
    /**
     * Låsets egen transaktion skriver ingenting. Föll den innan stängningen
     * kört vet vi bara att ingenting gjordes här, inte om en annan stängning
     * pågår. Föll den efteråt, när den skulle avslutas, har stängningen redan
     * svarat med ett utfall den själv kontrollerat, och det gäller.
     */
    if (holder.result === undefined) {
      throw new CloseAbortedError(
        'unknown',
        'Stängningen kunde inte ta sitt lås i röstlängden och har inte gjort något. En annan ' +
          'stängning kan pågå eller ha gått igenom under tiden.',
        { cause: lockError },
      )
    }
    logger.warn('Stängningens lås släpptes inte som vanligt efter stängningen', {
      reason: lockError instanceof Error ? lockError.message : String(lockError),
    })
  }

  if (holder.result === undefined) return { taken: false }
  if ('error' in holder.result) throw holder.result.error
  return { taken: true, value: holder.result.value }
}

/**
 * Raderingen träffade inte exakt de kuvert som flyttats, eller markeringarna
 * stämde inte (granskningen av uppgift 14f, K1, och uppgift 11d).
 *
 * Flera saker kan ha hänt efter att kuverten lästes och validerades, och alla
 * betyder att det som raderas inte längre är det som flyttats:
 *
 *   `removed < moved`  ett kuvert som flyttats fanns inte kvar oförändrat. Det
 *                      har tagits bort, eller bytts ut, direkt i databasen.
 *                      Raderingen görs efter id och chifferhash, så ett utbytt
 *                      kuvert är inte längre samma.
 *   `left > 0`         ett kuvert har lagts till direkt i databasen. Det är
 *                      varken validerat eller flyttat, och en radering som
 *                      låtit det ligga kvar hade gjort `already_closed` osant.
 *   markeringarna      en markering "har röstat" fanns redan på valsedlarna,
 *                      skriven förbi stängningen, så att antalet markeringar
 *                      inte är antalet flyttade kuvert.
 *
 * Före rättelsen i 14f märktes inget av de två första. Raderingen tog allt som
 * låg på valsedlarna, och en väljare som ändrade sig efter läsningen förlorade
 * sin nya röst medan den gamla räknades. Sedan uppgift 11d kan en väljare inte
 * längre lägga eller byta ett kuvert efter att kuverten lästs, eftersom
 * stängningen skriver CLOSED först och läggningen prövar fasen i samma
 * transaktion som den skriver.
 *
 * KASTAS INIFRÅN TRANSAKTIONEN, FÖRE COMMIT. Prisma skickar då ingen COMMIT
 * utan rullar tillbaka och lämnar vidare just det här felet, så raderingen
 * försvinner tillsammans med roten, fasen, markeringarna och revisionsposten.
 * Att det är en egen klass gör att `closeElection` kan skilja det från ett fel
 * vid COMMIT, där ingen vet om transaktionen gick igenom.
 */
class EnvelopesChangedError extends Error {
  readonly moved: number
  readonly removed: number
  readonly left: number
  readonly marked: number
  readonly markersMatch: boolean

  constructor(counts: {
    moved: number
    removed: number
    left: number
    marked: number
    markersMatch: boolean
  }) {
    super(describeChangedEnvelopes(counts))
    this.name = 'EnvelopesChangedError'
    this.moved = counts.moved
    this.removed = counts.removed
    this.left = counts.left
    this.marked = counts.marked
    this.markersMatch = counts.markersMatch
  }
}

/**
 * Omröstningen stod inte i VALIDATED med oskriven rot när skalningen skulle
 * skriva STRIPPED. Jämför-och-sätt på fasen, kastat inifrån transaktionen som
 * `EnvelopesChangedError`, och med samma följd: ingenting av transaktionen
 * finns kvar. Under låset kan det bara hända om någon skrivit i röstlängden
 * förbi stängningen, eller om låset gått förlorat.
 */
class PhaseMovedError extends Error {
  constructor() {
    super(
      'Stängningen avbröts: omröstningen stod inte längre i VALIDATED med oskriven kuvertrot när ' +
        'kopplingen skulle raderas. Transaktionen rullades tillbaka före COMMIT, så den här ' +
        'körningen har inte raderat något.',
    )
    this.name = 'PhaseMovedError'
  }
}

/**
 * Vad som hänt, i siffror, för loggen och för den som ska utreda. Texten säger
 * bara det som alltid är sant. Vad det betyder för kopplingen avgörs av
 * `settleRolledBack`, som läser fasen.
 */
function describeChangedEnvelopes({
  moved,
  removed,
  left,
  marked,
  markersMatch,
}: {
  moved: number
  removed: number
  left: number
  marked: number
  markersMatch: boolean
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

  if (left !== 0) {
    return (
      `Stängningen avbröts: ${left} kuvert i röstlängden lästes inte före valideringen. Kuvert ` +
      'som läggs till medan stängningen pågår är varken validerade eller flyttade. ' +
      rolledBack
    )
  }

  return (
    `Stängningen avbröts: ${moved} kuvert flyttades, men markeringarna "har röstat" stämmer inte ` +
    `med dem. ${marked} markeringar skrevs${markersMatch ? '' : ', och antalet på någon valsedel är inte antalet flyttade kuvert där'}. ` +
    'En markering som fanns före skalningen har skrivits förbi stängningen. ' +
    rolledBack
  )
}

/** Vad en administratör kan vänta sig av en omkörning, när kopplingen är orörd. */
function afterChangedEnvelopes(change: EnvelopesChangedError | PhaseMovedError): string {
  if (change instanceof PhaseMovedError) {
    return 'En omkörning läser fasen på nytt och fortsätter bara från CLOSED eller VALIDATED.'
  }
  if (change.removed !== change.moved) {
    return (
      'Chiffren för de flyttade kuverten ligger kvar i röstdatabasen. En omkörning validerar de ' +
      'kuvert som ligger kvar och tar först bort de chiffer som inte hör till något av dem.'
    )
  }
  if (change.left !== 0) return 'En omkörning validerar och flyttar också de tillkomna kuverten.'
  return (
    'Markeringarna som fanns före skalningen behöver utredas och tas bort, och tills dess stoppas ' +
    'varje omkörning av samma kontroll.'
  )
}

/**
 * Vad ett avbrott inifrån transaktionen betyder för kopplingen.
 *
 * Den här körningen raderade ingenting, eftersom transaktionen avbröt sig själv
 * före COMMIT. Om kopplingen ändå är raderad avgör fasen och roten, inte
 * låset: under låset kan ingen annan stängning ha skalat, men det här är sista
 * platsen där den som skrivit förbi stängningen kan märkas.
 *
 *   Fasen står i OPEN, CLOSED eller VALIDATED och roten är oskriven.
 *   Kopplingen ligger kvar, och beskedet är att den är orörd.
 *
 *   Fasen står i STRIPPED eller senare. Kopplingen är raderad, och svaret är
 *   detsamma som för en omkörning.
 *
 * Går fasen inte att läsa, eller stämmer den inte med roten, blir beskedet det
 * försiktiga.
 */
async function settleRolledBack(
  electionId: string,
  change: EnvelopesChangedError | PhaseMovedError,
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

  if (!linkStillExists(state)) {
    throw new CloseAbortedError('unknown', `${change.message} ${describeUnexpectedState(state)}`)
  }

  throw new CloseAbortedError(
    'untouched',
    `${change.message} Fasen står i ${state.phase} och kuvertroten är oskriven, så kopplingen är ` +
      `orörd. ${afterChangedEnvelopes(change)}`,
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
 * Hur många rader i votes_db som läses per fråga när resterna letas upp. Bara
 * id och chifferhash läses, så omgångarna kan vara stora.
 */
const RESIDUE_READ_BATCH_SIZE = 5_000

/** Hur många rester som raderas per sats, en parameter per chifferhash. */
const RESIDUE_DELETE_BATCH_SIZE = 1_000

/**
 * Tar bort chiffer i votes_db som inte hör till något av de validerade kuverten
 * (uppgift 11d, ruling 115).
 *
 * VARFÖR. Infogningen sker före transaktionen i röstlängden, eftersom flytten
 * går över en databasgräns. Tas ett kuvert bort eller byts ut efter läsningen
 * avbryts transaktionen, men chiffret ligger redan i votes_db. Fram till 11d
 * stoppade antalskontrollen sedan varje omkörning, eftersom den läste färre
 * kuvert än det fanns chiffer, tills någon städade för hand. Den som kunde
 * skriva i databasen kunde alltså låsa ett val.
 *
 * VAD SOM TAS BORT. Exakt de rader i encrypted_vote på omröstningens valsedlar
 * vars chifferhash inte finns i den nyss validerade läsningen. Ett sådant
 * chiffer har inget kuvert i den läsningen och får inte räknas: det är kvar
 * från en körning som avbrutits sedan kuvertet tagits bort eller bytts ut,
 * eller skrivet direkt i röstdatabasen. Låg det kvar skulle det räknas med i
 * summan, och därför stoppade antalskontrollen stängningen. En rad vars hash
 * finns i läsningen men vars innehåll skiljer sig tas däremot inte bort: den
 * hittas av återläsningen i steg 5 och stoppar stängningen, så att den kan
 * utredas.
 *
 * NÄR. Bara under stängningens lås, bekräftat precis före, och direkt efter att
 * fasen satts till VALIDATED med jämför-och-sätt från CLOSED eller VALIDATED med
 * oskriven rot. Fasen är alltså skild från STRIPPED och roten null när
 * raderingen görs, och ingen annan stängning kan skala under tiden. Det är de
 * villkor omgranskningen av 14f satte: utan dem kunde städningen se en tom
 * läsning och ta bort det en annan stängning just flyttat.
 *
 * Antalet loggas, och chifferhasharna står i stängningens svar till
 * administratören. Loggen maskerar chifferhashar, så de står inte där.
 */
async function removeResidue(ballotIds: string[], envelopes: readonly Envelope[]): Promise<string[]> {
  if (ballotIds.length === 0) return []

  const validated = new Set(envelopes.map((envelope) => envelope.ciphertextHash))
  const residue: string[] = []
  let after: string | null = null

  for (;;) {
    const batch: Array<{ id: string; ciphertextHash: string }> = await votesDb.encryptedVote.findMany({
      where: { ballotId: { in: ballotIds }, ...(after === null ? {} : { id: { gt: after } }) },
      orderBy: { id: 'asc' },
      take: RESIDUE_READ_BATCH_SIZE,
      select: { id: true, ciphertextHash: true },
    })
    for (const row of batch) {
      if (!validated.has(row.ciphertextHash)) residue.push(row.ciphertextHash)
    }
    if (batch.length < RESIDUE_READ_BATCH_SIZE) break
    after = batch[batch.length - 1]!.id
  }

  let removed = 0
  for (let start = 0; start < residue.length; start += RESIDUE_DELETE_BATCH_SIZE) {
    const result = await votesDb.encryptedVote.deleteMany({
      where: {
        ballotId: { in: ballotIds },
        ciphertextHash: { in: residue.slice(start, start + RESIDUE_DELETE_BATCH_SIZE) },
      },
    })
    removed += result.count
  }

  if (residue.length > 0) {
    logger.warn('Stängningen tog bort rester i röstdatabasen: chiffer utan något validerat kuvert', {
      found: residue.length,
      removed,
    })
  }

  return residue.sort()
}

/**
 * Samma innehåll, tecken för tecken, som databasen lämnar tillbaka det.
 *
 * Båda sidor är jsonb, som lagrar nycklarna i en fast ordning, och Prisma
 * tolkar texten PostgreSQL skickar. Samma värde ger därför samma serialisering
 * här, och ett annat värde ger en annan. Det som jämförs är alltså exakt det
 * valideringen prövade och det räkningen senare läser.
 */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Steg 5: det som ligger i urnan är exakt det som validerades (uppgift 11d,
 * ruling 118).
 *
 * VARFÖR ANTALET INTE RÄCKTE. Infogningen hoppar över en rad vars chifferhash
 * redan finns. Den som kan skriva i votes_db kunde före infogningen lägga en
 * rad med ett äkta kuverts hash men ett annat chiffer, och stängningen, som
 * bara räknade raderna, svarade `closed` fast urnans chiffer inte gav sin egen
 * hash.
 *
 * Varje flyttat kuvert läses därför tillbaka, i omgångar, och ska finnas med
 * samma valsedel, samma chiffer och samma bevis som i den validerade läsningen.
 * Antalet rader på omröstningens valsedlar ska dessutom vara antalet flyttade,
 * så att ingenting finns där som inte validerades. Svaret är null när allt
 * stämmer, annars en beskrivning för loggen.
 *
 * Det här stänger bytet FÖRE infogningen. Efter stängningen kontrollerar
 * ingenting urnan förrän uppgift 12b räknar om en urnrot, se posten
 * `votes-db-writer-can-swap-ciphertext` i src/lib/known-limitations.ts.
 */
async function urnMismatch(ballotIds: string[], envelopes: readonly Envelope[]): Promise<string | null> {
  const onBallots = await votesDb.encryptedVote.count({ where: { ballotId: { in: ballotIds } } })

  let missing = 0
  let different = 0

  for (let start = 0; start < envelopes.length; start += ENVELOPE_READ_BATCH_SIZE) {
    const batch = envelopes.slice(start, start + ENVELOPE_READ_BATCH_SIZE)
    const stored = await votesDb.encryptedVote.findMany({
      where: { ciphertextHash: { in: batch.map((envelope) => envelope.ciphertextHash) } },
      select: { ciphertextHash: true, ballotId: true, ciphertext: true, proofs: true },
    })
    const byHash = new Map(stored.map((row) => [row.ciphertextHash, row]))

    for (const envelope of batch) {
      const row = byHash.get(envelope.ciphertextHash)
      if (!row) {
        missing += 1
      } else if (
        row.ballotId !== envelope.ballotId ||
        !sameJson(row.ciphertext, envelope.ciphertext) ||
        !sameJson(row.proofs, envelope.proofs)
      ) {
        different += 1
      }
    }
  }

  if (onBallots === envelopes.length && missing === 0 && different === 0) return null

  return (
    `Stängningen avbröts: ${envelopes.length} kuvert skulle flyttas, och ${onBallots} chiffer finns ` +
    `på omröstningens valsedlar i röstdatabasen. ${missing} av de flyttade saknas där, och ` +
    `${different} finns där med en annan valsedel, ett annat chiffer eller andra bevis än det ` +
    'som validerades.'
  )
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
      ballotIds: string[]
      /** Hur många kuvert som flyttades per valsedel. Så många markeringar ska det bli. */
      movedByBallot: Map<string, number>
      /** Exakt de kuvert som validerades och flyttades. Bara dem raderar transaktionen. */
      envelopes: ReadonlyArray<{ id: string; ciphertextHash: string }>
      residueRemoved: string[]
    }

/**
 * Den här körningen avbryts i förberedelsen och har inte raderat något kuvert.
 * Vad får sägas om kopplingen?
 *
 * FASEN LÄSES INNAN "ORÖRD" SÄGS (uppgift 11d). Granskningen av 14f visade en
 * andra stängning som läste fasen före den förstas COMMIT och kuverten efter,
 * och som sedan sa att kopplingen var orörd fast fasen var STRIPPED. Under
 * låset kan det inte längre hända, men påståendet görs ändå först när fasen
 * bekräftar det, som i `settleRolledBack`:
 *
 *   STRIPPED eller senare  kopplingen är raderad, och svaret är already_closed
 *   OPEN, CLOSED, VALIDATED med oskriven rot
 *                          kopplingen finns kvar, och den är orörd
 *   något annat            fasen och roten stämmer inte, och beskedet är det
 *                          försiktiga
 *
 * Går fasen inte att läsa avgör låset. Hålls det fortfarande kan ingen annan
 * stängning ha raderat kopplingen, och den här har inte gjort det. Har det
 * gått förlorat vet vi inte, och beskedet blir det försiktiga.
 */
async function settlePreparation(
  electionId: string,
  lock: ClosingLock,
  message: string,
  cause?: unknown,
): Promise<Preparation> {
  let state: CloseState | null
  try {
    state = await closeStateOf(electionId)
  } catch (error) {
    if (await lock.stillHeld()) {
      throw new CloseAbortedError(
        'untouched',
        `${message} Fasen gick inte att läsa, men stängningens lås hålls fortfarande, så ingen ` +
          'annan stängning kan ha raderat kopplingen. Kopplingen är orörd.',
        { cause: cause ?? error },
      )
    }
    throw new CloseAbortedError(
      'unknown',
      `${message} Varken fasen eller stängningens lås gick att läsa, så det går inte att säga om ` +
        'en annan stängning raderat kopplingen.',
      { cause: cause ?? error },
    )
  }

  if (state === null) {
    throw new CloseAbortedError('unknown', `${message} Omröstningen fanns sedan inte längre i röstlängden.`)
  }

  if (linkAlreadyCleared(state.phase)) return { kind: 'settled', outcome: { status: 'already_closed' } }

  if (!linkStillExists(state)) {
    throw new CloseAbortedError('unknown', `${message} ${describeUnexpectedState(state)}`, { cause })
  }

  throw new CloseAbortedError(
    'untouched',
    `${message} Fasen står i ${state.phase} och kuvertroten är oskriven, så kopplingen är orörd.`,
    { cause },
  )
}

/**
 * Är låset kvar? Annars avbryts stängningen, och beskedet kommer ur fasen.
 * Anropas precis före de två steg låset finns för, se `withClosingLock`.
 */
async function lockStillHeldOrSettle(
  electionId: string,
  lock: ClosingLock,
  step: string,
): Promise<Preparation | null> {
  if (await lock.stillHeld()) return null

  const lost: ClosingLock = { stillHeld: async () => false }
  return settlePreparation(
    electionId,
    lost,
    `Stängningen avbröts före ${step}: stängningens lås har gått förlorat, så en annan ` +
      'stängning kan ha startat.',
  )
}

/**
 * Steg 1–5: allt som sker INNAN transaktionen.
 *
 * Utbruten ur `closeElection` för att gränsen mot transaktionen ska vara en
 * plats i koden och inte en överenskommelse — se `closeElection` för varför
 * den gränsen bestämmer vad som får sägas om kopplingen. Ingenting härifrån
 * raderar ett kuvert. Det som skrivs i röstlängden är fasen, CLOSED och
 * VALIDATED, och i votes_db rester som tas bort och chiffer som infogas.
 */
async function prepareClose(electionId: string, lock: ClosingLock): Promise<Preparation> {
  /**
   * CLOSED, MED JÄMFÖR-OCH-SÄTT, INNAN NÅGOT ANNAT (uppgift 11d, punkt 1 och 5b).
   *
   * Fram till 11d stod fasen kvar i OPEN tills skalningen, och röster avvisades
   * efter closesAt bara av klockan. En röst vars fas prövades före stängningen
   * men som skrevs efter läsningen raderades då utan att flyttas, medan
   * väljaren fått beskedet att den var lagd. Nu skrivs CLOSED först, i en egen
   * skrivning, och läggningen prövar fasen i samma transaktion som den skriver
   * kuvertet, se `castEncryptedBallot`. Ett kuvert som läggs finns därför på
   * plats innan kuverten läses nedan, och inget kan läggas efter.
   *
   * Villkoret är en omröstning i OPEN, med oskriven rot och closesAt passerad.
   * Står den redan i CLOSED eller VALIDATED ändrar satsen ingenting, och
   * omkörningen fortsätter. Allt annat avgörs av läsningen efteråt.
   */
  const now = new Date()
  await votersDb.election.updateMany({
    where: { id: electionId, phase: 'OPEN', envelopeRoot: null, closesAt: { lte: now } },
    data: { phase: 'CLOSED' },
  })

  const election = await votersDb.election.findUniqueOrThrow({
    where: { id: electionId },
    select: { closesAt: true, phase: true, envelopeRoot: true },
  })

  /**
   * FASEN AVGÖR, INTE KLOCKAN — I DEN HÄR RIKTNINGEN.
   *
   * En omröstning i STRIPPED eller senare har redan skalats: kopplingen är
   * raderad och det finns ingenting kvar att flytta. Att i stället låta klockan
   * avgöra hade gjort en omkörning omöjlig att skilja från en
   * förstagångskörning.
   */
  if (linkAlreadyCleared(election.phase)) {
    return { kind: 'settled', outcome: { status: 'already_closed' } }
  }

  if (!linkStillExists(election)) {
    throw new CloseAbortedError(
      'unknown',
      `Stängningen avbröts innan den började. ${describeUnexpectedState(election)}`,
    )
  }

  if (election.phase === 'OPEN') {
    if (election.closesAt > now) {
      return { kind: 'settled', outcome: { status: 'too_early', closesAt: election.closesAt } }
    }
    return settlePreparation(
      electionId,
      lock,
      'Stängningen avbröts: omröstningen gick inte att föra från OPEN till CLOSED.',
    )
  }

  // --- 1. En läsning, och valideringen av just den, som spärr -------------
  /**
   * EN LÄSNING, OCH ALLT EFTER DEN ARBETAR PÅ DEN (granskningen av uppgift
   * 14f, K1).
   *
   * `envelopes` är de rader valideringen prövar. Roten, omverifieringen,
   * infogningen, återläsningen och raderingen använder samma rader och läser
   * aldrig pending_vote igen. Förut läste valideringen en gång till för sig,
   * och en rad som fanns vid den ena läsningen men inte vid den andra flyttades
   * utan att ha validerats. Det som ändras efter läsningen fångas i stället av
   * raderingen, som bara tar exakt de här raderna. Läsningen görs i omgångar,
   * se `readEnvelopes`.
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
     * administratören får veta. Fasen står kvar där den stod, CLOSED eller
     * VALIDATED, och går inte tillbaka.
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
   * `envelopes` är läst ovan, alltså före varje skrivning av kuverten.
   *
   * SKRIVNINGEN däremot hör hemma i samma transaktion som raderingen, och
   * skälet är ett krascherfönster som annars förstör roten permanent: kraschar
   * processen efter att kopplingen raderats men innan fasövergången skrivits,
   * står omröstningen kvar utan ett enda `PendingVote`. En omkörning läser då
   * noll kuvert, passerar valideringen (noll rader ger noll avvikelser) — och
   * skulle med en tidig skrivning ha ersatt den äkta roten med
   * `envelopeRootOf([])` innan antalskontrollen hinner avbryta. Den förlusten
   * går inte att reparera: signaturerna är borta.
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

  // --- 4. VALIDATED, resterna och infogningen i votes_db ------------------
  const lostBeforeResidue = await lockStillHeldOrSettle(electionId, lock, 'städningen av rester')
  if (lostBeforeResidue) return lostBeforeResidue

  /**
   * VALIDATED, MED JÄMFÖR-OCH-SÄTT, NÄR VALIDERINGEN PASSERAT (uppgift 11d).
   *
   * Från CLOSED eller VALIDATED, och bara med oskriven rot. En omkörning från
   * VALIDATED skriver samma fas igen, och en omkörning som stoppas av
   * valideringen lämnar VALIDATED som den är, eftersom ingen fas går
   * baklänges. VALIDATED betyder alltså att en validering har passerat, inte
   * att den senaste gjorde det. Skalningen kräver ändå att den egna
   * körningens validering passerat, eftersom den bara når hit i så fall.
   *
   * Villkoret är också villkoret för städningen nedan: fasen skild från
   * STRIPPED och roten null.
   */
  const validated = await votersDb.election.updateMany({
    where: { id: electionId, phase: { in: ['CLOSED', 'VALIDATED'] }, envelopeRoot: null },
    data: { phase: 'VALIDATED' },
  })
  if (validated.count !== 1) {
    return settlePreparation(
      electionId,
      lock,
      'Stängningen avbröts: omröstningen gick inte att föra till VALIDATED.',
    )
  }

  const residueRemoved = await removeResidue(ballotIds, envelopes)

  /**
   * `skipDuplicates` är idempotensen, och återläsningen i steg 5 är skyddet.
   *
   * Flytten går över en databasgräns och kan därför omöjligt vara en
   * transaktion. En körning som avbryts mellan infogningen och raderingen
   * lämnar chiffren på plats — och nästa körning ser dem som befintliga tack
   * vare det unika indexet på `ciphertextHash`, i stället för att skapa
   * dubbletter. Att en befintlig rad hoppas över betyder också att den som
   * skrivit en rad med samma hash före infogningen får sin rad kvar. Därför
   * läses varje flyttat chiffer tillbaka nedan.
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

  // --- 5. Urnan måste vara exakt det validerade FÖRE raderingen -----------
  const mismatch = await urnMismatch(ballotIds, envelopes)

  if (mismatch !== null) {
    /**
     * KASTAR I STÄLLET FÖR ATT RADERA.
     *
     * Kommer vi hit är det som ligger i urnan inte det som validerades. Att
     * ändå fortsätta till steg 6 vore att radera de enda kopior som finns av
     * de röster urnan saknar, eller att räkna något som inte validerats. Ett
     * undantag lämnar kopplingen orörd, och stängningen kan köras om när felet
     * är utrett.
     */
    return settlePreparation(electionId, lock, mismatch)
  }

  const lostBeforeStripping = await lockStillHeldOrSettle(electionId, lock, 'skalningen')
  if (lostBeforeStripping) return lostBeforeStripping

  const movedByBallot = new Map<string, number>()
  for (const envelope of envelopes) {
    movedByBallot.set(envelope.ballotId, (movedByBallot.get(envelope.ballotId) ?? 0) + 1)
  }

  return {
    kind: 'ready',
    envelopeRoot,
    moved: envelopes.length,
    ballotIds,
    movedByBallot,
    envelopes,
    residueRemoved,
  }
}

/**
 * Stänger omröstningen och skalar bort identitetslagret.
 *
 * ATT STÄNGNINGEN ÄR ETT ANROP OCH INTE EN TIDPUNKT ÄR AVSIKTLIGT — se
 * `Election.phase`s dokumentation i schemat: en klocka som går fel ändrar
 * beteendet tyst, medan en fasövergång är en händelse någon utfört.
 *
 * Bara en stängning av samma omröstning kör åt gången. En andra svarar
 * `in_progress` utan att röra något, se `withClosingLock`.
 */
export async function closeElection(electionId: string): Promise<CloseOutcome> {
  const locked = await withClosingLock(electionId, (lock) => closeUnderLock(electionId, lock))
  if (!locked.taken) return { status: 'in_progress' }
  return locked.value
}

async function closeUnderLock(electionId: string, lock: ClosingLock): Promise<CloseOutcome> {
  /**
   * ALLT SOM KASTAR INUTI `prepareClose` LÄMNAR KOPPLINGEN BEVISBART ORÖRD.
   *
   * Det är en egenskap hos VAR I FLÖDET felet uppstod, inte hos vilken
   * funktion som råkade kasta — `prepareClose` läser, validerar, verifierar
   * och skriver fasen och till den anonyma sidan, men rör aldrig
   * `pending_vote`. Och under stängningens lås kan ingen annan stängning ha
   * raderat kopplingen under tiden (uppgift 11d). Därför sätts påståendet här,
   * på gränsen, i stället för vid varje enskilt anropsställe. En uppräkning av
   * anropsställen hade ruttnat vid nästa ändring; gränsen gör det inte.
   *
   * Undantagen kastar redan en `CloseAbortedError` med `unknown` och släpps
   * igenom oförändrade: ett tillstånd där fasen och roten inte stämmer med
   * varandra, som bara uppstår av en skrivning förbi stängningen, och ett lås
   * som gått förlorat när fasen inte heller gick att läsa.
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
    preparation = await prepareClose(electionId, lock)
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

  const { envelopeRoot, moved, ballotIds, movedByBallot, envelopes, residueRemoved } = preparation

  /**
   * --- 6. Först nu raderas kopplingen mellan väljare och röst -------------
   *
   * SKRIVNINGARNA ÄR ODELBARA, OCH DET ÄR INGEN DETALJ.
   *
   * Flytten mellan databaserna kan omöjligt vara en transaktion — men de här
   * skrivningarna ligger alla i röstlängden och kunde alltså vara det. Var de
   * inte det fanns ett fönster mellan raderingen och fasövergången där en
   * krasch lämnar omröstningen utan kuvert: ett tillstånd en omkörning inte kan
   * skilja från "ingen har röstat", och som utan roten skriven här hade fått
   * omkörningen att publicera roten över en tom mängd.
   *
   * STRIPPED SKRIVS MED JÄMFÖR-OCH-SÄTT, SOM FÖRSTA SATS (uppgift 11d). Från
   * VALIDATED och bara med oskriven rot, så att två stängningar inte båda kan
   * skala och ingen fas går baklänges. Villkoret på roten är samtidigt
   * skriv-en-gång: en redan publicerad rot får aldrig ersättas. Satsen kommer
   * först, eftersom den låser omröstningens rad för resten av transaktionen.
   * Har stängningens lås gått förlorat efter den sista frågan om det, och en
   * annan stängning tagit över, väntar den andras övergång till VALIDATED, och
   * därmed dess städning av rester, tills den här transaktionen är klar, och
   * ser sedan STRIPPED. Att STRIPPED står före raderingen i texten spelar ingen
   * roll för utfallet: transaktionen blir synlig som en helhet vid COMMIT, eller
   * inte alls.
   *
   * MARKERINGEN "HAR RÖSTAT" SKRIVS UR DE KUVERT SOM RADERAS, FÖRE RADERINGEN
   * (spec 3.1 punkt 6). Se `markEnvelopesAsVoted`.
   *
   * RADERINGEN TAR EXAKT DE FLYTTADE KUVERTEN, OCH ANTALEN PRÖVAS FÖRE COMMIT
   * (granskningen av uppgift 14f, K1, och uppgift 11d). Kuverten raderas efter
   * id och chifferhash, och antalet raderade ska vara antalet flyttade, med
   * ingenting kvar på omröstningens valsedlar. Antalet markeringar ska vara
   * antalet flyttade, totalt och per valsedel. Varje avvikelse kastar inifrån
   * transaktionen, och då följer raderingen och markeringarna med i
   * rollbacken. Se `EnvelopesChangedError`.
   *
   * Revisionsposten ligger med inuti, sist. En rollback tar då posten med sig
   * — en logg som påstår att kopplingen raderats när den ligger kvar vore
   * värre än ingen logg alls.
   */
  let cleared: number

  try {
    cleared = await votersDb.$transaction(
      async (tx) => {
        const stripped = await tx.election.updateMany({
          where: { id: electionId, phase: 'VALIDATED', envelopeRoot: null },
          data: { phase: 'STRIPPED', linkClearedAt: new Date(), envelopeRoot },
        })
        if (stripped.count !== 1) throw new PhaseMovedError()

        // Markeringarna, ur exakt de kuvert som raderas, före raderingen.
        const { marked, markersByBallot } = await markEnvelopesAsVoted(electionId, envelopes, tx)

        // Exakt de kuvert som validerades och flyttades, och inga andra.
        const { removed, left } = await clearPendingVotes(electionId, envelopes, tx)

        const markersMatch =
          markersByBallot.every(({ ballotId, markers }) => markers === (movedByBallot.get(ballotId) ?? 0)) &&
          ballotIds.every((ballotId) => markersByBallot.some((entry) => entry.ballotId === ballotId))

        if (removed !== moved || left !== 0 || marked !== moved || !markersMatch) {
          throw new EnvelopesChangedError({ moved, removed, left, marked, markersMatch })
        }

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
     * Undantaget är `EnvelopesChangedError` och `PhaseMovedError`. Dem kastar
     * transaktionen själv, inifrån, och då skickar Prisma aldrig någon COMMIT
     * utan rullar tillbaka och lämnar vidare just det felet. Att den här
     * körningen inte raderat något är alltså känt. Vad det betyder för
     * kopplingen avgör fasen, se `settleRolledBack`.
     */
    if (error instanceof EnvelopesChangedError || error instanceof PhaseMovedError) {
      return settleRolledBack(electionId, error)
    }

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
   * stod kvar. Administratören fick veta att valhemligheten uppstått när den
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
   * som återläsningen i steg 5 redan kastar på, och rutten har en gren som
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

  if (after.phase === 'STRIPPED' && after.envelopeRoot !== null) {
    return { status: 'closed', moved, cleared, envelopeRoot, residueRemoved }
  }

  if (linkStillExists(after)) {
    throw new CloseAbortedError(
      'untouched',
      'Stängningen gick inte igenom: skrivningarna i röstlängden finns inte kvar efter ' +
        `transaktionen (fas ${after.phase}, rot oskriven). Kopplingen mellan väljare och röst ` +
        'ligger kvar och stängningen kan köras om.',
    )
  }

  throw new CloseAbortedError(
    'unknown',
    `Stängningen kunde inte bekräftas efter transaktionen. ${describeUnexpectedState(after)}`,
  )
}
