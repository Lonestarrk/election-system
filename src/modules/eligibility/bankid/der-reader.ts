/**
 * EN LITEN, STRIKT DER-LÄSARE, FÖR DET node:crypto INTE LÄMNAR UT.
 *
 * `X509Certificate` i node:crypto tolkar certifikaten, prövar signaturerna och
 * svarar på om ett certifikat är en CA. Två saker lämnar den inte ut:
 * keyUsage-biten digitalSignature, eftersom egenskapen `keyUsage` i själva verket
 * är de utökade användningarna, och subject som byte, så att serialNumber går
 * att läsa utan att tolka OpenSSL:s textform. Dessutom lagras kedjan som
 * certifikat efter varandra, och de måste delas upp innan de kan tolkas.
 *
 * VARFÖR STRIKT, OCH INTE BARA FÖRSIKTIG
 *
 * Det som läses kan komma ur databasen, förbi varje schema, och valideringen
 * före stängningen finns just för raden som en angripare har skrivit. Läsaren
 * följer därför samma regel som tolkningen av talen i valsedlarna efter uppgift
 * 14b: en kodning, aldrig två. Obestämd längd, en längd i lång form som hade
 * fått plats i den korta, en längd med inledande nolla och ett element som går
 * förbi sin förälder eller sin buffert ger null, aldrig en gissning och aldrig
 * ett undantag. Två kodningar av samma sak är två sätt att skriva samma
 * certifikat, och en prövning som säger ja till den ena och nej till den andra
 * är en prövning som går att runda.
 *
 * Läsaren förstår bara det som behövs: taggar med ett enda byte, längder upp
 * till tre byte och strukturen i ett certifikat fram till tilläggen. Resten
 * lämnas åt OpenSSL, som redan har tolkat hela certifikatet när det här körs.
 */

/** Ett element i en DER-buffert, som förskjutningar. Ingenting kopieras. */
export type DerElement = {
  tag: number
  /** Där elementet börjar, med tagg och längd. */
  start: number
  /** Där innehållet börjar. */
  contentStart: number
  /** Första byte efter elementet. */
  end: number
}

/**
 * Tre byte räcker till 16 MiB. Ett certifikat är ett par kilobyte, och en längd
 * som kräver fler byte är ett försök att få läsaren att räkna med tal den inte
 * behöver.
 */
const MAX_LENGTH_BYTES = 3

/** Sammansatta element har bit 6 satt: SEQUENCE, SET och de kontextbundna [0]–[3]. */
const CONSTRUCTED = 0x20

export const DER_SEQUENCE = 0x30

/**
 * Läser elementet som börjar vid `offset`, och som måste sluta senast vid
 * `limit`.
 */
export function readDerElement(
  der: Uint8Array,
  offset: number,
  limit: number = der.length,
): DerElement | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || limit > der.length || offset + 2 > limit) {
    return null
  }

  const tag = der[offset]!
  // Taggnummer 31 betyder att numret fortsätter i nästa byte. Inget fält i
  // ett certifikat använder det.
  if ((tag & 0x1f) === 0x1f) return null

  const first = der[offset + 1]!
  let contentStart = offset + 2
  let length = first

  if (first >= 0x80) {
    const count = first & 0x7f
    // 0x80 är obestämd längd, som BER tillåter och DER förbjuder.
    if (count === 0 || count > MAX_LENGTH_BYTES) return null
    if (contentStart + count > limit) return null
    // En inledande nolla betyder att längden kunde ha skrivits kortare.
    if (der[contentStart] === 0) return null

    length = 0
    for (let index = 0; index < count; index += 1) {
      length = length * 256 + der[contentStart + index]!
    }
    // Under 128 ska längden stå i den korta formen.
    if (length < 0x80) return null

    contentStart += count
  }

  const end = contentStart + length
  if (end > limit) return null

  return { tag, start: offset, contentStart, end }
}

/**
 * Barnen i ett sammansatt element, i ordning. De ska fylla föräldern exakt.
 *
 * Null för ett primitivt element: innehållet i en OCTET STRING eller ett
 * INTEGER är inte struktur, och läses det som struktur kan bytes som råkar se
 * ut som ett element tas för ett.
 */
export function derChildren(der: Uint8Array, parent: DerElement): DerElement[] | null {
  if ((parent.tag & CONSTRUCTED) === 0) return null

  const children: DerElement[] = []
  let offset = parent.contentStart

  while (offset < parent.end) {
    const child = readDerElement(der, offset, parent.end)
    if (!child) return null
    children.push(child)
    offset = child.end
  }

  return children
}

/** Innehållet i ett element, utan tagg och längd. En vy, ingen kopia. */
export function derContent(der: Uint8Array, element: DerElement): Uint8Array {
  return der.subarray(element.contentStart, element.end)
}

/** Hela elementet, med tagg och längd. En vy, ingen kopia. */
export function derBytes(der: Uint8Array, element: DerElement): Uint8Array {
  return der.subarray(element.start, element.end)
}

/** Jämför två bytesekvenser. Innehållet är offentligt, så konstant tid behövs inte. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * Delar upp SEQUENCE-element som ligger direkt efter varandra, som certifikaten
 * i en lagrad kedja. Bufferten ska bestå av dem och ingenting annat.
 */
export function splitDerSequences(der: Uint8Array): Uint8Array[] | null {
  if (der.length === 0) return null

  const parts: Uint8Array[] = []
  let offset = 0

  while (offset < der.length) {
    const element = readDerElement(der, offset)
    if (!element || element.tag !== DER_SEQUENCE) return null
    parts.push(derBytes(der, element))
    offset = element.end
  }

  return parts
}

/** De fält ur TBSCertificate som certifikatkontrollen och attrappen behöver. */
export type TbsCertificate = {
  issuer: DerElement
  subject: DerElement
  /** Varje Extension i ordning. Tom när certifikatet saknar tillägg. */
  extensions: DerElement[]
}

const VERSION = 0xa0
const INTEGER = 0x02
const ISSUER_UNIQUE_ID = 0x81
const SUBJECT_UNIQUE_ID = 0x82
const EXTENSIONS = 0xa3

/**
 * Läser TBSCertificate ur ett certifikat, enligt RFC 5280 4.1:
 *
 *   TBSCertificate ::= SEQUENCE {
 *     version         [0] EXPLICIT, valfri
 *     serialNumber    INTEGER
 *     signature       AlgorithmIdentifier
 *     issuer          Name
 *     validity        Validity
 *     subject         Name
 *     subjectPublicKeyInfo
 *     issuerUniqueID  [1], valfri
 *     subjectUniqueID [2], valfri
 *     extensions      [3] EXPLICIT, valfri }
 *
 * Certifikatet ska vara ett enda element, utan något efter. Ett fält som inte
 * står i listan, eller som står i fel ordning, ger null.
 */
export function readTbsCertificate(der: Uint8Array): TbsCertificate | null {
  const certificate = readDerElement(der, 0)
  if (!certificate || certificate.tag !== DER_SEQUENCE || certificate.end !== der.length) {
    return null
  }

  const parts = derChildren(der, certificate)
  if (!parts || parts.length !== 3 || parts[0]!.tag !== DER_SEQUENCE) return null

  const fields = derChildren(der, parts[0]!)
  if (!fields) return null

  let index = fields[0]?.tag === VERSION ? 1 : 0
  const [serialNumber, signature, issuer, validity, subject, publicKey] = fields.slice(index, index + 6)
  if (
    !serialNumber ||
    !signature ||
    !issuer ||
    !validity ||
    !subject ||
    !publicKey ||
    serialNumber.tag !== INTEGER ||
    [signature, issuer, validity, subject, publicKey].some((field) => field.tag !== DER_SEQUENCE)
  ) {
    return null
  }
  index += 6

  // De valfria fälten efter nyckeln, var och en högst en gång och i ordning.
  for (const optional of [ISSUER_UNIQUE_ID, SUBJECT_UNIQUE_ID]) {
    if (fields[index]?.tag === optional) index += 1
  }

  let extensions: DerElement[] = []
  if (fields[index]?.tag === EXTENSIONS) {
    const wrapped = derChildren(der, fields[index]!)
    if (!wrapped || wrapped.length !== 1 || wrapped[0]!.tag !== DER_SEQUENCE) return null

    const list = derChildren(der, wrapped[0]!)
    if (!list || list.some((extension) => extension.tag !== DER_SEQUENCE)) return null

    extensions = list
    index += 1
  }

  if (index !== fields.length) return null

  return { issuer, subject, extensions }
}
