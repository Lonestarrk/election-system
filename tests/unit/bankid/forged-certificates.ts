import { createPrivateKey, createSign, generateKeyPairSync, type KeyObject, X509Certificate } from 'node:crypto'
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
  issuer?: CertificateIssuer
  notBefore?: Date
  notAfter?: Date
  ca?: boolean
  keyUsage?: KeyUsageBit[] | null
}

/** Namnet i ett BankID-certifikat: land, efternamn, förnamn, personnummer och hela namnet. */
export function voterName(personalNumber: string | null): DistinguishedName {
  return {
    country: 'SE',
    surname: 'Lindqvist',
    givenName: 'Anna',
    ...(personalNumber === null ? {} : { serialNumber: personalNumber }),
    commonName: 'Anna Lindqvist',
  }
}

/** Ett löv för en väljare, som attrappen hade utfärdat det om inget anges. */
export function voterLeaf(pair: KeyPair, options: LeafOptions = {}): X509Certificate {
  const now = Date.now()
  const personalNumber = options.personalNumber === undefined ? '199001011234' : options.personalNumber

  return issueCertificate({
    subject: voterName(personalNumber),
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

/** En underskrift som BankID gör den: RSA med SHA-256, i base64. */
export function signPayload(privateKey: KeyObject, payload: string): string {
  return createSign('sha256').update(payload).end().sign(privateKey, 'base64')
}

export function pemChain(...certificates: X509Certificate[]): string[] {
  return certificates.map((certificate) => certificate.toString())
}
