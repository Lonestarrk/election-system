import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isMockBankIdRoot,
  trustedBankIdRoots,
} from '@/modules/eligibility/bankid/trusted-roots'
import {
  customHierarchy,
  lookalikeHierarchy,
  MOCK_INTERMEDIATE,
  MOCK_ROOT,
  rsaKeys,
  voterLeaf,
} from './forged-certificates'

/**
 * VILKA RÖTTER KEDJAN PRÖVAS MOT.
 *
 * Rötterna är konfiguration, inte data: de kommer ur en fil som
 * BANKID_ROOT_CERTIFICATES pekar ut, och bara i demoläget faller systemet
 * tillbaka på attrappens rot. Utanför demoläget finns ingen rot att falla
 * tillbaka på, och en fil som inte håller stoppar allt i stället för att
 * systemet tyst litar på något annat än det som konfigurerats.
 */

const mode = vi.hoisted(() => ({ demo: true }))

vi.mock('@/lib/demo-mode', () => ({ isDemoMode: () => mode.demo }))

const written: string[] = []

function rootFile(...pems: string[]): string {
  const path = join(tmpdir(), `bankid-rotter-${randomUUID()}.pem`)
  writeFileSync(path, pems.join(''), 'utf8')
  written.push(path)
  return path
}

afterEach(() => {
  mode.demo = true
  vi.unstubAllEnvs()
  for (const path of written.splice(0)) rmSync(path, { force: true })
})

const fingerprints = () => trustedBankIdRoots().map((root) => root.fingerprint256)

describe('de betrodda rötterna', () => {
  it('är attrappens rot i demoläget, när ingen fil är konfigurerad', () => {
    vi.stubEnv('BANKID_ROOT_CERTIFICATES', '')

    expect(fingerprints()).toEqual([MOCK_ROOT.fingerprint256])
  })

  it('kommer ur filen när den är konfigurerad, och då bara ur den', () => {
    const lookalike = lookalikeHierarchy()
    vi.stubEnv('BANKID_ROOT_CERTIFICATES', rootFile(lookalike.root.toString()))

    expect(fingerprints()).toEqual([lookalike.root.fingerprint256])
  })

  it('kan vara flera i samma fil', () => {
    const lookalike = lookalikeHierarchy()
    vi.stubEnv('BANKID_ROOT_CERTIFICATES', rootFile(MOCK_ROOT.toString(), lookalike.root.toString()))

    expect(fingerprints()).toEqual([MOCK_ROOT.fingerprint256, lookalike.root.fingerprint256])
  })

  it('finns inte utanför demoläget, om ingen fil är konfigurerad', () => {
    mode.demo = false
    vi.stubEnv('BANKID_ROOT_CERTIFICATES', '')

    expect(() => trustedBankIdRoots()).toThrow(/BANKID_ROOT_CERTIFICATES/)
  })

  it('kommer ur filen också utanför demoläget', () => {
    mode.demo = false
    vi.stubEnv('BANKID_ROOT_CERTIFICATES', rootFile(MOCK_ROOT.toString()))

    expect(fingerprints()).toEqual([MOCK_ROOT.fingerprint256])
  })
})

describe('en fil som inte håller stoppar', () => {
  it('när den inte finns', () => {
    vi.stubEnv('BANKID_ROOT_CERTIFICATES', join(tmpdir(), `saknas-${randomUUID()}.pem`))

    expect(() => trustedBankIdRoots()).toThrow(/BANKID_ROOT_CERTIFICATES/)
  })

  it('när den inte innehåller något certifikat', () => {
    vi.stubEnv('BANKID_ROOT_CERTIFICATES', rootFile('ingenting här\n'))

    expect(() => trustedBankIdRoots()).toThrow(/BANKID_ROOT_CERTIFICATES/)
  })

  it('när ett certifikat i den inte är en självsignerad CA', () => {
    // En mellannivå är en CA men inte självsignerad, och ett löv är ingetdera.
    // Att lita på någon av dem som rot vore att hoppa över ett led i kedjan.
    for (const certificate of [MOCK_INTERMEDIATE, voterLeaf(rsaKeys('väljaren'))]) {
      vi.stubEnv('BANKID_ROOT_CERTIFICATES', rootFile(MOCK_ROOT.toString(), certificate.toString()))

      expect(() => trustedBankIdRoots()).toThrow(/BANKID_ROOT_CERTIFICATES/)
    }
  })

  it('när den innehåller något annat än certifikat', () => {
    vi.stubEnv('BANKID_ROOT_CERTIFICATES', rootFile(MOCK_ROOT.toString(), 'skräp efter\n'))

    expect(() => trustedBankIdRoots()).toThrow(/BANKID_ROOT_CERTIFICATES/)
  })

  it('när en rots basicConstraints inte går att läsa för kedjeprövningen', () => {
    /**
     * Kedjeprövningen läser rotens pathLen sedan granskningen av uppgift 14f
     * (M2). Ett pathLen på fyra byte godtar OpenSSL, men den strikta läsaren
     * inte. Utan den här kontrollen hade roten lästs in och fällt varje kedja
     * under sig, som om varje väljare vore förfalskad.
     */
    const { root } = customHierarchy('rot med pathLen på fyra byte', { pathLength: 2 ** 24 }, [])
    expect(root.ca).toBe(true)
    vi.stubEnv('BANKID_ROOT_CERTIFICATES', rootFile(root.toString()))

    expect(() => trustedBankIdRoots()).toThrow(/basicConstraints/)
  })
})

describe('attrappens rot känns igen på sitt fingeravtryck', () => {
  it('och inte på sitt namn', () => {
    // Uppgift 17 ska vägra starta skarpt läge med attrappens rot. En rot med
    // samma namn men en annan nyckel är inte attrappens, och attrappens rot
    // under ett annat namn vore det fortfarande.
    const lookalike = lookalikeHierarchy()

    expect(isMockBankIdRoot(MOCK_ROOT)).toBe(true)
    expect(lookalike.root.subject).toBe(MOCK_ROOT.subject)
    expect(isMockBankIdRoot(lookalike.root)).toBe(false)
  })
})
