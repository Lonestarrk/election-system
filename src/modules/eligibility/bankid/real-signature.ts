import { createHash, type X509Certificate } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_OCSP_RESPONSE_BYTES } from '../sealed-chain'
import { customerRootFor } from './bankid-environment'
import { certificateFromDer, signedOnDay } from './certificate-chain'
import { parseServiceName } from './service-name'
import { MAX_SIGNATURE_XML_BYTES, parseXml, strictBase64, verifyBankIdSignature, type XmlElement } from './xmldsig'

/**
 * EN RIKTIG UNDERSKRIFT FRÅN BANKID:S TESTMILJÖ SOM TESTFALL (uppgift 17d).
 *
 * Läsaren (./xmldsig.ts) är byggd efter BankID:s signaturprofil, och rapporten
 * för uppgift 17b räknar upp de antaganden den vilar på. Den här modulen prövar en
 * fångad underskrift (./signature-capture.ts) med läsaren, mot BankID:s kundrot för
 * testmiljön så som den är förankrad i ./bankid-environment.ts, och säger vilket
 * antagande som inte höll när läsaren avvisar den. Den används av
 * scripts/add-real-bankid-signature.ts och av tests/unit/bankid/real-signature.test.ts,
 * och appen importerar den inte.
 *
 * Läsaren avgör. Inget här godtar något som läsaren avvisar: fynden är en
 * förklaring för den som ska rätta läsaren, och de läses ur dokumentet med egna,
 * enkla regler, så att ett fel i läsarens tolkning inte döljer sig själv.
 */

/** De tretton antagandena ur rapporten för uppgift 17b, med 13 från dess fixrunda. */
export const STATED_ASSUMPTIONS: Record<number, string> = {
  1: 'C14N-identifieraren är den inkluderande (profilens) eller den exklusiva',
  2: 'Signaturalgoritmen är rsa-sha256 och digesten sha256, inte sha1 eller ECDSA',
  3: 'Ordningen är profilens: bidSignedData före bidKeyInfo i SignedInfo, och usrVisibleData, usrNonVisibleData, srvInfo, clientInfo i bankIdSignedData',
  4: 'srvInfo, clientInfo, env och ai har bara de element profilen räknar upp',
  5: 'XML-deklarationen är den fasta, <?xml version="1.0" encoding="UTF-8" standalone="no"?>, eller ingen',
  6: 'Base64 står utan radbrytningar och blanktecken i SignatureValue, X509Certificate och DigestValue',
  7: 'usrNonVisibleData och usrVisibleData är base64 av UTF-8',
  8: 'usrVisibleData har charset="UTF-8" och möjligen visible, men inte format',
  9: 'Kedjan är 2–4 certifikat utan rot (5 med roten sist), och lövet har en RSA-nyckel på minst 2048 bitar',
  10: 'Kedjan går till BankID:s kundrot för testmiljön, som den är förankrad i koden',
  11: `Dokumentet ryms i ${MAX_SIGNATURE_XML_BYTES} byte och spärrsvaret i ${MAX_OCSP_RESPONSE_BYTES} byte`,
  12: 'Ett riktigt exempel finns som testfall',
  13: 'srvInfo/name är RP-certifikatets namn, i RFC 4514-form med name och serialNumber',
}

/** srvInfo/name för BankID:s publika testcertifikat FP Testcert 5, som fångsten kör med enligt README. */
export const PUBLIC_TEST_RP_SERVICE_NAME =
  'CN=FP Testcert 5,name=Test av BankID,serialNumber=5566304928,O=Testbank A AB (publ),C=SE'

/** Ett fynd: vilket antagande som inte höll, eller null när inget av dem förklarar det. */
export type Finding = { assumption: number | null; text: string }

/** Filen som fångsten skrev. */
export type RealCapture = { environment: string; capturedOn: string; signature: string; ocspResponse: string }

/** En fixtur i tests/unit/bankid/fixtures/real: fångsten och vad som behövs för att pröva den igen. */
export type RealFixture = {
  environment: 'test'
  capturedOn: string
  /** Vilken BankID-app och version som skrev under, som människan angav. */
  bankIdApp: string
  /** srvInfo/name som underskriften prövas mot. */
  service: string
  signature: string
  ocspResponse: string
}

export type RealSignatureResult =
  | { ok: true; personalNumber: string; name: string | null; observations: string[] }
  | { ok: false; reason: string; findings: Finding[]; personalNumber: string | null; name: string | null }

type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string }

const DAY = /^\d{4}-\d{2}-\d{2}$/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseCapture(value: unknown): Parsed<RealCapture> {
  if (!isObject(value)) return { ok: false, problem: 'filen är inget JSON-objekt.' }
  const { environment, capturedOn, signature, ocspResponse } = value
  if (typeof environment !== 'string') return { ok: false, problem: 'environment saknas.' }
  if (typeof capturedOn !== 'string' || !DAY.test(capturedOn) || Number.isNaN(Date.parse(`${capturedOn}T00:00:00Z`))) {
    return { ok: false, problem: 'capturedOn är ingen dag på formen ÅÅÅÅ-MM-DD.' }
  }
  if (typeof signature !== 'string' || signature === '' || strictBase64(signature) === null) {
    return { ok: false, problem: 'signature är inte base64.' }
  }
  if (typeof ocspResponse !== 'string' || (ocspResponse !== '' && strictBase64(ocspResponse) === null)) {
    return { ok: false, problem: 'ocspResponse är inte base64.' }
  }
  return { ok: true, value: { environment, capturedOn, signature, ocspResponse } }
}

const FIXTURE_KEYS = ['environment', 'capturedOn', 'bankIdApp', 'service', 'signature', 'ocspResponse']

export function parseRealFixture(value: unknown): { ok: true; fixture: RealFixture } | { ok: false; problem: string } {
  const capture = parseCapture(value)
  if (!capture.ok) return capture
  const record = value as Record<string, unknown>
  const extra = Object.keys(record).filter((key) => !FIXTURE_KEYS.includes(key))
  if (extra.length > 0) return { ok: false, problem: `okända fält: ${extra.join(', ')}.` }
  if (capture.value.environment !== 'test') {
    return { ok: false, problem: 'environment är inte test. Bara underskrifter från BankID:s testmiljö är fixturer.' }
  }
  const { bankIdApp, service } = record
  if (typeof bankIdApp !== 'string' || bankIdApp.trim() === '' || bankIdApp.length > 200) {
    return { ok: false, problem: 'bankIdApp saknas: vilken BankID-app och version som skrev under.' }
  }
  if (typeof service !== 'string' || parseServiceName(service) === null) {
    return { ok: false, problem: 'service är inget srvInfo/name i RFC 4514-form.' }
  }
  return { ok: true, fixture: { ...capture.value, environment: 'test', bankIdApp, service } }
}

/**
 * Prövar underskriften med läsaren. `roots` är BankID:s förankrade kundrot för
 * testmiljön. Bara testerna av verktyget ger något annat, och aldrig
 * kommandoraden eller testet av fixturerna.
 */
export function verifyRealSignature(
  input: { signature: string; ocspResponse: string; capturedOn: string; service: string },
  roots: readonly X509Certificate[] = [customerRootFor('test')],
): RealSignatureResult {
  const xmlBytes = Buffer.from(input.signature, 'base64')
  const xml = xmlBytes.toString('utf8')
  const ocspBytes = Buffer.from(input.ocspResponse, 'base64').length
  const { personalNumber, name } = identityIn(xml)

  const service = parseServiceName(input.service)
  if (!service) {
    return {
      ok: false,
      reason: 'service_unreadable',
      findings: [{ assumption: 13, text: `Det angivna srvInfo/name går inte att läsa: ${input.service}` }],
      personalNumber,
      name,
    }
  }

  const verdict = verifyBankIdSignature(xmlBytes, {
    roots,
    signedDuring: signedOnDay(new Date(`${input.capturedOn}T00:00:00Z`)),
    service,
  })
  if (!verdict.ok) {
    return {
      ok: false,
      reason: verdict.reason,
      findings: diagnoseRejection(xml, verdict.reason, { expectedService: input.service, roots }),
      personalNumber,
      name,
    }
  }

  if (ocspBytes > MAX_OCSP_RESPONSE_BYTES) {
    return {
      ok: false,
      reason: 'ocsp_too_large',
      findings: [
        {
          assumption: 11,
          text: `Spärrsvaret är ${ocspBytes} byte, och taket är ${MAX_OCSP_RESPONSE_BYTES}. Läggningen hade svarat signature_too_large.`,
        },
      ],
      personalNumber: verdict.personalNumber,
      name,
    }
  }

  return { ok: true, personalNumber: verdict.personalNumber, name, observations: observe(xml, xmlBytes.length, ocspBytes) }
}

/**
 * Namnen på de fixturer i katalogen som har metadata från testmiljön och som läsaren
 * godtar mot testmiljöns förankrade kundrot. Kravet `bankid-reader-tested` följer
 * den här listan, se tests/unit/bankid/real-signature.test.ts.
 */
export function acceptedRealFixtures(directory: string, roots?: readonly X509Certificate[]): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .filter((name) => {
      let parsed: ReturnType<typeof parseRealFixture>
      try {
        parsed = parseRealFixture(JSON.parse(readFileSync(join(directory, name), 'utf8')))
      } catch {
        return false
      }
      return parsed.ok && verifyRealSignature(parsed.fixture, roots).ok
    })
}

/** Filnamnet för en fixtur: dagen och början av underskriftens SHA-256. */
export function fixtureFileName(capture: RealCapture): string {
  const digest = createHash('sha256').update(capture.signature).digest('hex').slice(0, 12)
  return `bankid-test-${capture.capturedOn}-${digest}.json`
}

// ---------------------------------------------------------------------------
// Fynden. Egna, enkla regler över dokumentet, oberoende av läsarens tolkning.
// ---------------------------------------------------------------------------

const C14N = ['http://www.w3.org/TR/2001/REC-xml-c14n-20010315', 'http://www.w3.org/2001/10/xml-exc-c14n#']
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256'
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>'

const ALLOWED_CHILDREN: Record<string, readonly string[]> = {
  srvInfo: ['name', 'nonce', 'displayName'],
  clientInfo: ['funcId', 'version', 'rpRef', 'env'],
  env: ['ai'],
  ai: ['type', 'deviceInfo', 'deviceinfo', 'uhi', 'fsib', 'utb', 'requirement', 'uauth', 'token'],
}
const SIGNED_DATA_ORDER = ['usrVisibleData', 'usrNonVisibleData', 'srvInfo', 'clientInfo']

/** Läsarens skäl i klartext, för det som inget antagande förklarar. */
const REASONS: Record<string, string> = {
  malformed: 'dokumentet går inte att tolka som XML, eller ett certifikat går inte att läsa',
  doctype: 'dokumentet har en DOCTYPE',
  entity: 'dokumentet har en entitet eller teckenreferens',
  comment: 'dokumentet har en kommentar',
  processing_instruction: 'dokumentet har en processinstruktion',
  namespace: 'ett element har ett prefix eller ligger i fel namnrymd',
  not_canonical: 'dokumentet står inte i kanonisk form (självstängande element, attributordning, citattecken)',
  duplicate_id: 'ett Id står två gånger',
  unexpected_structure: 'strukturen avviker från profilen på ett sätt som reglerna här inte känner igen',
  algorithm: 'en algoritm avviker',
  reference: 'en referens pekar på något annat än profilens element',
  digest: 'en digest stämmer inte med elementets kanoniska form',
  signature: 'underskriften över SignedInfo håller inte med lövets nyckel',
  weak_key: 'lövet saknar en RSA-nyckel på minst 2048 bitar',
  not_valid_when_signed: 'ett certifikat gällde inte på dagen i fångsten',
  no_personal_number: 'lövet bär inget personnummer i serialNumber',
}

const CHAIN_REASONS = ['intermediate_not_ca', 'path_length_exceeded', 'not_issued_by_intermediate', 'leaf_is_ca', 'no_digital_signature']

/**
 * Vilka antaganden dokumentet bryter mot, med det som syntes. Skälet från läsaren
 * räknas med, och när inget antagande förklarar det sägs skälet som det är.
 */
export function diagnoseRejection(
  xml: string,
  reason: string,
  context: { expectedService?: string; roots?: readonly X509Certificate[] } = {},
): Finding[] {
  const findings: Finding[] = []
  const add = (assumption: number | null, seen: string) => {
    const stated = assumption === null ? '' : `Antagande ${assumption} (${STATED_ASSUMPTIONS[assumption]}) höll inte. `
    findings.push({ assumption, text: `${stated}Sett: ${seen}` })
  }

  // 5: deklarationen läses ur texten, eftersom läsaren avvisar en annan redan i tolkningen.
  const declaration = /^<\?xml[^?]*\?>/.exec(xml)?.[0]
  if (declaration !== undefined && declaration !== DECLARATION) add(5, declaration)

  // 6: base64 med radbrytningar eller blanktecken.
  for (const match of xml.matchAll(/<(SignatureValue|X509Certificate|DigestValue)>([^<]*)<\//g)) {
    if (/[\s]/.test(match[2]!)) {
      add(6, `${match[1]} har radbrytningar eller blanktecken i sin base64.`)
      break
    }
  }

  if (/>\s+</.test(xml)) {
    add(null, 'blanktecken eller radbrytningar mellan elementen. Profilen och FriBID:s beskrivning säger att dokumentet saknar dem.')
  }

  const parsed = parseXml(xml)
  if (parsed.ok) inspectTree(parsed.root, add)

  // Det läsaren själv säger, där det pekar ut ett antagande.
  if (reason === 'service_name') {
    add(13, `srvInfo/name i underskriften är "${serviceNameIn(xml) ?? '(går inte att läsa)'}", och det väntade är "${context.expectedService ?? '(okänt)'}".`)
  } else if (reason === 'untrusted_root') {
    const top = topCertificateIssuer(xml)
    const roots = (context.roots ?? []).map((root) => root.subject.replace(/\n/g, ', ')).join('; ')
    add(10, `kedjans översta certifikat är utfärdat av "${top ?? '(okänt)'}", och den betrodda roten är "${roots}".`)
  } else if (reason === 'too_large') {
    add(11, `dokumentet är ${Buffer.byteLength(xml, 'utf8')} byte, eller djupare eller större än läsarens tak.`)
  } else if (CHAIN_REASONS.includes(reason) && !findings.some((finding) => finding.assumption === 9)) {
    add(9, `kedjeprövningen avvisade kedjan med skälet ${reason}.`)
  }

  if (!findings.some((finding) => finding.assumption !== null)) {
    findings.push({
      assumption: null,
      text:
        `Läsaren avvisade med skälet "${reason}" (${REASONS[reason] ?? 'okänt skäl'}), och inget av de tretton ` +
        'antagandena förklarar det.',
    })
  }
  return findings
}

function inspectTree(root: XmlElement, add: (assumption: number | null, seen: string) => void): void {
  const all: XmlElement[] = []
  const walk = (element: XmlElement) => {
    all.push(element)
    element.children.forEach(walk)
  }
  walk(root)
  const named = (name: string) => all.filter((element) => element.name === name)

  // 1 och 2: algoritmerna.
  for (const element of [...named('CanonicalizationMethod'), ...named('Transform')]) {
    const algorithm = attribute(element, 'Algorithm')
    if (algorithm !== null && !C14N.includes(algorithm)) add(1, `${element.name} Algorithm="${algorithm}".`)
  }
  for (const element of named('SignatureMethod')) {
    const algorithm = attribute(element, 'Algorithm')
    if (algorithm !== RSA_SHA256) add(2, `SignatureMethod Algorithm="${algorithm}".`)
  }
  for (const element of named('DigestMethod')) {
    const algorithm = attribute(element, 'Algorithm')
    if (algorithm !== SHA256) add(2, `DigestMethod Algorithm="${algorithm}".`)
  }

  // 3: ordningen.
  const uris = named('Reference').map((reference) => attribute(reference, 'URI'))
  if (uris.length === 2 && uris[0] === '#bidKeyInfo' && uris[1] === '#bidSignedData') {
    add(3, 'referensen till bidKeyInfo står före den till bidSignedData i SignedInfo.')
  }
  for (const signedData of named('bankIdSignedData')) {
    const order = signedData.children.map((child) => child.name)
    const known = order.filter((name) => SIGNED_DATA_ORDER.includes(name))
    const expected = SIGNED_DATA_ORDER.filter((name) => known.includes(name))
    if (known.join() !== expected.join()) add(3, `barnen till bankIdSignedData står i ordningen ${order.join(', ')}.`)
    const unknown = order.filter((name) => !SIGNED_DATA_ORDER.includes(name))
    if (unknown.length > 0) add(null, `bankIdSignedData har elementen ${unknown.join(', ')}, som profilen inte räknar upp.`)
  }

  // 4: elementen i srvInfo, clientInfo, env och ai.
  for (const [parent, allowed] of Object.entries(ALLOWED_CHILDREN)) {
    for (const element of named(parent)) {
      const unknown = element.children.map((child) => child.name).filter((name) => !allowed.includes(name))
      if (unknown.length > 0) add(4, `${parent} har ${unknown.join(', ')}, utöver ${allowed.join(', ')}.`)
    }
  }

  // 7: texterna är base64 av UTF-8.
  for (const name of ['usrNonVisibleData', 'usrVisibleData']) {
    for (const element of named(name)) {
      const bytes = strictBase64(element.text)
      if (bytes === null) add(7, `${name} är inte strikt base64.`)
      else if (!isUtf8(bytes)) add(7, `${name} är base64, men av något som inte är UTF-8.`)
    }
  }

  // 8: attributen på usrVisibleData.
  for (const element of named('usrVisibleData')) {
    const names = element.attributes.map(([name]) => name)
    const unknown = names.filter((name) => name !== 'charset' && name !== 'visible')
    if (unknown.length > 0) add(8, `usrVisibleData har attributen ${unknown.join(', ')}.`)
    const charset = attribute(element, 'charset')
    if (charset !== 'UTF-8') add(8, `usrVisibleData har charset="${charset}".`)
  }

  // 9: kedjans längd och lövets nyckel. 2: nyckeltypen.
  for (const data of named('X509Data')) {
    const count = data.children.length
    if (count < 2 || count > 5) add(9, `X509Data har ${count} certifikat.`)
    const leaf = data.children[0] ? certificateFromBase64(data.children[0].text) : null
    const key = leaf?.publicKey
    if (key && key.asymmetricKeyType !== 'rsa') add(2, `lövets nyckel är ${key.asymmetricKeyType}, inte RSA.`)
    else if (key && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      add(9, `lövets RSA-nyckel är ${key.asymmetricKeyDetails?.modulusLength} bitar.`)
    }
  }
}

/** Vad som syntes i en underskrift som läsaren godtog, per antagande, för rapporten. */
function observe(xml: string, xmlBytes: number, ocspBytes: number): string[] {
  const parsed = parseXml(xml)
  if (!parsed.ok) return []
  const all: XmlElement[] = []
  const walk = (element: XmlElement) => {
    all.push(element)
    element.children.forEach(walk)
  }
  walk(parsed.root)
  const first = (name: string) => all.find((element) => element.name === name)
  const childrenOf = (name: string) => first(name)?.children.map((child) => child.name).join(', ') ?? '(saknas)'
  const x509 = first('X509Data')?.children ?? []
  const leaf = x509[0] ? certificateFromBase64(x509[0].text) : null

  return [
    `1: CanonicalizationMethod ${attribute(first('CanonicalizationMethod')!, 'Algorithm')}, Transform ${attribute(first('Transform')!, 'Algorithm')}.`,
    `2: SignatureMethod ${attribute(first('SignatureMethod')!, 'Algorithm')}, DigestMethod ${attribute(first('DigestMethod')!, 'Algorithm')}.`,
    `3: bankIdSignedData har ${childrenOf('bankIdSignedData')}.`,
    `4: srvInfo har ${childrenOf('srvInfo')}. clientInfo har ${childrenOf('clientInfo')}. ai har ${childrenOf('ai')}.`,
    `5: XML-deklarationen är ${parsed.declaration === '' ? 'ingen' : parsed.declaration}.`,
    '6: Base64 utan radbrytningar.',
    '7: usrNonVisibleData och usrVisibleData är base64 av UTF-8.',
    `8: usrVisibleData har ${first('usrVisibleData')!.attributes.map(([name, value]) => `${name}="${value}"`).join(' ')}.`,
    `9: X509Data har ${x509.length} certifikat, och lövets nyckel är ${leaf?.publicKey.asymmetricKeyType} ${leaf?.publicKey.asymmetricKeyDetails?.modulusLength} bitar.`,
    `10: Kedjan går till kundroten "${topCertificateIssuer(xml) ?? '(okänt)'}".`,
    `11: Dokumentet är ${xmlBytes} byte av ${MAX_SIGNATURE_XML_BYTES}, och spärrsvaret ${ocspBytes} byte av ${MAX_OCSP_RESPONSE_BYTES}.`,
    `13: srvInfo/name är "${serviceNameIn(xml)}".`,
  ]
}

function attribute(element: XmlElement, name: string): string | null {
  return element.attributes.find(([key]) => key === name)?.[1] ?? null
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

function certificateFromBase64(text: string): X509Certificate | null {
  const der = strictBase64(text.replace(/\s/g, ''))
  return der ? certificateFromDer(der) : null
}

function certificatesIn(xml: string): X509Certificate[] {
  return [...xml.matchAll(/<X509Certificate>([^<]+)<\/X509Certificate>/g)]
    .map((match) => certificateFromBase64(match[1]!))
    .filter((certificate): certificate is X509Certificate => certificate !== null)
}

function topCertificateIssuer(xml: string): string | null {
  const certificates = certificatesIn(xml)
  return certificates.at(-1)?.issuer.replace(/\n/g, ', ') ?? null
}

function serviceNameIn(xml: string): string | null {
  const match = /<srvInfo><name>([^<]*)<\/name>/.exec(xml)
  if (!match) return null
  const bytes = strictBase64(match[1]!)
  return bytes && isUtf8(bytes) ? Buffer.from(bytes).toString('utf8') : null
}

/** Personnummer och namn ur lövet, för varningen innan underskriften blir en fixtur. */
function identityIn(xml: string): { personalNumber: string | null; name: string | null } {
  const leaf = certificatesIn(xml)[0]
  if (!leaf) return { personalNumber: null, name: null }
  const field = (key: string) =>
    leaf.subject
      .split('\n')
      .find((line) => line.startsWith(`${key}=`))
      ?.slice(key.length + 1) ?? null
  return { personalNumber: field('serialNumber'), name: field('CN') }
}
