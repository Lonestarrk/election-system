import { afterEach, describe, expect, it, vi } from 'vitest'
import { openCertificateChain, sealCertificateChain } from '@/modules/eligibility/sealed-chain'
import { MOCK_INTERMEDIATE, rsaKeys, voterLeaf } from './forged-certificates'

/**
 * KEDJAN LAGRAS KRYPTERAD, BUNDEN TILL SIN RAD.
 *
 * Lövet bär väljarens personnummer och namn i klartext. Lagrat som det är hade
 * en databasdump utan pepparn avslöjat vem som röstat, med namn, och det är
 * precis vad röstlängden är byggd för att inte göra. Kedjan krypteras därför
 * med AES-256-GCM under en nyckel ur IDENTITY_PEPPER, och raden den hör till
 * binds in som autentiserad data, så att en kedja inte kan flyttas till en
 * annan väljares rad.
 */

const leaf = voterLeaf(rsaKeys('väljaren'), { personalNumber: '199001011234' })
const chain = [leaf, MOCK_INTERMEDIATE]
const row = { voterStatusId: 'b1f4c0de-0000-4000-8000-000000000001', ballotId: 'valsedel-riksdag' }

afterEach(() => {
  vi.unstubAllEnvs()
})

const fingerprints = (certificates: { fingerprint256: string }[] | null) =>
  certificates?.map((certificate) => certificate.fingerprint256) ?? null

/** Byter ett hextecken i fältet med givet index, räknat från 1 efter versionen. */
function tamper(stored: string, field: 1 | 2 | 3): string {
  const parts = stored.split(':')
  const value = parts[field]!
  const middle = Math.floor(value.length / 2)
  parts[field] = value.slice(0, middle) + (value[middle] === '0' ? '1' : '0') + value.slice(middle + 1)
  return parts.join(':')
}

describe('den krypterade kedjan', () => {
  it('kommer tillbaka oförändrad för samma rad', () => {
    const stored = sealCertificateChain(chain, row)

    expect(fingerprints(openCertificateChain(stored, row))).toEqual(fingerprints(chain))
  })

  it('bär varken personnummer, namn eller certifikatets bytes i klartext', () => {
    const stored = sealCertificateChain(chain, row)
    const raw = leaf.raw

    expect(stored).not.toContain('199001011234')
    expect(stored).not.toContain('Lindqvist')
    expect(stored).not.toContain(raw.subarray(100, 140).toString('hex'))
    expect(stored).not.toContain(raw.subarray(100, 140).toString('base64'))
  })

  it('blir ett nytt chiffer varje gång, eftersom varje kuvert får en egen nonce', () => {
    const first = sealCertificateChain(chain, row)
    const second = sealCertificateChain(chain, row)

    expect(first.split(':')[1]).not.toBe(second.split(':')[1])
    expect(first).not.toBe(second)
    expect(fingerprints(openCertificateChain(second, row))).toEqual(fingerprints(chain))
  })

  it('går inte att flytta till en annan väljares rad eller en annan valsedel', () => {
    const stored = sealCertificateChain(chain, row)

    expect(openCertificateChain(stored, { ...row, voterStatusId: 'b1f4c0de-0000-4000-8000-000000000002' })).toBeNull()
    expect(openCertificateChain(stored, { ...row, ballotId: 'valsedel-kommun' })).toBeNull()
  })

  it('går inte att öppna när en byte ändrats, i nonce, i taggen eller i chiffret', () => {
    const stored = sealCertificateChain(chain, row)

    for (const field of [1, 2, 3] as const) {
      expect(openCertificateChain(tamper(stored, field), row)).toBeNull()
    }
  })

  it('går inte att öppna med en annan peppar', () => {
    const stored = sealCertificateChain(chain, row)
    vi.stubEnv('IDENTITY_PEPPER', 'en-helt-annan-peppar-minst-trettiotva-tecken-lang')

    expect(openCertificateChain(stored, row)).toBeNull()
  })

  it('ger null för allt som inte är en förseglad kedja, och kastar aldrig', () => {
    const stored = sealCertificateChain(chain, row)

    for (const junk of [
      '',
      'v1:',
      'inte-en-kedja',
      stored.toUpperCase(),
      stored.replace(/^v1:/, 'v2:'),
      `${stored}:00`,
      stored.slice(0, -1),
      'v1:' + '0'.repeat(24) + ':' + '0'.repeat(32) + ':' + '0'.repeat(64),
      `v1:${'0'.repeat(24)}:${'0'.repeat(32)}:${'00'.repeat(40_000)}`,
      null,
      42,
      { stored },
    ]) {
      expect(openCertificateChain(junk, row)).toBeNull()
    }
  })

  it('kastar när pepparn saknas, eftersom det är ett fel i driftsättningen och inte i raden', () => {
    const stored = sealCertificateChain(chain, row)
    vi.stubEnv('IDENTITY_PEPPER', '')

    expect(() => openCertificateChain(stored, row)).toThrow(/IDENTITY_PEPPER/)
  })
})
