import { registerGroupExponentiation } from './group'
import { nativeModPow } from './native-exponentiation'
import { verifyEncryptedBallotInSteps, type EncryptedBallot } from './verify-ballot'

/**
 * SERVERNS INGÅNG TILL KRYPTOT.
 *
 * Klienten och servern delar all kryptokod, men servern ska räkna i OpenSSL och
 * inte i ren BigInt: 1,4 ms i stället för 40 ms per exponentiering, och i
 * konstant tid när exponenten är hemlig. OpenSSL nås genom node:crypto, som
 * inte får finnas i röstsidans bunt. Därför kopplas det in här, och bara här.
 *
 * Att importera den här modulen registrerar OpenSSL som gruppens
 * exponentiering, för hela modulgrafen den ingår i. Varje serverfil som
 * verifierar en valsedel eller räknar med en hemlig exponent hämtar funktionen
 * härifrån i stället för ur den delade modulen, och
 * tests/security/server-crypto.test.ts håller dem till det. Så följer
 * registreringen med också till kod som skrivs senare. Räkningen i uppgift 12
 * hämtar `partiallyDecrypt` härifrån och får andelen exponentierad i OpenSSL,
 * och undergruppskontrollen av urnans chiffer och den diskreta logaritmen
 * räknas där också.
 *
 * Röstsidan får aldrig importera modulen, och kan inte: den drar in node:crypto,
 * vilket tests/security/browser-bundle.test.ts stoppar.
 */
registerGroupExponentiation(nativeModPow)

export { discreteLog, generateKeyPair } from './elgamal'
export { isInSubgroup } from './group'
export { combine, partiallyDecrypt, publicShare, splitSecret, verifyPartialDecryption } from './threshold'

/**
 * Hur många verifieringar som får pågå samtidigt.
 *
 * Verifieringen körs i steg, och mellan stegen släpps händelseslingan fram.
 * Men varje pågående verifiering kör ett steg per varv i slingan, så med tjugo
 * samtidiga väntar en annan besökares begäran tjugo steg mellan varje
 * I/O-händelse. Taket håller den väntan kort, två steg, alltså omkring 25 ms,
 * hur många som än röstar samtidigt. Resten väntar i tur och ordning.
 *
 * DE 25 MS GÄLLER TAL INOM SINA INTERVALL, och bara sådana tal räknas. Ett
 * steg är högst åtta exponentieringar med exponenter under q. Före fixrunda 1
 * hade talen ingen längdgräns, och granskaren lät en giltig valsedel med fyra
 * tal förlängda med k·q stå still i 5,45 s i ett enda steg. Nu underkänner
 * tolkningen i verify-ballot.ts ett sådant tal innan något räknas med det.
 *
 * Fler än två ger ingen genomströmning: allt räknas i samma tråd. Två och inte
 * en, så att en ovanligt stor valsedel, eller en konstruerad med de 200
 * alternativ som schemat tillåter, inte får hela kön att vänta bakom sig. Samma
 * tanke som inträdeskön för hashningen (src/lib/admission-queue.ts), fast med
 * ett lägre tak, eftersom hashningen körs i libuv:s trådpool och det här inte
 * gör det.
 *
 * Kön är per process, med samma begränsning som inträdeskön.
 */
export const MAX_CONCURRENT_VERIFICATIONS = 2

/**
 * Hur många verifieringar åt besökare som får vänta på sin tur.
 *
 * VARFÖR ETT TAK (granskningen av uppgift 14b, MINDRE 3)
 *
 * Utan tak växte kön utan gräns. Varje väntande håller sin valsedel i minnet,
 * omkring 170 kB för en riksdagsvalsedel, och väntan växer med omkring 0,4 s
 * för varje riksdagsvalsedel före i kön. Tusen väntande hade varit 170 MB, och
 * sex minuter för den siste, och så länge väntar ingen väljare.
 *
 * Tjugo väntande ger som mest omkring åtta sekunders väntan och några MB. Den
 * som kommer när kön är full får 503, och röstsidan försöker igen, se
 * /api/vote/encrypted. Samma anda som inträdeskön för hashningen, med sina 300
 * platser (src/lib/admission-queue.ts). Där är en väntande bara ett löfte, och
 * hashningen körs i libuv:s trådpool. Här håller varje väntande en valsedel,
 * och varje verifiering tar tid av den enda tråden.
 *
 * TAKET GÄLLER BARA BESÖKARE. Valideringen före stängningen och
 * omverifieringen i skalningen prövar en valsedel i taget och tar därför
 * aldrig mer än en plats. De skickar ingen begäran, och får alltid vänta. En
 * full kö ska inte kunna få dem att rapportera en giltig röst som ogiltig.
 */
export const MAX_WAITING_VERIFICATIONS = 20

/** Kön är full. Rutten svarar 503, och ingenting prövas. */
export class VerificationQueueFull extends Error {
  constructor() {
    super('Verifieringskön är full.')
    this.name = 'VerificationQueueFull'
  }
}

/**
 * Besökaren gav upp innan verifieringen var klar.
 *
 * Förut prövades och lades en röst också när klienten redan hade gått, och
 * den tog en plats i kön under tiden. Nu lämnar den kön, eller stannar vid
 * nästa steg, och ingenting läggs (granskningen av uppgift 14b, MINDRE 3).
 */
export class VerificationAborted extends Error {
  constructor() {
    super('Besökaren gav upp innan verifieringen var klar.')
    this.name = 'VerificationAborted'
  }
}

/**
 * En verifiering åt en besökares begäran.
 *
 * `signal` är begärans egen, `request.signal`, som avbryts när klienten
 * stänger anslutningen.
 */
export type VerificationRequest = { signal: AbortSignal }

type Waiter = { admit: () => void }

let running = 0
const waiting: Waiter[] = []

/**
 * Kör uppgiften när det finns en plats, i den ordning uppgifterna kom.
 *
 * Görs den åt en besökare, med `request`, avvisas den när kön är full, och den
 * lämnar kön om besökaren ger upp. Utan `request` väntar den alltid.
 *
 * Platsen lämnas vidare i `finally`, så en verifiering som kastar läcker
 * aldrig en plats.
 */
export async function inVerificationTurn<T>(
  task: () => Promise<T>,
  request?: VerificationRequest,
): Promise<T> {
  if (request?.signal.aborted) throw new VerificationAborted()

  if (running >= MAX_CONCURRENT_VERIFICATIONS) {
    if (request && waiting.length >= MAX_WAITING_VERIFICATIONS) throw new VerificationQueueFull()
    await waitForTurn(request?.signal)
  } else {
    running += 1
  }

  try {
    return await task()
  } finally {
    // Platsen går direkt till nästa i kön, så att ingen som kommer in under
    // tiden hinner före.
    const next = waiting.shift()
    if (next) next.admit()
    else running -= 1
  }
}

/**
 * Väntar på en plats i kön.
 *
 * Ger besökaren upp under tiden lämnar den kön utan att ha tagit någon plats,
 * och de efter flyttar fram. Platsen lämnas alltid över i samma synkrona steg
 * som den tas ur kön, så ett avbrott kan inte komma emellan och tappa den.
 */
function waitForTurn(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const leave = () => {
      const index = waiting.indexOf(waiter)
      if (index !== -1) waiting.splice(index, 1)
      reject(new VerificationAborted())
    }
    const waiter: Waiter = {
      admit: () => {
        signal?.removeEventListener('abort', leave)
        resolve()
      },
    }

    waiting.push(waiter)
    signal?.addEventListener('abort', leave, { once: true })
  })
}

/**
 * Om en verifiering åt en besökare skulle avvisas just nu.
 *
 * /api/vote/encrypted frågar innan den hämtar BankID-ordern, eftersom ordern
 * förbrukas när den hämtas: avvisades valsedeln först efteråt hade väljaren
 * fått skriva under igen. Kön kan hinna fyllas mellan frågan och
 * verifieringen, och då avvisas den där i stället, men det fönstret är några
 * millisekunder.
 */
export function verificationQueueIsFull(): boolean {
  return running >= MAX_CONCURRENT_VERIFICATIONS && waiting.length >= MAX_WAITING_VERIFICATIONS
}

/** Pågående och väntande verifieringar, för testerna. */
export function verificationQueueState(): { running: number; waiting: number } {
  return { running, waiting: waiting.length }
}

/** Släpper fram väntande I/O innan nästa steg, till skillnad från ett löfte som redan är uppfyllt. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Som `yieldToEventLoop`, och stannar sedan om besökaren har gett upp. */
async function yieldUnlessAbandoned(signal: AbortSignal): Promise<void> {
  await yieldToEventLoop()
  if (signal.aborted) throw new VerificationAborted()
}

/**
 * Verifierar en valsedel på servern: i OpenSSL, i steg och i tur och ordning.
 *
 * Samma kontroller och samma svar som `verifyEncryptedBallot` i
 * verify-ballot.ts. En riksdagsvalsedel med 26 alternativ tar omkring 0,4 s,
 * och händelseslingan står aldrig still längre än ett steg åt gången.
 *
 * Med `request` görs verifieringen åt en besökare: den avvisas med
 * `VerificationQueueFull` när kön är full, och den avbryts med
 * `VerificationAborted`, i kön eller vid nästa steg, när besökaren ger upp.
 */
export function verifyEncryptedBallotOnServer(
  publicKey: string,
  electionId: string,
  ballotId: string,
  expectedLength: number,
  ballot: EncryptedBallot,
  request?: VerificationRequest,
): Promise<boolean> {
  const pause = request ? () => yieldUnlessAbandoned(request.signal) : yieldToEventLoop

  return inVerificationTurn(
    () =>
      verifyEncryptedBallotInSteps(publicKey, electionId, ballotId, expectedLength, ballot, pause),
    request,
  )
}
