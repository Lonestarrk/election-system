/**
 * BLINDNING I VÄLJARENS WEBBLÄSARE
 *
 * Detta är samma matematik som i lib/blind-signature.ts, men skriven mot
 * WebCrypto och BigInt så att den kan köras på klienten.
 *
 * VARFÖR DEN MÅSTE KÖRAS PÅ KLIENTEN
 *
 * Blindningsfaktorn är det enda som hindrar valmyndigheten från att koppla
 * ihop ett utfärdat röstintyg med ett inlämnat. Räknade servern fram både
 * faktorn och signaturen i samma begäran vore obundenheten ingenting värd —
 * servern skulle ha sett båda sidorna och kunnat spara kopplingen. Hela
 * mekanismen vore teater.
 *
 * Genom att blinda här, i webbläsaren, lämnar faktorn aldrig väljarens enhet.
 * Servern ser ett värde som är statistiskt oberoende av intyget, signerar det,
 * och får tillbaka en röst som den bevisligen auktoriserat men inte kan spåra.
 *
 * VAD SOM FORTFARANDE KRÄVER TILLIT
 *
 * Att koden som körs i webbläsaren är den som finns i repot. En server som
 * levererar en manipulerad version av den här filen till en utvald väljare
 * skulle kunna lägga tillbaka kopplingen. Det är ett verkligt och välkänt
 * problem för all webbaserad kryptografi, och motmedlen — signerade
 * klientpaket, reproducerbara byggen, oberoende granskning av det som
 * levereras — ligger utanför den här POC:en. Se SECURITY.md.
 */

function bufferToBigInt(bytes: Uint8Array): bigint {
  let result = 0n
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte)
  }
  return result
}

function bigIntToHex(value: bigint, byteLength: number): string {
  const hex = value.toString(16)
  if (hex.length > byteLength * 2) throw new Error('Värdet får inte plats i modulusen.')
  return hex.padStart(byteLength * 2, '0')
}

function hexToBigInt(hex: string): bigint {
  return BigInt('0x' + hex)
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let current = base % modulus
  let remaining = exponent

  while (remaining > 0n) {
    if (remaining & 1n) result = (result * current) % modulus
    current = (current * current) % modulus
    remaining >>= 1n
  }

  return result
}

function modInverse(value: bigint, modulus: bigint): bigint {
  let [oldRemainder, remainder] = [value % modulus, modulus]
  let [oldCoefficient, coefficient] = [1n, 0n]

  while (remainder !== 0n) {
    const quotient = oldRemainder / remainder
    ;[oldRemainder, remainder] = [remainder, oldRemainder - quotient * remainder]
    ;[oldCoefficient, coefficient] = [coefficient, oldCoefficient - quotient * coefficient]
  }

  if (oldRemainder !== 1n) throw new Error('Ingen modulär invers finns.')

  return ((oldCoefficient % modulus) + modulus) % modulus
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return new Uint8Array(digest)
}

/** MGF1 med SHA-256. Samma konstruktion som på serversidan. */
async function mgf1(seed: Uint8Array, length: number): Promise<Uint8Array> {
  const output = new Uint8Array(length)
  let offset = 0
  let counter = 0

  while (offset < length) {
    const input = new Uint8Array(seed.length + 4)
    input.set(seed, 0)
    new DataView(input.buffer).setUint32(seed.length, counter, false)

    const block = await sha256(input)
    const take = Math.min(block.length, length - offset)
    output.set(block.subarray(0, take), offset)

    offset += take
    counter += 1
  }

  return output
}

type PublicNumbers = { n: bigint; e: bigint; byteLength: number }

/**
 * Plockar ut modulus och exponent ur en publik nyckel i PEM-format.
 *
 * Nyckeln importeras via WebCrypto och exporteras som JWK, vilket ger n och e
 * i base64url. Det undviker att den här filen behöver en egen ASN.1-parser.
 */
export async function publicNumbersFromPem(publicKeyPem: string): Promise<PublicNumbers> {
  const body = publicKeyPem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '')

  const der = base64UrlToBytes(body.replace(/\+/g, '-').replace(/\//g, '_'))

  const key = await crypto.subtle.importKey(
    'spki',
    der as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify'],
  )

  const jwk = (await crypto.subtle.exportKey('jwk', key)) as { n?: string; e?: string }
  if (!jwk.n || !jwk.e) throw new Error('Nyckeln är inte en RSA-nyckel.')

  const modulusBytes = base64UrlToBytes(jwk.n)

  return {
    n: bufferToBigInt(modulusBytes),
    e: bufferToBigInt(base64UrlToBytes(jwk.e)),
    byteLength: modulusBytes.length,
  }
}

async function fullDomainHash(message: string, numbers: PublicNumbers): Promise<bigint> {
  const seed = await sha256(new TextEncoder().encode(message))
  // En byte kortare än modulusen garanterar att värdet alltid är mindre än n.
  const expanded = await mgf1(seed, numbers.byteLength - 1)
  return bufferToBigInt(expanded) % numbers.n
}

export type VoteCredential = {
  /** Väljarens eget, hemliga intygsvärde. Visas för myndigheten först vid inlösen. */
  credentialId: string
  /** Blindat värde att skicka till myndigheten för signering. */
  blinded: string
  /** Blindningsfaktorn. Lämnar aldrig enheten. */
  blindingFactor: string
}

/**
 * Skapar ett röstintyg och blindar det.
 *
 * Intygets värde slumpas här, på väljarens enhet. Myndigheten får aldrig se
 * det förrän rösten lämnas in — och då utan något som säger vem som fick det
 * signerat.
 */
export async function createBlindedCredential(publicKeyPem: string): Promise<VoteCredential> {
  const numbers = await publicNumbersFromPem(publicKeyPem)

  // 32 byte slump. Utfallsrummet måste vara stort nog att två väljare aldrig
  // råkar välja samma intyg — en kollision skulle avvisas som återanvändning
  // och kosta någon sin röst.
  const credentialBytes = crypto.getRandomValues(new Uint8Array(32))
  const credentialId = Array.from(credentialBytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

  const hashed = await fullDomainHash(credentialId, numbers)

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const factorBytes = crypto.getRandomValues(new Uint8Array(numbers.byteLength))
    const factor = bufferToBigInt(factorBytes) % numbers.n
    if (factor <= 1n) continue

    try {
      modInverse(factor, numbers.n)
    } catch {
      continue
    }

    const blinded = (hashed * modPow(factor, numbers.e, numbers.n)) % numbers.n

    return {
      credentialId,
      blinded: bigIntToHex(blinded, numbers.byteLength),
      blindingFactor: bigIntToHex(factor, numbers.byteLength),
    }
  }

  throw new Error('Kunde inte välja en giltig blindningsfaktor.')
}

/** Avblindar signaturen: s = s' * r^-1 mod n. */
export async function unblindSignature(
  blindSignatureHex: string,
  blindingFactorHex: string,
  publicKeyPem: string,
): Promise<string> {
  const numbers = await publicNumbersFromPem(publicKeyPem)

  const signature =
    (hexToBigInt(blindSignatureHex) * modInverse(hexToBigInt(blindingFactorHex), numbers.n)) %
    numbers.n

  return bigIntToHex(signature, numbers.byteLength)
}

/**
 * Verifierar en signatur på klienten.
 *
 * Väljaren kan alltså kontrollera att myndigheten faktiskt signerade intyget
 * innan rösten lämnas in. Utan den kontrollen skulle en server kunna svara med
 * skräp, väljaren lämna in en oanvändbar röst, och felet upptäckas först när
 * rösten redan är förbrukad.
 */
export async function verifySignature(
  message: string,
  signatureHex: string,
  publicKeyPem: string,
): Promise<boolean> {
  try {
    const numbers = await publicNumbersFromPem(publicKeyPem)

    const signature = hexToBigInt(signatureHex)
    if (signature <= 0n || signature >= numbers.n) return false

    const recovered = modPow(signature, numbers.e, numbers.n)

    return recovered === (await fullDomainHash(message, numbers))
  } catch {
    return false
  }
}
