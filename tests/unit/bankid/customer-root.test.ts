import { X509Certificate } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BANKID_ENVIRONMENTS,
  CUSTOMER_ROOTS,
  customerRootFor,
  SERVER_ROOT_SHA256,
} from '@/modules/eligibility/bankid/bankid-environment'
import { issueCertificate, issuerFrom } from '@/modules/eligibility/bankid/mock-ca/issue-certificate'
import { MOCK_BANKID_ROOT_CERTIFICATE } from '@/modules/eligibility/bankid/mock-ca/root-certificate'
import { authority, encryptedKeyPem, rpCredential } from './fake-rp-server'
import { customHierarchy, rsaKeys } from './forged-certificates'

/**
 * KUNDROTEN LÅSES PER BANKID_ENV (uppgift 17d, punkt 4, B5 i helgrensgranskningen).
 *
 * Kedjan i en underskrift går till BankID:s rot för kundcertifikat. Förut prövade
 * uppstartsvakten bara att rötterna i BANKID_ROOT_CERTIFICATES inte var attrappens,
 * och skarpt läge mot testmiljön startade med BankID:s TLS-rot som rot för
 * underskrifterna. Nu ska varje rot i filen vara exakt kundroten för den miljö
 * BANKID_ENV pekar ut, på fingeravtrycket och på subject.
 */

const TEST_SUBJECT = 'O=Finansiell ID-Teknik BID AB\nOU=BankID Member Banks CA\nCN=Test BankID Root CA v1 Test'
const PRODUCTION_SUBJECT = 'O=Finansiell ID-Teknik BID AB\nOU=BankID Member Banks CA\nCN=BankID Root CA v1'

const SHARP_ENV = {
  DEMO_MODE: '',
  NODE_ENV: 'production',
  COOKIE_SECURE: 'true',
  APP_ORIGIN: 'https://val.example',
  IDENTITY_PEPPER: 'en-riktig-peppar-som-ar-minst-trettiotva-tecken-lang',
  BANKID_ENV: 'test',
}

function file(name: string, content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'kundrot-'))
  const path = join(directory, name)
  writeFileSync(path, content)
  return path
}

function rpFiles(): Record<string, string> {
  const rpCa = authority('rp-ca-kundrot', 'RP-CA för kundroten')
  const rp = rpCredential(rpCa, 'rp-kundrot')
  return {
    BANKID_CERT_PATH: file('rp.pem', `${rp.certPem}${encryptedKeyPem(rp, 'qwerty123')}`),
    BANKID_CERT_PASSPHRASE: 'qwerty123',
  }
}

async function requirementWith(environment: string, rootsPem: string | null) {
  vi.resetModules()
  const env: Record<string, string> = {
    ...SHARP_ENV,
    BANKID_ENV: environment,
    BANKID_ROOT_CERTIFICATES: rootsPem === null ? '' : file('rotter.pem', rootsPem),
  }
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  const mode = await import('@/lib/runtime-mode')
  return mode.sharpModeRequirements().find((entry) => entry.id === 'bankid-customer-root')!
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('BankID:s kundrötter, förankrade i koden', () => {
  it('den incheckade PEM:en har det låsta fingeravtrycket och subject, självutfärdad, per miljö', () => {
    for (const environment of ['test', 'production'] as const) {
      const pinned = CUSTOMER_ROOTS[environment]
      const root = new X509Certificate(pinned.pem)
      expect(root.fingerprint256, environment).toBe(pinned.sha256)
      expect(root.subject, environment).toBe(pinned.subject)
      expect(root.issuer, environment).toBe(pinned.subject)
      expect(root.ca).toBe(true)
      expect(customerRootFor(environment).fingerprint256).toBe(pinned.sha256)
    }
    expect(CUSTOMER_ROOTS.test.subject).toBe(TEST_SUBJECT)
    expect(CUSTOMER_ROOTS.production.subject).toBe(PRODUCTION_SUBJECT)
  })

  it('fingeravtrycken är BankID:s publicerade certifikats', () => {
    // Räknade på https://cdn.bankid.com/pki/bankid/{Test-BankID-Root-CA-v1-Test,BankID-Root-CA-v1}.pem,
    // hämtade 2026-10-16. Ändras ett tecken i PEM:en eller i värdet går testet ovan rött.
    expect(CUSTOMER_ROOTS.test.sha256).toBe(
      'C6:FA:EA:F8:CC:AD:CF:D0:73:8D:C9:91:40:CA:78:8C:1A:19:A9:3F:84:3C:5A:9E:C1:36:98:72:D5:0E:45:F2',
    )
    expect(CUSTOMER_ROOTS.production.sha256).toBe(
      'CA:32:58:8E:38:5B:96:1D:58:E2:60:10:C6:F8:C8:39:F7:CA:07:1E:49:7D:E6:B7:84:16:40:A6:15:06:FD:31',
    )
  })

  it('kundroten är varken den andra miljöns kundrot eller någon av TLS-rötterna', () => {
    const all = [
      CUSTOMER_ROOTS.test.sha256,
      CUSTOMER_ROOTS.production.sha256,
      SERVER_ROOT_SHA256.test,
      SERVER_ROOT_SHA256.production,
    ]
    expect(new Set(all).size).toBe(4)
  })

  it('customerRootFor vägrar en PEM som inte är miljöns låsta', () => {
    expect(() => customerRootFor('production', CUSTOMER_ROOTS.test.pem)).toThrow(/fingeravtryck/)
    expect(() => customerRootFor('test', CUSTOMER_ROOTS.production.pem)).toThrow(/fingeravtryck/)
  })
})

describe('kravet bankid-customer-root i uppstartsvakten', () => {
  it('är uppfyllt med testmiljöns kundrot och BANKID_ENV=test, och med produktionens i produktion', async () => {
    const test = await requirementWith('test', CUSTOMER_ROOTS.test.pem)
    expect(test.met).toBe(true)
    expect(test.blocking).toBe(true)

    const production = await requirementWith('production', CUSTOMER_ROOTS.production.pem)
    expect(production.met).toBe(true)
  })

  it('vägrar BankID:s TLS-rot som rot för underskrifterna, det som hände förut', async () => {
    const requirement = await requirementWith('test', BANKID_ENVIRONMENTS.test.serverRootPem)
    expect(requirement.met).toBe(false)
    expect(requirement.blocking).toBe(true)
    expect(requirement.detail).toMatch(/TLS/)
  })

  it('vägrar testmiljöns kundrot i produktion', async () => {
    const requirement = await requirementWith('production', CUSTOMER_ROOTS.test.pem)
    expect(requirement.met).toBe(false)
    expect(requirement.detail).toMatch(/testmiljön/)
  })

  it('vägrar produktionens kundrot i testmiljön', async () => {
    const requirement = await requirementWith('test', CUSTOMER_ROOTS.production.pem)
    expect(requirement.met).toBe(false)
    expect(requirement.detail).toMatch(/produktion/)
  })

  it('vägrar attrappens rot i skarpt läge, i båda miljöerna', async () => {
    for (const environment of ['test', 'production']) {
      const requirement = await requirementWith(environment, MOCK_BANKID_ROOT_CERTIFICATE)
      expect(requirement.met, environment).toBe(false)
      expect(requirement.detail).toMatch(/attrapp/)
    }
  })

  it('vägrar en egen rot, också när den bär kundrotens namn', async () => {
    const unknown = await requirementWith('test', customHierarchy('en egen rot', {}, [{}]).root.toString())
    expect(unknown.met).toBe(false)

    // Samma subject och utfärdare som testmiljöns kundrot, byte för byte, men en egen nyckel.
    const keys = rsaKeys('kundrotens dubbelgångare')
    const name = issuerFrom(customerRootFor('test'), keys.privateKey).name
    const lookalike = issueCertificate({
      subject: name,
      publicKey: keys.publicKey,
      issuer: { name, privateKey: keys.privateKey },
      notBefore: new Date('2020-01-01T00:00:00Z'),
      notAfter: new Date('2046-01-01T00:00:00Z'),
      ca: true,
      keyUsage: ['keyCertSign', 'cRLSign'],
    })
    expect(lookalike.subject).toBe(CUSTOMER_ROOTS.test.subject)
    const twin = await requirementWith('test', lookalike.toString())
    expect(twin.met).toBe(false)
    expect(twin.detail).toMatch(/okänd rot/)
  })

  it('vägrar en fil där rätt rot står tillsammans med en annan', async () => {
    const mixed = await requirementWith('test', CUSTOMER_ROOTS.test.pem + BANKID_ENVIRONMENTS.test.serverRootPem)
    expect(mixed.met).toBe(false)
    expect(mixed.detail).toMatch(/TLS/)
  })

  it('är ouppfyllt utan fil och utan BANKID_ENV', async () => {
    expect((await requirementWith('test', null)).met).toBe(false)
    expect((await requirementWith('', CUSTOMER_ROOTS.test.pem)).met).toBe(false)
  })

  it('uppstartsvakten stoppar skarpt läge mot testmiljön med TLS-roten, och startar med kundroten', async () => {
    const boot = async (rootsPem: string) => {
      vi.resetModules()
      const env = { ...SHARP_ENV, ...rpFiles(), BANKID_ROOT_CERTIFICATES: file('rotter.pem', rootsPem) }
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
      return (await import('@/lib/runtime-mode')).assertBootable
    }

    expect(await boot(BANKID_ENVIRONMENTS.test.serverRootPem)).toThrow(/bankid-customer-root/)
    expect(await boot(CUSTOMER_ROOTS.test.pem)).not.toThrow()
  })
})
