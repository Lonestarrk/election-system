import { buildFixedBaseTable, type FixedBaseTable } from './fixed-base'

/**
 * RFC 3526 MODP Group 14, 2048 bitar.
 *
 * VARFÖR g = 4 OCH INTE RFC:ns g = 2
 *
 * Med g = 2 genereras hela multiplikativa gruppen, vars ordning är 2q. Den
 * innehåller då en undergrupp av ordning 2, och ett element därifrån läcker en
 * bit av den privata nyckeln vid varje partiell dekryptering. Efter tillräckligt
 * många röster är nyckeln utläsbar.
 *
 * g = 2² har ordning q, som är primtal, och då finns ingen liten undergrupp att
 * hamna i. Priset är att varje mottaget element måste kontrolleras — se
 * isInSubgroup.
 */
export const P = BigInt(
  '0x' +
    'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E08' +
    '8A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B' +
    '302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9' +
    'A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE6' +
    '49286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8' +
    'FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
    '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C' +
    '180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718' +
    '3995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFF' +
    'FFFFFFFF',
)

/** Undergruppens ordning. Alla exponenter räknas mod detta. */
export const Q = (P - 1n) / 2n

/** Generator av ordning q. */
export const G = 4n

/**
 * g^(−1) mod p, alltså det tal som flyttar ett chiffer av 1 till ett chiffer av 0.
 *
 * Skrivs i sluten form i stället för som g^(q−1): 4 · (p + 1)/4 = p + 1 ≡ 1, och
 * (p + 1)/4 är ett heltal eftersom p ≡ 3 (mod 4). Det är samma tal, men det
 * kostar ingen exponentiering. Bevisen behövde det en gång per alternativ, både
 * när de byggs och när de prövas.
 */
export const G_INVERSE = (P + 1n) / 4n

/**
 * Kvadrera och multiplicera, en bit i taget, i ren BigInt.
 *
 * Referensen som varje snabbare väg jämförs mot, och den väg allt faller
 * tillbaka på. Den ska inte ändras: tabellerna i fixed-base.ts och OpenSSL i
 * native-exponentiation.ts är prövade mot exakt den här funktionen, också på
 * gränsfallen, så att "samma svar" betyder samma svar för varje indata.
 */
export function bigintModPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let b = base % modulus
  let e = exponent

  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus
    b = (b * b) % modulus
    e >>= 1n
  }

  return result
}

/**
 * En snabbare exponentiering i gruppen: bas^exponent mod p.
 *
 * Den måste ge exakt samma svar som `bigintModPow(bas, exponent, P)`, för varje
 * indata. Den får alltså inte validera, avrunda eller vägra något. Validering
 * är anroparens sak och sker före, med isInSubgroup.
 */
export type GroupExponentiation = (base: bigint, exponent: bigint) => bigint

/**
 * DEN REGISTRERADE EXPONENTIERINGEN, OCH VARFÖR DEN REGISTRERAS.
 *
 * Klienten och servern delar all kryptokod: webbläsaren bygger bevisen, servern
 * prövar dem, och det är samma funktioner som gör det. Servern räknar
 * däremot i OpenSSL genom node:crypto, och det får inte hamna i röstsidans
 * bunt (tests/security/browser-bundle.test.ts). Därför importerar ingen delad
 * modul OpenSSL-vägen. Servern kopplar in den här, genom att importera
 * src/lib/crypto/server.ts.
 *
 * Utan registrering räknar allt som förut, i ren BigInt, med tabeller för de
 * fasta baserna nedan. Registreringen gäller för modulens livstid och bara
 * modulen p. Exponenter mod q, som Lagrange-koefficienterna i threshold.ts,
 * räknas alltid i BigInt.
 */
let registered: GroupExponentiation | null = null

/** Kopplar in en snabbare exponentiering, eller kopplar ur den med null (för tester). */
export function registerGroupExponentiation(implementation: GroupExponentiation | null): void {
  registered = implementation
}

/**
 * FASTA BASER I WEBBLÄSAREN.
 *
 * g och valets publika nyckel h är desamma i varje exponentiering under ett
 * val, och tre av fyra exponentieringar i krypteringen har någon av dem som
 * bas. För dem byggs en tabell första gången de används, och därefter blir en
 * exponentiering en multiplikation per fönster, se fixed-base.ts. Tabellerna
 * används bara när ingen snabbare exponentiering är registrerad, alltså i
 * webbläsaren och i tester som räknar i BigInt.
 *
 * Fyra bitar per fönster. Tabellen blir 512 · 15 = 7 680 tal, omkring 2 MB per
 * bas, och byggs på omkring 11 ms i Chromium 153. En exponentiering med den tar
 * 0,7 ms i stället för 4,4. Bredare fönster kostar mer än de ger: fem bitar är
 * 3,3 MB och 19 ms att bygga, sex bitar 5,5 MB och 31 ms, och krypteringen av en
 * riksdagsvalsedel blir ändå bara 5–10 procent snabbare. Den domineras av de 52
 * exponentieringar som har c1 eller c2 som bas, och dem hjälper ingen tabell.
 * Mätningarna står i spec 4.1 och körs med scripts/measure-crypto.ts --chromium.
 *
 * Tabellerna ligger bara i minnet, för sidans livstid. g:s tabell finns kvar,
 * och bara en publik nyckel i taget har tabell: en ny nyckel ersätter den
 * förra.
 */
export const FIXED_BASE_WINDOW_BITS = 4

const EXPONENT_BITS = P.toString(2).length

const fixedBaseTables = new Map<bigint, FixedBaseTable | null>([[G, null]])
let publicKeyBase: bigint | null = null

/**
 * Markerar valets publika nyckel som fast bas. Tabellen byggs först när den
 * används, så en server med OpenSSL registrerat bygger den aldrig.
 */
export function useFixedBase(base: bigint): void {
  if (base === G || base === publicKeyBase || base <= 1n || base >= P) return
  if (publicKeyBase !== null) fixedBaseTables.delete(publicKeyBase)
  publicKeyBase = base
  fixedBaseTables.set(base, null)
}

function fixedBaseTableFor(base: bigint): FixedBaseTable | null {
  if (!fixedBaseTables.has(base)) return null

  let table = fixedBaseTables.get(base) ?? null
  if (table === null) {
    table = buildFixedBaseTable(base, P, EXPONENT_BITS, FIXED_BASE_WINDOW_BITS)
    fixedBaseTables.set(base, table)
  }
  return table
}

export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus !== P) return bigintModPow(base, exponent, modulus)
  if (registered) return registered(base, exponent)

  return fixedBaseTableFor(base)?.pow(exponent) ?? bigintModPow(base, exponent, P)
}

/**
 * Kryptografiskt säkra slumpbytes, i Node och i webbläsaren.
 *
 * `crypto.getRandomValues` är WebCrypto och finns globalt på båda ställena,
 * med operativsystemets slumpkälla bakom. Tidigare hämtades `randomBytes` ur
 * node:crypto, men valsedeln krypteras i väljarens webbläsare, och där finns
 * inte den modulen: röstsidan gick inte att bygga. Se ./sha256.ts för samma
 * byte på hashsidan.
 *
 * Finns ingen slumpkälla kastar funktionen. Den får aldrig falla tillbaka på
 * `Math.random`: ett förutsägbart slumptal avslöjar klartexten.
 */
function secureRandomBytes(length: number): Uint8Array {
  const source = globalThis.crypto
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new Error('Ingen kryptografisk slumpkälla finns i den här miljön.')
  }
  return source.getRandomValues(new Uint8Array(length))
}

/**
 * Enhetligt slumptal i [1, q-1].
 *
 * Avvisning i stället för modulo: slumpbytes modulo q ger en snedfördelning
 * mot små tal, och ett förutsägbart slumptal i ElGamal avslöjar klartexten.
 */
export function randomScalar(): bigint {
  const byteLength = (Q.toString(16).length + 1) >> 1

  for (;;) {
    const hex = Array.from(secureRandomBytes(byteLength), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    const candidate = BigInt('0x' + hex)
    if (candidate > 0n && candidate < Q) return candidate
  }
}

/**
 * Ligger värdet i undergruppen av ordning q?
 *
 * REVIEW FOCUS 1. Ett chiffer utanför undergruppen är inte ett räknefel utan ett
 * angrepp: det låter en klient läcka en bit av tröskelnyckeln per röst.
 *
 * KONTROLLEN ÄR FORTFARANDE y^q ≡ 1, RÄKNAD SOM y^(q−1) · y.
 *
 * Det är samma tal, räknat i två steg. Omvägen finns för servern, som räknar i
 * OpenSSL. Där lämnas resultatet 1 aldrig ut, eftersom Diffie–Hellman vägrar en
 * hemlighet som är 1 eller p − 1, och y^q är 1 för just varje giltigt element.
 * Räknat rakt på hade varje kontroll krävt ett anrop till OpenSSL (se
 * native-exponentiation.ts). y^(q−1) är y^(−1) i undergruppen och −y^(−1)
 * utanför den, aldrig 1 eller p − 1 när 1 < y < p − 1. Den sista
 * multiplikationen är billig.
 */
export function isInSubgroup(value: bigint): boolean {
  if (value <= 1n || value >= P) return false
  return (modPow(value, Q - 1n, P) * value) % P === 1n
}
