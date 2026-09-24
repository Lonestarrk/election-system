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
 * för. Kedjan är lövet och den mellannivå som utfärdat det, i den ordningen,
 * och roten är konfigurerad och lagras aldrig med kuvertet (se
 * ./trusted-roots.ts). Kontrollerna, i den ordning de görs:
 *
 *   1. mellannivån är utfärdad och signerad av en betrodd rot
 *   2. mellannivån har CA-rätt
 *   3. lövet är utfärdat och signerat av mellannivån
 *   4. lövet har inte CA-rätt i basicConstraints
 *   5. lövet får användas till underskrifter: keyUsage med digitalSignature
 *   6. lövet och mellannivån gällde vid underskriften
 *   7. lövet bär exakt ett personnummer, tolv siffror, som serialNumber i subject
 *
 * "Utfärdad och signerad" är två frågor, och båda ställs. `checkIssued` jämför
 * bara namnen och nyckelidentifierarna, och de kan vem som helst skriva av.
 * `verify` prövar signaturen, och den kan bara utfärdarens nyckel ha gjort.
 *
 * Ordningen gör att varje förfalskning underkänns av sin egen kontroll: en
 * mellannivå utan CA-rätt fastnar i 2 och inte i 3, fast den fastnat där också,
 * och ett löv med CA-rätt fastnar i 4. Skälet kommer med i svaret, så att en
 * avvikelse i valideringen går att utreda.
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
 * enligt RFC 5280 gör. Med en fast rot och en kedja av fast längd, där bara
 * BankID:s egna CA utfärdar, är det de prövningarna som inte behövs.
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
  | 'not_issued_by_intermediate'
  | 'leaf_is_ca'
  | 'no_digital_signature'
  | 'not_valid_when_signed'
  | 'no_personal_number'

export type ChainVerdict =
  | { ok: true; personalNumber: string; signingKey: KeyObject }
  | { ok: false; reason: ChainFailure }

/**
 * Lövet och en mellannivå. BankID:s kedja har samma form, och en fast längd
 * gör att ingen längre kedja behöver prövas mot begränsningar i rotens
 * basicConstraints, som node:crypto inte lämnar ut.
 */
const CHAIN_LENGTH = 2

/** Ett certifikat är ett par kilobyte. Det här är gott om plats, och ingen gräns för det rimliga. */
const MAX_PEM_LENGTH = 16 * 1024

const PEM = /^-----BEGIN CERTIFICATE-----\r?\n((?:[A-Za-z0-9+/=]+\r?\n)+)-----END CERTIFICATE-----\r?\n?$/

const KEY_USAGE = Uint8Array.of(0x06, 0x03, 0x55, 0x1d, 0x0f)
const BASIC_CONSTRAINTS = Uint8Array.of(0x06, 0x03, 0x55, 0x1d, 0x13)
const SERIAL_NUMBER = Uint8Array.of(0x06, 0x03, 0x55, 0x04, 0x05)
const OID = 0x06
const BOOLEAN = 0x01
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
  if (!Array.isArray(pems) || pems.length === 0 || pems.length > CHAIN_LENGTH + 1) return null

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
 * digitalSignature i lövets keyUsage. Null om tillägget inte går att läsa, och
 * falskt om det saknas: utan tillägget får nyckeln enligt RFC 5280 användas
 * till allt, men ett BankID-certifikat har det alltid, och det som saknar det
 * godtas inte.
 */
function allowsDigitalSignature(der: Uint8Array, tbs: TbsCertificate): boolean | null {
  const bits = extensionValue(der, tbs, KEY_USAGE)
  if (bits === 'absent') return false
  if (bits === null || bits.tag !== BIT_STRING) return null

  // Först antalet oanvända bitar i sista byten, sedan bitarna. digitalSignature
  // är bit 0, den högsta biten i första byten.
  const content = derContent(der, bits)
  if (content.length === 0 || content[0]! > 7 || (content.length === 1 && content[0] !== 0)) {
    return null
  }
  return content.length > 1 && (content[1]! & 0x80) !== 0
}

/**
 * Står cA i lövets basicConstraints? Null om tillägget inte går att läsa.
 *
 * LÄST UR BYTENA, INTE UR `X509Certificate.ca`.
 *
 * `ca` svarar på om certifikatet kan verka som CA, och OpenSSL säger nej för
 * ett certifikat vars keyUsage saknar keyCertSign, också när basicConstraints
 * ger det CA-rätt. Ett löv med CA-rätt och bara digitalSignature passerade
 * därför `ca`. För mellannivån är just det rätt fråga, eftersom den ska kunna
 * utfärda. För lövet är frågan en annan: har utfärdaren gett det CA-rätt? Ett
 * BankID-certifikat för en person har det aldrig, och ett som har det är inte
 * ett sådant certifikat, oavsett vad keyUsage säger.
 */
function claimsCaRights(der: Uint8Array, tbs: TbsCertificate): boolean | null {
  const constraints = extensionValue(der, tbs, BASIC_CONSTRAINTS)
  if (constraints === 'absent') return false
  if (constraints === null || constraints.tag !== DER_SEQUENCE) return null

  const fields = derChildren(der, constraints)
  if (!fields || fields.length > 2) return null

  // cA har förvalet FALSE och står bara med när det är sant. DER skriver sant
  // som 0xff, och ett annat värde är en kodning OpenSSL kanske läser som sant.
  const first = fields[0]
  if (first?.tag !== BOOLEAN) return fields.length === 0 ? false : null
  const flag = derContent(der, first)
  if (flag.length !== 1 || flag[0] !== 0xff) return null
  return true
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
 * Prövar kedjan mot de betrodda rötterna.
 *
 * @param chain Lövet först, sedan mellannivån.
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
  if (chain.length !== CHAIN_LENGTH) return fail('malformed')
  const [leaf, intermediate] = chain as [X509Certificate, X509Certificate]

  if (!options.roots.some((root) => issuedBy(intermediate, root))) return fail('untrusted_root')
  if (!intermediate.ca) return fail('intermediate_not_ca')
  if (!issuedBy(leaf, intermediate)) return fail('not_issued_by_intermediate')

  const tbs = readTbsCertificate(leaf.raw)
  if (!tbs) return fail('malformed')

  const caRights = claimsCaRights(leaf.raw, tbs)
  if (caRights === null) return fail('malformed')
  if (caRights || leaf.ca) return fail('leaf_is_ca')

  const digitalSignature = allowsDigitalSignature(leaf.raw, tbs)
  if (digitalSignature === null) return fail('malformed')
  if (!digitalSignature) return fail('no_digital_signature')

  if (!validDuring([leaf, intermediate], options.signedDuring)) return fail('not_valid_when_signed')

  const personalNumber = personalNumberOf(leaf.raw, tbs)
  if (personalNumber === null) return fail('no_personal_number')

  return { ok: true, personalNumber, signingKey: leaf.publicKey }
}
