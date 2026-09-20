import { encodeCrockfordBase32, normaliseCrockfordBase32 } from '@/lib/base32'
import { secureRandomBytes, sha256Hex } from '@/lib/crypto'

/**
 * Röst-token.
 *
 * Token är väljarens enda sätt att i efterhand kontrollera att rösten
 * registrerats. Den är därför en ren bärarhemlighet: den som har token kan se
 * vad rösten avsåg, och ingen annan kan det.
 *
 * TOKEN INNEHÅLLER INGEN INFORMATION.
 *
 * Den härleds inte från personnummer, väljar-id, sessions-id, tidpunkt, parti
 * eller IP-adress. Den är 240 slumpbitar och ingenting annat. Det är en
 * förutsättning för anonymiteten: en token som kodade in exempelvis en
 * tidsstämpel eller ett löpnummer skulle räcka för att sortera rösterna i
 * samma ordning som väljarna legitimerade sig, och därmed återskapa
 * kopplingen.
 */

/**
 * 30 byte = 240 bitar.
 *
 * Ger exakt 48 base32-tecken utan utfyllnad. Entropin är långt bortom vad som
 * går att uttömma: även med 10^12 gissningar per sekund i miljarder år ligger
 * sannolikheten att träffa en giltig token nära noll. Gränsen för antal
 * verifieringsförsök finns därför inte för att stoppa gissning, utan för att
 * stoppa uppräkning som lastangrepp.
 */
const TOKEN_BYTES = 30
const GROUP_SIZE = 8

/**
 * Genererar en ny token.
 *
 * `randomBytes` från Node:s crypto-modul är en kryptografiskt säker
 * slumpkälla (CSPRNG från operativsystemet). `Math.random` är det inte, och
 * skulle här göra tokens förutsägbara för den som sett tillräckligt många —
 * vilket vore liktydigt med att kunna läsa andras röster.
 */
export function generateVoteToken(): { token: string; canonical: string; tokenHash: string } {
  const raw = encodeCrockfordBase32(secureRandomBytes(TOKEN_BYTES))
  const token = groupForDisplay(raw)

  return {
    token,
    canonical: raw,
    tokenHash: hashToken(raw),
  }
}

/** Grupperar i block om åtta tecken så att den går att läsa upp och skriva av. */
function groupForDisplay(canonical: string): string {
  const groups: string[] = []
  for (let index = 0; index < canonical.length; index += GROUP_SIZE) {
    groups.push(canonical.slice(index, index + GROUP_SIZE))
  }
  return groups.join('-')
}

/** Normaliserar en token som en människa skrivit av. Se lib/base32.ts. */
export function normaliseToken(input: string): string {
  return normaliseCrockfordBase32(input)
}

/**
 * Hashar en token för lagring.
 *
 * Endast hashen lagras. Klartexten finns hos väljaren och ingen annanstans.
 *
 * Här används ren SHA-256, inte en långsam lösenordshash som Argon2. Det är
 * ett medvetet val: långsam hashning skyddar mot uttömmande sökning av
 * hemligheter med låg entropi, som lösenord. En token med 240 slumpbitar har
 * ingen sådan svaghet, och en långsam hash skulle bara göra verifieringen
 * dyrare utan att höja säkerheten.
 */
export function hashToken(canonicalOrRaw: string): string {
  return sha256Hex(normaliseToken(canonicalOrRaw))
}
