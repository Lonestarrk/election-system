import { type KeyObject, X509Certificate } from 'node:crypto'
import { truncateToDay } from '@/lib/time'
import {
  DER_SEQUENCE,
  derBytes,
  derChildren,
  derContent,
  readDerElement,
  readTbsCertificate,
  sameBytes,
  type DerElement,
  type TbsCertificate,
} from './der-reader'

/**
 * CERTIFIKATKEDJAN PRÖVAS MOT EN FAST ROT (uppgift 14f).
 *
 * VAD SOM VAR FEL. Underskriften prövades mot den nyckel raden i pending_vote
 * själv bar. Den som kunde skriva i databasen skapade ett eget nyckelpar,
 * skrev under ett välformat kuvert och lade nyckel, underskrift och en verklig
 * väljare i en rad som varje kontroll godkände. Underskriften skyddade mot en
 * klient, men inte mot den som driver systemet.
 *
 * VAD SOM PRÖVAS NU. Nyckeln måste sitta i ett löv som en betrodd rot står
 * för. Kedjan är lövet och de mellannivåer som utfärdat det, från lövet och
 * uppåt, och roten är konfigurerad och lagras aldrig med kuvertet (se
 * ./trusted-roots.ts). Kontrollerna, i den ordning de görs:
 *
 *   0. kedjan har ett löv och en till tre mellannivåer
 *   1. den översta mellannivån är utfärdad och signerad av en betrodd rot, och
 *      ingen mellannivå är en självsignerad rot
 *   2. varje mellannivå har CA-rätt och keyUsage med keyCertSign
 *   3. ingen mellannivå, och inte heller roten, har fler mellannivåer under
 *      sig än pathLen i dess basicConstraints tillåter
 *   4. varje led är utfärdat och signerat av ledet ovanför, ner till lövet
 *   5. lövet har inte CA-rätt i basicConstraints
 *   6. lövet får användas till underskrifter: keyUsage med digitalSignature
 *   7. lövet, varje mellannivå och roten gällde vid underskriften
 *   8. lövet bär exakt ett personnummer, tolv siffror, som serialNumber i subject
 *
 * "Utfärdad och signerad" är två frågor, och båda ställs. `checkIssued` jämför
 * bara namnen och nyckelidentifierarna, och de kan vem som helst skriva av.
 * `verify` prövar signaturen, och den kan bara utfärdarens nyckel ha gjort.
 *
 * Ordningen gör att varje förfalskning underkänns av sin egen kontroll: en
 * mellannivå utan CA-rätt fastnar i 2, en mellannivå under en rot med pathLen
 * 0 i 3 och ett löv med CA-rätt i 5. Skälet kommer med i svaret, så att en
 * avvikelse i valideringen går att utreda.
 *
 * VARFÖR LÄNGDEN ÄR RÖRLIG (granskningen av uppgift 14f, M3). Kedjan hade förut
 * exakt två certifikat, och texten sa att BankID:s kedja har samma form. Det är
 * inte bekräftat. Granskaren tror att BankID:s kundcertifikat har två CA-nivåer
 * under roten, och stämmer det hade en fast längd underkänt varje riktig
 * underskrift. Hur djup BankID:s kedja är får adaptern för XML-signaturen
 * bekräfta mot BankID:s testmiljö. Taket på tre mellannivåer finns för att en
 * rad inte ska kunna få prövningen att gå igenom hur många led som helst.
 *
 * VARFÖR ROTENS TID OCH PATHLEN PRÖVAS (M2). Förut godkändes en betrodd rot som
 * gått ut, och en rot med pathLen 0 godkändes som utfärdare av en mellannivå.
 * Båda avvek från OpenSSL och RFC 5280. Rotens tid prövas här, mot tiden för
 * underskriften, och inte när rötterna läses in, se ./trusted-roots.ts.
 *
 * Här prövas bara kedjan. Att signaturen över kuvertet håller mot lövets nyckel
 * prövar `verifySignedPayload`, och att personnumret är väljarens prövas mot
 * röstlängdens identitetshash av anroparen, som äger hashningen.
 *
 * INGENTING HÄR KASTAR. Kedjan kan komma ur databasen, förbi varje schema, och
 * valideringen före stängningen är en spärr. En spärr som kraschar på en trasig
 * rad hjälper den som skrev raden, så varje fel blir ett skäl i svaret.
 *
 * VAD SOM INTE PRÖVAS. Ingen spärrkontroll: ett BankID-certifikat som spärrats
 * godkänns så länge det gäller i tid. Riktig BankID skickar med ett OCSP-svar
 * som visar certifikatets status vid underskriften, och det är det som ska
 * prövas, men kedjeprövningen tar inte emot något sådant. Det står som en känd
 * begränsning i src/lib/known-limitations.ts. Inte heller namnbegränsningar,
 * policyer eller okända kritiska tillägg prövas, som en fullständig prövning
 * enligt RFC 5280 gör. De finns för att begränsa vad en underordnad CA får
 * utfärda, och under en fast rot, där bara BankID:s egna CA utfärdar, är det
 * de prövningarna som inte behövs. En mellannivå som utfärdat sig själv, som
 * vid ett nyckelbyte, räknas här som ett led av alla andra, vilket är
 * strängare än RFC 5280 och aldrig mer tillåtande.
 */

/**
 * Tidsrummet då underskriften gjordes. Certifikaten ska ha gällt någon gång
 * inom det, alla samtidigt.
 */
export type SigningWindow = { from: Date; until: Date }

/** Underskriften gjordes nu, eller vid en känd tidpunkt. Så prövas den när rösten läggs. */
export function signedAt(instant: Date): SigningWindow {
  return { from: instant, until: instant }
}

/**
 * Underskriften gjordes någon gång under dygnet, i UTC.
 *
 * Så prövas den i valideringen före stängningen. Tidpunkten för underskriften
 * finns kvar bara som dagen i `PendingVote.updatedAt`, avrundad med avsikt, som
 * all tidsdata i röstlängden (se src/lib/time.ts). Ett certifikat som gick ut
 * på förmiddagen godkänns därför för en underskrift på eftermiddagen samma dag.
 * Läggningen prövade däremot mot klockan i det ögonblick BankID svarade.
 */
export function signedOnDay(day: Date): SigningWindow {
  const from = truncateToDay(day)
  return { from, until: new Date(from.getTime() + 86_400_000 - 1) }
}

export type ChainFailure =
  | 'malformed'
  | 'untrusted_root'
  | 'intermediate_not_ca'
  | 'path_length_exceeded'
  | 'not_issued_by_intermediate'
  | 'leaf_is_ca'
  | 'no_digital_signature'
  | 'not_valid_when_signed'
  | 'no_personal_number'

export type ChainVerdict =
  | { ok: true; personalNumber: string; signingKey: KeyObject }
  | { ok: false; reason: ChainFailure }

/**
 * Lövet och en till tre mellannivåer. Hur många BankID har är inte bekräftat,
 * se modulens dokumentation. Varje mellannivå prövas för sig, också mot pathLen
 * i basicConstraints, som node:crypto inte lämnar ut och som därför läses ur
 * bytena.
 */
const MIN_CHAIN_LENGTH = 2
const MAX_CHAIN_LENGTH = 4

/** Ett certifikat är ett par kilobyte. Det här är gott om plats, och ingen gräns för det rimliga. */
const MAX_PEM_LENGTH = 16 * 1024

const PEM = /^-----BEGIN CERTIFICATE-----\r?\n((?:[A-Za-z0-9+/=]+\r?\n)+)-----END CERTIFICATE-----\r?\n?$/

const KEY_USAGE = Uint8Array.of(0x06, 0x03, 0x55, 0x1d, 0x0f)
const BASIC_CONSTRAINTS = Uint8Array.of(0x06, 0x03, 0x55, 0x1d, 0x13)
const SERIAL_NUMBER = Uint8Array.of(0x06, 0x03, 0x55, 0x04, 0x05)

/** Bitarnas nummer i KeyUsage, RFC 5280 4.2.1.3. */
const DIGITAL_SIGNATURE = 0
const KEY_CERT_SIGN = 5

const OID = 0x06
const BOOLEAN = 0x01
const INTEGER = 0x02
const OCTET_STRING = 0x04
const BIT_STRING = 0x03
const SET = 0x31
const PRINTABLE_STRING = 0x13
const UTF8_STRING = 0x0c

/** Ett svenskt personnummer som BankID skriver det: tolv siffror, utan skiljetecken. */
const PERSONAL_NUMBER = /^[0-9]{12}$/

/**
 * Ett certifikat ur DER, som ett enda element utan något efter. OpenSSL läser
 * det första certifikatet i en buffert och bryr sig inte om resten, så den
 * prövningen görs här.
 */
export function certificateFromDer(der: Uint8Array): X509Certificate | null {
  const element = readDerElement(der, 0)
  if (!element || element.tag !== DER_SEQUENCE || element.end !== der.length) return null

  try {
    return new X509Certificate(der)
  } catch {
    return null
  }
}

/**
 * Ett certifikat i PEM, som exakt ett block och ingenting runt det.
 *
 * STRIKT, AV SAMMA SKÄL SOM LÄSAREN. OpenSSL hoppar över text före PEM-blocket
 * och läser bara det första av flera block. Attrappens gamla format utnyttjade
 * just det, med personnumret på en rad ovanför nyckeln. Här ska base64 dessutom
 * vara kanonisk, så att samma certifikat bara kan skrivas på ett sätt.
 */
export function certificateFromPem(pem: unknown): X509Certificate | null {
  if (typeof pem !== 'string' || pem.length > MAX_PEM_LENGTH) return null

  const match = PEM.exec(pem)
  if (!match) return null

  const base64 = match[1]!.replace(/\r?\n/g, '')
  const der = Buffer.from(base64, 'base64')
  if (der.toString('base64') !== base64) return null

  return certificateFromDer(der)
}

/** Kedjan ur BankID:s svar: en lista med ett certifikat i PEM per post, lövet först. */
export function parseCertificateChain(pems: unknown): X509Certificate[] | null {
  if (!Array.isArray(pems) || pems.length === 0 || pems.length > MAX_CHAIN_LENGTH) return null

  const chain: X509Certificate[] = []
  for (const pem of pems) {
    const certificate = certificateFromPem(pem)
    if (!certificate) return null
    chain.push(certificate)
  }

  return chain
}

/** Är `child` utfärdat av `issuer`, till namnet och till signaturen? */
function issuedBy(child: X509Certificate, issuer: X509Certificate): boolean {
  try {
    return child.checkIssued(issuer) && child.verify(issuer.publicKey)
  } catch {
    return false
  }
}

/**
 * Värdet i ett tillägg, alltså det som står i dess OCTET STRING, läst som ett
 * enda DER-element. `absent` om tillägget saknas och null om det inte går att
 * läsa eller står två gånger: två svar på samma fråga i samma certifikat är
 * inget svar.
 */
function extensionValue(
  der: Uint8Array,
  tbs: TbsCertificate,
  oid: Uint8Array,
): DerElement | 'absent' | null {
  let found: DerElement | null = null

  for (const extension of tbs.extensions) {
    const parts = derChildren(der, extension)
    if (!parts || parts.length < 2 || parts.length > 3 || parts[0]!.tag !== OID) return null
    if (!sameBytes(derBytes(der, parts[0]!), oid)) continue
    if (found !== null) return null

    // Mellan identifieraren och värdet kan flaggan critical stå.
    if (parts.length === 3 && parts[1]!.tag !== BOOLEAN) return null
    const wrapper = parts[parts.length - 1]!
    if (wrapper.tag !== OCTET_STRING) return null

    const value = readDerElement(der, wrapper.contentStart, wrapper.end)
    if (!value || value.end !== wrapper.end) return null
    found = value
  }

  return found ?? 'absent'
}

/**
 * Är biten satt i certifikatets keyUsage? Null om tillägget inte går att läsa,
 * och falskt om det saknas: utan tillägget får nyckeln enligt RFC 5280 användas
 * till allt, men ett BankID-certifikat har det alltid, och det som saknar det
 * godtas inte, varken i lövet eller i en mellannivå.
 *
 * För en mellannivå är det här strängare än `X509Certificate.ca`, som godtar en
 * CA helt utan keyUsage. RFC 5280 kräver tillägget i varje certifikat vars
 * nyckel prövar andra certifikat.
 */
function keyUsageAllows(der: Uint8Array, tbs: TbsCertificate, bit: number): boolean | null {
  const bits = extensionValue(der, tbs, KEY_USAGE)
  if (bits === 'absent') return false
  if (bits === null || bits.tag !== BIT_STRING) return null

  // Först antalet oanvända bitar i sista byten, sedan bitarna. Bit 0 är den
  // högsta biten i första byten. De oanvända bitarna ska vara noll i DER, och
  // en bit som bara står bland dem är inte satt.
  const content = derContent(der, bits)
  const unused = content[0]
  if (unused === undefined || unused > 7 || (content.length === 1 && unused !== 0)) return null
  if ((content[content.length - 1]! & ((1 << unused) - 1)) !== 0) return null

  const byte = 1 + Math.floor(bit / 8)
  return content.length > byte && (content[byte]! & (0x80 >> bit % 8)) !== 0
}

/** basicConstraints ur bytena: CA-rätt, och högsta antalet mellannivåer under certifikatet. */
type BasicConstraints = { ca: boolean; pathLength: number | null }

/**
 * Ett icke-negativt heltal i minsta DER-kodning, högst tre byte. Null för allt
 * annat: ett negativt pathLen, eller ett som kunde ha skrivits kortare, är en
 * kodning OpenSSL kanske läser annorlunda än vi.
 */
function smallNonNegativeInteger(content: Uint8Array): number | null {
  if (content.length === 0 || content.length > 3 || (content[0]! & 0x80) !== 0) return null
  if (content.length > 1 && content[0] === 0 && (content[1]! & 0x80) === 0) return null
  return content.reduce((value, byte) => value * 256 + byte, 0)
}

/**
 * basicConstraints: har certifikatet CA-rätt, och hur många mellannivåer får
 * stå under det? Saknas tillägget har certifikatet ingen CA-rätt och ingen
 * gräns. Null om tillägget inte går att läsa.
 *
 * LÄST UR BYTENA, INTE UR `X509Certificate.ca`.
 *
 * `ca` svarar på om certifikatet kan verka som CA, och OpenSSL säger nej för
 * ett certifikat vars keyUsage saknar keyCertSign, också när basicConstraints
 * ger det CA-rätt. Ett löv med CA-rätt och bara digitalSignature passerade
 * därför `ca`. För en mellannivå är just det rätt fråga, eftersom den ska kunna
 * utfärda, och den ställs också. För lövet är frågan en annan: har utfärdaren
 * gett det CA-rätt? Ett BankID-certifikat för en person har det aldrig, och ett
 * som har det är inte ett sådant certifikat, oavsett vad keyUsage säger.
 *
 * pathLen finns inte i node:crypto alls, och läses därför också här. Det får
 * bara stå när cA är satt (RFC 5280 4.2.1.9), och ett pathLen utan cA är ett
 * tillägg som inte går att läsa.
 */
function basicConstraintsOf(der: Uint8Array, tbs: TbsCertificate): BasicConstraints | null {
  const constraints = extensionValue(der, tbs, BASIC_CONSTRAINTS)
  if (constraints === 'absent') return { ca: false, pathLength: null }
  if (constraints === null || constraints.tag !== DER_SEQUENCE) return null

  const fields = derChildren(der, constraints)
  if (!fields || fields.length > 2) return null

  // cA har förvalet FALSE och står bara med när det är sant. DER skriver sant
  // som 0xff, och ett annat värde är en kodning OpenSSL kanske läser som sant.
  let ca = false
  let rest = fields
  if (fields[0]?.tag === BOOLEAN) {
    const flag = derContent(der, fields[0])
    if (flag.length !== 1 || flag[0] !== 0xff) return null
    ca = true
    rest = fields.slice(1)
  }

  if (rest.length === 0) return { ca, pathLength: null }
  if (!ca || rest.length !== 1 || rest[0]!.tag !== INTEGER) return null

  const pathLength = smallNonNegativeInteger(derContent(der, rest[0]!))
  return pathLength === null ? null : { ca, pathLength }
}

/**
 * Personnumret i lövets subject, som serialNumber. Exakt ett, och exakt tolv
 * siffror. Två serialNumber i samma namn, eller ett i fel form, ger null.
 */
function personalNumberOf(der: Uint8Array, tbs: TbsCertificate): string | null {
  const relativeNames = derChildren(der, tbs.subject)
  if (!relativeNames) return null

  const values: string[] = []
  for (const relativeName of relativeNames) {
    const attributes = relativeName.tag === SET ? derChildren(der, relativeName) : null
    if (!attributes || attributes.length === 0) return null

    for (const attribute of attributes) {
      const parts = attribute.tag === DER_SEQUENCE ? derChildren(der, attribute) : null
      if (!parts || parts.length !== 2 || parts[0]!.tag !== OID) return null
      if (!sameBytes(derBytes(der, parts[0]!), SERIAL_NUMBER)) continue

      const value = parts[1]!
      if (value.tag !== PRINTABLE_STRING && value.tag !== UTF8_STRING) return null
      values.push(Buffer.from(derContent(der, value)).toString('latin1'))
    }
  }

  return values.length === 1 && PERSONAL_NUMBER.test(values[0]!) ? values[0]! : null
}

/**
 * Gällde alla certifikaten samtidigt någon gång inom tidsrummet? Det senaste
 * av startdagarna måste ligga före det tidigaste av slutdagarna. En tid som
 * inte går att läsa blir NaN, och då blir svaret nej.
 */
function validDuring(certificates: X509Certificate[], window: SigningWindow): boolean {
  let earliest = window.from.getTime()
  let latest = window.until.getTime()

  for (const certificate of certificates) {
    earliest = Math.max(earliest, certificate.validFromDate.getTime())
    latest = Math.min(latest, certificate.validToDate.getTime())
  }

  return earliest <= latest
}

function fail(reason: ChainFailure): ChainVerdict {
  return { ok: false, reason }
}

/**
 * Går certifikatets basicConstraints att läsa med den strikta läsaren här?
 * Rötterna prövas med den när de läses in, se ./trusted-roots.ts, så att en rot
 * som OpenSSL godtar men som `rootAllows` inte kan läsa stoppar driftsättningen
 * i stället för att fälla varje kedja under sig.
 */
export function hasReadableConstraints(certificate: X509Certificate): boolean {
  const tbs = readTbsCertificate(certificate.raw)
  return tbs !== null && basicConstraintsOf(certificate.raw, tbs) !== null
}

/**
 * Tillåter rotens pathLen så många mellannivåer under sig? En rot vars
 * basicConstraints inte går att läsa tillåter ingenting. Rötterna prövas redan
 * när de läses in, så det ska aldrig hända.
 */
function rootAllows(root: X509Certificate, intermediatesBelow: number): boolean {
  const tbs = readTbsCertificate(root.raw)
  const constraints = tbs ? basicConstraintsOf(root.raw, tbs) : null
  return (
    constraints !== null &&
    (constraints.pathLength === null || intermediatesBelow <= constraints.pathLength)
  )
}

/**
 * Prövar kedjan mot de betrodda rötterna.
 *
 * @param chain Lövet först, sedan mellannivåerna uppåt, den översta sist.
 * @param options.roots Rötterna ur ./trusted-roots.ts. De prövas där, när de läses in.
 * @param options.signedDuring När underskriften gjordes, se `signedAt` och `signedOnDay`.
 */
export function verifyCertificateChain(
  chain: readonly X509Certificate[],
  options: { roots: readonly X509Certificate[]; signedDuring: SigningWindow },
): ChainVerdict {
  /**
   * Hela prövningen är inlindad, som `proofHoldsSafely` i valideringen: ett
   * certifikat som OpenSSL tolkat men inte kan lämna ut en nyckel ur, eller
   * något annat oväntat, blir ett underkänt certifikat och inget undantag.
   */
  try {
    return checkChain(chain, options)
  } catch {
    return fail('malformed')
  }
}

function checkChain(
  chain: readonly X509Certificate[],
  options: { roots: readonly X509Certificate[]; signedDuring: SigningWindow },
): ChainVerdict {
  // 0. Ett löv och en till tre mellannivåer.
  if (chain.length < MIN_CHAIN_LENGTH || chain.length > MAX_CHAIN_LENGTH) return fail('malformed')
  const leaf = chain[0]!
  const intermediates = chain.slice(1)

  // 1. Den översta mellannivån är utfärdad och signerad av en betrodd rot.
  const top = intermediates[intermediates.length - 1]!
  const anchors = options.roots.filter((root) => issuedBy(top, root))
  if (anchors.length === 0) return fail('untrusted_root')

  /**
   * ... och ingen mellannivå är själv en rot. En rot följer aldrig med kedjan:
   * en rot som kom med svaret vore vald av den som skrev svaret. En betrodd rot
   * som lagts sist i kedjan hade annars godkänts som sin egen utfärdare, i en
   * kedja som bara ser längre ut. Prövningen kommer efter roten, så att en
   * kedja som slutar i en egen, obetrodd rot får det skäl som säger mest.
   */
  if (intermediates.some((certificate) => issuedBy(certificate, certificate))) return fail('malformed')

  // 2. Varje mellannivå får utfärda certifikat: CA-rätt, både enligt bytena och
  // enligt OpenSSL, och keyUsage med keyCertSign.
  const pathLengths: Array<number | null> = []
  for (const intermediate of intermediates) {
    const tbs = readTbsCertificate(intermediate.raw)
    const constraints = tbs ? basicConstraintsOf(intermediate.raw, tbs) : null
    const certificateSign = tbs ? keyUsageAllows(intermediate.raw, tbs, KEY_CERT_SIGN) : null
    if (constraints === null || certificateSign === null) return fail('malformed')
    if (!constraints.ca || !certificateSign || !intermediate.ca) return fail('intermediate_not_ca')
    pathLengths.push(constraints.pathLength)
  }

  /**
   * 3. pathLen. Mellannivån på plats `index`, räknat från lövet, har `index`
   * mellannivåer under sig, och roten har alla. Lövet räknas inte, så den som
   * utfärdat lövet klarar också pathLen 0. Det är samma räkning som OpenSSL gör.
   */
  if (pathLengths.some((limit, index) => limit !== null && index > limit)) {
    return fail('path_length_exceeded')
  }
  const usableAnchors = anchors.filter((root) => rootAllows(root, intermediates.length))
  if (usableAnchors.length === 0) return fail('path_length_exceeded')

  // 4. Varje led är utfärdat och signerat av ledet ovanför, ner till lövet.
  for (let index = 0; index < chain.length - 1; index += 1) {
    if (!issuedBy(chain[index]!, chain[index + 1]!)) return fail('not_issued_by_intermediate')
  }

  const tbs = readTbsCertificate(leaf.raw)
  if (!tbs) return fail('malformed')

  // 5. Lövet har inte CA-rätt.
  const leafConstraints = basicConstraintsOf(leaf.raw, tbs)
  if (leafConstraints === null) return fail('malformed')
  if (leafConstraints.ca || leaf.ca) return fail('leaf_is_ca')

  // 6. Lövet får användas till underskrifter.
  const digitalSignature = keyUsageAllows(leaf.raw, tbs, DIGITAL_SIGNATURE)
  if (digitalSignature === null) return fail('malformed')
  if (!digitalSignature) return fail('no_digital_signature')

  // 7. Hela vägen gällde vid underskriften, roten inräknad (M2).
  if (!usableAnchors.some((root) => validDuring([...chain, root], options.signedDuring))) {
    return fail('not_valid_when_signed')
  }

  // 8. Personnumret.
  const personalNumber = personalNumberOf(leaf.raw, tbs)
  if (personalNumber === null) return fail('no_personal_number')

  return { ok: true, personalNumber, signingKey: leaf.publicKey }
}
