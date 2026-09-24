import { randomBytes, sign, type KeyObject, X509Certificate } from 'node:crypto'
import { derBytes, readTbsCertificate } from '../der-reader'
import {
  derBitString,
  derBoolean,
  derExplicit,
  derInteger,
  derNull,
  derOctetString,
  derOid,
  derPrintableString,
  derSequence,
  derSet,
  derSmallInteger,
  derTime,
  derUtf8String,
} from './der-encoder'

/**
 * ATTRAPPEN UTFÄRDAR CERTIFIKAT, SOM BANKID:S CA GÖR.
 *
 * Varje underskrift i attrappen får ett eget X.509-certifikat, utfärdat av
 * attrappens mellannivå (./issuing-ca-test-key.ts), som i sin tur är utfärdad av
 * attrappens rot (./root-certificate.ts). Certifikatet bär väljarens
 * personnummer som `serialNumber` i subject, som ett svenskt BankID-certifikat
 * gör, och kedjan prövas sedan på samma sätt som en riktig: mot en fast rot,
 * med CA-rätt, giltighetstid och keyUsage. Se ../certificate-chain.ts.
 *
 * Funktionen tar vilka värden som helst, också sådana som ingen CA borde
 * utfärda: ett löv med CA-rätt, ett certifikat som redan gått ut, en
 * mellannivå utan CA-rätt. Testerna behöver just de certifikaten för att visa
 * att varje kontroll underkänner sitt fall. Attrappen själv utfärdar bara det
 * en riktig CA hade utfärdat, se `MockBankIdService`.
 *
 * Den hör bara till attrappen och testerna, precis som DER-kodaren.
 */

/** sha256WithRSAEncryption, RFC 4055. Attrappens nycklar är RSA, som BankID:s. */
const SHA256_WITH_RSA = '1.2.840.113549.1.1.11'

const ATTRIBUTE = {
  country: '2.5.4.6',
  organization: '2.5.4.10',
  commonName: '2.5.4.3',
  surname: '2.5.4.4',
  givenName: '2.5.4.42',
  serialNumber: '2.5.4.5',
} as const

const BASIC_CONSTRAINTS = '2.5.29.19'
const KEY_USAGE = '2.5.29.15'

export type KeyUsageBit =
  | 'digitalSignature'
  | 'nonRepudiation'
  | 'keyEncipherment'
  | 'dataEncipherment'
  | 'keyAgreement'
  | 'keyCertSign'
  | 'cRLSign'

/** Bitarnas nummer i KeyUsage, RFC 5280 4.2.1.3. Bit 0 är den högsta i första byten. */
const KEY_USAGE_BIT: Record<KeyUsageBit, number> = {
  digitalSignature: 0,
  nonRepudiation: 1,
  keyEncipherment: 2,
  dataEncipherment: 3,
  keyAgreement: 4,
  keyCertSign: 5,
  cRLSign: 6,
}

/** De attribut ett namn i attrappen kan ha. Landet och serialNumber skrivs som PrintableString. */
export type DistinguishedName = {
  country?: string
  organization?: string
  commonName?: string
  surname?: string
  givenName?: string
  serialNumber?: string
}

export type CertificateIssuer = {
  /** Utfärdarens namn, byte för byte som det står i utfärdarens eget certifikat. */
  name: Uint8Array
  privateKey: KeyObject
}

export type CertificateRequest = {
  /** Ett namn att koda, eller ett färdigkodat, som för en självsignerad rot. */
  subject: DistinguishedName | Uint8Array
  publicKey: KeyObject
  issuer: CertificateIssuer
  notBefore: Date
  notAfter: Date
  /** basicConstraints med cA satt. */
  ca: boolean
  /**
   * pathLenConstraint i basicConstraints: hur många mellannivåer som får stå
   * under certifikatet. Utelämnat betyder ingen gräns. Det skrivs också utan
   * cA, fast ingen CA borde utfärda ett sådant, eftersom testerna behöver det.
   */
  pathLength?: number
  /** Null utelämnar tillägget helt. */
  keyUsage: KeyUsageBit[] | null
}

function attribute(type: string, value: Buffer): Buffer {
  return derSet(derSequence(derOid(type), value))
}

/** Kodar ett namn, ett attribut per RDN, i en fast ordning. */
export function encodeName(name: DistinguishedName): Buffer {
  const rdns: Buffer[] = []

  if (name.country !== undefined) rdns.push(attribute(ATTRIBUTE.country, derPrintableString(name.country)))
  if (name.organization !== undefined) {
    rdns.push(attribute(ATTRIBUTE.organization, derUtf8String(name.organization)))
  }
  if (name.surname !== undefined) rdns.push(attribute(ATTRIBUTE.surname, derUtf8String(name.surname)))
  if (name.givenName !== undefined) rdns.push(attribute(ATTRIBUTE.givenName, derUtf8String(name.givenName)))
  if (name.serialNumber !== undefined) {
    rdns.push(attribute(ATTRIBUTE.serialNumber, derPrintableString(name.serialNumber)))
  }
  if (name.commonName !== undefined) rdns.push(attribute(ATTRIBUTE.commonName, derUtf8String(name.commonName)))

  return derSequence(...rdns)
}

/**
 * Utfärdaren bakom ett befintligt certifikat, med namnet exakt som det står
 * där. Ett namn som kodats om, med en annan strängtyp eller ordning, hade
 * kunnat skilja sig på bytenivå, och då hittar OpenSSL inte utfärdaren.
 */
export function issuerFrom(certificate: X509Certificate, privateKey: KeyObject): CertificateIssuer {
  const tbs = readTbsCertificate(certificate.raw)
  if (!tbs) throw new Error('Utfärdarens certifikat går inte att läsa.')
  return { name: Buffer.from(derBytes(certificate.raw, tbs.subject)), privateKey }
}

/** Ett tillägg, alltid kritiskt: båda tilläggen attrappen skriver ska prövas av den som läser. */
function extension(type: string, value: Buffer): Buffer {
  return derSequence(derOid(type), derBoolean(true), derOctetString(value))
}

function basicConstraints(ca: boolean, pathLength: number | undefined): Buffer {
  // cA har förvalet FALSE, och DER skriver aldrig ut ett förval.
  const fields = [
    ...(ca ? [derBoolean(true)] : []),
    ...(pathLength === undefined ? [] : [derSmallInteger(pathLength)]),
  ]
  return extension(BASIC_CONSTRAINTS, derSequence(...fields))
}

/**
 * KeyUsage som en namngiven bitsträng. DER kräver att nollbitarna efter den
 * sista satta tas bort, och antalet oanvända bitar skrivs först.
 */
function keyUsage(bits: KeyUsageBit[]): Buffer {
  if (bits.length === 0) throw new Error('keyUsage utan bitar ska utelämnas, inte skrivas tomt.')

  const numbers = bits.map((bit) => KEY_USAGE_BIT[bit])
  const highest = Math.max(...numbers)
  const bytes = new Uint8Array(Math.floor(highest / 8) + 1)
  for (const number of numbers) bytes[Math.floor(number / 8)]! |= 0x80 >> number % 8

  return extension(KEY_USAGE, derBitString(bytes, 7 - (highest % 8)))
}

/** Utfärdar ett certifikat och returnerar det som OpenSSL läser det. */
export function issueCertificate(request: CertificateRequest): X509Certificate {
  if (request.issuer.privateKey.asymmetricKeyType !== 'rsa') {
    throw new Error('Attrappen signerar bara med RSA, som BankID.')
  }

  const algorithm = derSequence(derOid(SHA256_WITH_RSA), derNull())
  const subject =
    request.subject instanceof Uint8Array ? Buffer.from(request.subject) : encodeName(request.subject)

  // Ett slumpat serienummer på 16 byte, positivt, som CA/Browser Forum kräver
  // av riktiga utfärdare: två certifikat från samma utfärdare får aldrig dela ett.
  const serialNumber = randomBytes(16)
  serialNumber[0]! &= 0x7f

  const extensions = [basicConstraints(request.ca, request.pathLength)]
  if (request.keyUsage !== null) extensions.push(keyUsage(request.keyUsage))

  const tbs = derSequence(
    derExplicit(0, derSmallInteger(2)),
    derInteger(serialNumber),
    algorithm,
    Buffer.from(request.issuer.name),
    derSequence(derTime(request.notBefore), derTime(request.notAfter)),
    subject,
    request.publicKey.export({ type: 'spki', format: 'der' }),
    derExplicit(3, derSequence(...extensions)),
  )

  const signature = sign('sha256', tbs, request.issuer.privateKey)

  return new X509Certificate(derSequence(tbs, algorithm, derBitString(signature)))
}
