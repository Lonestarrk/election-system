import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateEncrypt,
  publicDecrypt,
  randomBytes,
} from 'node:crypto'

/**
 * RSA BLINDA SIGNATURER
 *
 * Detta är mekanismen som gör valet oberoende verifierbart utan att offra
 * valhemligheten. Den löser ett problem som ingen databaskonstruktion kan lösa
 * på egen hand.
 *
 * PROBLEMET
 *
 * En observatör ska kunna verifiera att varje registrerad röst skapats genom
 * den auktoriserade processen — att ingen lagt till röster vid sidan om. Med
 * enbart databaser går det inte: en observatör som inte litar på databasen kan
 * inte verifiera en flagga i samma databas. "Rösten är godkänd" är då bara ett
 * påstående från den som kontrollerar servern.
 *
 * LÖSNINGEN
 *
 * Väljaren skapar själv ett hemligt röstintyg och BLINDAR det innan det visas
 * för valmyndigheten. Myndigheten signerar det blindade värdet medan väljaren
 * fortfarande är legitimerad — men ser aldrig det den signerar. Väljaren
 * avblindar signaturen och lämnar in intyget i den anonyma delen.
 *
 * Resultatet:
 *   – Varje röst bär en signatur som BARA myndigheten kan ha skapat.
 *   – Vem som helst kan verifiera signaturen med den publika nyckeln.
 *   – Myndigheten kan INTE koppla ihop en utfärdad signatur med en inlämnad,
 *     eftersom blindningsfaktorn bara väljaren känt till.
 *
 * Matematiken bakom omöjligheten att koppla ihop dem: blindningsfaktorn r är
 * likformigt slumpad, och r^e mod n är därmed likformigt fördelad. Det
 * myndigheten ser är alltså statistiskt oberoende av meddelandet. Det är inte
 * "svårt" att koppla ihop dem — det är informationsteoretiskt omöjligt.
 *
 * VAD DETTA OCKSÅ LÖSER
 *
 * Inlösen blir idempotent: samma intyg kan bara lösas in en gång, och ett
 * försök att lösa in det igen avvisas oavsett när det sker. Därmed spelar
 * ordningen mellan "markera som röstad" och "registrera röst" ingen roll
 * längre — varken dubbelröstning eller förlorad röst kan uppstå. Det är samma
 * garanti som en transaktion över två databaser skulle ha gett, uppnådd utan
 * att kräva något som PostgreSQL inte kan leverera.
 *
 * BEGRÄNSNING SOM MÅSTE STÅ HÄR
 *
 * Implementationen använder full-domain hashing via MGF1 och rå RSA. Det är en
 * korrekt och välkänd konstruktion, men ett produktionssystem ska använda
 * RFC 9474 (RSA-BSSA), som är standardiserad, granskad och skyddar mot
 * subtilare angrepp än vad som får plats i en POC. Se SECURITY.md.
 */

/**
 * Nyckelstorlek.
 *
 * 2048 bitar är minimum för ett system som ska stå emot analys under valets
 * livstid. Det är också det som gör signaturen dyr nog att inte kunna
 * massproduceras av en angripare som fått tillgång till signeringsrutten men
 * inte nyckeln.
 */
export const RSA_MODULUS_BITS = 2048

export type ElectionKeyPair = {
  /** PEM, SPKI. Publiceras öppet — observatörer behöver den för att verifiera. */
  publicKeyPem: string
  /**
   * PEM, PKCS8. Valmyndighetens signeringsnyckel.
   *
   * Läcker den kan vem som helst skapa giltiga röstintyg, och därmed lägga
   * till röster som ser auktoriserade ut. Den är alltså minst lika känslig som
   * IDENTITY_PEPPER — fast med skillnaden att en läcka här angriper valets
   * RIKTIGHET, medan en läcka av peppret angriper valhemligheten.
   */
  privateKeyPem: string
}

type RsaPublicNumbers = { n: bigint; e: bigint; byteLength: number }

/**
 * Genererar ett nyckelpar för en omröstning.
 *
 * EGET NYCKELPAR PER OMRÖSTNING, INTE ETT GEMENSAMT.
 *
 * Med en gemensam nyckel skulle ett röstintyg utfärdat i en omröstning vara
 * giltigt i en annan. Den som sparat ett oanvänt intyg från ett tidigare val
 * kunde då lösa in det i nästa. Nyckelparet knyter intyget till exakt en
 * omröstning.
 */
export function generateElectionKeyPair(): ElectionKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: RSA_MODULUS_BITS,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  return { publicKeyPem: publicKey, privateKeyPem: privateKey }
}

function base64UrlToBigInt(value: string): bigint {
  const bytes = Buffer.from(value, 'base64url')
  let result = 0n
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte)
  }
  return result
}

function bigIntToBuffer(value: bigint, byteLength: number): Buffer {
  const buffer = Buffer.alloc(byteLength)
  let remaining = value
  for (let index = byteLength - 1; index >= 0; index -= 1) {
    buffer[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  if (remaining !== 0n) {
    throw new Error('Värdet får inte plats i modulusen.')
  }
  return buffer
}

function bufferToBigInt(buffer: Buffer): bigint {
  let result = 0n
  for (const byte of buffer) {
    result = (result << 8n) | BigInt(byte)
  }
  return result
}

export function publicNumbers(publicKeyPem: string): RsaPublicNumbers {
  const jwk = createPublicKey(publicKeyPem).export({ format: 'jwk' }) as {
    n?: string
    e?: string
  }

  if (!jwk.n || !jwk.e) throw new Error('Nyckeln är inte en RSA-nyckel.')

  const n = base64UrlToBigInt(jwk.n)
  return { n, e: base64UrlToBigInt(jwk.e), byteLength: Buffer.from(jwk.n, 'base64url').length }
}

/** Modulär exponentiering. */
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

/** Modulär invers via utvidgade Euklides. Kastar om inversen inte finns. */
function modInverse(value: bigint, modulus: bigint): bigint {
  let [old_r, r] = [value % modulus, modulus]
  let [old_s, s] = [1n, 0n]

  while (r !== 0n) {
    const quotient = old_r / r
    ;[old_r, r] = [r, old_r - quotient * r]
    ;[old_s, s] = [s, old_s - quotient * s]
  }

  if (old_r !== 1n) throw new Error('Ingen modulär invers finns.')

  return ((old_s % modulus) + modulus) % modulus
}

/**
 * MGF1 med SHA-256, enligt PKCS#1.
 *
 * Används för att expandera en hash till hela modulusens bredd.
 */
function mgf1(seed: Buffer, length: number): Buffer {
  const blocks: Buffer[] = []
  let counter = 0

  while (Buffer.concat(blocks).length < length) {
    const counterBuffer = Buffer.alloc(4)
    counterBuffer.writeUInt32BE(counter, 0)
    blocks.push(createHash('sha256').update(seed).update(counterBuffer).digest())
    counter += 1
  }

  return Buffer.concat(blocks).subarray(0, length)
}

/**
 * Full-domain hash av ett meddelande till ett heltal mindre än n.
 *
 * VARFÖR HASHNINGEN MÅSTE TÄCKA HELA DOMÄNEN
 *
 * Rå RSA är multiplikativ: sig(a) * sig(b) = sig(a*b). Signerades en kort hash
 * direkt skulle den som fått två signaturer kunna räkna fram en giltig
 * signatur för en produkt av meddelanden — alltså skapa ett röstintyg som
 * aldrig utfärdats. Genom att expandera hashen över hela modulusen blir sådana
 * produkter med överväldigande sannolikhet inte giltiga hashvärden för något
 * meddelande.
 */
export function fullDomainHash(message: string, publicKeyPem: string): bigint {
  const { n, byteLength } = publicNumbers(publicKeyPem)

  const seed = createHash('sha256').update(message, 'utf8').digest()

  // En byte kortare än modulusen garanterar att värdet alltid är mindre än n.
  const expanded = mgf1(seed, byteLength - 1)

  return bufferToBigInt(expanded) % n
}

export type BlindedMessage = {
  /** Det blindade värdet som skickas till valmyndigheten. Hex. */
  blinded: string
  /**
   * Blindningsfaktorn. Lämnar ALDRIG väljarens klient i ett riktigt system.
   *
   * I den här POC:en körs blindningen på servern, vilket betyder att skyddet
   * mot att myndigheten kopplar ihop utfärdande och inlösen vilar på att
   * servern inte sparar faktorn. Det är en verklig svaghet och den står i
   * SECURITY.md: full obundenhet kräver att blindningen sker i väljarens
   * webbläsare.
   */
  blindingFactor: string
}

/**
 * Blindar ett meddelande: m' = m * r^e mod n.
 *
 * r väljs slumpmässigt och måste vara inverterbar modulo n. Sannolikheten att
 * den inte är det är astronomiskt liten (det skulle innebära att r delar en av
 * primfaktorerna, alltså att RSA-nyckeln just faktoriserats), men fallet
 * hanteras genom att välja om.
 */
export function blind(message: string, publicKeyPem: string): BlindedMessage {
  const { n, e, byteLength } = publicNumbers(publicKeyPem)
  const hashed = fullDomainHash(message, publicKeyPem)

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = bufferToBigInt(randomBytes(byteLength)) % n
    if (candidate <= 1n) continue

    try {
      // Kontrollerar bara att faktorn är inverterbar. Inversen räknas fram på
      // nytt vid avblindningen, där den faktiskt behövs.
      modInverse(candidate, n)
    } catch {
      continue
    }

    const blinded = (hashed * modPow(candidate, e, n)) % n

    return {
      blinded: bigIntToBuffer(blinded, byteLength).toString('hex'),
      blindingFactor: bigIntToBuffer(candidate, byteLength).toString('hex'),
    }
  }

  throw new Error('Kunde inte välja en giltig blindningsfaktor.')
}

/**
 * Signerar ett blindat värde med valmyndighetens privata nyckel.
 *
 * Detta är rå RSA — s' = m'^d mod n — utan padding, eftersom paddningen redan
 * är gjord av full-domain-hashningen. `privateEncrypt` med RSA_NO_PADDING är
 * Nodes väg till den råa operationen.
 *
 * MYNDIGHETEN SER ALDRIG VAD DEN SIGNERAR. Värdet som kommer in är
 * multiplicerat med en slumpfaktor bara väljaren känner till, och är därmed
 * likformigt fördelat oavsett vad det underliggande meddelandet är.
 */
export function signBlinded(blindedHex: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem)
  const blinded = Buffer.from(blindedHex, 'hex')

  const signature = privateEncrypt(
    { key, padding: constants.RSA_NO_PADDING },
    blinded,
  )

  return signature.toString('hex')
}

/**
 * Avblindar en signatur: s = s' * r^-1 mod n.
 *
 * Efter detta är s en giltig signatur över det ursprungliga meddelandet, och
 * ingenting i den bär spår av blindningsfaktorn.
 */
export function unblind(
  blindSignatureHex: string,
  blindingFactorHex: string,
  publicKeyPem: string,
): string {
  const { n, byteLength } = publicNumbers(publicKeyPem)

  const blindSignature = bufferToBigInt(Buffer.from(blindSignatureHex, 'hex'))
  const blindingFactor = bufferToBigInt(Buffer.from(blindingFactorHex, 'hex'))

  const signature = (blindSignature * modInverse(blindingFactor, n)) % n

  return bigIntToBuffer(signature, byteLength).toString('hex')
}

/**
 * Verifierar en signatur: s^e mod n == FDH(meddelande).
 *
 * Kan köras av vem som helst med den publika nyckeln — det är precis det som
 * gör valet oberoende verifierbart. En observatör kan gå igenom samtliga
 * registrerade röster och själv avgöra att var och en bär ett äkta intyg, utan
 * att fråga systemet och utan att behöva lita på det.
 */
export function verify(message: string, signatureHex: string, publicKeyPem: string): boolean {
  try {
    const { n, e } = publicNumbers(publicKeyPem)

    const signature = bufferToBigInt(Buffer.from(signatureHex, 'hex'))
    if (signature <= 0n || signature >= n) return false

    const recovered = modPow(signature, e, n)

    return recovered === fullDomainHash(message, publicKeyPem)
  } catch {
    return false
  }
}

/**
 * Verifierar med den publika nyckeln via Nodes RSA i stället för egen
 * modulär exponentiering.
 *
 * Finns som en oberoende andra implementation av samma kontroll. Om de två
 * någonsin är oense är något fel, och ett test jämför dem — en egen
 * bigint-rutin som tyst räknar fel vore annars svår att upptäcka.
 */
export function verifyViaNodeRsa(
  message: string,
  signatureHex: string,
  publicKeyPem: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem)
    const recovered = publicDecrypt(
      { key, padding: constants.RSA_NO_PADDING },
      Buffer.from(signatureHex, 'hex'),
    )

    const { byteLength } = publicNumbers(publicKeyPem)
    const expected = bigIntToBuffer(fullDomainHash(message, publicKeyPem), byteLength)

    return Buffer.compare(recovered, expected) === 0
  } catch {
    return false
  }
}
