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
 * registreringen med också till kod som skrivs senare, som förtroendemännens
 * partiella dekryptering i uppgift 12: den som hämtar `partiallyDecrypt`
 * härifrån får andelen exponentierad i OpenSSL.
 *
 * Röstsidan får aldrig importera modulen, och kan inte: den drar in node:crypto,
 * vilket tests/security/browser-bundle.test.ts stoppar.
 */
registerGroupExponentiation(nativeModPow)

export { generateKeyPair } from './elgamal'
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

let running = 0
const waiting: Array<() => void> = []

/**
 * Kör uppgiften när det finns en plats, i den ordning uppgifterna kom.
 *
 * Platsen lämnas vidare i `finally`, så en verifiering som kastar på ett
 * missformat tal läcker aldrig en plats.
 */
export async function inVerificationTurn<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_VERIFICATIONS) {
    await new Promise<void>((resolve) => waiting.push(resolve))
  } else {
    running += 1
  }

  try {
    return await task()
  } finally {
    // Platsen går direkt till nästa i kön, så att ingen som kommer in under
    // tiden hinner före.
    const next = waiting.shift()
    if (next) next()
    else running -= 1
  }
}

/** Pågående och väntande verifieringar, för testerna. */
export function verificationQueueState(): { running: number; waiting: number } {
  return { running, waiting: waiting.length }
}

/** Släpper fram väntande I/O innan nästa steg, till skillnad från ett löfte som redan är uppfyllt. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Verifierar en valsedel på servern: i OpenSSL, i steg och i tur och ordning.
 *
 * Samma kontroller och samma svar som `verifyEncryptedBallot` i
 * verify-ballot.ts. En riksdagsvalsedel med 26 alternativ tar omkring 0,4 s,
 * och händelseslingan står aldrig still längre än ett steg åt gången.
 */
export function verifyEncryptedBallotOnServer(
  publicKey: string,
  electionId: string,
  ballotId: string,
  expectedLength: number,
  ballot: EncryptedBallot,
): Promise<boolean> {
  return inVerificationTurn(() =>
    verifyEncryptedBallotInSteps(
      publicKey,
      electionId,
      ballotId,
      expectedLength,
      ballot,
      yieldToEventLoop,
    ),
  )
}
