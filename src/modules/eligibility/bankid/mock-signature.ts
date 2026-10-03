import { createHash, createSign, type KeyObject, randomBytes, type X509Certificate } from 'node:crypto'
import { MOCK_SERVICE_NAME } from './service-name'
import { BANKID_NAMESPACE, canonicalize, parseXml, serializeXml, XMLDSIG_NAMESPACE, type XmlElement } from './xmldsig'

/**
 * ATTRAPPENS UNDERSKRIFT, I BANKID:S FORMAT (uppgift 17b).
 *
 * Attrappen skriver samma XMLDSig-dokument som en riktig BankID enligt
 * "Signature profile for BankID" (developers.bankid.com/assets/signature-profile.pdf),
 * så att varje underskrift i demon och i testerna prövas av samma läsare som en
 * riktig, se ./xmldsig.ts. Dokumentet står i kanonisk form utan blanktecken
 * mellan elementen, som profilen säger att BankID:s gör.
 *
 * Fälten i srvInfo och clientInfo är påhittade men har profilens form: nonce och
 * uhi är slumpade, och type, deviceInfo och version säger att det är attrappen.
 * Inget av dem lämnar förseglingen.
 */

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>'
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256'

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

export type MockSignatureRequest = {
  userVisibleData: string
  userNonVisibleData: string
  /** Lövet först och sedan mellannivåerna, utan roten. */
  certificates: readonly X509Certificate[]
  /** Lövets privata nyckel, RSA. */
  privateKey: KeyObject
}

/** Bygger ett signerat dokument i BankID:s format och ger det som text. */
export function buildBankIdSignatureXml(request: MockSignatureRequest): string {
  const reference = (attributes: string, digest: string) =>
    `<Reference${attributes}><Transforms><Transform Algorithm="${C14N}"></Transform></Transforms>` +
    `<DigestMethod Algorithm="${SHA256}"></DigestMethod><DigestValue>${digest}</DigestValue></Reference>`

  const signedInfo = (signedDataDigest: string, keyInfoDigest: string) =>
    `<SignedInfo xmlns="${XMLDSIG_NAMESPACE}">` +
    `<CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="${RSA_SHA256}"></SignatureMethod>` +
    reference(` Type="${BANKID_NAMESPACE}" URI="#bidSignedData"`, signedDataDigest) +
    reference(' URI="#bidKeyInfo"', keyInfoDigest) +
    '</SignedInfo>'

  const keyInfo =
    `<KeyInfo xmlns="${XMLDSIG_NAMESPACE}" Id="bidKeyInfo"><X509Data>` +
    request.certificates.map((certificate) => `<X509Certificate>${certificate.raw.toString('base64')}</X509Certificate>`).join('') +
    '</X509Data></KeyInfo>'

  const signedData =
    `<bankIdSignedData xmlns="${BANKID_NAMESPACE}" Id="bidSignedData">` +
    `<usrVisibleData charset="UTF-8" visible="wysiwys">${b64(request.userVisibleData)}</usrVisibleData>` +
    `<usrNonVisibleData>${b64(request.userNonVisibleData)}</usrNonVisibleData>` +
    `<srvInfo><name>${b64(MOCK_SERVICE_NAME)}</name>` +
    `<nonce>${randomBytes(32).toString('base64')}</nonce>` +
    `<displayName>${b64('Valsystemet')}</displayName></srvInfo>` +
    `<clientInfo><funcId>Signing</funcId><version>${b64('Attrapp=17b')}</version>` +
    `<env><ai><type>${b64('ATTRAPP')}</type><deviceInfo>${b64('attrapp')}</deviceInfo>` +
    `<uhi>${randomBytes(20).toString('base64')}</uhi><utb>cs1</utb>` +
    '<requirement><condition><type>CertificatePolicies</type><value>1.2.752.78.1.5</value></condition></requirement>' +
    '<uauth>pw</uauth></ai></env></clientInfo>' +
    '</bankIdSignedData>'

  // Digesterna räknas över den kanoniska formen ur läsarens egen tolkning av dokumentet.
  const draft = parsed(
    `${DECLARATION}<Signature xmlns="${XMLDSIG_NAMESPACE}">${signedInfo('', '')}<SignatureValue></SignatureValue>` +
      `${keyInfo}<Object>${signedData}</Object></Signature>`,
  )
  const [, , draftKeyInfo, draftObject] = draft.children as [XmlElement, XmlElement, XmlElement, XmlElement]
  const digest = (element: XmlElement) => createHash('sha256').update(canonicalize(element), 'utf8').digest('base64')

  const root = parsed(
    `${DECLARATION}<Signature xmlns="${XMLDSIG_NAMESPACE}">` +
      `${signedInfo(digest(draftObject.children[0]!), digest(draftKeyInfo))}<SignatureValue></SignatureValue>` +
      `${keyInfo}<Object>${signedData}</Object></Signature>`,
  )
  const [finalSignedInfo, signatureValue] = root.children as [XmlElement, XmlElement]
  signatureValue.text = createSign('sha256')
    .update(canonicalize(finalSignedInfo), 'utf8')
    .end()
    .sign(request.privateKey, 'base64')

  return serializeXml(root, DECLARATION)
}

function parsed(xml: string): XmlElement {
  // Tomma DigestValue och SignatureValue är tillåtna här, eftersom läsaren bara tolkar taggarna.
  const result = parseXml(xml)
  if (!result.ok) throw new Error(`Attrappens underskrift gick inte att läsa: ${result.reason}`)
  return result.root
}
