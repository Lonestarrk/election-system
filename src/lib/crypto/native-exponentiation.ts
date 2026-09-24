import { createDiffieHellman, type DiffieHellman } from 'node:crypto'
import { logger } from '../logger'
import { G, P, bigintModPow, rejectNegativeExponent } from './group'

/**
 * EXPONENTIERING I OPENSSL, GENOM DIFFIE–HELLMAN. BARA PÅ SERVERN.
 *
 * VARFÖR
 *
 * Ren BigInt i Node 22 tar omkring 40 ms för en exponentiering med 2048 bitar
 * (spec 4.1). En riksdagsvalsedel med 26 alternativ krävde omkring 290 för att
 * verifieras, alltså elva sekunder, och under den tiden stod händelseslingan
 * still för alla andra besökare. OpenSSL gör samma räkning på omkring 1,4 ms,
 * och verifieringen tar nu 0,4 s med 264 exponentieringar.
 *
 * node:crypto har ingen modexp, men Diffie–Hellman är en: `computeSecret(y)`
 * räknar y^x mod p, där x är objektets privata nyckel. Med x satt till
 * exponenten och y till basen blir det precis bas^exponent mod p. Inget nytt
 * beroende behövs.
 *
 * FÄLLORNA, PRÖVADE EN OCH EN I tests/unit/crypto/native-exponentiation.test.ts
 *
 *   – `computeSecret` kastar för en bas utanför [2, p − 2]. Basen 0, 1 och
 *     p − 1 räknas därför i BigInt, där de är triviala.
 *   – Blir resultatet 1 eller p − 1 kastar den INTE, utan lämnar en tom buffert.
 *     Det är OpenSSL:s skydd mot svaga DH-hemligheter. En tom buffert får
 *     aldrig läsas som ett tal, och fallet löses med ett anrop till, se
 *     `nativeModPow`.
 *   – Ett objekt skapat med generatorn 2 känns igen som RFC 3526:s namngivna
 *     grupp. Då sätter OpenSSL själv q och prövar varje bas mot undergruppen,
 *     vilket dubblar tiden och vägrar varje bas utanför den. Med generatorn 4,
 *     vår egen g, känns gruppen inte igen, och basen prövas bara mot
 *     intervallet. Undergruppskontrollen är fortfarande vår egen,
 *     `isInSubgroup`, och den går först, precis som förut.
 *   – Att skapa ett objekt med en grupp OpenSSL inte känner igen kostar
 *     omkring 170 ms, eftersom Node låter OpenSSL primtalspröva p och (p − 1)/2.
 *     Objektet skapas därför en gång och återanvänds. Då kan OpenSSL också
 *     behålla sina förberäknade konstanter för p mellan anropen.
 *
 * Baserna 0, 1 och p − 1, negativa baser och exponenten 0 går till
 * `bigintModPow`, där de är triviala. Allt annat räknas i OpenSSL. Svarar
 * OpenSSL med något annat än ett tal eller den tomma bufferten är skälet
 * okänt: då räknas svaret i BigInt, med samma svar, och det loggas en gång, se
 * `reportUnexpectedFallback`. En negativ exponent kastar, som i
 * `bigintModPow`. Jämförelsen mot BigInt, på slumpade indata och på varje
 * gränsfall, står i testet ovan.
 *
 * HEMLIGA EXPONENTER
 *
 * Valets privata nyckel och förtroendemännens andelar är exponenter här, i
 * nyckelgenereringen och i den partiella dekrypteringen. OpenSSL räknar
 * DH:s privata nyckel i konstant tid (BN_FLG_CONSTTIME), vilket kvadrera och
 * multiplicera i ren BigInt inte gör: där beror tiden på exponentens bitar.
 * scripts/measure-crypto.ts visar skillnaden med två lika långa exponenter,
 * en med två ettor och en med bara ettor.
 * Omvandlingen mellan bigint och bytes sker fortfarande i JavaScript, och den
 * är inte prövad för konstant tid. Efter varje anrop skrivs den privata nyckeln
 * i objektet över, och bufferten med exponenten nollställs, så att en andel
 * inte blir liggande i det återanvända objektet till nästa anrop.
 */

const PRIME_BYTES = (P.toString(16).length + 1) >> 1

function toBytes(value: bigint): Buffer {
  const hex = value.toString(16)
  return Buffer.from(hex.length % 2 === 0 ? hex : '0' + hex, 'hex')
}

/** Ett offentligt värde att lämna i objektet mellan anropen. */
const PLACEHOLDER_KEY = toBytes(1n)

let engine: DiffieHellman | null = null

function diffieHellman(): DiffieHellman {
  engine ??= createDiffieHellman(toBytes(P), toBytes(G))
  return engine
}

/**
 * OpenSSL:s vägran att lämna ut en DH-hemlighet som är 1 eller p − 1: en tom
 * buffert, utan undantag. Det är det enda sätt att vägra som är känt och
 * prövat (se testet ovan), och det löses i OpenSSL, se `nativeModPow`.
 */
const REFUSED = Symbol('OpenSSL lämnade inte ut svaret')

/**
 * bas^exponent mod p i OpenSSL, eller REFUSED när OpenSSL inte lämnar ut svaret.
 *
 * Förutsätter 2 ≤ bas ≤ p − 2 och exponent ≥ 1. REFUSED betyder att resultatet
 * var 1 eller p − 1. Allt annat än ett tal eller den tomma bufferten kastar,
 * också ett undantag ur node:crypto, eftersom inget av det är känt för de här
 * indata.
 */
function opensslModPow(base: bigint, exponent: bigint): bigint | typeof REFUSED {
  const dh = diffieHellman()
  const secret = toBytes(exponent)

  try {
    dh.setPrivateKey(secret)
    const shared = dh.computeSecret(toBytes(base))

    // En tom buffert är OpenSSL:s vägran, inte talet noll.
    if (shared.length === 0) return REFUSED

    // Noll kan inte vara ett riktigt svar: basen är inverterbar mod p, och då
    // är varje potens av den det också. Ett svar från p och uppåt kan inte
    // heller vara det. Talen själva står inte i felet, eftersom exponenten kan
    // vara en förtroendemans andel.
    const value = BigInt('0x' + shared.toString('hex'))
    if (shared.length > PRIME_BYTES || value === 0n || value >= P) {
      throw new Error(`OpenSSL gav ett svar på ${shared.length} byte som inte kan vara en potens.`)
    }
    return value
  } finally {
    secret.fill(0)
    dh.setPrivateKey(PLACEHOLDER_KEY)
  }
}

/**
 * ETT OKÄNT SKÄL ATT FALLA TILLBAKA LOGGAS, EN GÅNG.
 *
 * Förut svaldes varje undantag ur OpenSSL, och allt räknades tyst i BigInt:
 * rätt, men 25 gånger långsammare och inte i konstant tid för en hemlig
 * exponent. Ändrar Node eller OpenSSL sitt beteende märker testsviten det,
 * men i drift hade ingenting syntes (granskningen av uppgift 14b, MINDRE 8).
 *
 * Nu faller bara det okända tillbaka på BigInt: ett undantag, ett svar som inte
 * kan vara en potens, eller ett andra anrop som inte avgör om svaret var 1
 * eller p − 1. Svaret blir fortfarande rätt, så att ingen röst underkänns fel,
 * och det loggas en gång per process: händer det en gång händer det troligen
 * vid varje exponentiering, och en rad per anrop hade dränkt loggen. Basen och
 * exponenten loggas aldrig.
 */
let unexpectedFallbackReported = false

function reportUnexpectedFallback(error: unknown): void {
  if (unexpectedFallbackReported) return
  unexpectedFallbackReported = true

  logger.error(
    'OpenSSL räknade inte en exponentiering, av ett okänt skäl. Den räknas i BigInt i stället: ' +
      'rätt, men långsamt och inte i konstant tid för en hemlig exponent. Loggas bara en gång.',
    { error },
  )
}

/** Endast för tester: nästa okända skäl loggas igen. */
export function resetUnexpectedFallbackReport(): void {
  unexpectedFallbackReported = false
}

/**
 * bas^exponent mod p, med exakt samma svar som `bigintModPow(bas, exponent, P)`.
 *
 * Registreras som gruppens exponentiering av src/lib/crypto/server.ts.
 */
export function nativeModPow(base: bigint, exponent: bigint): bigint {
  // Som i bigintModPow, och innan något annat: en negativ exponent har kommit
  // förbi tolkningen och får inte räknas som 1.
  rejectNegativeExponent(exponent)

  // Negativa baser och exponenten 0 når aldrig OpenSSL. BigInt ger där samma
  // svar som förut, utan att räkna något: 1 för exponenten 0.
  if (base < 0n || exponent === 0n) return bigintModPow(base, exponent, P)

  // bigintModPow börjar själv med bas mod p, så att reducera här ändrar inget.
  const reduced = base % P
  if (reduced <= 1n || reduced >= P - 1n) return bigintModPow(reduced, exponent, P)

  try {
    const direct = opensslModPow(reduced, exponent)
    if (direct !== REFUSED) return direct

    /**
     * RESULTATET VAR 1 ELLER p − 1, OCH OPENSSL LÄMNAR INTE UT NÅGOT AV DEM.
     *
     * Ett steg till avgör vilket: bas^(e+1) = bas · bas^e, alltså basen själv om
     * bas^e = 1 och p − bas om bas^e = −1. Båda ligger i [2, p − 2] när basen gör
     * det, så OpenSSL svarar på det andra anropet. Utan den här vägen hade en
     * klient kunnat skicka exponenter som är multipler av q, och tvinga varje
     * sådan exponentiering till BigInt, 25 gånger långsammare.
     *
     * Stämmer ingetdera har OpenSSL vägrat av ett skäl som inte är känt.
     */
    const next = opensslModPow(reduced, exponent + 1n)
    if (next === reduced) return 1n
    if (next === P - reduced) return P - 1n

    throw new Error(
      'OpenSSL vägrade ett svar, och ett anrop till visade att det inte var 1 eller p − 1.',
    )
  } catch (error) {
    reportUnexpectedFallback(error)
    return bigintModPow(reduced, exponent, P)
  }
}
