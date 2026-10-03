import type { KeyObject, X509Certificate } from 'node:crypto'
import { certificateFromDer, signedAt } from '@/modules/eligibility/bankid/certificate-chain'
import { buildBankIdSignatureXml } from '@/modules/eligibility/bankid/mock-signature'
import { MOCK_SERVICE_NAME, parseServiceName } from '@/modules/eligibility/bankid/service-name'
import { verifyBankIdSignature } from '@/modules/eligibility/bankid/xmldsig'
import { sealBankIdSignature, sealLegacyCertificateChain } from '@/modules/eligibility/sealed-chain'
import { MOCK_INTERMEDIATE, MOCK_ROOT, rsaKeys, signPayload, voterLeaf } from './forged-certificates'

/**
 * HJÄLP FÖR TESTER SOM LÄSER ELLER BYGGER BANKID:S UNDERSKRIFT (uppgift 17b).
 *
 * `completionData.signature` är base64 av ett XMLDSig-dokument. Testerna läser
 * det signerade och kedjan genom läsaren, som produktionskoden gör, och bygger
 * förfalskningar med attrappens byggare och en egen nyckel.
 */

export function signatureXml(signature: string): string {
  return Buffer.from(signature, 'base64').toString('utf8')
}

/** Underskriften prövad mot attrappens rot, nu. Kastar om den inte håller. */
export function verifiedMockSignature(signature: string) {
  const verdict = verifyBankIdSignature(Buffer.from(signature, 'base64'), {
    roots: [MOCK_ROOT],
    signedDuring: signedAt(new Date()),
    service: parseServiceName(MOCK_SERVICE_NAME)!,
  })
  if (!verdict.ok) throw new Error(`underskriften underkändes: ${verdict.reason}`)
  return verdict
}

/** Det signerade, ur det prövade elementet. */
export function signedContentIn(signature: string): string {
  return verifiedMockSignature(signature).usrNonVisibleData
}

/** Certifikaten i KeyInfo, lövet först. */
export function certificatesIn(signature: string): X509Certificate[] {
  return [...signatureXml(signature).matchAll(/<X509Certificate>([^<]+)<\/X509Certificate>/g)].map((match) => {
    const certificate = certificateFromDer(Buffer.from(match[1]!, 'base64'))
    if (!certificate) throw new Error('certifikatet gick inte att läsa')
    return certificate
  })
}

/** En underskrift i BankID:s format, med valfri kedja och nyckel, som base64 i BankID:s svar. */
export function bankIdSignature(request: {
  userNonVisibleData: string
  certificates: readonly X509Certificate[]
  privateKey: KeyObject
  userVisibleData?: string
}): string {
  const xml = buildBankIdSignatureXml({ userVisibleData: 'Rösta', ...request })
  return Buffer.from(xml, 'utf8').toString('base64')
}

/**
 * Underskriften så som `castEncryptedBallot` lagrar den: SignatureValue i
 * bankid_signature och hela dokumentet, med spärrsvaret, förseglat för raden.
 * För testerna som skriver en rad direkt.
 */
export function storedBankIdSignature(
  signature: string,
  ocspResponse: string,
  location: { voterStatusId: string; ballotId: string },
): { bankIdSignature: string; bankIdCertificateChain: string } {
  const xml = Buffer.from(signature, 'base64')
  const value = /<SignatureValue>([^<]+)<\/SignatureValue>/.exec(xml.toString('utf8'))?.[1]
  if (!value) throw new Error('Ingen SignatureValue i underskriften.')
  return {
    bankIdSignature: value,
    bankIdCertificateChain: sealBankIdSignature({ xml, ocspResponse: Buffer.from(ocspResponse, 'base64') }, location),
  }
}

/**
 * Ett kuvert så som det lagrades före uppgift 17b: attrappens tidigare
 * underskrift, en RSA-signatur direkt över det signerade, och kedjan förseglad i
 * det gamla formatet. Lövet utfärdas av attrappens mellannivå, som attrappen
 * gjorde då.
 */
export function storedLegacySignature(
  signedContent: string,
  personalNumber: string,
  location: { voterStatusId: string; ballotId: string },
  keys = rsaKeys(`gammal underskrift ${personalNumber}`),
): { bankIdSignature: string; bankIdCertificateChain: string } {
  const leaf = voterLeaf(keys, { personalNumber })
  return {
    bankIdSignature: signPayload(keys.privateKey, signedContent),
    bankIdCertificateChain: sealLegacyCertificateChain([leaf, MOCK_INTERMEDIATE], location),
  }
}

/** SignatureValue i dokumentet, som läggningen lagrar i bankid_signature och kuvertroten läser. */
export function signatureValueIn(signature: string): string {
  return verifiedMockSignature(signature).signatureValue
}
