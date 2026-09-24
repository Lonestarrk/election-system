import { generateKeyPairSync, X509Certificate } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  derBitString,
  derInteger,
  derOid,
  derTime,
} from '@/modules/eligibility/bankid/mock-ca/der-encoder'
import {
  encodeName,
  issueCertificate,
  issuerFrom,
  type CertificateRequest,
} from '@/modules/eligibility/bankid/mock-ca/issue-certificate'

/**
 * ATTRAPPENS CERTIFIKATUTFÄRDARE.
 *
 * node:crypto kan läsa och pröva certifikat men inte skapa dem, så attrappen
 * har en egen liten DER-kodare. Den prövas här mot OpenSSL: ett certifikat som
 * kodaren skriver ska läsas tillbaka av `X509Certificate` med exakt det
 * subject, den giltighetstid och den nyckel det fick, och signaturen ska hålla
 * mot utfärdarens nyckel. Där OpenSSL inte lämnar ut värdet prövas bytena mot
 * handräknade DER-kodningar.
 */

const rootKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const intermediateKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const leafKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })

const NOT_BEFORE = new Date('2026-01-01T00:00:00Z')
const NOT_AFTER = new Date('2036-01-01T00:00:00Z')

const rootName = encodeName({ country: 'SE', organization: 'Prov', commonName: 'Provrot' })

function issue(overrides: Partial<CertificateRequest> & Pick<CertificateRequest, 'subject' | 'publicKey' | 'issuer'>) {
  return issueCertificate({
    notBefore: NOT_BEFORE,
    notAfter: NOT_AFTER,
    ca: false,
    keyUsage: ['digitalSignature'],
    ...overrides,
  })
}

const root = issue({
  subject: rootName,
  publicKey: rootKeys.publicKey,
  issuer: { name: rootName, privateKey: rootKeys.privateKey },
  ca: true,
  keyUsage: ['keyCertSign', 'cRLSign'],
})

const intermediate = issue({
  subject: { country: 'SE', organization: 'Prov', commonName: 'Provutfärdare' },
  publicKey: intermediateKeys.publicKey,
  issuer: issuerFrom(root, rootKeys.privateKey),
  ca: true,
  keyUsage: ['keyCertSign', 'cRLSign'],
})

describe('DER-kodaren', () => {
  it('kodar objektidentifierare', () => {
    // 2.5.4.5: 2·40 + 5 = 0x55, sedan 4 och 5.
    expect([...derOid('2.5.4.5')]).toEqual([0x06, 0x03, 0x55, 0x04, 0x05])
    // sha256WithRSAEncryption. 840 = 6·128 + 72 och 113549 = 6·128² + 119·128 + 13.
    expect(Buffer.from(derOid('1.2.840.113549.1.1.11')).toString('hex')).toBe(
      '06092a864886f70d01010b',
    )
  })

  it('kodar ett positivt heltal med minsta antal byte', () => {
    // Hög bit satt kräver en inledande nolla, annars vore talet negativt.
    expect([...derInteger(Uint8Array.of(0x80))]).toEqual([0x02, 0x02, 0x00, 0x80])
    // Inledande nollor tas bort.
    expect([...derInteger(Uint8Array.of(0x00, 0x00, 0x05))]).toEqual([0x02, 0x01, 0x05])
    expect([...derInteger(Uint8Array.of(0x00))]).toEqual([0x02, 0x01, 0x00])
  })

  it('kodar tid som UTCTime före 2050 och som GeneralizedTime därefter', () => {
    // RFC 5280 4.1.2.5. Millisekunderna följer inte med.
    expect(Buffer.from(derTime(new Date('2049-12-31T23:59:59.999Z'))).toString('latin1')).toBe(
      '\x17\x0d491231235959Z',
    )
    expect(Buffer.from(derTime(new Date('2050-01-02T03:04:05Z'))).toString('latin1')).toBe(
      '\x18\x0f20500102030405Z',
    )
  })

  it('kodar en bitsträng med antalet oanvända bitar först', () => {
    expect([...derBitString(Uint8Array.of(0x80), 7)]).toEqual([0x03, 0x02, 0x07, 0x80])
  })
})

describe('ett certifikat som kodaren har skrivit', () => {
  it('läses av OpenSSL med sitt subject, sin giltighetstid och sin nyckel', () => {
    expect(root.toLegacyObject().subject).toEqual({ C: 'SE', O: 'Prov', CN: 'Provrot' })
    expect(root.validFromDate).toEqual(NOT_BEFORE)
    expect(root.validToDate).toEqual(NOT_AFTER)
    expect(root.publicKey.export({ type: 'spki', format: 'der' })).toEqual(
      rootKeys.publicKey.export({ type: 'spki', format: 'der' }),
    )
  })

  it('är signerat av utfärdarens nyckel, och av ingen annan', () => {
    expect(root.verify(rootKeys.publicKey)).toBe(true)
    expect(intermediate.verify(rootKeys.publicKey)).toBe(true)
    expect(intermediate.verify(intermediateKeys.publicKey)).toBe(false)
  })

  it('bär utfärdarens namn, så att OpenSSL hittar utfärdaren', () => {
    expect(root.checkIssued(root)).toBe(true)
    expect(intermediate.checkIssued(root)).toBe(true)
    expect(root.checkIssued(intermediate)).toBe(false)
  })

  it('är en CA bara när det begärs', () => {
    const leaf = issue({
      subject: { commonName: 'Löv' },
      publicKey: leafKeys.publicKey,
      issuer: issuerFrom(intermediate, intermediateKeys.privateKey),
    })

    expect(intermediate.ca).toBe(true)
    expect(leaf.ca).toBe(false)
  })

  it('bär ett löv med serialNumber och keyUsage digitalSignature, båda kritiska där det gäller', () => {
    const leaf = issue({
      subject: {
        country: 'SE',
        commonName: 'Anna Lindqvist',
        givenName: 'Anna',
        surname: 'Lindqvist',
        serialNumber: '199001011234',
      },
      publicKey: leafKeys.publicKey,
      issuer: issuerFrom(intermediate, intermediateKeys.privateKey),
    })
    const raw = leaf.raw.toString('hex')

    expect(leaf.toLegacyObject().subject).toMatchObject({
      CN: 'Anna Lindqvist',
      GN: 'Anna',
      SN: 'Lindqvist',
      serialNumber: '199001011234',
    })
    // keyUsage (2.5.29.15), kritiskt, med bit 0 satt och sju oanvända bitar.
    expect(raw).toContain('300e0603551d0f0101ff0404030207' + '80')
    // basicConstraints (2.5.29.19), kritiskt, utan CA-rätt: en tom SEQUENCE.
    expect(raw).toContain('300c0603551d130101ff04023000')
  })

  it('bär keyUsage så att OpenSSL läser keyCertSign', () => {
    /**
     * OpenSSL godtar bara en utfärdare som får signera certifikat, om den
     * alls har keyUsage. En mellannivå med bara digitalSignature kan därför
     * inte utfärda ett löv som OpenSSL erkänner, och en med keyCertSign kan
     * det. Så prövas kodningen av bitarna mot OpenSSL och inte bara mot sig
     * själv.
     */
    const signingOnly = issue({
      subject: { commonName: 'Bara signering' },
      publicKey: intermediateKeys.publicKey,
      issuer: issuerFrom(root, rootKeys.privateKey),
      ca: true,
      keyUsage: ['digitalSignature'],
    })
    const leafOf = (issuer: X509Certificate) =>
      issue({
        subject: { commonName: 'Löv' },
        publicKey: leafKeys.publicKey,
        issuer: issuerFrom(issuer, intermediateKeys.privateKey),
      })

    expect(leafOf(signingOnly).checkIssued(signingOnly)).toBe(false)
    expect(leafOf(intermediate).checkIssued(intermediate)).toBe(true)
  })

  it('får ett nytt serienummer varje gång', () => {
    const request = {
      subject: { commonName: 'Löv' },
      publicKey: leafKeys.publicKey,
      issuer: issuerFrom(intermediate, intermediateKeys.privateKey),
    }

    expect(issue(request).serialNumber).not.toBe(issue(request).serialNumber)
  })
})
