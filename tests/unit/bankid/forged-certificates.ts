import { createPrivateKey, createSign, generateKeyPairSync, type KeyObject, X509Certificate } from 'node:crypto'
import {
  derOid,
  derPrintableString,
  derSequence,
  derSet,
  derUtf8String,
} from '@/modules/eligibility/bankid/mock-ca/der-encoder'
import {
  encodeName,
  issueCertificate,
  issuerFrom,
  type CertificateIssuer,
  type DistinguishedName,
  type KeyUsageBit,
} from '@/modules/eligibility/bankid/mock-ca/issue-certificate'
import {
  MOCK_BANKID_INTERMEDIATE_CERTIFICATE,
  MOCK_BANKID_INTERMEDIATE_PRIVATE_KEY,
} from '@/modules/eligibility/bankid/mock-ca/issuing-ca-test-key'
import { MOCK_BANKID_ROOT_CERTIFICATE } from '@/modules/eligibility/bankid/mock-ca/root-certificate'

/**
 * CERTIFIKAT SOM EN ANGRIPARE KAN BYGGA, FÖR TESTERNA.
 *
 * Varje förfalskning är så nära en äkta kedja som angriparen kan komma, så att
 * precis en kontroll har något att säga nej till. En kedja till en annan rot
 * bär därför attrappens egna namn, så att bara signaturen skiljer den från den
 * äkta, och ett utgånget löv är i övrigt korrekt utfärdat av den äkta
 * mellannivån. Då visar testet att just den kontrollen underkänner, och inte
 * att något annat råkade gå fel först.
 *
 * Attrappens mellannivå har sin privata nyckel incheckad, så testerna kan
 * utfärda vad som helst under den. Rotens nyckel finns inte, så det enda sättet
 * att få en egen mellannivå godkänd är att lägga till en egen rot bland de
 * betrodda, och det gör bara testet för en mellannivå utan CA-rätt.
 */

export const MOCK_ROOT = new X509Certificate(MOCK_BANKID_ROOT_CERTIFICATE)
export const MOCK_INTERMEDIATE = new X509Certificate(MOCK_BANKID_INTERMEDIATE_CERTIFICATE)
export const MOCK_ISSUER: CertificateIssuer = issuerFrom(
  MOCK_INTERMEDIATE,
  createPrivateKey(MOCK_BANKID_INTERMEDIATE_PRIVATE_KEY),
)

export type KeyPair = { publicKey: KeyObject; privateKey: KeyObject }

/** RSA-nycklar tar en stund att ta fram, så varje nyckel skapas en gång per testfil. */
const keys = new Map<string, KeyPair>()

export function rsaKeys(name: string): KeyPair {
  let pair = keys.get(name)
  if (!pair) {
    pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    keys.set(name, pair)
  }
  return pair
}

const DAY = 86_400_000

export type LeafOptions = {
  personalNumber?: string | null
  /** Förnamn och efternamn. Förvalet är Anna Lindqvist. */
  name?: PersonName
  /** Ett färdigkodat subject, som ersätter namn och personnummer. */
  subject?: Uint8Array
  issuer?: CertificateIssuer
  notBefore?: Date
  notAfter?: Date
  ca?: boolean
  keyUsage?: KeyUsageBit[] | null
}

export type PersonName = { givenName: string; surname: string }

const ANNA: PersonName = { givenName: 'Anna', surname: 'Lindqvist' }

/** Namnet i ett BankID-certifikat: land, efternamn, förnamn, personnummer och hela namnet. */
export function voterName(personalNumber: string | null, name: PersonName = ANNA): DistinguishedName {
  return {
    country: 'SE',
    surname: name.surname,
    givenName: name.givenName,
    ...(personalNumber === null ? {} : { serialNumber: personalNumber }),
    commonName: `${name.givenName} ${name.surname}`,
  }
}

/**
 * Ett subject med två serialNumber, som ingen CA borde utfärda. `together`
 * lägger dem i samma RDN, annars står de i var sin.
 */
export function subjectWithTwoPersonalNumbers(
  first: string,
  second: string,
  options: { together: boolean },
): Buffer {
  const attribute = (oid: string, value: Buffer) => derSequence(derOid(oid), value)
  const serialNumber = (value: string) => attribute('2.5.4.5', derPrintableString(value))

  return derSequence(
    derSet(attribute('2.5.4.6', derPrintableString('SE'))),
    ...(options.together
      ? [derSet(serialNumber(first), serialNumber(second))]
      : [derSet(serialNumber(first)), derSet(serialNumber(second))]),
    derSet(attribute('2.5.4.3', derUtf8String('Anna Lindqvist'))),
  )
}

/** Ett löv för en väljare, som attrappen hade utfärdat det om inget anges. */
export function voterLeaf(pair: KeyPair, options: LeafOptions = {}): X509Certificate {
  const now = Date.now()
  const personalNumber = options.personalNumber === undefined ? '199001011234' : options.personalNumber

  return issueCertificate({
    subject: options.subject ?? voterName(personalNumber, options.name),
    publicKey: pair.publicKey,
    issuer: options.issuer ?? MOCK_ISSUER,
    notBefore: options.notBefore ?? new Date(now - 60_000),
    notAfter: options.notAfter ?? new Date(now + 365 * DAY),
    ca: options.ca ?? false,
    keyUsage: options.keyUsage === undefined ? ['digitalSignature'] : options.keyUsage,
  })
}

/** Ett löv som certifikatet självt har signerat, med väljarens personnummer. */
export function selfSignedLeaf(pair: KeyPair, personalNumber: string): X509Certificate {
  const now = Date.now()
  const name = encodeName(voterName(personalNumber))

  return issueCertificate({
    subject: name,
    publicKey: pair.publicKey,
    issuer: { name, privateKey: pair.privateKey },
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 365 * DAY),
    ca: false,
    keyUsage: ['digitalSignature'],
  })
}

/**
 * En egen rot och mellannivå med exakt samma namn som attrappens, men med
 * andra nycklar. Namnen gör att OpenSSL hittar "utfärdaren", och bara
 * signaturerna avslöjar förfalskningen.
 *
 * De gäller från 2020, långt före attrappens egna, som skapades när skriptet
 * kördes. Så kan testerna av giltighetstiden lägga en underskrift i det
 * förflutna utan att mellannivån hinner bli det som underkänner den.
 */
export function lookalikeHierarchy(options: { intermediateIsCa?: boolean } = {}) {
  const rootKeys = rsaKeys('egen rot')
  const intermediateKeys = rsaKeys('egen mellannivå')
  const rootName = issuerFrom(MOCK_ROOT, rootKeys.privateKey).name
  const validity = { notBefore: new Date('2020-01-01T00:00:00Z'), notAfter: new Date('2046-01-01T00:00:00Z') }

  const root = issueCertificate({
    subject: rootName,
    publicKey: rootKeys.publicKey,
    issuer: { name: rootName, privateKey: rootKeys.privateKey },
    ...validity,
    ca: true,
    keyUsage: ['keyCertSign', 'cRLSign'],
  })

  const intermediate = issueCertificate({
    subject: issuerFrom(MOCK_INTERMEDIATE, intermediateKeys.privateKey).name,
    publicKey: intermediateKeys.publicKey,
    issuer: issuerFrom(root, rootKeys.privateKey),
    ...validity,
    ca: options.intermediateIsCa ?? true,
    keyUsage: ['keyCertSign', 'cRLSign'],
  })

  return { root, intermediate, issuer: issuerFrom(intermediate, intermediateKeys.privateKey) }
}

/** Hur en CA i en egen hierarki ska se ut. Det som inte anges är som hos en riktig CA. */
export type CaOptions = {
  ca?: boolean
  pathLength?: number
  keyUsage?: KeyUsageBit[] | null
  notBefore?: Date
  notAfter?: Date
}

/**
 * En egen rot med mellannivåer under sig, för testerna av kedjans form.
 *
 * `levels` räknas uppifrån: den första utfärdas av roten, nästa av den första,
 * och så vidare. Svaret har mellannivåerna i kedjans ordning, alltså från den
 * som utfärdar lövet och uppåt, och den utfärdare ett löv ska ha. Allt gäller
 * från 2020 till 2046 om inget annat anges, och namnet `label` gör att två
 * hierarkier i samma test aldrig delar namn eller nycklar.
 */
export function customHierarchy(label: string, rootOptions: CaOptions, levels: CaOptions[]) {
  const validity = (options: CaOptions) => ({
    notBefore: options.notBefore ?? new Date('2020-01-01T00:00:00Z'),
    notAfter: options.notAfter ?? new Date('2046-01-01T00:00:00Z'),
  })
  const authority = (options: CaOptions) => ({
    ca: options.ca ?? true,
    ...(options.pathLength === undefined ? {} : { pathLength: options.pathLength }),
    keyUsage: options.keyUsage === undefined ? (['keyCertSign', 'cRLSign'] as KeyUsageBit[]) : options.keyUsage,
  })

  const rootKeys = rsaKeys(`${label}: rot`)
  const rootName = encodeName({ country: 'SE', organization: 'Egen testhierarki', commonName: `${label}: rot` })
  const root = issueCertificate({
    subject: rootName,
    publicKey: rootKeys.publicKey,
    issuer: { name: rootName, privateKey: rootKeys.privateKey },
    ...validity(rootOptions),
    ...authority(rootOptions),
  })

  let issuer = issuerFrom(root, rootKeys.privateKey)
  const fromTop: X509Certificate[] = []
  levels.forEach((options, index) => {
    const keys = rsaKeys(`${label}: nivå ${index + 1}`)
    const certificate = issueCertificate({
      subject: { country: 'SE', organization: 'Egen testhierarki', commonName: `${label}: nivå ${index + 1}` },
      publicKey: keys.publicKey,
      issuer,
      ...validity(options),
      ...authority(options),
    })
    fromTop.push(certificate)
    issuer = issuerFrom(certificate, keys.privateKey)
  })

  return { root, intermediates: [...fromTop].reverse(), issuer }
}

/** En underskrift som BankID gör den: RSA med SHA-256, i base64. */
export function signPayload(privateKey: KeyObject, payload: string): string {
  return createSign('sha256').update(payload).end().sign(privateKey, 'base64')
}

export function pemChain(...certificates: X509Certificate[]): string[] {
  return certificates.map((certificate) => certificate.toString())
}
