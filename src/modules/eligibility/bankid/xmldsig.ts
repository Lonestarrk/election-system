import { constants, createHash, verify as verifySignature, type KeyObject, type X509Certificate } from 'node:crypto'
import {
  certificateFromDer,
  verifyCertificateChain,
  type ChainFailure,
  type SigningWindow,
} from './certificate-chain'

/**
 * BANKID:S UNDERSKRIFT, PRÖVAD I BANKID:S EGET FORMAT (uppgift 17b).
 *
 * En riktig BankID lämnar underskriften i `completionData.signature`, base64 av
 * ett XMLDSig-dokument. Där ligger det signerade innehållet (`bankIdSignedData`,
 * med `usrNonVisibleData`) och certifikatkedjan (`KeyInfo`) inbäddade. Den här
 * modulen läser och prövar det dokumentet. Attrappen skriver samma format, så
 * att varje test går genom samma väg som en riktig underskrift.
 *
 * KÄLLORNA.
 *
 *   - BankID, "Signature profile for BankID", developers.bankid.com/assets/signature-profile.pdf,
 *     länkad från developers.bankid.com/how-to-guides/verifying-signatures (hämtad 2026-10-03).
 *     Den ger strukturen, att Signature alltid omsluter ett Object med exakt ett
 *     bankIdSignedData med Id="bidSignedData", att SignedInfo har exakt en
 *     referens till det och exakt en till KeyInfo med Id="bidKeyInfo", att
 *     kedjan står utan rot med lövet först, algoritmerna, och att SignedInfo och
 *     de refererade elementen redan står i kanonisk form.
 *   - W3C, "Exclusive XML Canonicalization Version 1.0", www.w3.org/TR/xml-exc-c14n/,
 *     och "Canonical XML Version 1.0", www.w3.org/TR/xml-c14n, för kanoniseringen.
 *   - W3C, "XML Signature Syntax and Processing", www.w3.org/TR/xmldsig-core/,
 *     avsnitt 3.2 Core Validation, som profilen hänvisar till.
 *
 * VARFÖR EN EGEN LÄSARE OCH INGET BIBLIOTEK. Inga nya beroenden får läggas till,
 * och XMLDSig-bibliotek har haft fel där en underskrift kunde flyttas eller
 * lindas in (signature wrapping): det som prövades var inte det som lästes.
 * Läsaren här tar inte emot XMLDSig i allmänhet. Den tar emot exakt BankID:s
 * profil och avvisar allt annat, och den läser `usrNonVisibleData` ur just det
 * element vars digest har prövats.
 *
 * VAD SOM AVVISAS, och i den ordning det prövas:
 *
 *   1. mer än `MAX_SIGNATURE_XML_BYTES`, ogiltig UTF-8, för djupt eller för många element
 *   2. DOCTYPE, entitetsreferenser (varje &), kommentarer, bearbetningsinstruktioner
 *      och CDATA. Bara en enda XML-deklaration godtas, först i dokumentet
 *   3. prefix och xmlns:prefix, och varje element utanför BankID:s två namnrymder
 *   4. det som inte är kanonisk form: självstängande element, attribut i fel
 *      ordning, enkla citattecken, blanktecken i taggarna, > eller CR i text
 *   5. dubbla Id
 *   6. allt utanför profilens struktur: okända element och attribut, element i
 *      fel ordning eller i fel antal, blanktecken mellan element, text som inte
 *      är strikt base64 där base64 ska stå, och en underskrift som inte är en
 *      underskrift (funcId är inte "Signing")
 *   7. andra algoritmer än profilens
 *   8. referenser som inte pekar på exakt profilens två element
 *   9. en digest som inte stämmer
 *  10. en kedja som inte går till en betrodd rot (se `verifyCertificateChain`)
 *  11. en underskrift som inte håller mot lövets nyckel, eller ett löv utan RSA-nyckel på minst 2048 bitar
 *
 * KANONISERINGEN. Profilen anger Canonical XML 1.0 (inkluderande), och uppgiften
 * kräver exklusiv kanonisering. På den delmängd läsaren godtar ger de exakt samma
 * bytes: de skiljer sig bara i namnrymder som ärvs från förfäder och i ärvda
 * xml:-attribut, och här finns varken prefix, xmlns:prefix eller xml:-attribut.
 * Det enda som finns är standardnamnrymden, och den skriver båda på toppelementet
 * och stryker den där den är överflödig. Därför godtas båda algoritmernas
 * identifierare, och kanoniseringen nedan är en implementation av båda för just
 * den delmängden och inte av någon av dem i allmänhet.
 *
 * INGENTING HÄR KASTAR för ett dokument. Underskriften läses också ur databasen
 * i valideringen före stängningen, och en spärr som kraschar på en trasig rad
 * hjälper den som skrev raden.
 */

export const XMLDSIG_NAMESPACE = 'http://www.w3.org/2000/09/xmldsig#'
export const BANKID_NAMESPACE = 'http://www.bankid.com/signature/v1.0.0/types'

/** Profilens kanonisering, och den exklusiva, som ger samma bytes här. Se modulens dokumentation. */
const CANONICALIZATION_ALGORITHMS: readonly string[] = [
  'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  'http://www.w3.org/2001/10/xml-exc-c14n#',
]

/**
 * Profilen tillåter också http://www.w3.org/2000/09/xmldsig#rsa-sha1. Den godtas
 * inte: SHA-1 är bruten för kollisioner, och en underskrift som ska stå sig mot den
 * som driver systemet ska inte vila på den. Ger BankID:s testmiljö RSA-SHA1 får
 * uppgift 17c avgöra saken.
 */
const SIGNATURE_ALGORITHM = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
const DIGEST_ALGORITHM = 'http://www.w3.org/2001/04/xmlenc#sha256'

/** Reference-elementets Type för bankIdSignedData, enligt profilen. */
const SIGNED_DATA_TYPE = 'http://www.bankid.com/signature/v1.0.0/types'

const SIGNED_DATA_ID = 'bidSignedData'
const KEY_INFO_ID = 'bidKeyInfo'

/**
 * TAKET FÖR DOKUMENTET: 24 KiB.
 *
 * UPPMÄTT 2026-10-03 med attrappens byggare:
 *
 *   - attrappens dokument, ett löv och en mellannivå på 2048 bitar och
 *     riksdagsvalets text: 5 370 byte
 *   - kedjans tak i certificate-chain.ts, ett löv och tre mellannivåer med
 *     RSA-nycklar på 4096 bitar och långa namn (6 021 byte DER), med ett valnamn
 *     på 200 tecken, det längsta en omröstning får ha: 11 632 byte
 *
 * Attrappens certifikat har färre tillägg än BankID:s, som bär till exempel
 * policy, spärrpunkt och adress till spärrtjänsten. Med omkring 600 byte till
 * per certifikat blir det största realistiska dokumentet omkring 15 KiB, och
 * taket ger omkring 9 KiB marginal. Förseglingen fyller ut till en fast längd
 * som rymmer taket, se src/modules/eligibility/sealed-chain.ts.
 */
export const MAX_SIGNATURE_XML_BYTES = 24 * 1024

/** Signature/Object/bankIdSignedData/clientInfo/env/ai/requirement/condition/type är nio nivåer. */
const MAX_DEPTH = 10
const MAX_ELEMENTS = 100

/** Den enda XML-deklaration som godtas, som FriBID:s beskrivning av formatet visar den. */
const XML_DECLARATIONS: readonly string[] = ['<?xml version="1.0" encoding="UTF-8" standalone="no"?>']

export type XmlDsigFailure =
  | 'malformed'
  | 'too_large'
  | 'doctype'
  | 'entity'
  | 'comment'
  | 'processing_instruction'
  | 'namespace'
  | 'not_canonical'
  | 'duplicate_id'
  | 'unexpected_structure'
  | 'algorithm'
  | 'reference'
  | 'digest'
  | 'signature'
  | 'weak_key'

/**
 * Ett element ur dokumentet. Antingen barn eller text, aldrig båda: blandat
 * innehåll finns inte i profilen. `text` är tom för ett element med barn.
 */
export type XmlElement = {
  name: string
  /** Namnrymden elementet ligger i, ur närmaste xmlns. Tom när ingen gäller. */
  namespace: string
  /** Värdet på elementets eget xmlns-attribut, eller null om det saknas. */
  declaredNamespace: string | null
  /** Attributen utom xmlns, i dokumentets ordning. */
  attributes: Array<[string, string]>
  children: XmlElement[]
  text: string
}

type Parsed = { ok: true; root: XmlElement; declaration: string } | { ok: false; reason: XmlDsigFailure }

class Reject {
  constructor(readonly reason: XmlDsigFailure) {}
}

const NAME = /^[A-Za-z][A-Za-z0-9]*$/

/**
 * LÄSER DOKUMENTET STRIKT, utan att tolka något utöver taggar, attribut och text.
 *
 * Ingenting avkodas: varje & avvisas, så det finns inga entiteter och inga
 * teckenreferenser att tolka olika. Kommentarer avvisas i stället för att hoppas
 * över, eftersom kanoniseringen utan kommentarer tar bort dem: en kommentar mitt i
 * ett textfält ändrar inte digesten, men en läsare som bara tar första textnoden
 * läser då något annat än det som signerades.
 *
 * Exporteras för attrappen och testerna.
 */
export function parseXml(xml: string): Parsed {
  try {
    return new XmlReader(xml).document()
  } catch (error) {
    if (error instanceof Reject) return { ok: false, reason: error.reason }
    return { ok: false, reason: 'malformed' }
  }
}

class XmlReader {
  private position = 0
  private elements = 0

  constructor(private readonly xml: string) {}

  document(): Parsed {
    let declaration = ''
    for (const candidate of XML_DECLARATIONS) {
      if (this.xml.startsWith(candidate)) {
        declaration = candidate
        this.position = candidate.length
      }
    }

    const root = this.element('', 1)
    if (this.position !== this.xml.length) throw new Reject(this.rejectionAt(this.position))
    return { ok: true, root, declaration }
  }

  /** Vad som står vid en plats där ett element eller slutet skulle ha stått. */
  private rejectionAt(at: number): XmlDsigFailure {
    const rest = this.xml.slice(at, at + 9)
    if (rest.startsWith('<!--')) return 'comment'
    if (rest.startsWith('<!DOCTYPE')) return 'doctype'
    if (rest.startsWith('<?')) return 'processing_instruction'
    if (rest.startsWith('&')) return 'entity'
    return 'malformed'
  }

  private element(parentNamespace: string, depth: number): XmlElement {
    if (depth > MAX_DEPTH) throw new Reject('too_large')
    this.elements += 1
    if (this.elements > MAX_ELEMENTS) throw new Reject('too_large')

    if (this.xml[this.position] !== '<' || /[!?/]/.test(this.xml[this.position + 1] ?? '')) {
      throw new Reject(this.rejectionAt(this.position))
    }
    this.position += 1

    const name = this.name()
    const attributes: Array<[string, string]> = []
    let declaredNamespace: string | null = null

    for (;;) {
      const next = this.xml[this.position]
      if (next === '>') {
        this.position += 1
        break
      }
      // Kanonisk form har aldrig självstängande element, och bara ett mellanslag före varje attribut.
      if (next === '/') throw new Reject('not_canonical')
      if (next !== ' ') throw new Reject(next === '\t' || next === '\n' || next === '\r' ? 'not_canonical' : 'malformed')
      this.position += 1

      const attribute = this.name()
      if (this.xml[this.position] !== '=') throw new Reject('malformed')
      if (this.xml[this.position + 1] !== '"') throw new Reject(this.xml[this.position + 1] === "'" ? 'not_canonical' : 'malformed')
      this.position += 2

      const end = this.xml.indexOf('"', this.position)
      if (end === -1) throw new Reject('malformed')
      const value = this.xml.slice(this.position, end)
      this.position = end + 1
      checkCharacters(value, 'attribute')

      if (attribute === 'xmlns') {
        if (declaredNamespace !== null || attributes.length > 0) throw new Reject('not_canonical')
        declaredNamespace = value
        continue
      }
      if (attributes.some(([existing]) => existing === attribute)) throw new Reject('malformed')
      const previous = attributes[attributes.length - 1]
      // Kanonisk ordning: xmlns först, sedan attributen utan namnrymd efter namn.
      if (previous && previous[0] >= attribute) throw new Reject('not_canonical')
      attributes.push([attribute, value])
    }

    const namespace = declaredNamespace ?? parentNamespace
    const element: XmlElement = { name, namespace, declaredNamespace, attributes, children: [], text: '' }

    if (this.xml[this.position] === '<' && this.xml[this.position + 1] !== '/') {
      // Barn. Mellan dem får ingenting stå, inte heller blanktecken.
      while (!this.xml.startsWith('</', this.position)) {
        if (this.xml[this.position] !== '<') throw new Reject(this.textBetweenElements())
        element.children.push(this.element(namespace, depth + 1))
      }
    } else {
      const end = this.xml.indexOf('<', this.position)
      if (end === -1) throw new Reject('malformed')
      element.text = this.xml.slice(this.position, end)
      checkCharacters(element.text, 'text')
      this.position = end
      if (!this.xml.startsWith('</', this.position)) throw new Reject(this.rejectionAt(this.position))
    }

    const closing = `</${name}>`
    if (!this.xml.startsWith(closing, this.position)) throw new Reject('malformed')
    this.position += closing.length

    return element
  }

  /** Text mellan två element: blandat innehåll, som profilen inte har. */
  private textBetweenElements(): XmlDsigFailure {
    const end = this.xml.indexOf('<', this.position)
    const text = this.xml.slice(this.position, end === -1 ? undefined : end)
    if (text.includes('&')) return 'entity'
    return 'unexpected_structure'
  }

  private name(): string {
    const start = this.position
    while (/[A-Za-z0-9:_.-]/.test(this.xml[this.position] ?? '')) this.position += 1
    const name = this.xml.slice(start, this.position)
    // Ett prefix, eller xmlns:prefix, är namnrymdsknep. Profilen har bara standardnamnrymden.
    if (name.includes(':')) throw new Reject('namespace')
    if (!NAME.test(name)) throw new Reject('malformed')
    return name
  }
}

/**
 * Tecken som inte får stå i text eller attribut. & betyder en entitet eller en
 * teckenreferens, och de avvisas hellre än tolkas. > och CR skriver kanonisk form
 * som referenser, så ett sådant tecken i klartext är inte kanonisk form. Övriga
 * kontrolltecken förekommer inte i profilen, och tab och radbrytning i ett
 * attribut normaliseras av en vanlig XML-läsare till mellanslag, så att två
 * läsare skulle se olika värden.
 */
function checkCharacters(value: string, where: 'text' | 'attribute'): void {
  if (value.includes('&')) throw new Reject('entity')
  if (value.includes('<')) throw new Reject('malformed')
  if (where === 'text' && (value.includes('>') || value.includes('\r'))) throw new Reject('not_canonical')
  if (where === 'attribute' && value.includes('"')) throw new Reject('malformed')
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f || code === 0xfffe || code === 0xffff) throw new Reject('malformed')
  }
}

/**
 * KANONISK FORM AV ETT ELEMENT, SOM TOPPELEMENT.
 *
 * Standardnamnrymden skrivs där den börjar gälla i utdata: på toppelementet, och
 * på ett element vars namnrymd skiljer sig från förälderns. Annars stryks den,
 * också om dokumentet skrev den. Attributen står efter namn, med xmlns först.
 * Text och attribut skrivs som de är, eftersom läsaren redan avvisat varje tecken
 * som kanonisk form skulle ha skrivit som en referens.
 */
export function canonicalize(element: XmlElement, renderedNamespace = ''): string {
  const namespace = element.namespace === renderedNamespace ? '' : ` xmlns="${element.namespace}"`
  const attributes = [...element.attributes]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => ` ${name}="${value}"`)
    .join('')
  const content =
    element.children.length > 0
      ? element.children.map((child) => canonicalize(child, element.namespace)).join('')
      : element.text
  return `<${element.name}${namespace}${attributes}>${content}</${element.name}>`
}

/**
 * Skriver ut ett läst dokument som det stod, med de xmlns som dokumentet skrev.
 * Bara för attrappen och testerna, som bygger och ändrar dokument.
 */
export function serializeXml(root: XmlElement, declaration = ''): string {
  const write = (element: XmlElement): string => {
    const namespace = element.declaredNamespace === null ? '' : ` xmlns="${element.declaredNamespace}"`
    const attributes = element.attributes.map(([name, value]) => ` ${name}="${value}"`).join('')
    const content = element.children.length > 0 ? element.children.map(write).join('') : element.text
    return `<${element.name}${namespace}${attributes}>${content}</${element.name}>`
  }
  return declaration + write(root)
}

/**
 * STRIKT BASE64: bara alfabetet, rätt utfyllnad, och samma text när den kodas
 * tillbaka. Buffer.from hoppar annars över blanktecken och tecken utanför
 * alfabetet, och då kan två olika texter ge samma bytes.
 */
export function strictBase64(text: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null
  const bytes = Buffer.from(text, 'base64')
  return bytes.toString('base64') === text ? bytes : null
}

/** UTF-8 som inte går att avkoda avvisas i stället för att bli ersättningstecken. */
function strictUtf8(bytes: Uint8Array): string | null {
  try {
    // ignoreBOM: ett BOM står kvar som tecken och fäller dokumentet, i stället för att tyst tas bort.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}

/** Det som läses ur profilens struktur, innan något har prövats kryptografiskt. */
type Structure = {
  signedInfo: XmlElement
  canonicalization: string
  signatureMethod: string
  references: Array<{ uri: string; type: string | null; transform: string; digestMethod: string; digest: string }>
  signatureValue: string
  keyInfo: XmlElement
  certificates: Buffer[]
  signedData: XmlElement
  usrVisibleData: string
  usrNonVisibleData: string
}

function attributesOf(element: XmlElement, allowed: Record<string, 'required' | 'optional'>): Map<string, string> {
  const values = new Map(element.attributes)
  for (const name of values.keys()) {
    if (!(name in allowed)) throw new Reject('unexpected_structure')
  }
  for (const [name, rule] of Object.entries(allowed)) {
    if (rule === 'required' && !values.has(name)) throw new Reject('unexpected_structure')
  }
  return values
}

function childrenInOrder(element: XmlElement, names: readonly string[]): XmlElement[] {
  if (element.children.length !== names.length) throw new Reject('unexpected_structure')
  element.children.forEach((child, index) => {
    if (child.name !== names[index]) throw new Reject('unexpected_structure')
  })
  return element.children
}

function emptyElement(element: XmlElement, allowed: Record<string, 'required' | 'optional'>): Map<string, string> {
  const values = attributesOf(element, allowed)
  if (element.children.length > 0 || element.text !== '') throw new Reject('unexpected_structure')
  return values
}

function textElement(element: XmlElement): string {
  attributesOf(element, {})
  if (element.children.length > 0) throw new Reject('unexpected_structure')
  return element.text
}

function base64Element(element: XmlElement): Buffer {
  const bytes = strictBase64(textElement(element))
  if (!bytes || bytes.length === 0) throw new Reject('unexpected_structure')
  return bytes
}

/**
 * Barn som får stå i valfri ordning, var och ett högst en gång. Profilen säger att
 * BankID kan lägga till element i srvInfo och clientInfo. Ett element som inte
 * står här avvisas ändå: hellre en underskrift för mycket som uppgift 17c får
 * pröva än ett okänt element i det som godtas.
 */
function childSet(
  element: XmlElement,
  allowed: Record<string, 'required' | 'optional'>,
): Map<string, XmlElement> {
  attributesOf(element, {})
  if (element.text !== '' || element.children.length === 0) throw new Reject('unexpected_structure')
  const children = new Map<string, XmlElement>()
  for (const child of element.children) {
    if (!(child.name in allowed) || children.has(child.name)) throw new Reject('unexpected_structure')
    children.set(child.name, child)
  }
  for (const [name, rule] of Object.entries(allowed)) {
    if (rule === 'required' && !children.has(name)) throw new Reject('unexpected_structure')
  }
  return children
}

/** Varje element i dokumentet ligger i en av profilens två namnrymder, och på sin plats. */
function checkNamespaces(root: XmlElement): void {
  const visit = (element: XmlElement, expected: string) => {
    const namespace = element.name === 'bankIdSignedData' ? BANKID_NAMESPACE : expected
    if (element.namespace !== namespace) throw new Reject('namespace')
    for (const child of element.children) visit(child, namespace)
  }
  visit(root, XMLDSIG_NAMESPACE)
}

/** Varje Id i dokumentet, en gång. Ett Id som står två gånger gör referensen tvetydig. */
function indexIds(root: XmlElement): Map<string, XmlElement> {
  const ids = new Map<string, XmlElement>()
  const visit = (element: XmlElement) => {
    for (const [name, value] of element.attributes) {
      if (name !== 'Id') continue
      if (ids.has(value)) throw new Reject('duplicate_id')
      ids.set(value, element)
    }
    element.children.forEach(visit)
  }
  visit(root)
  return ids
}

/** Profilens struktur, och ingenting annat. */
function readStructure(root: XmlElement): Structure {
  if (root.name !== 'Signature') throw new Reject('unexpected_structure')
  // Signature ska själv skriva ut sin namnrymd. Den ärvs inte från något.
  if (root.declaredNamespace !== XMLDSIG_NAMESPACE) throw new Reject('namespace')
  attributesOf(root, {})
  const [signedInfo, signatureValue, keyInfo, object] = childrenInOrder(root, [
    'SignedInfo',
    'SignatureValue',
    'KeyInfo',
    'Object',
  ]) as [XmlElement, XmlElement, XmlElement, XmlElement]

  attributesOf(signedInfo, {})
  const [canonicalization, signatureMethod, ...references] = childrenInOrder(signedInfo, [
    'CanonicalizationMethod',
    'SignatureMethod',
    'Reference',
    'Reference',
  ]) as [XmlElement, XmlElement, XmlElement, XmlElement]

  const readReference = (reference: XmlElement) => {
    const attributes = attributesOf(reference, { Type: 'optional', URI: 'required' })
    const [transforms, digestMethod, digestValue] = childrenInOrder(reference, [
      'Transforms',
      'DigestMethod',
      'DigestValue',
    ]) as [XmlElement, XmlElement, XmlElement]
    attributesOf(transforms, {})
    const [transform] = childrenInOrder(transforms, ['Transform']) as [XmlElement]
    const digest = base64Element(digestValue)
    if (digest.length !== 32) throw new Reject('unexpected_structure')
    return {
      uri: attributes.get('URI')!,
      type: attributes.get('Type') ?? null,
      transform: emptyElement(transform, { Algorithm: 'required' }).get('Algorithm')!,
      digestMethod: emptyElement(digestMethod, { Algorithm: 'required' }).get('Algorithm')!,
      digest: digestValue.text,
    }
  }

  attributesOf(keyInfo, { Id: 'required' })
  const [x509Data] = childrenInOrder(keyInfo, ['X509Data']) as [XmlElement]
  attributesOf(x509Data, {})
  // Ett löv och en till tre mellannivåer, som kedjeprövningen tar.
  if (x509Data.children.length < 2 || x509Data.children.length > 4) throw new Reject('unexpected_structure')
  const certificates = x509Data.children.map((child) => {
    if (child.name !== 'X509Certificate') throw new Reject('unexpected_structure')
    return base64Element(child)
  })

  attributesOf(object, {})
  const [signedData] = childrenInOrder(object, ['bankIdSignedData']) as [XmlElement]
  // Också bankIdSignedData skriver ut sin namnrymd, som i profilens exempel.
  if (signedData.declaredNamespace !== BANKID_NAMESPACE) throw new Reject('namespace')
  attributesOf(signedData, { Id: 'required' })
  const [usrVisible, usrNonVisible, srvInfo, clientInfo] = childrenInOrder(signedData, [
    'usrVisibleData',
    'usrNonVisibleData',
    'srvInfo',
    'clientInfo',
  ]) as [XmlElement, XmlElement, XmlElement, XmlElement]

  // charset är UTF-8 enligt profilen. visible bär en sträng för vissa kortläsare.
  // format finns bara när texten skickats som simpleMarkdownV1, och det gör systemet inte.
  const visibleAttributes = attributesOf(usrVisible, { charset: 'required', visible: 'optional' })
  if (visibleAttributes.get('charset') !== 'UTF-8') throw new Reject('unexpected_structure')
  if (usrVisible.children.length > 0) throw new Reject('unexpected_structure')
  const usrVisibleData = decodeText(usrVisible.text)
  const usrNonVisibleData = decodeText(textElement(usrNonVisible))

  const server = childSet(srvInfo, { name: 'required', nonce: 'required', displayName: 'optional' })
  for (const field of server.values()) base64Element(field)

  const client = childSet(clientInfo, {
    funcId: 'required',
    version: 'required',
    rpRef: 'optional',
    env: 'required',
  })
  // En legitimering är ingen underskrift över ett kuvert.
  if (textElement(client.get('funcId')!) !== 'Signing') throw new Reject('unexpected_structure')
  base64Element(client.get('version')!)
  if (client.has('rpRef')) base64Element(client.get('rpRef')!)

  const environment = childSet(client.get('env')!, { ai: 'required' })
  const assessment = childSet(environment.get('ai')!, {
    type: 'required',
    // Profilens tabell skriver deviceinfo. Det ena eller det andra, aldrig båda, se readAssessment.
    deviceInfo: 'optional',
    deviceinfo: 'optional',
    uhi: 'required',
    fsib: 'optional',
    utb: 'optional',
    requirement: 'optional',
    uauth: 'optional',
    token: 'optional',
  })
  readAssessment(assessment)

  // SignatureValue ska vara strikt base64. Texten lämnas ut som den står.
  base64Element(signatureValue)
  const signatureValueText = signatureValue.text

  return {
    signedInfo,
    canonicalization: emptyElement(canonicalization, { Algorithm: 'required' }).get('Algorithm')!,
    signatureMethod: emptyElement(signatureMethod, { Algorithm: 'required' }).get('Algorithm')!,
    references: references.map(readReference),
    signatureValue: signatureValueText,
    keyInfo,
    certificates,
    signedData,
    usrVisibleData,
    usrNonVisibleData,
  }
}

/** clientInfo.env.ai, med de värden profilen räknar upp. */
function readAssessment(assessment: Map<string, XmlElement>): void {
  if (assessment.has('deviceInfo') === assessment.has('deviceinfo')) throw new Reject('unexpected_structure')
  for (const name of ['type', 'deviceInfo', 'deviceinfo', 'uhi']) {
    const field = assessment.get(name)
    if (field) base64Element(field)
  }
  for (const name of ['fsib', 'utb', 'uauth', 'token']) {
    const field = assessment.get(name)
    if (field && !/^[A-Za-z0-9-]{1,32}$/.test(textElement(field))) throw new Reject('unexpected_structure')
  }

  const requirement = assessment.get('requirement')
  if (!requirement) return
  attributesOf(requirement, {})
  if (requirement.text !== '' || requirement.children.length === 0 || requirement.children.length > 8) {
    throw new Reject('unexpected_structure')
  }
  for (const condition of requirement.children) {
    if (condition.name !== 'condition') throw new Reject('unexpected_structure')
    attributesOf(condition, {})
    const [type, value] = childrenInOrder(condition, ['type', 'value']) as [XmlElement, XmlElement]
    if (!/^[A-Za-z0-9.-]{1,64}$/.test(textElement(type)) || !/^[A-Za-z0-9.-]{1,64}$/.test(textElement(value))) {
      throw new Reject('unexpected_structure')
    }
  }
}

/** usrVisibleData och usrNonVisibleData: base64 av UTF-8, strikt åt båda hållen. */
function decodeText(text: string): string {
  const bytes = strictBase64(text)
  if (!bytes || bytes.length === 0) throw new Reject('unexpected_structure')
  const decoded = strictUtf8(bytes)
  if (decoded === null) throw new Reject('unexpected_structure')
  return decoded
}

export type BankIdSignatureVerdict =
  | {
      ok: true
      /** Det signerade innehållet, ur det bankIdSignedData vars digest har prövats. */
      usrNonVisibleData: string
      /** Texten väljaren såg, ur samma element. */
      usrVisibleData: string
      /** Ur lövet, som kedjeprövningen har godkänt. */
      personalNumber: string
      /** SignatureValue i base64, som det står i dokumentet. */
      signatureValue: string
    }
  | { ok: false; reason: XmlDsigFailure | ChainFailure }

/**
 * PRÖVAR EN UNDERSKRIFT FRÅN BANKID, XML:EN SOM BYTES.
 *
 * Godkänner bara när allt håller: profilens struktur, algoritmerna, att
 * referenserna pekar på exakt profilens bankIdSignedData och KeyInfo, digesterna
 * över deras kanoniska form, kedjan mot `roots` vid `signedDuring`, och
 * underskriften över kanonisk SignedInfo med lövets nyckel. Det som lämnas ut
 * läses ur det element som prövats, och ingen annan kopia kan godtas, eftersom
 * dokumentet bara får innehålla ett.
 *
 * Att personnumret är väljarens prövar anroparen, som äger identitetshashen, och
 * att det signerade är rätt kuvert likaså.
 */
export function verifyBankIdSignature(
  xml: Uint8Array,
  options: { roots: readonly X509Certificate[]; signedDuring: SigningWindow },
): BankIdSignatureVerdict {
  if (xml.length > MAX_SIGNATURE_XML_BYTES) return { ok: false, reason: 'too_large' }
  const text = strictUtf8(xml)
  if (text === null) return { ok: false, reason: 'malformed' }

  const parsed = parseXml(text)
  if (!parsed.ok) return parsed

  let structure: Structure
  try {
    checkNamespaces(parsed.root)
    const ids = indexIds(parsed.root)
    structure = readStructure(parsed.root)

    if (!CANONICALIZATION_ALGORITHMS.includes(structure.canonicalization)) throw new Reject('algorithm')
    if (structure.signatureMethod !== SIGNATURE_ALGORITHM) throw new Reject('algorithm')
    for (const reference of structure.references) {
      if (!CANONICALIZATION_ALGORITHMS.includes(reference.transform)) throw new Reject('algorithm')
      if (reference.digestMethod !== DIGEST_ALGORITHM) throw new Reject('algorithm')
    }

    /**
     * REFERENSERNA PEKAR PÅ EXAKT PROFILENS TVÅ ELEMENT, och på inget annat.
     *
     * Det Id:t pekar ut ska vara samma element som strukturen läste innehållet ur.
     * Annars kan digesten gälla ett element och innehållet läsas ur ett annat.
     */
    const [toSignedData, toKeyInfo] = structure.references as [Structure['references'][0], Structure['references'][0]]
    if (toSignedData.uri !== `#${SIGNED_DATA_ID}` || toSignedData.type !== SIGNED_DATA_TYPE) {
      throw new Reject('reference')
    }
    if (toKeyInfo.uri !== `#${KEY_INFO_ID}` || toKeyInfo.type !== null) throw new Reject('reference')
    if (ids.get(SIGNED_DATA_ID) !== structure.signedData || ids.get(KEY_INFO_ID) !== structure.keyInfo) {
      throw new Reject('reference')
    }

    if (digestOf(structure.signedData) !== toSignedData.digest) throw new Reject('digest')
    if (digestOf(structure.keyInfo) !== toKeyInfo.digest) throw new Reject('digest')
  } catch (error) {
    if (error instanceof Reject) return { ok: false, reason: error.reason }
    return { ok: false, reason: 'malformed' }
  }

  const chain: X509Certificate[] = []
  for (const der of structure.certificates) {
    const certificate = certificateFromDer(der)
    if (!certificate) return { ok: false, reason: 'malformed' }
    chain.push(certificate)
  }

  const certificate = verifyCertificateChain(chain, { roots: options.roots, signedDuring: options.signedDuring })
  if (!certificate.ok) return certificate

  if (!isStrongRsaKey(certificate.signingKey)) return { ok: false, reason: 'weak_key' }

  /**
   * PKCS #1 v1.5 med SHA-256, som rsa-sha256 i XMLDSig. Utfyllnaden anges
   * uttryckligen, så att en annan nyckeltyp aldrig prövas med en annan algoritm.
   */
  const holds = (() => {
    try {
      return verifySignature(
        'sha256',
        Buffer.from(canonicalize(structure.signedInfo), 'utf8'),
        { key: certificate.signingKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(structure.signatureValue, 'base64'),
      )
    } catch {
      return false
    }
  })()
  if (!holds) return { ok: false, reason: 'signature' }

  return {
    ok: true,
    usrNonVisibleData: structure.usrNonVisibleData,
    usrVisibleData: structure.usrVisibleData,
    personalNumber: certificate.personalNumber,
    signatureValue: structure.signatureValue,
  }
}

function digestOf(element: XmlElement): string {
  return createHash('sha256').update(canonicalize(element), 'utf8').digest('base64')
}

function isStrongRsaKey(key: KeyObject): boolean {
  return key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048
}
