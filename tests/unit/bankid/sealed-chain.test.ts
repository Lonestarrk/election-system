import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_SIGNATURE_XML_BYTES } from '@/modules/eligibility/bankid/xmldsig'
import {
  MAX_OCSP_RESPONSE_BYTES,
  openBankIdSignature,
  openLegacyCertificateChain,
  SEALED_CHAIN_LENGTH,
  SEALED_SIGNATURE_LENGTH,
  sealBankIdSignature,
  sealedFormatOf,
  sealLegacyCertificateChain,
} from '@/modules/eligibility/sealed-chain'
import { bankIdSignature } from './bankid-xml'
import { customHierarchy, MOCK_INTERMEDIATE, rsaKeys, voterLeaf } from './forged-certificates'

/**
 * UNDERSKRIFTEN LAGRAS FÖRSEGLAD, BUNDEN TILL SIN RAD (uppgift 14f och 17b).
 *
 * BankID:s dokument bär lövet, med väljarens personnummer och namn i klartext.
 * Lagrat som det är hade en databasdump utan pepparn avslöjat vem som röstat,
 * med namn. Dokumentet förseglas därför, med spärrsvaret, med AES-256-GCM under
 * en nyckel ur IDENTITY_PEPPER, och raden binds in som autentiserad data.
 */

const voterKeys = rsaKeys('väljaren')
const leaf = voterLeaf(voterKeys, { personalNumber: '199001011234' })
const row = { voterStatusId: 'b1f4c0de-0000-4000-8000-000000000001', ballotId: 'valsedel-riksdag' }

function signatureFor(certificates = [leaf, MOCK_INTERMEDIATE], privateKey = voterKeys.privateKey) {
  return {
    xml: Buffer.from(bankIdSignature({ userNonVisibleData: 'signerat', certificates, privateKey }), 'base64'),
    ocspResponse: Buffer.from('ett spärrsvar i DER'),
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Byter ett tecken i fältet med givet index, räknat från 1 efter versionen. */
function tamper(stored: string, field: 1 | 2 | 3): string {
  const parts = stored.split(':')
  const value = parts[field]!
  const middle = Math.floor(value.length / 2)
  parts[field] = value.slice(0, middle) + (value[middle] === '0' ? '1' : '0') + value.slice(middle + 1)
  return parts.join(':')
}

describe('den förseglade underskriften', () => {
  it('kommer tillbaka oförändrad för samma rad, med dokumentet och spärrsvaret', () => {
    const signature = signatureFor()
    const opened = openBankIdSignature(sealBankIdSignature(signature, row), row)

    expect(opened?.xml.equals(signature.xml)).toBe(true)
    expect(opened?.ocspResponse.equals(signature.ocspResponse)).toBe(true)
  })

  it('tar emot ett tomt spärrsvar, som attrappens', () => {
    const signature = { ...signatureFor(), ocspResponse: Buffer.alloc(0) }

    expect(openBankIdSignature(sealBankIdSignature(signature, row), row)?.ocspResponse.length).toBe(0)
  })

  it('bär varken personnummer, namn, certifikatets bytes eller spärrsvaret i klartext', () => {
    const signature = signatureFor()
    const stored = sealBankIdSignature(signature, row)

    expect(stored).not.toContain('199001011234')
    expect(stored).not.toContain('Lindqvist')
    expect(stored).not.toContain('X509Certificate')
    expect(stored).not.toContain(leaf.raw.subarray(100, 140).toString('hex'))
    expect(stored).not.toContain(leaf.raw.subarray(100, 140).toString('base64'))
    expect(stored).not.toContain(signature.xml.subarray(200, 260).toString('base64'))
    expect(stored).not.toContain(Buffer.from('spärrsvar').toString('base64'))
  })

  it('blir ett nytt chiffer varje gång, eftersom varje kuvert får en egen nonce', () => {
    const signature = signatureFor()
    const first = sealBankIdSignature(signature, row)
    const second = sealBankIdSignature(signature, row)

    expect(first.split(':')[1]).not.toBe(second.split(':')[1])
    expect(first).not.toBe(second)
  })

  it('går inte att flytta till en annan väljares rad eller en annan valsedel', () => {
    const stored = sealBankIdSignature(signatureFor(), row)

    expect(openBankIdSignature(stored, { ...row, voterStatusId: 'b1f4c0de-0000-4000-8000-000000000002' })).toBeNull()
    expect(openBankIdSignature(stored, { ...row, ballotId: 'valsedel-kommun' })).toBeNull()
  })

  it('går inte att öppna när ett tecken ändrats, i nonce, i taggen eller i chiffret', () => {
    const stored = sealBankIdSignature(signatureFor(), row)

    for (const field of [1, 2, 3] as const) {
      expect(openBankIdSignature(tamper(stored, field), row)).toBeNull()
    }
  })

  it('går inte att öppna med en annan peppar', () => {
    const stored = sealBankIdSignature(signatureFor(), row)
    vi.stubEnv('IDENTITY_PEPPER', 'en-helt-annan-peppar-minst-trettiotva-tecken-lang')

    expect(openBankIdSignature(stored, row)).toBeNull()
  })

  it('ger null för allt som inte är en förseglad underskrift, också en kedja i det gamla formatet, och kastar aldrig', () => {
    const stored = sealBankIdSignature(signatureFor(), row)
    // Ett tecken mitt i strängen byts mot ett annat. Med en fast ersättning av de två sista
    // tecknen, som `A=`, blev "skräpet" ibland exakt det förseglade (ungefär var 64:e
    // körning), och testet föll på slumpen. Mitt i strängen räknas varje bit, till skillnad
    // från sista tecknet före utfyllnaden.
    const middle = Math.floor(stored.length / 2)
    const flipped = `${stored.slice(0, middle)}${stored[middle] === 'A' ? 'B' : 'A'}${stored.slice(middle + 1)}`

    for (const junk of [
      '',
      'v3:',
      'inte-en-underskrift',
      stored.replace(/^v3:/, 'v2:'),
      `${stored}:00`,
      stored.slice(0, -1),
      flipped,
      sealLegacyCertificateChain([leaf, MOCK_INTERMEDIATE], row),
      null,
      42,
      { stored },
    ]) {
      expect(openBankIdSignature(junk, row)).toBeNull()
    }
  })

  it('är lika lång för varje underskrift, oavsett namn, antal mellannivåer och spärrsvar', () => {
    /**
     * Granskningen av uppgift 14f, V1: AES-GCM bevarar längden, och före
     * utfyllnaden gav "Robin Ek" 3765 tecken och "Charlie Näslund" 3797. Med
     * riktig BankID hade längden sannolikt också sagt vilken bank som utfärdat
     * certifikatet. Nu är varje förseglad underskrift lika lång.
     */
    const robin = voterLeaf(voterKeys, { name: { givenName: 'Robin', surname: 'Ek' } })
    const charlie = voterLeaf(voterKeys, { name: { givenName: 'Charlie', surname: 'Näslund' } })
    const deep = customHierarchy('djup kedja', {}, [{}, {}, {}])
    const deepLeaf = voterLeaf(voterKeys, { issuer: deep.issuer })

    const signatures = [
      signatureFor([robin, MOCK_INTERMEDIATE]),
      signatureFor([charlie, MOCK_INTERMEDIATE]),
      signatureFor([deepLeaf, ...deep.intermediates]),
      { ...signatureFor([robin, MOCK_INTERMEDIATE]), ocspResponse: Buffer.alloc(MAX_OCSP_RESPONSE_BYTES, 1) },
    ]
    expect(new Set(signatures.map((signature) => signature.xml.length)).size).toBe(3)

    const lengths = signatures.map((signature) => sealBankIdSignature(signature, row).length)
    expect(new Set(lengths)).toEqual(new Set([SEALED_SIGNATURE_LENGTH]))

    // Och underskriften kommer tillbaka hel, utan utfyllnaden.
    const opened = openBankIdSignature(sealBankIdSignature(signatures[2]!, row), row)
    expect(opened?.xml.equals(signatures[2]!.xml)).toBe(true)
  })

  it('rymmer dokumentets tak och spärrsvarets tak samtidigt', () => {
    const signature = { xml: Buffer.alloc(MAX_SIGNATURE_XML_BYTES, 0x61), ocspResponse: Buffer.alloc(MAX_OCSP_RESPONSE_BYTES, 1) }

    expect(openBankIdSignature(sealBankIdSignature(signature, row), row)?.ocspResponse.length).toBe(MAX_OCSP_RESPONSE_BYTES)
  })

  it('vägrar en underskrift eller ett spärrsvar som inte ryms, i stället för att fylla ut till en egen längd', () => {
    expect(() =>
      sealBankIdSignature({ xml: Buffer.alloc(MAX_SIGNATURE_XML_BYTES + 1), ocspResponse: Buffer.alloc(0) }, row),
    ).toThrow(/ryms inte/)
    expect(() =>
      sealBankIdSignature({ xml: Buffer.alloc(10), ocspResponse: Buffer.alloc(MAX_OCSP_RESPONSE_BYTES + 1) }, row),
    ).toThrow(/ryms inte/)
  })

  it('kastar när pepparn saknas, eftersom det är ett fel i driftsättningen och inte i raden', () => {
    const stored = sealBankIdSignature(signatureFor(), row)
    vi.stubEnv('IDENTITY_PEPPER', '')

    expect(() => openBankIdSignature(stored, row)).toThrow(/IDENTITY_PEPPER/)
  })
})

describe('kedjan i det gamla formatet, från före uppgift 17b', () => {
  const fingerprints = (certificates: { fingerprint256: string }[] | null) =>
    certificates?.map((certificate) => certificate.fingerprint256) ?? null

  it('går att öppna, så att valideringen kan känna igen ett gammalt kuvert', () => {
    const stored = sealLegacyCertificateChain([leaf, MOCK_INTERMEDIATE], row)

    expect(stored).toHaveLength(SEALED_CHAIN_LENGTH)
    expect(fingerprints(openLegacyCertificateChain(stored, row))).toEqual(fingerprints([leaf, MOCK_INTERMEDIATE]))
    expect(openLegacyCertificateChain(stored, { ...row, ballotId: 'valsedel-kommun' })).toBeNull()
  })

  it('en underskrift i det nya formatet går inte att öppna som en kedja', () => {
    expect(openLegacyCertificateChain(sealBankIdSignature(signatureFor(), row), row)).toBeNull()
  })

  it('formatet läses ur versionen', () => {
    expect(sealedFormatOf(sealBankIdSignature(signatureFor(), row))).toBe('signature')
    expect(sealedFormatOf(sealLegacyCertificateChain([leaf, MOCK_INTERMEDIATE], row))).toBe('legacy_chain')
    expect(sealedFormatOf('skräp')).toBeNull()
    expect(sealedFormatOf(null)).toBeNull()
  })
})
