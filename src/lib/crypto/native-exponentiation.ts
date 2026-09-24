import { createDiffieHellman, type DiffieHellman } from 'node:crypto'
import { G, P, bigintModPow } from './group'

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
 * Varje fall som OpenSSL inte räknar på går till `bigintModPow`, med samma
 * svar. Jämförelsen mot BigInt, på slumpade indata och på varje gränsfall,
 * står i testet ovan.
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
 * bas^exponent mod p i OpenSSL, eller null när OpenSSL inte lämnar ut svaret.
 *
 * Förutsätter 2 ≤ bas ≤ p − 2 och exponent ≥ 1. Null betyder i praktiken att
 * resultatet var 1 eller p − 1; se `nativeModPow` för hur det avgörs.
 */
function opensslModPow(base: bigint, exponent: bigint): bigint | null {
  const dh = diffieHellman()
  const secret = toBytes(exponent)

  try {
    dh.setPrivateKey(secret)
    const shared = dh.computeSecret(toBytes(base))

    // En tom buffert är OpenSSL:s vägran, inte talet noll. Noll kan inte heller
    // vara ett riktigt svar: basen är inverterbar mod p, och då är varje
    // potens av den det också.
    if (shared.length === 0 || shared.length > PRIME_BYTES) return null
    const value = BigInt('0x' + shared.toString('hex'))
    return value === 0n ? null : value
  } catch {
    return null
  } finally {
    secret.fill(0)
    dh.setPrivateKey(PLACEHOLDER_KEY)
  }
}

/**
 * bas^exponent mod p, med exakt samma svar som `bigintModPow(bas, exponent, P)`.
 *
 * Registreras som gruppens exponentiering av src/lib/crypto/server.ts.
 */
export function nativeModPow(base: bigint, exponent: bigint): bigint {
  // Negativa tal och exponenten 0 når aldrig OpenSSL. BigInt ger där samma svar
  // som förut, utan att räkna något: 1 för exponenten 0.
  if (base < 0n || exponent <= 0n) return bigintModPow(base, exponent, P)

  // bigintModPow börjar själv med bas mod p, så att reducera här ändrar inget.
  const reduced = base % P
  if (reduced <= 1n || reduced >= P - 1n) return bigintModPow(reduced, exponent, P)

  const direct = opensslModPow(reduced, exponent)
  if (direct !== null) return direct

  /**
   * RESULTATET VAR 1 ELLER p − 1, OCH OPENSSL LÄMNAR INTE UT NÅGOT AV DEM.
   *
   * Ett steg till avgör vilket: bas^(e+1) = bas · bas^e, alltså basen själv om
   * bas^e = 1 och p − bas om bas^e = −1. Båda ligger i [2, p − 2] när basen gör
   * det, så OpenSSL svarar på det andra anropet. Utan den här vägen hade en
   * klient kunnat skicka exponenter som är multipler av q, och tvinga varje
   * sådan exponentiering till BigInt, 25 gånger långsammare.
   *
   * Stämmer ingetdera har OpenSSL vägrat av något annat skäl. Då räknar BigInt,
   * långsamt men rätt.
   */
  const next = opensslModPow(reduced, exponent + 1n)
  if (next === reduced) return 1n
  if (next === P - reduced) return P - 1n

  return bigintModPow(reduced, exponent, P)
}
