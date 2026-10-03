import type { X509Certificate } from 'node:crypto'
import { runtimeMode } from '@/lib/mode-flag'
import { derChildren, derContent, DER_SEQUENCE, readTbsCertificate } from './der-reader'
import { rpCredentialsFromEnv } from './rp-certificate'

/**
 * VEM SOM BAD OM UNDERSKRIFTEN: srvInfo/name (uppgift 17c, antagande 13 från 17b).
 *
 * BankID:s signaturprofil säger att srvInfo/name är "the base64 encoded value of
 * the string representation of distinguished name, according to RFC4514 with
 * attribute names for 2.5.4.41 ("name") and 2.5.4.5 ("serialNumber") from
 * RFC4519, of the subject in the relying party certificate"
 * (developers.bankid.com/assets/signature-profile.pdf, hämtad 2026-10-03).
 *
 * Läsaren kräver att namnet är den egna tjänstens, ur det egna RP-certifikatet.
 * Utan den prövningen hade en underskrift som en annan tjänst bett om godtagits,
 * så länge det signerade innehållet var vårt kuvert, och den andra tjänsten hade
 * kunnat visa väljaren vilken text den ville i sin egen app. Texten väljaren såg
 * prövas också, men namnet är det BankID självt står för.
 *
 * JÄMFÖRELSEN. Namnet läses som en lista av attribut i RFC 4514:s ordning, alltså
 * med certifikatets sista RDN först. Attributnamnen jämförs utan hänsyn till
 * skiftläge, som RFC 4514 säger att de ska, och värdena exakt, efter att
 * escape-sekvenserna lästs. Ordningen och antalet ska vara desamma. Ett namn med
 * flera attribut i samma RDN ("+") eller ett hexkodat värde ("#...") avvisas: BankID:s
 * RP-certifikat har inga sådana, och det som avvisas är bara en underskrift för
 * mycket.
 */

export type ServiceNameAttribute = { type: string; value: string }
export type ServiceName = ServiceNameAttribute[]

/** Namnet i attrappens underskrifter, se ./mock-signature.ts. */
export const MOCK_SERVICE_NAME = 'name=Valsystemet (attrapp),serialNumber=0000000000'

/** Kortnamnen i RFC 4514 avsnitt 3, och de två från RFC 4519 som profilen anger. */
const ATTRIBUTE_NAMES: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.6': 'C',
  '2.5.4.9': 'STREET',
  '0.9.2342.19200300.100.1.25': 'DC',
  '0.9.2342.19200300.100.1.1': 'UID',
  '2.5.4.41': 'name',
  '2.5.4.5': 'serialNumber',
}

const OID = 0x06
const SET = 0x31
const STRING_TAGS = new Set([0x0c, 0x13, 0x16, 0x14]) // UTF8String, PrintableString, IA5String, TeletexString

function decodeOid(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null
  const parts: number[] = [Math.floor(bytes[0]! / 40), bytes[0]! % 40]
  let value = 0
  for (let index = 1; index < bytes.length; index += 1) {
    value = value * 128 + (bytes[index]! & 0x7f)
    if ((bytes[index]! & 0x80) === 0) {
      parts.push(value)
      value = 0
    }
  }
  return (bytes[bytes.length - 1]! & 0x80) === 0 ? parts.join('.') : null
}

/**
 * RP-certifikatets subject som en lista i RFC 4514:s ordning, eller null om det
 * inte går att läsa eller har en RDN med flera attribut.
 */
export function serviceNameOf(certificate: X509Certificate): ServiceName | null {
  const der = certificate.raw
  const tbs = readTbsCertificate(der)
  if (!tbs) return null
  const relativeNames = derChildren(der, tbs.subject)
  if (!relativeNames) return null

  const attributes: ServiceName = []
  for (const relativeName of relativeNames) {
    const members = relativeName.tag === SET ? derChildren(der, relativeName) : null
    if (!members || members.length !== 1) return null
    const parts = members[0]!.tag === DER_SEQUENCE ? derChildren(der, members[0]!) : null
    if (!parts || parts.length !== 2 || parts[0]!.tag !== OID || !STRING_TAGS.has(parts[1]!.tag)) return null
    const oid = decodeOid(derContent(der, parts[0]!))
    if (!oid) return null
    const raw = Buffer.from(derContent(der, parts[1]!))
    // PrintableString och IA5String är ASCII, och UTF8String är UTF-8.
    const value = parts[1]!.tag === 0x14 ? raw.toString('latin1') : raw.toString('utf8')
    attributes.push({ type: ATTRIBUTE_NAMES[oid] ?? oid, value })
  }
  return attributes.reverse()
}

/** Tecknen RFC 4514 avsnitt 2.4 kräver ett \ framför, var som helst i värdet. */
const SPECIAL = new Set(['"', '+', ',', ';', '<', '>', '\\'])

function escapeValue(value: string): string {
  let out = ''
  ;[...value].forEach((character, index, all) => {
    const leading = index === 0 && (character === ' ' || character === '#')
    const trailing = index === all.length - 1 && character === ' '
    out += SPECIAL.has(character) || leading || trailing ? `\\${character}` : character
  })
  return out
}

export function formatServiceName(name: ServiceName): string {
  return name.map(({ type, value }) => `${type}=${escapeValue(value)}`).join(',')
}

/** Läser ett namn enligt RFC 4514. Null för allt som inte är ett namn i den delmängd som beskrivs ovan. */
export function parseServiceName(text: string): ServiceName | null {
  const attributes: ServiceName = []
  let index = 0

  while (index < text.length) {
    const equals = text.indexOf('=', index)
    if (equals === -1) return null
    const type = text.slice(index, equals)
    if (!/^(?:[A-Za-z][A-Za-z0-9-]*|[0-9]+(?:\.[0-9]+)+)$/.test(type)) return null
    index = equals + 1
    if (text[index] === '#') return null

    const bytes: number[] = []
    let ended = false
    while (index < text.length && !ended) {
      const character = text[index]!
      if (character === ',') {
        ended = true
        index += 1
        break
      }
      if (character === '+' || character === '"' || character === ';' || character === '<' || character === '>') {
        return null
      }
      if (character === '\\') {
        const next = text[index + 1]
        if (next === undefined) return null
        if (SPECIAL.has(next) || next === ' ' || next === '#' || next === '=') {
          bytes.push(next.charCodeAt(0))
          index += 2
          continue
        }
        const hex = text.slice(index + 1, index + 3)
        if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null
        bytes.push(Number.parseInt(hex, 16))
        index += 3
        continue
      }
      bytes.push(...Buffer.from(character, 'utf8'))
      index += character.length
    }

    const decoded = Buffer.from(bytes)
    const value = decoded.toString('utf8')
    // Ogiltig UTF-8 i en hexkodad sekvens blir ersättningstecken, och då är det inget namn.
    if (!Buffer.from(value, 'utf8').equals(decoded)) return null
    if (value.length === 0) return null
    attributes.push({ type, value })
    // Ett komma sist lämnar ett tomt namn efter sig.
    if (ended && index >= text.length) return null
  }

  return attributes.length > 0 ? attributes : null
}

export function sameServiceName(a: ServiceName, b: ServiceName): boolean {
  return (
    a.length === b.length &&
    a.every(
      (attribute, index) =>
        attribute.type.toLowerCase() === b[index]!.type.toLowerCase() && attribute.value === b[index]!.value,
    )
  )
}

/**
 * Det namn varje underskrift ska bära. I demoläget attrappens, och i skarpt läge
 * subject i RP-certifikatet ur BANKID_CERT_PATH. Kastar när det inte går att
 * fastställa: läggningen svarar då med ett serverfel, och stängningen avbryts med
 * kopplingen orörd, som när rötterna saknas.
 */
export function expectedServiceName(): ServiceName {
  if (runtimeMode() === 'DEMO') return parseServiceName(MOCK_SERVICE_NAME)!
  const name = serviceNameOf(rpCredentialsFromEnv().certificate)
  if (!name) throw new Error('BANKID_CERT_PATH: certifikatets subject går inte att läsa som ett namn.')
  return name
}
