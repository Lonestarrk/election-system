import { Prisma } from '.prisma/votes'
import type { Prisma as VotersPrisma } from '.prisma/voters'
import { sha256Hex } from '@/lib/crypto'
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
 *   4. skriv VALIDATED, ta bort rester och ersätt förfalskade rader i
 *      votes_db, och infoga, sorterat på chifferhash
 *   5. läs tillbaka varje flyttat chiffer och kontrollera antalet
 *   6. först då, odelbart och i låsets transaktion: skriv STRIPPED och roten,
 *      markera väljarna, radera exakt de flyttade kuverten och kontrollera att
 *      inget annat ligger kvar
 *   7. efter låsets COMMIT: kontrollera att skalningen finns i röstlängden
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
 * dem som befintliga tack vare primärnyckeln: samma läsning ger samma
 * platser i urnan, se `withUrnIds`.
 *
 * SORTERINGEN PÅ INNEHÅLL är inte kosmetik. Skulle raderna infogas i den
 * ordning väljarna röstade kunde den som vet när någon legitimerade sig peka
 * ut hens rad, och skalningen vore verkningslös.
 *
 * TVÅ KUVERT FÅR HA SAMMA CHIFFER (fixrunda 3, ruling 130). Den som lägger en
 * kopia av någon annans valsedel lägger en giltig röst, och båda flyttas.
 * Urnans rader nycklas därför per kuvert och inte per hash.
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
       * kuverten. Se `findUrnDeviations`.
       */
      residueRemoved: string[]
      /**
       * Chifferhashen för varje validerat kuvert vars plats i votes_db,
       * hashen eller id:t, var tagen av en rad med ett annat innehåll. Raden
       * togs bort och det validerade infogades i stället (ruling 126). Tyder
       * på att någon skrivit i röstdatabasen förbi stängningen.
       */
      urnRowsReplaced: string[]
    }
  | { status: 'too_early'; closesAt: Date }
  | {
      status: 'already_closed'
      /**
       * Rader som den här körningen ersatte innan den fann omröstningen stängd
       * (fixrunda 2 av 11d). Står bara med när det finns några, se
       * `urnRowsReplaced` i `closed`.
       */
      urnRowsReplaced?: string[]
    }
  | { status: 'in_progress' }
  | { status: 'validation_failed'; summary: ValidationReport['summary'] }
  | {
      status: 'invalid_ballot'
      ciphertextHash: string
      /**
       * Valideringens sammanfattning, med antal och kategorier och ingen
       * väljare (fixrunda 1 av uppgift 14d). Kuvertet ovan är det första som
       * inte verifierar, och sammanfattningen säger hur många som avviker och
       * hur, till exempel att de har det gamla bevisformatet.
       */
      summary: ValidationReport['summary']
    }

/**
 * Vad som är känt om kopplingen mellan väljare och röst när stängningen
 * avbrutits.
 *
 * `untouched` — kontrollerat: ingenting är raderat, och det går att säga rakt
 *   ut. Den här körningen har inte raderat något kuvert, och stängningens lås
 *   hålls bevisligen när beskedet ges, så ingen annan stängning kan ha gjort
 *   det heller (se `withClosingLock` och `verdictFor`). Så är det på varje väg
 *   som bryter FÖRE skalningen, och när skalningens satser förts tillbaka
 *   till sparpunkten i låsets transaktion, så länge låset hålls och fasen gått
 *   att läsa och inte visar något annat (fixrunda 2 av 11d).
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

  /**
   * Chifferhashen för varje rad i röstdatabasen som körningen tog bort för att
   * ersätta den med det validerade innehållet innan den avbröts (ruling 126).
   * Sätts av `closeElection`, som ser hela körningen, och står i ruttens
   * svar: en ersättning tyder på ett angrepp, och medan kopplingen finns kvar
   * pekar chifferhashen ut vilket kuvert det gällde.
   */
  urnRowsReplaced: readonly string[] = []

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

/** Raderna i röstdatabasen som en avbruten körning ersatt, se `CloseAbortedError`. */
export function urnRowsReplacedOf(error: unknown): readonly string[] {
  return error instanceof CloseAbortedError ? error.urnRowsReplaced : []
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
 * de lästa kuverten, och rader som tagit ett läst kuverts plats med ett annat
 * innehåll, se `findUrnDeviations`. Kuverten själva ligger kvar, och en
 * omkörning flyttar dem på nytt. Beskedet säger därför vad som faktiskt är
 * känt: att varje kuvert ligger kvar i röstlängden.
 */
export function abortedMessageFor(error: unknown): string {
  const linkState = linkStateOf(error)

  if (linkState === 'untouched') {
    return (
      'Stängningen avbröts innan något kuvert raderades. Kopplingen mellan väljare och röst är ' +
      'ORÖRD, och omröstningen kan stängas om när felet är utrett. Chiffer i röstdatabasen som ' +
      'inte hörde till något av de lästa kuverten, eller som inte stämde med dem, kan ha tagits ' +
      'bort, och det står i serverloggen, liksom vad som gick fel — svaret gissar medvetet inte.'
    )
  }

  return (
    'Stängningen kunde inte bekräftas. Den KAN ha gått igenom — kontrollera omröstningens fas ' +
    'och kuvertrot innan du gör något annat. Står fasen i STRIPPED eller en senare fas med ' +
    'kuvertroten skriven är kopplingen mellan väljare och röst raderad och stängningen klar. ' +
    'Står den i OPEN, CLOSED eller VALIDATED med kuvertroten oskriven gick den inte igenom. ' +
    'Stämmer fasen och roten inte med varandra har någon skrivit i röstlängden förbi ' +
    'stängningen: antingen har kopplingen raderats och fasen skrivits om, eller så har fasen ' +
    'eller roten skrivits utan radering. En omkörning rör ingenting i en omröstning där fasen ' +
    'och roten inte stämmer, och inte heller där kopplingen redan är raderad. Vad som gick fel ' +
    'framgår av serverloggen.'
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
 * `already_closed` betyder fas STRIPPED eller senare MED KUVERTROTEN SKRIVEN,
 * här och ingen annanstans. STRIPPED skrivs bara i skalningens transaktion, i
 * samma sats som roten och tillsammans med raderingen, och de senare faserna
 * bara efter den. En omröstning i CLOSED eller VALIDATED har kvar sina kuvert,
 * och en omkörning ska ta dem. Fram till uppgift 11d räknades allt som inte var
 * OPEN som raderat, vilket stämde så länge bara OPEN och STRIPPED skrevs.
 *
 * ROTEN KRÄVS (fixrunda 1 av 11d, M3). En fas efter skalningen utan rot kan
 * bara komma av en skrivning förbi stängningen, och då vet ingen om kopplingen
 * raderats. Före rättelsen svarade stängningen `already_closed` där, och
 * rutten att kopplingen var raderad, fast kuverten låg kvar.
 *
 * En fas som inte står i någon av listorna har skrivits förbi stängningen, och
 * då vet stängningen inte vad som gäller för kopplingen.
 */
const LINKED_PHASES: readonly string[] = ['OPEN', 'CLOSED', 'VALIDATED']
const CLEARED_PHASES: readonly string[] = ['STRIPPED', 'TALLIED', 'CERTIFIED']

function linkAlreadyCleared(state: CloseState): boolean {
  return CLEARED_PHASES.includes(state.phase) && state.envelopeRoot !== null
}

function linkStillExists(state: CloseState): boolean {
  return LINKED_PHASES.includes(state.phase) && state.envelopeRoot === null
}

/**
 * Vad fasen och roten säger när de inte stämmer med varandra, eller fasen inte
 * är någon av specens. Alla utom det sista fallet kan bara komma av en
 * skrivning i röstlängden förbi stängningen: STRIPPED och roten skrivs i samma
 * sats, och ingenting annat skriver roten.
 *
 * EN SKRIVEN ROT FÖRE STRIPPED BEVISAR INTE ATT KOPPLINGEN RADERATS (fixrunda 1
 * av 11d, M4). Antingen har skalningen gått igenom och fasen skrivits om
 * efteråt, eller så har roten skrivits direkt i databasen, utan radering.
 * Ingenting i röstlängden skiljer de två åt, så beskedet säger båda.
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
      'transaktion, tillsammans med raderingen, så någon har skrivit i röstlängden förbi ' +
      'stängningen: antingen har kopplingen raderats och fasen skrivits om efteråt, eller så har ' +
      'roten skrivits förbi stängningen utan att något raderats. Ingenting raderas nu.'
    )
  }
  if (state.envelopeRoot === null) {
    return (
      `Fasen står i ${state.phase} men kuvertroten är oskriven. STRIPPED skrivs bara tillsammans ` +
      'med roten, så någon har skrivit i röstlängden förbi stängningen, och det går inte att ' +
      'säga om kopplingen raderats. Ingenting raderas nu.'
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
 * `stillHeld`, före de steg låset skyddar: städningen i röstdatabasen, en gång
 * före läsningen och en gång direkt före raderingen, och skalningen. Har låset
 * gått förlorat avbryts stängningen, och beskedet om kopplingen kommer då ur
 * fasen. "Orörd" sägs aldrig utan en läst fas och ett lås som frågats efter
 * läsningen, se `verdictWithoutDeletion` (fixrunda 1 och 2 av 11d). Ett lås som
 * gått förlorat kommer inte tillbaka, så ett ja från `stillHeld` betyder att
 * låset hållits hela vägen dit.
 *
 * SKALNINGEN KÖRS I LÅSETS TRANSAKTION (fixrunda 2 av 11d, ruling 128). Fram
 * till rundan hade skalningen en egen transaktion, på en annan anslutning.
 * Omgranskningens prob Z1 lät en stängning vars lås gått förlorat efter den
 * sista frågan skala ändå, medan en annan stängning tog låset. Nu körs
 * skalningens satser på låsets anslutning, efter en sparpunkt, och blir
 * beständiga först när låsets transaktion gör COMMIT. Går låset förlorat går
 * skalningen förlorad med det, och "låset hålls" betyder att ingen annan
 * skalning kan pågå. Se `ClosingLock.strip`.
 *
 * Går låset förlorat mellan den sista frågan och städningens radering finns
 * ett fönster på några satser. Raderingen tar bort chiffer som inte fanns i den
 * här läsningen, och en stängning som tagit över kan ha flyttat ett sådant, om
 * kuvertet skrivits direkt i röstlängden efter läsningen. Därför frågas låset
 * och fasen igen efter raderingen, och stängningen larmar och ger det
 * försiktiga beskedet om något av dem inte stämmer, se `removeFromUrn`.
 * Skalningens första sats låser omröstningens rad, så en annan stängnings
 * övergång till VALIDATED, och därmed dess städning, väntar tills låsets
 * transaktion är klar och ser då STRIPPED.
 */
type ClosingLock = {
  stillHeld: () => Promise<boolean>
  /**
   * Kör skalningens satser i låsets transaktion, efter sparpunkten
   * `stripping`. Satserna blir beständiga när låsets transaktion gör COMMIT,
   * och det gör den bara om stängningen svarat med skalningen, se
   * `withClosingLock`.
   */
  strip: <R>(work: (tx: VotersTransaction) => Promise<R>) => Promise<Stripping<R>>
}

/** En transaktion i röstlängden, som låsets. */
type VotersTransaction = VotersPrisma.TransactionClient

/**
 * Hur skalningens satser gick.
 *
 * `done`        satserna gick igenom, och transaktionen håller. De blir
 *               beständiga när låsets transaktion gör COMMIT.
 * `rolledBack`  satserna kastade, eller transaktionen hade avbrutits av ett
 *               fel som svalts. Allt efter sparpunkten är ångrat, och låset
 *               hålls fortfarande.
 * `lost`        transaktionen gick inte att föra tillbaka till sparpunkten,
 *               oftast för att anslutningen är borta. Den gör aldrig COMMIT,
 *               och låset hålls inte längre.
 */
type Stripping<R> = { outcome: 'done'; value: R } | { outcome: 'rolledBack' | 'lost'; error: unknown }

/** Låsets transaktion kunde inte föras tillbaka till sparpunkten, och får inte göra COMMIT. */
class StrippingNotCommitted extends Error {
  constructor() {
    super('Låsets transaktion kunde inte föras tillbaka till sparpunkten före skalningen och rullas tillbaka.')
    this.name = 'StrippingNotCommitted'
  }
}

/**
 * Tidsgränsen för låsets transaktion. Valideringen hashar ett personnummer per
 * väljare med scrypt, 37 ms, och verifierar bevisen två gånger, så ett stort
 * val kan ta timmar att stänga. Låset får inte gå ut under tiden.
 *
 * TAKET, I SIFFROR (fixrunda 1 av 11d, M7). Granskningen mätte 13,6 sekunder
 * för 101 kuvert, omkring 134 ms per kuvert för hela förberedelsen. Sex timmar
 * räcker då till ungefär 160 000 kuvert. Ett större val går inte att stänga:
 * låset går ut under förberedelsen, och varje stängning avbryts vid nästa
 * fråga till `stillHeld`, med kopplingen orörd men med det försiktiga
 * beskedet. Då krävs en längre gräns eller en snabbare validering. Siffran
 * gäller en processor som granskarens, och bevisverifieringen delar kö med
 * röstningen. Minnet sätter ett lägre tak, se `readEnvelopes`.
 */
const CLOSING_LOCK_TIMEOUT_MS = 6 * 60 * 60 * 1000

/**
 * Skalningens egna gränser, i låsets transaktion (fixrunda 3 av 11d).
 *
 * `STRIP_LOCK_TIMEOUT_MS` är hur länge en sats i skalningen väntar på ett lås.
 * Läggningen håller omröstningens rad med FOR SHARE i högst några sekunder,
 * och efter CLOSED bara så länge den behöver för att se att röstningen stängt.
 * Tio sekunder rymmer det, men inte en transaktion som hänger. Då ger
 * skalningen upp, förs tillbaka till sparpunkten, och stängningen kan köras
 * om.
 *
 * `STRIP_STATEMENT_TIMEOUT_MS` är hur länge en enskild sats får köra. Den
 * största är en omgång om tusen raderade kuvert. Två minuter är samma gräns
 * som skalningens egen transaktion hade före ruling 128, nu per sats.
 */
const STRIP_LOCK_TIMEOUT_MS = 10_000
const STRIP_STATEMENT_TIMEOUT_MS = 120_000

type LockedRun<T> = { taken: false } | { taken: true; value: T }

async function withClosingLock<T>(
  electionId: string,
  run: (lock: ClosingLock) => Promise<T>,
): Promise<LockedRun<T>> {
  const holder: { result?: { value: T } | { error: unknown } } = {}
  /** Skalningens satser står i låsets transaktion och görs beständiga av dess COMMIT. */
  let carriesStripping = false

  try {
    await votersDb.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(
            ('x' || substr(md5(${`close-election:${electionId}`}), 1, 16))::bit(64)::bigint
          ) AS locked`
        if (row?.locked !== true) return

        /**
         * Låsets transaktion står stilla medan stängningen arbetar i andra
         * anslutningar, i ett stort val i timmar. En server med
         * `idle_in_transaction_session_timeout` satt skulle avsluta den och
         * släppa låset mitt i stängningen, så gränsen stängs av för just den
         * här transaktionen (fixrunda 1 av 11d, tveksamhet 3). `set_config`
         * med `true` gäller bara transaktionen, som `SET LOCAL`.
         */
        await tx.$queryRaw`SELECT set_config('idle_in_transaction_session_timeout', '0', true)`

        /** En transaktion som inte går att föra tillbaka till sparpunkten får aldrig göra COMMIT. */
        let unusable = false

        const lock: ClosingLock = {
          stillHeld: async () => {
            try {
              await tx.$queryRaw`SELECT 1`
              return true
            } catch {
              return false
            }
          },
          strip: async (work) => {
            try {
              /**
               * SKALNINGEN HAR EGNA TIDSGRÄNSER (fixrunda 3 av 11d, omgranskningens
               * iakttagelse 2). Före ruling 128 hade skalningen en egen
               * transaktion med två minuter, så att en transaktion som hänger
               * inte håller lås på `election` och `pending_vote` hur länge som
               * helst. I låsets transaktion hade den i stället sex timmar. Nu
               * väntar varje sats högst `STRIP_LOCK_TIMEOUT_MS` på ett lås och
               * kör högst `STRIP_STATEMENT_TIMEOUT_MS`. Gränserna sätts före
               * sparpunkten, med `true`, så att de gäller resten av låsets
               * transaktion och inte ångras av en återgång till sparpunkten.
               */
              await tx.$queryRaw`SELECT set_config('lock_timeout', ${String(STRIP_LOCK_TIMEOUT_MS)}, true) AS lock_timeout, set_config('statement_timeout', ${String(STRIP_STATEMENT_TIMEOUT_MS)}, true) AS statement_timeout`
              await tx.$queryRaw`SAVEPOINT stripping`
              const value = await work(tx)
              /**
               * EN AVBRUTEN TRANSAKTION MÄRKS HÄR, MEDAN LÅSET HÅLLS. Ett fel
               * som svalts inne i satserna lämnar transaktionen avbruten, och
               * dess COMMIT blir då en ROLLBACK, utan fel (fixrunda 2 av
               * uppgift 11). En enkel sats kastar i det läget, och
               * transaktionen förs tillbaka till sparpunkten i stället.
               */
              await tx.$queryRaw`SELECT 1`
              carriesStripping = true
              return { outcome: 'done', value }
            } catch (error) {
              try {
                await tx.$queryRaw`ROLLBACK TO SAVEPOINT stripping`
                return { outcome: 'rolledBack', error }
              } catch {
                unusable = true
                return { outcome: 'lost', error }
              }
            }
          },
        }

        try {
          holder.result = { value: await run(lock) }
        } catch (error) {
          holder.result = { error }
          /**
           * En skalning görs bara beständig när stängningen svarat med den.
           * Kastade stängningen efter skalningen ångras den här.
           */
          if (carriesStripping) {
            carriesStripping = false
            try {
              await tx.$queryRaw`ROLLBACK TO SAVEPOINT stripping`
            } catch {
              unusable = true
            }
          }
        }

        if (unusable) throw new StrippingNotCommitted()
      },
      /**
       * READ COMMITTED, UTTRYCKLIGEN (fixrunda 3 av 11d, omgranskningens N1).
       * Skalningen körs i den här transaktionen, som började innan fasen
       * skrevs till CLOSED och VALIDATED i andra anslutningar. Under
       * REPEATABLE READ ser den fasen som den stod när transaktionen tog sin
       * ögonblicksbild, och jämför-och-sätt till STRIPPED träffar aldrig. En
       * databas med ett annat förval hade alltså gjort varje stängning
       * omöjlig, så nivån står här i stället för att ärvas.
       */
      { timeout: CLOSING_LOCK_TIMEOUT_MS, maxWait: 20_000, isolationLevel: 'ReadCommitted' },
    )
  } catch (lockError) {
    if (holder.result === undefined) {
      throw new CloseAbortedError(
        'unknown',
        'Stängningen kunde inte ta sitt lås i röstlängden och har inte gjort något. En annan ' +
          'stängning kan pågå eller ha gått igenom under tiden.',
        { cause: lockError },
      )
    }
    /**
     * Bär transaktionen skalningen kan COMMIT ha gått igenom eller inte, och
     * felet säger inte vilket. Då är det försiktiga beskedet det enda ärliga.
     * Bär den ingen skalning skrev den ingenting, och stängningens eget utfall
     * gäller.
     */
    if (carriesStripping) {
      throw new CloseAbortedError(
        'unknown',
        'Stängningen kunde inte bekräftas: låsets transaktion, som bär skalningen, avbröts vid ' +
          'COMMIT utan besked om den hann genomföras. Kontrollera omröstningens fas innan ' +
          'stängningen körs om.',
        { cause: lockError },
      )
    }
    if (!(lockError instanceof StrippingNotCommitted)) {
      logger.warn('Stängningens lås släpptes inte som vanligt efter stängningen', {
        reason: lockError instanceof Error ? lockError.message : String(lockError),
      })
    }
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
 * KASTAS INIFRÅN SKALNINGEN, FÖRE COMMIT. Låsets transaktion förs då tillbaka
 * till sparpunkten före skalningen, så raderingen försvinner tillsammans med
 * roten, fasen, markeringarna och revisionsposten, och låset hålls kvar (se
 * `withClosingLock`). Att det är en egen klass gör att `closeUnderLock` kan ge
 * dess egen text, som säger vad som ändrats.
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
 * VAD FASEN OCH LÅSET SÄGER OM KOPPLINGEN, NÄR DEN HÄR KÖRNINGEN INTE HAR
 * RADERAT NÅGOT (uppgift 11d, och fixrunda 1 av 11d, M10).
 *
 * Ett enda beslut för varje väg: avbrottet i förberedelsen, avbrottet inifrån
 * skalningens transaktion, avvikelserna i valideringen och efterkontrollen.
 * Före fixrundan fattades samma beslut i två kopior, och ett villkor som det om
 * roten i `linkAlreadyCleared` kunde ändras i den ena men inte i den andra.
 *
 *   `cleared`    fasen står i STRIPPED eller senare och roten är skriven.
 *                Kopplingen är raderad, och svaret är `already_closed`.
 *   `intact`     fasen står i OPEN, CLOSED eller VALIDATED, roten är
 *                oskriven, och stängningens lås hålls. Kopplingen finns kvar,
 *                och ingen annan stängning kan radera den, så den är orörd.
 *   `uncertain`  allt annat: omröstningen finns inte, fasen och roten stämmer
 *                inte med varandra, eller låset hålls inte längre. En
 *                stängning som tagit över kan då radera kopplingen när som
 *                helst, och beskedet är det försiktiga.
 *
 * `lockHeld` ska vara frågat EFTER att fasen lästs. Ett lås som gått förlorat
 * kommer inte tillbaka, eftersom transaktionen som höll det är borta. Ett ja
 * efter läsningen betyder alltså att låset hölls när fasen lästes, och att
 * ingen annan stängning kunnat skala sedan dess.
 */
type Verdict =
  | { kind: 'cleared' }
  | { kind: 'intact'; statement: string }
  | { kind: 'uncertain'; statement: string; cause?: unknown }

function verdictFor(state: CloseState | null, lockHeld: boolean): Verdict {
  if (state === null) {
    return { kind: 'uncertain', statement: 'Omröstningen fanns inte längre i röstlängden.' }
  }
  if (linkAlreadyCleared(state)) return { kind: 'cleared' }
  if (!linkStillExists(state)) return { kind: 'uncertain', statement: describeUnexpectedState(state) }
  if (!lockHeld) {
    return {
      kind: 'uncertain',
      statement:
        `Fasen står i ${state.phase} och kuvertroten är oskriven, men stängningens lås hålls inte ` +
        'längre. En stängning som tagit över kan radera kopplingen när som helst, så det går inte ' +
        'att säga att den är orörd.',
    }
  }
  return {
    kind: 'intact',
    statement:
      `Fasen står i ${state.phase} och kuvertroten är oskriven, och stängningens lås hålls, så ` +
      'kopplingen är orörd.',
  }
}

/**
 * Läser fasen, frågar sedan låset och fattar beslutet i `verdictFor`.
 *
 * GÅR FASEN INTE ATT LÄSA ÄR BESKEDET DET FÖRSIKTIGA, OAVSETT LÅS (fixrunda 2
 * av 11d, nytt fel 1). Fram till rundan avgjorde låset ensamt i det läget:
 * hölls det sades kopplingen vara orörd. Men låset utesluter bara en
 * stängning som tar det senare. Omgranskningens prob Z1 lät en stängning vars
 * lås gått förlorat skala medan en annan höll låset, och den andra svarade
 * ORÖRD fast kopplingen var raderad. Sedan ruling 128 kan en stängning utan
 * lås inte skala, men "orörd" ska ändå vila på en läst fas.
 */
async function verdictWithoutDeletion(electionId: string, lock: ClosingLock): Promise<Verdict> {
  let state: CloseState | null
  try {
    state = await closeStateOf(electionId)
  } catch (error) {
    return {
      kind: 'uncertain',
      statement: 'Fasen gick inte att läsa, så det går inte att säga om kopplingen raderats.',
      cause: error,
    }
  }

  return verdictFor(state, await lock.stillHeld())
}

/**
 * Stängningen avbryts, och den här körningen har inte raderat något kuvert.
 *
 * Svarar `already_closed` när kopplingen bevisligen är raderad, och kastar
 * annars med beskedet ur `verdictWithoutDeletion`. `afterIntact` säger vad en
 * omkörning kan vänta sig när kopplingen är orörd.
 *
 * FASEN LÄSES INNAN "ORÖRD" SÄGS (uppgift 11d). Granskningen av 14f visade en
 * andra stängning som läste fasen före den förstas COMMIT och kuverten efter,
 * och som sedan sa att kopplingen var orörd fast fasen var STRIPPED. Och
 * LÅSET FRÅGAS EFTER FASEN (fixrunda 1 av 11d, V1): utan lås kan en annan
 * stängning radera kopplingen strax efter läsningen.
 */
async function abortWithoutDeletion(
  electionId: string,
  lock: ClosingLock,
  message: string,
  options: { cause?: unknown; afterIntact?: string } = {},
): Promise<CloseOutcome> {
  const verdict = await verdictWithoutDeletion(electionId, lock)
  if (verdict.kind === 'cleared') return { status: 'already_closed' }

  const cause = options.cause ?? (verdict.kind === 'uncertain' ? verdict.cause : undefined)
  const errorOptions = cause === undefined ? undefined : { cause }

  if (verdict.kind === 'intact') {
    const after = options.afterIntact === undefined ? '' : ` ${options.afterIntact}`
    throw new CloseAbortedError('untouched', `${message} ${verdict.statement}${after}`, errorOptions)
  }
  throw new CloseAbortedError('unknown', `${message} ${verdict.statement}`, errorOptions)
}

/**
 * Vad ett avbrott inifrån transaktionen betyder för kopplingen.
 *
 * Den här körningen raderade ingenting, eftersom transaktionen avbröt sig själv
 * före COMMIT. Om kopplingen ändå är raderad avgör fasen, och om en annan
 * stängning kan radera den avgör låset, med samma beslut som för ett avbrott i
 * förberedelsen, se `verdictFor`.
 */
async function settleRolledBack(
  electionId: string,
  lock: ClosingLock,
  change: EnvelopesChangedError | PhaseMovedError,
): Promise<CloseOutcome> {
  return abortWithoutDeletion(electionId, lock, change.message, {
    afterIntact: afterChangedEnvelopes(change),
  })
}

/**
 * Två strängar i samma ordning som `Array.prototype.sort` ger dem.
 *
 * Avsiktligt INTE `localeCompare`: det som skrivs till databasen måste hamna i
 * en ordning som en observatör kan räkna fram igen utan att känna till
 * serverns språkinställning.
 */
function compareText(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Innehållets ordning: chifferhash, valsedel, bevis och chiffer.
 *
 * Det här är den ENDA ordningen i filen som har någon effekt. Roten sorterar
 * `merkleRoot` själv, på lövhashar — se `envelopeRootOf`. Den bestämmer i
 * vilken ordning raderna infogas och vilket löpnummer ett av flera likadana
 * kuvert får, se `withUrnIds`. Den bygger bara på innehållet, aldrig på
 * väljaren, kuvertets id i röstlängden eller läggningens ordning, så den säger
 * ingenting om vem som röstade när. Bevisen och chiffret jämförs bara när
 * hashen och valsedeln är lika, alltså nästan aldrig.
 */
function byContent(a: Envelope, b: Envelope): number {
  return (
    compareText(a.ciphertextHash, b.ciphertextHash) ||
    compareText(a.ballotId, b.ballotId) ||
    compareText(JSON.stringify(a.proofs), JSON.stringify(b.proofs)) ||
    compareText(JSON.stringify(a.ciphertext), JSON.stringify(b.ciphertext))
  )
}

/**
 * Radens id i urnan, härlett ur kuvertets innehåll i stället för slumpat.
 *
 * PER KUVERT, INTE PER HASH (fixrunda 3 av uppgift 11d, ruling 130). Två kuvert
 * får ha samma chiffer, en valsedel och en kopia av den, och båda ska flyttas.
 * Id:t är därför de första 128 bitarna av SHA-256 över chifferhashen,
 * valsedeln och `copy`, ett löpnummer bland likadana kuvert i innehållets
 * ordning. Fram till rundan var id:t chifferhashens första 128 bitar, och två
 * kuvert med samma chiffer fick samma plats.
 *
 * ETT SLUMPAT UUID HADE GJORT SORTERINGEN VERKNINGSLÖS I PRAKTIKEN. Raderna
 * infogas i innehållets ordning just för att tabellens egen ordning inte ska
 * avslöja i vilken ordning väljarna röstade. Den som läser tabellen sorterar
 * på primärnyckeln, och ett härlett id ger en ordning som bara beror på
 * innehållet och går att räkna fram igen. Det avslöjar ingenting nytt:
 * chifferhashen och valsedeln står redan i raden. Och det är
 * deterministiskt, så samma läsning ger samma id:n, och en omkörning krockar
 * på primärnyckeln i stället för att skapa dubbletter.
 *
 * FUNKTIONEN HÄVDAR SIN EGEN FÖRUTSÄTTNING: chifferhashen ska vara 64 gemena
 * hextecken, som den som räknar fram id:t igen också får.
 */
export function urnIdFor(ciphertextHash: string, ballotId: string, copy: number): string {
  if (!/^[0-9a-f]{64}$/.test(ciphertextHash)) {
    throw new Error('Chifferhashen är inte 64 gemena hextecken — id:t kan inte härledas ur den.')
  }
  if (!Number.isSafeInteger(copy) || copy < 0) {
    throw new Error('Löpnumret är inte ett heltal från noll och uppåt.')
  }

  const hex = sha256Hex(`${ciphertextHash}|${ballotId}|${copy}`).slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/** Ett validerat kuvert med sin plats i urnan. */
export type UrnEnvelope<T extends Envelope = Envelope> = T & { urnId: string }

/**
 * Ger varje kuvert i läsningen sin plats i urnan, i innehållets ordning
 * (fixrunda 3 av uppgift 11d, ruling 130).
 *
 * Löpnumret räknas bland kuvert med samma chifferhash och valsedel, i den
 * ordning `byContent` ger dem. Två helt likadana kuvert är utbytbara, så det
 * spelar ingen roll vilket av dem som får vilket nummer: raderna i urnan blir
 * desamma. Skiljer sig bevisen avgör de ordningen. Varken väljaren, kuvertets
 * id i röstlängden eller läggningens ordning påverkar något id.
 */
export function withUrnIds<T extends Envelope>(envelopes: readonly T[]): Array<UrnEnvelope<T>> {
  const copies = new Map<string, number>()
  return [...envelopes].sort(byContent).map((envelope) => {
    const key = `${envelope.ciphertextHash}|${envelope.ballotId}`
    const copy = copies.get(key) ?? 0
    copies.set(key, copy + 1)
    return { ...envelope, urnId: urnIdFor(envelope.ciphertextHash, envelope.ballotId, copy) }
  })
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

  for (const envelope of [...envelopes].sort(byContent)) {
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

/** Hur många rader som raderas per sats, en parameter per rad. */
const URN_DELETE_BATCH_SIZE = 1_000

/**
 * Det städningen hittade i votes_db före infogningen, per rad i urnan.
 *
 * `residue`        chifferhashen för varje rad på omröstningens valsedlar vars
 *                  id inte hör till något validerat kuvert, sorterade
 * `residueRowIds`  id:t för de raderna
 * `forged`         chifferhashen för varje validerat kuvert vars plats i urnan,
 *                  dess id, redan är tagen av en rad med ett annat innehåll,
 *                  sorterade
 * `forgedRowIds`   id:t för de raderna, var i votes_db de än ligger
 */
type UrnDeviations = { residue: string[]; residueRowIds: string[]; forged: string[]; forgedRowIds: string[] }

/**
 * Vad städningen tagit bort ur votes_db i den här körningen: resterna, och de
 * validerade kuvert vars rad ersätts. Står i stängningens svar, och följer med
 * ett avbrott, se `closeElection`.
 */
type UrnChanges = { residueRemoved: string[]; urnRowsReplaced: string[] }

/**
 * Letar upp det som ska bort ur votes_db innan de validerade kuverten infogas,
 * och loggar antalet INNAN något raderas (fixrunda 1 av 11d, M8). Loggades
 * antalet först efter raderingen fanns ingen loggrad om en omgång kastade,
 * fast beskedet om en orörd koppling hänvisar till serverloggen.
 *
 * PER ID, INTE PER HASH (fixrunda 3 av 11d, ruling 130). Två kuvert får ha
 * samma chiffer, och varje validerat kuvert har en egen plats i urnan, se
 * `withUrnIds`. Allt jämförs därför mot platserna.
 *
 * RESTERNA (uppgift 11d, ruling 115). Exakt de rader i encrypted_vote på
 * omröstningens valsedlar vars id inte är något validerat kuverts plats.
 * Infogningen sker före transaktionen i röstlängden, eftersom flytten går
 * över en databasgräns. Tas ett kuvert bort eller byts ut efter läsningen
 * avbryts transaktionen, men chiffret ligger redan i votes_db. Ett sådant
 * chiffer har inget kuvert i den nya läsningen och får inte räknas. Det kan
 * också vara skrivet direkt i röstdatabasen, också med ett validerat kuverts
 * hash. Fram till 11d stoppade antalskontrollen varje omkörning, tills någon
 * städade för hand, så den som kunde skriva i databasen kunde låsa ett val.
 *
 * DE FÖRFALSKADE RADERNA (fixrunda 1 av 11d, ruling 126). En rad, var som
 * helst i votes_db, som står på ett validerat kuverts plats men inte har
 * exakt dess innehåll. Infogningen hoppar över en rad som redan finns, så en
 * sådan rad hade stått kvar i stället för det validerade kuvertet. Fram till
 * fixrunda 1 stoppade återläsningen då varje stängning tills någon tog bort
 * raden för hand, och den som kunde skriva i röstdatabasen kunde hålla valet
 * öppet. Ingen legitim väg skriver en sådan rad: platsen härleds ur
 * kuvertets innehåll, och bara stängningen skriver i urnan. Att ta bort
 * raden kan alltså bara ta bort en förfalskning, och infogningen sätter det
 * validerade innehållet i dess ställe. Det tyder på ett angrepp, så det
 * larmas i loggen, med antal, och chifferhasharna står i stängningens svar.
 * Loggen maskerar chifferhashar, så de står inte där.
 */
async function findUrnDeviations(ballotIds: string[], envelopes: readonly UrnEnvelope[]): Promise<UrnDeviations> {
  const places = new Set(envelopes.map((envelope) => envelope.urnId))
  const residue: Array<{ id: string; ciphertextHash: string }> = []

  if (ballotIds.length > 0) {
    let after: string | null = null
    for (;;) {
      const batch: Array<{ id: string; ciphertextHash: string }> = await votesDb.encryptedVote.findMany({
        where: { ballotId: { in: ballotIds }, ...(after === null ? {} : { id: { gt: after } }) },
        orderBy: { id: 'asc' },
        take: RESIDUE_READ_BATCH_SIZE,
        select: { id: true, ciphertextHash: true },
      })
      for (const row of batch) {
        if (!places.has(row.id)) residue.push(row)
      }
      if (batch.length < RESIDUE_READ_BATCH_SIZE) break
      after = batch[batch.length - 1]!.id
    }
  }

  const forged: string[] = []
  const forgedRowIds: string[] = []

  for (let start = 0; start < envelopes.length; start += ENVELOPE_READ_BATCH_SIZE) {
    const batch = envelopes.slice(start, start + ENVELOPE_READ_BATCH_SIZE)
    const byPlace = new Map(batch.map((envelope) => [envelope.urnId, envelope]))

    const stored = await votesDb.encryptedVote.findMany({
      where: { id: { in: [...byPlace.keys()] } },
      select: { id: true, ciphertextHash: true, ballotId: true, ciphertext: true, proofs: true },
    })

    for (const row of stored) {
      const envelope = byPlace.get(row.id)
      if (envelope && !storedAsValidated(row, envelope)) {
        forged.push(envelope.ciphertextHash)
        forgedRowIds.push(row.id)
      }
    }
  }

  if (residue.length > 0) {
    logger.warn(
      'Stängningen hittade rester i röstdatabasen: chiffer utan något validerat kuvert. De tas ' +
        'bort före infogningen.',
      { found: residue.length },
    )
  }
  if (forgedRowIds.length > 0) {
    logger.error(
      'LARM: stängningen hittade rader i röstdatabasen på ett validerat kuverts plats men med ett ' +
        'annat innehåll. Ingen legitim väg skriver en sådan rad. De ersätts med det validerade ' +
        'innehållet före infogningen, och chifferhasharna står i stängningens svar.',
      { found: forgedRowIds.length },
    )
  }

  return {
    residue: residue.map((row) => row.ciphertextHash).sort(),
    residueRowIds: residue.map((row) => row.id).sort(),
    forged: forged.sort(),
    forgedRowIds: forgedRowIds.sort(),
  }
}

/**
 * Tar bort det `findUrnDeviations` hittat, under stängningens lås, och skriver
 * i `urn` vad som tagits bort, först när det bevisligen är borta.
 *
 * NÄR. Direkt efter att fasen satts till VALIDATED med jämför-och-sätt från
 * CLOSED eller VALIDATED med oskriven rot, och direkt efter en fråga till
 * låset. Fasen är alltså skild från STRIPPED och roten null när raderingen
 * görs, och ingen annan stängning kan skala under tiden. Det är de villkor
 * omgranskningen av 14f satte: utan dem kunde städningen se en tom läsning och
 * ta bort det en annan stängning just flyttat.
 *
 * EFTER RADERINGEN PRÖVAS LÅSET OCH FASEN IGEN (fixrunda 1 av 11d, M2).
 * Granskarens prob tappade låset efter frågan före städningen, skrev Robins
 * äkta kuvert direkt i röstlängden efter den här läsningen och lät en andra
 * stängning flytta tre kuvert. Städningen tog sedan bort Robins chiffer, som
 * inte fanns i den här läsningen, och urnan saknade en röst. Frågan direkt före
 * raderingen stänger det mesta av det fönstret. Det som återstår är tiden
 * mellan frågan och raderingen, och det fångas här. Hölls låset inte hela
 * vägen, eller står fasen inte kvar i VALIDATED med oskriven rot, larmar
 * stängningen i loggen och ger det försiktiga beskedet i stället för att
 * fortsätta. Ett lås som gått förlorat kommer inte tillbaka, så ett ja efter
 * raderingen betyder att låset hölls under den.
 */
async function removeFromUrn(
  electionId: string,
  lock: ClosingLock,
  ballotIds: string[],
  { residue, residueRowIds, forged, forgedRowIds }: UrnDeviations,
  urn: UrnChanges,
): Promise<void> {
  let residueRemoved = 0
  for (let start = 0; start < residueRowIds.length; start += URN_DELETE_BATCH_SIZE) {
    const result = await votesDb.encryptedVote.deleteMany({
      where: {
        ballotId: { in: ballotIds },
        id: { in: residueRowIds.slice(start, start + URN_DELETE_BATCH_SIZE) },
      },
    })
    residueRemoved += result.count
  }
  urn.residueRemoved = residue

  let forgedRemoved = 0
  for (let start = 0; start < forgedRowIds.length; start += URN_DELETE_BATCH_SIZE) {
    const result = await votesDb.encryptedVote.deleteMany({
      where: { id: { in: forgedRowIds.slice(start, start + URN_DELETE_BATCH_SIZE) } },
    })
    forgedRemoved += result.count
  }
  /**
   * FÖRST NU ÄR RADERNA BEVISLIGEN BORTTAGNA (fixrunda 2 av 11d, nytt fel 6).
   * Hasharna sattes förut innan något raderats, och kastade raderingen av
   * resterna bar felet ändå hasharna, med texten att raderna tagits bort. En
   * rad som redan var borta när raderingen kom räknas också som borttagen:
   * ingen av dem finns kvar.
   */
  urn.urnRowsReplaced = forged

  if (residue.length > 0) {
    logger.warn('Stängningen tog bort rester i röstdatabasen: chiffer utan något validerat kuvert', {
      found: residue.length,
      removed: residueRemoved,
    })
  }
  if (forgedRowIds.length > 0) {
    logger.error(
      'LARM: stängningen tog bort rader i röstdatabasen som tagit ett validerat kuverts plats med ' +
        'ett annat innehåll. Det validerade innehållet infogas i deras ställe.',
      { found: forgedRowIds.length, removed: forgedRemoved },
    )
  }

  const removed = residueRemoved + forgedRemoved
  if (removed === 0) return

  if (await lock.stillHeld()) {
    const state = await closeStateOf(electionId)
    if (state !== null && state.phase === 'VALIDATED' && state.envelopeRoot === null) return
  }

  logger.error(
    'LARM: stängningen tog bort chiffer ur röstdatabasen, men efteråt hölls inte stängningens lås ' +
      'längre, eller så stod fasen inte kvar i VALIDATED med oskriven rot. En annan stängning kan ' +
      'ha flyttat ett av de borttagna chiffren, och då saknas det i urnan.',
    { removed },
  )
  throw new CloseAbortedError(
    'unknown',
    'Stängningen avbröts efter att chiffer tagits bort ur röstdatabasen: efteråt hölls inte ' +
      'stängningens lås längre, eller så stod fasen inte kvar i VALIDATED med oskriven rot. En ' +
      'annan stängning kan ha tagit över och flyttat ett chiffer som togs bort här. Larmet står i ' +
      'serverloggen.',
  )
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
 * Ligger raden i urnan exakt som det validerade kuvertet: på dess plats, med
 * dess chifferhash, och med samma valsedel, samma chiffer och samma bevis?
 * Samma prövning i städningen och i återläsningen.
 */
function storedAsValidated(
  row: { id: string; ciphertextHash: string; ballotId: string; ciphertext: unknown; proofs: unknown },
  envelope: UrnEnvelope,
): boolean {
  return (
    row.ciphertextHash === envelope.ciphertextHash &&
    row.id === envelope.urnId &&
    row.ballotId === envelope.ballotId &&
    sameJson(row.ciphertext, envelope.ciphertext) &&
    sameJson(row.proofs, envelope.proofs)
  )
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
 * Varje flyttat kuvert läses därför tillbaka, i omgångar, på sin plats i
 * urnan, och ska finnas där med samma chifferhash, samma valsedel, samma
 * chiffer och samma bevis som i den validerade läsningen. Sedan fixrunda 3 av
 * 11d läses platsen, id:t, och inte hashen, eftersom två kuvert får ha samma
 * chiffer (ruling 130). Antalet rader på omröstningens valsedlar ska dessutom
 * vara antalet flyttade, så att ingenting finns där som inte validerades.
 * Svaret är null när allt stämmer, annars en beskrivning för loggen.
 *
 * En sådan rad som fanns vid städningen har redan ersatts (ruling 126, se
 * `findUrnDeviations`). Återläsningen fångar det som skrivits efter
 * städningen, och det som infogningen själv inte skrev som väntat. Efter
 * stängningen kontrollerar ingenting urnan förrän uppgift 12b räknar om en
 * urnrot, se posten `votes-db-writer-can-swap-ciphertext` i
 * src/lib/known-limitations.ts.
 */
async function urnMismatch(ballotIds: string[], envelopes: readonly UrnEnvelope[]): Promise<string | null> {
  const onBallots = await votesDb.encryptedVote.count({ where: { ballotId: { in: ballotIds } } })

  let missing = 0
  let different = 0

  for (let start = 0; start < envelopes.length; start += ENVELOPE_READ_BATCH_SIZE) {
    const batch = envelopes.slice(start, start + ENVELOPE_READ_BATCH_SIZE)
    const stored = await votesDb.encryptedVote.findMany({
      where: { id: { in: batch.map((envelope) => envelope.urnId) } },
      select: { id: true, ciphertextHash: true, ballotId: true, ciphertext: true, proofs: true },
    })
    const byPlace = new Map(stored.map((row) => [row.id, row]))

    for (const envelope of batch) {
      const row = byPlace.get(envelope.urnId)
      if (!row) {
        missing += 1
      } else if (!storedAsValidated(row, envelope)) {
        different += 1
      }
    }
  }

  if (onBallots === envelopes.length && missing === 0 && different === 0) return null

  return (
    `Stängningen avbröts: ${envelopes.length} kuvert skulle flyttas, och ${onBallots} chiffer finns ` +
    `på omröstningens valsedlar i röstdatabasen. ${missing} av de flyttade saknas där, och ` +
    `${different} finns där med ett annat id, en annan valsedel, ett annat chiffer eller andra ` +
    'bevis än det som validerades.'
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
    }

/**
 * Förberedelsen avbryts, och den här körningen har inte raderat något kuvert.
 * Beskedet kommer ur `abortWithoutDeletion`.
 */
async function settlePreparation(
  electionId: string,
  lock: ClosingLock,
  message: string,
  cause?: unknown,
): Promise<Preparation> {
  return { kind: 'settled', outcome: await abortWithoutDeletion(electionId, lock, message, { cause }) }
}

/**
 * Valideringen eller omverifieringen hittade en avvikelse (fixrunda 1 av 11d,
 * V1).
 *
 * Båda utfallen säger administratören att kopplingen finns kvar, så att
 * avvikelsen går att utreda. Före fixrundan gavs de utan att låset frågades,
 * och med ett förlorat lås kan en annan stängning ha raderat kopplingen under
 * tiden. Nu ges de bara när fasen och låset bekräftar att kopplingen är orörd,
 * med samma beslut som för ett avbrott, se `verdictFor`. Är kopplingen
 * bevisligen raderad är svaret `already_closed`, och annars det försiktiga
 * beskedet, med avvikelsen i felets text.
 */
async function reportFinding(
  electionId: string,
  lock: ClosingLock,
  finding: Extract<CloseOutcome, { status: 'validation_failed' | 'invalid_ballot' }>,
): Promise<Preparation> {
  const found =
    finding.status === 'validation_failed'
      ? 'Valideringen hittade avvikelser'
      : 'Omverifieringen hittade en valsedel som inte verifierar'

  /**
   * AVVIKELSEN LOGGAS ALLTID, MED SIN SAMMANFATTNING (fixrunda 2 av 11d, nytt
   * fel 5). Svaret kan bli `already_closed` eller det försiktiga beskedet, och
   * då står avvikelsen ingen annanstans. Sammanfattningen bär antal och
   * kategorier men ingen väljare, och chifferhashen står inte med, eftersom
   * loggen maskerar den. Sedan fixrunda 1 av uppgift 14d har också
   * `invalid_ballot` sammanfattningen, så att loggen säger hur många kuvert
   * som avviker och inte bara att ett gör det.
   */
  logger.warn(`${found}, och skalningen avbröts`, { summary: finding.summary })

  const verdict = await verdictWithoutDeletion(electionId, lock)
  if (verdict.kind === 'intact') return { kind: 'settled', outcome: finding }
  if (verdict.kind === 'cleared') return { kind: 'settled', outcome: { status: 'already_closed' } }

  throw new CloseAbortedError(
    'unknown',
    `${found}, och skalningen avbröts, men det går inte att bekräfta att kopplingen finns kvar. ` +
      verdict.statement,
    verdict.cause === undefined ? undefined : { cause: verdict.cause },
  )
}

/**
 * Är låset kvar? Annars avbryts stängningen, och beskedet kommer ur fasen.
 * Anropas före de steg låset finns för, se `withClosingLock`.
 */
async function lockStillHeldOrSettle(
  electionId: string,
  lock: ClosingLock,
  step: string,
): Promise<Preparation | null> {
  if (await lock.stillHeld()) return null

  return settlePreparation(
    electionId,
    lock,
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
 * VALIDATED, och i votes_db rester och förfalskade rader som tas bort och
 * chiffer som infogas. Det som tas bort i votes_db står i `urn`.
 */
async function prepareClose(electionId: string, lock: ClosingLock, urn: UrnChanges): Promise<Preparation> {
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
   * En omröstning i STRIPPED eller senare, med kuvertroten skriven, har redan
   * skalats: kopplingen är raderad och det finns ingenting kvar att flytta. Att
   * i stället låta klockan avgöra hade gjort en omkörning omöjlig att skilja
   * från en förstagångskörning. Beslutet är detsamma som efter ett avbrott, se
   * `verdictFor`. Låset är nyss taget, och här sägs ingenting om att kopplingen
   * är orörd, så låset behöver inte frågas.
   */
  const start = verdictFor(election, true)

  if (start.kind === 'cleared') {
    return { kind: 'settled', outcome: { status: 'already_closed' } }
  }

  if (start.kind === 'uncertain') {
    throw new CloseAbortedError('unknown', `Stängningen avbröts innan den började. ${start.statement}`)
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
     *
     * Båda svaren säger att kopplingen finns kvar, så att avvikelsen går att
     * utreda. De ges därför bara när fasen och låset bekräftar det, se
     * `reportFinding` (fixrunda 1 av 11d, V1).
     */
    const broken = await firstUnverifiableEnvelope(electionId, envelopes)
    if (broken !== null) {
      return reportFinding(electionId, lock, {
        status: 'invalid_ballot',
        ciphertextHash: broken,
        summary: report.summary,
      })
    }

    return reportFinding(electionId, lock, { status: 'validation_failed', summary: report.summary })
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
  // Sammanfattningen är valideringens, som här har passerat.
  const broken = await firstUnverifiableEnvelope(electionId, envelopes)
  if (broken !== null) {
    return reportFinding(electionId, lock, {
      status: 'invalid_ballot',
      ciphertextHash: broken,
      summary: report.summary,
    })
  }

  // --- 4. VALIDATED, städningen och infogningen i votes_db ----------------
  const lostBeforeCleanup = await lockStillHeldOrSettle(electionId, lock, 'städningen i röstdatabasen')
  if (lostBeforeCleanup) return lostBeforeCleanup

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

  /**
   * STÄDNINGEN: RESTER TAS BORT OCH FÖRFALSKADE RADER ERSÄTTS, UNDER LÅSET.
   *
   * Avvikelserna letas först upp och räknas i loggen. Sedan frågas låset en
   * gång till, direkt före raderingen, och efter raderingen prövas låset och
   * fasen (fixrunda 1 av 11d, M2 och M8). Se `findUrnDeviations` och
   * `removeFromUrn`. Det som tas bort står i `urn`, också om stängningen sedan
   * avbryts.
   *
   * PLATSERNA I URNAN räknas här, ur den validerade läsningen och i
   * innehållets ordning, och samma ordning är infogningens (fixrunda 3 av 11d,
   * ruling 130, se `withUrnIds`).
   */
  const placed = withUrnIds(envelopes)
  const deviations = await findUrnDeviations(ballotIds, placed)

  if (deviations.residue.length > 0 || deviations.forgedRowIds.length > 0) {
    const lostBeforeDeletion = await lockStillHeldOrSettle(electionId, lock, 'raderingen i röstdatabasen')
    if (lostBeforeDeletion) return lostBeforeDeletion

    await removeFromUrn(electionId, lock, ballotIds, deviations, urn)
  }

  /**
   * `skipDuplicates` är idempotensen, och återläsningen i steg 5 är skyddet.
   *
   * Flytten går över en databasgräns och kan därför omöjligt vara en
   * transaktion. En körning som avbryts mellan infogningen och raderingen
   * lämnar chiffren på plats — och nästa körning ser dem som befintliga tack
   * vare primärnyckeln, eftersom samma läsning ger samma platser (se
   * `withUrnIds`), i stället för att skapa dubbletter. Att en befintlig rad
   * hoppas över betyder också att den som skrivit en rad på ett kuverts plats
   * före infogningen får sin rad kvar. En sådan rad som fanns vid städningen
   * har redan ersatts ovan, men en som skrivs mellan städningen och
   * infogningen står kvar. Därför läses varje flyttat chiffer tillbaka nedan.
   */
  await votesDb.encryptedVote.createMany({
    data: placed.map((envelope) => ({
      id: envelope.urnId,
      ballotId: envelope.ballotId,
      ciphertext: envelope.ciphertext as Prisma.InputJsonValue,
      proofs: envelope.proofs as Prisma.InputJsonValue,
      ciphertextHash: envelope.ciphertextHash,
    })),
    skipDuplicates: true,
  })

  // --- 5. Urnan måste vara exakt det validerade FÖRE raderingen -----------
  const mismatch = await urnMismatch(ballotIds, placed)

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
 *
 * ERSÄTTNINGARNA FÖLJER MED BESKEDET (fixrunda 1 och 2 av 11d, ruling 126).
 * En rad i röstdatabasen som ersatts med det validerade innehållet tyder på
 * ett angrepp, och chifferhashen pekar ut vilket kuvert det gällde medan
 * kopplingen finns kvar. Avbryts körningen efter ersättningen, eller svarar
 * den `already_closed` för att en annan stängning hunnit skala, hittar ingen
 * omkörning raden igen. Chifferhasharna läggs därför på svaret här, där hela
 * körningen syns: i `closed`, i `already_closed` och på felet.
 *
 * SKALNINGEN GÖRS BESTÄNDIG AV LÅSETS COMMIT (fixrunda 2 av 11d, ruling 128),
 * och kontrolleras därför här, när låsets transaktion är avslutad, se
 * `confirmStripped`.
 */
export async function closeElection(electionId: string): Promise<CloseOutcome> {
  const urn: UrnChanges = { residueRemoved: [], urnRowsReplaced: [] }

  try {
    const locked = await withClosingLock(electionId, (lock) => closeUnderLock(electionId, lock, urn))
    if (!locked.taken) return { status: 'in_progress' }
    if (locked.value.kind === 'stripped') return await confirmStripped(electionId, locked.value, urn)
    return withReplacements(locked.value.outcome, urn)
  } catch (error) {
    if (error instanceof CloseAbortedError) error.urnRowsReplaced = [...urn.urnRowsReplaced]
    throw error
  }
}

/**
 * `already_closed` bär ersättningarna när körningen gjort några (fixrunda 2 av
 * 11d, omgranskningens AC1). Annars svarar körningen med det den kom fram till.
 */
function withReplacements(outcome: CloseOutcome, urn: UrnChanges): CloseOutcome {
  if (outcome.status !== 'already_closed' || urn.urnRowsReplaced.length === 0) return outcome
  return { status: 'already_closed', urnRowsReplaced: [...urn.urnRowsReplaced] }
}

/**
 * Vad stängningen kom fram till under låset.
 *
 * `outcome`   ett utfall som redan är kontrollerat
 * `stripped`  skalningens satser gick igenom i låsets transaktion. De blir
 *             beständiga när transaktionen gör COMMIT, och utfallet
 *             kontrolleras efteråt, i `confirmStripped`.
 */
type UnderLock =
  | { kind: 'outcome'; outcome: CloseOutcome }
  | { kind: 'stripped'; moved: number; cleared: number; envelopeRoot: string }

async function closeUnderLock(electionId: string, lock: ClosingLock, urn: UrnChanges): Promise<UnderLock> {
  /**
   * INGET SOM KASTAR INUTI `prepareClose` HAR RADERAT KOPPLINGEN, MEN "ORÖRD"
   * SÄGS FÖRST NÄR FASEN OCH LÅSET BEKRÄFTAR DET.
   *
   * Att den här körningen inte raderat något är en egenskap hos VAR I FLÖDET
   * felet uppstod, inte hos vilken funktion som råkade kasta — `prepareClose`
   * läser, validerar, verifierar och skriver fasen och till den anonyma sidan,
   * men rör aldrig `pending_vote`. Därför sätts påståendet här, på gränsen, i
   * stället för vid varje enskilt anropsställe. En uppräkning av anropsställen
   * hade ruttnat vid nästa ändring; gränsen gör det inte.
   *
   * Att ingen ANNAN stängning raderat kopplingen följer bara av låset, och
   * fram till fixrunda 1 av 11d frågades det inte här (V1). Granskarens prob
   * tappade låset medan kuverten lästes, lät en andra stängning skala och
   * kastade sedan ett vanligt fel. Beskedet blev "ORÖRD", fast kopplingen var
   * raderad. Nu går felet genom `abortWithoutDeletion`, som läser fasen och
   * frågar låset efteråt, se `verdictFor`.
   *
   * Undantagen kastar redan en `CloseAbortedError` och släpps igenom
   * oförändrade. De har antingen gått genom samma beslut, eller gäller ett
   * tillstånd där fasen och roten inte stämmer med varandra, eller en radering
   * i röstdatabasen som låset inte täckte hela vägen, se `removeFromUrn`.
   *
   * GRÄNSEN ÄR `prepareClose`, INTE SKALNINGEN. Det är anropet nedan som drar
   * den. En framtida rad som hamnar mellan det här catch-blocket och
   * skalningen ligger utanför skyddet: kastar den blir felet inte en
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
    preparation = await prepareClose(electionId, lock, urn)
  } catch (error) {
    if (error instanceof CloseAbortedError) throw error

    return {
      kind: 'outcome',
      outcome: await abortWithoutDeletion(electionId, lock, 'Stängningen avbröts innan skalningen inleddes.', {
        cause: error,
      }),
    }
  }

  if (preparation.kind === 'settled') return { kind: 'outcome', outcome: preparation.outcome }

  const { envelopeRoot, moved, ballotIds, movedByBallot, envelopes } = preparation

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
   * SKALNINGEN KÖRS I LÅSETS TRANSAKTION (fixrunda 2 av 11d, ruling 128).
   * Satserna går på låsets anslutning, efter en sparpunkt, och blir beständiga
   * först när låsets transaktion gör COMMIT, tillsammans. En stängning vars lås
   * gått förlorat kan alltså inte heller skala: dess satser kastar eller når
   * aldrig någon COMMIT. Före rundan hade skalningen en egen transaktion, och
   * omgranskningens prob Z1 lät en sådan stängning skala medan en annan höll
   * låset. Se `withClosingLock`.
   *
   * STRIPPED SKRIVS MED JÄMFÖR-OCH-SÄTT, SOM FÖRSTA SATS (uppgift 11d). Från
   * VALIDATED och bara med oskriven rot, så att två stängningar inte båda kan
   * skala och ingen fas går baklänges. Villkoret på roten är samtidigt
   * skriv-en-gång: en redan publicerad rot får aldrig ersättas. Satsen kommer
   * först, eftersom den låser omröstningens rad för resten av transaktionen.
   * En annan stängnings övergång till VALIDATED, och därmed dess städning,
   * väntar då tills låsets transaktion är klar, och ser sedan STRIPPED. Att
   * STRIPPED står före raderingen i texten spelar ingen roll för utfallet:
   * transaktionen blir synlig som en helhet vid COMMIT, eller inte alls.
   *
   * MARKERINGEN "HAR RÖSTAT" SKRIVS UR DE KUVERT SOM RADERAS, FÖRE RADERINGEN
   * (spec 3.1 punkt 6). Se `markEnvelopesAsVoted`.
   *
   * RADERINGEN TAR EXAKT DE FLYTTADE KUVERTEN, OCH ANTALEN PRÖVAS FÖRE COMMIT
   * (granskningen av uppgift 14f, K1, och uppgift 11d). Kuverten raderas efter
   * id och chifferhash, och antalet raderade ska vara antalet flyttade, med
   * ingenting kvar på omröstningens valsedlar. Antalet markeringar ska vara
   * antalet flyttade, totalt och per valsedel. Varje avvikelse kastar, och då
   * förs transaktionen tillbaka till sparpunkten, med raderingen och
   * markeringarna. Se `EnvelopesChangedError`.
   *
   * Revisionsposten ligger med inuti, sist. En rollback tar då posten med sig
   * — en logg som påstår att kopplingen raderats när den ligger kvar vore
   * värre än ingen logg alls.
   *
   * TIDSGRÄNSEN är låsets, sex timmar. Före ruling 128 hade skalningen egna två
   * minuter, valda för att rymma en radering av hundratusentals kuvert. Låsets
   * gräns är längre än så, och ett lås som går ut tar skalningen med sig.
   */
  const stripping = await lock.strip(async (tx) => {
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
  })

  if (stripping.outcome === 'done') {
    return { kind: 'stripped', moved, cleared: stripping.value, envelopeRoot }
  }

  /**
   * SKALNINGEN GICK INTE IGENOM, OCH DEN HÄR KÖRNINGEN HAR INTE RADERAT NÅGOT.
   *
   * Satserna körs i låsets transaktion, som inte har gjort COMMIT. Är den förd
   * tillbaka till sparpunkten hålls låset fortfarande, och beskedet kommer ur
   * fasen, som för ett avbrott i förberedelsen. `EnvelopesChangedError` och
   * `PhaseMovedError` kastar satserna själva, och deras text säger vad som
   * ändrats, se `settleRolledBack`. Är transaktionen förlorad hålls inte låset
   * heller, och en annan stängning kan ha tagit över. Då är beskedet det
   * försiktiga, också om den här körningen bevisligen inte raderat något.
   */
  if (stripping.outcome === 'lost') {
    throw new CloseAbortedError(
      'unknown',
      'Stängningen avbröts i skalningen: låsets transaktion, som skalningen körs i, gick ' +
        'förlorad innan den gjorde COMMIT. Den här körningen har alltså inte raderat något, men ' +
        'låset hålls inte längre, och en annan stängning kan ha tagit över.',
      { cause: stripping.error },
    )
  }
  if (stripping.error instanceof EnvelopesChangedError || stripping.error instanceof PhaseMovedError) {
    return { kind: 'outcome', outcome: await settleRolledBack(electionId, lock, stripping.error) }
  }
  return {
    kind: 'outcome',
    outcome: await abortWithoutDeletion(
      electionId,
      lock,
      'Stängningen avbröts i skalningen, och satserna fördes tillbaka till sparpunkten i låsets ' +
        'transaktion, så den här körningen har inte raderat något.',
      { cause: stripping.error },
    ),
  }
}

/**
 * --- 7. STÄNGNINGEN KONTROLLERAR SITT EGET UTFALL ----------------------
 *
 * ATT SÄGA ATT KOPPLINGEN ÄR RADERAD ÄR DET MEST KONSEKVENSRIKA BESKED
 * SYSTEMET KAN GE. Det måste vara kontrollerat, aldrig antaget.
 *
 * Bakgrunden är konkret (fixrunda 2 av uppgift 11): en revisionsskrivning som
 * fallerade inuti transaktionen sveptes undan av `recordAuditEvent`s
 * svälj-gren. Callbacken returnerade normalt, PostgreSQL gjorde om COMMIT till
 * ROLLBACK utan att fela, och `$transaction` RESOLVADE — varpå stängningen
 * svarade `closed` medan kuverten låg kvar, roten var oskriven och fasen stod
 * kvar. Administratören fick veta att valhemligheten uppstått när den inte
 * hade det.
 *
 * `recordAuditEvent` kastar numera i det läget, och sedan ruling 128 prövar
 * `withClosingLock` transaktionen innan COMMIT. Den här kontrollen stänger
 * ändå hela klassen: vilken framtida väg som helst som får transaktionen att
 * tyst rulla tillbaka fångas här, av att det påstådda tillståndet inte finns
 * i databasen.
 *
 * EFTER LÅSETS COMMIT (fixrunda 2 av 11d, ruling 128). Skalningen görs
 * beständig av låsets COMMIT, så kontrollen görs när låset redan är släppt.
 * Står skrivningarna inte där är beskedet därför det försiktiga: utan lås kan
 * en annan stängning ha börjat. Före rundan kunde den här grenen säga "orörd",
 * eftersom låset fortfarande hölls när kontrollen gjordes.
 *
 * KASTAR I STÄLLET FÖR EN NY `CloseOutcome`-GREN. Varje gren i `CloseOutcome`
 * beskriver ett begripligt tillstånd hos omröstningen — för tidigt, redan
 * stängd, en avvikelse att utreda. "Skrivningen försvann utan att någon
 * felade" är inget sådant tillstånd; det är ett brutet antagande, samma sort
 * som återläsningen i steg 5 redan kastar på.
 *
 * LÄSNINGEN LIGGER EFTER COMMITEN, OCH DESS EGET FEL BETYDER NÅGOT HELT
 * ANNAT ÄN DESS SVAR (fixrunda 3 av uppgift 11).
 *
 * Fallerar den här läsningen — tappad anslutning, pool-timeout, en omstart
 * mellan COMMIT och SELECT — har transaktionen redan gått igenom eller inte,
 * och vi kan inte veta vilket. Att låta det felet falla i samma gren som
 * "kontrollen visade rollback" hade fått stängningen att påstå att kopplingen
 * är ORÖRD i ett läge där den mycket väl kan vara raderad.
 *
 * Ingen dataförlust sker i något av fallen, och en omkörning är ofarlig: har
 * stängningen gått igenom står fasen i STRIPPED och nästa körning svarar
 * `already_closed`.
 */
async function confirmStripped(
  electionId: string,
  stripped: { moved: number; cleared: number; envelopeRoot: string },
  urn: UrnChanges,
): Promise<CloseOutcome> {
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
    return {
      status: 'closed',
      moved: stripped.moved,
      cleared: stripped.cleared,
      envelopeRoot: stripped.envelopeRoot,
      residueRemoved: urn.residueRemoved,
      urnRowsReplaced: urn.urnRowsReplaced,
    }
  }

  /**
   * TEXTEN FÖLJER FASEN (fixrunda 3 av 11d, omgranskningens nytt fel 3). Står
   * fasen efter STRIPPED med roten skriven är kopplingen raderad, men fasen har
   * skrivits vidare förbi stängningen, och beskedet säger det. Förut sade
   * texten först att skalningens skrivningar saknades och sedan att
   * kopplingen var raderad.
   */
  const verdict = verdictFor(after, false)
  if (verdict.kind === 'cleared') {
    throw new CloseAbortedError(
      'unknown',
      'Stängningen kunde inte bekräftas: låsets transaktion gjorde COMMIT, och kuvertroten är ' +
        `skriven, men fasen står i ${after.phase} i stället för STRIPPED. Någon har skrivit fasen ` +
        'förbi stängningen efter skalningen.',
    )
  }
  throw new CloseAbortedError(
    'unknown',
    'Stängningen kunde inte bekräftas: låsets transaktion gjorde COMMIT, men skalningens ' +
      `skrivningar finns inte i röstlängden. ${verdict.statement}`,
  )
}
