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

export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
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
 */
export function isInSubgroup(value: bigint): boolean {
  if (value <= 1n || value >= P) return false
  return modPow(value, Q, P) === 1n
}
