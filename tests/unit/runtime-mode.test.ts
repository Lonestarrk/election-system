import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authority, encryptedKeyPem, rpCredential } from './bankid/fake-rp-server'
import { customHierarchy } from './bankid/forged-certificates'

/**
 * Demoläge och skarpt läge (uppgift 17).
 *
 * Läget sätts vid driftsättning och följer bara DEMO_MODE=true. Skarpt är
 * förvalt, oavsett NODE_ENV. Ingen väg i appen byter läge.
 */

const EXAMPLE_PEPPER = 'byt-ut-mig-detta-ar-bara-for-lokal-utveckling-0000'

/** En miljö där alla krav utom RP-certifikatet och BankID:s rot är uppfyllda. */
const SHARP_ENV = {
  DEMO_MODE: '',
  NODE_ENV: 'production',
  COOKIE_SECURE: 'true',
  APP_ORIGIN: 'https://val.example',
  IDENTITY_PEPPER: 'en-riktig-peppar-som-ar-minst-trettiotva-tecken-lang',
  BANKID_ENV: 'test',
  BANKID_ROOT_CERTIFICATES: '',
  BANKID_CERT_PATH: '',
  BANKID_CERT_PASSPHRASE: '',
}

/**
 * Ett RP-certifikat med krypterad nyckel och en rotfil med en egen rot, som
 * skarpt läge kräver. Rötterna är inte BankID:s, men kraven prövar bara att de
 * går att läsa och inte är attrappens.
 */
function sharpFiles(): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), 'skarpt-'))
  const rpCa = authority('rp-ca-skarpt', 'RP-CA för skarpt läge')
  const rp = rpCredential(rpCa, 'rp-skarpt')
  const certPath = join(directory, 'rp.pem')
  writeFileSync(certPath, `${rp.certPem}${encryptedKeyPem(rp, 'qwerty123')}`)
  const rootsPath = join(directory, 'rotter.pem')
  writeFileSync(rootsPath, customHierarchy('kundrot för skarpt läge', {}, [{}]).root.toString())
  return { BANKID_CERT_PATH: certPath, BANKID_CERT_PASSPHRASE: 'qwerty123', BANKID_ROOT_CERTIFICATES: rootsPath }
}

async function load(env: Record<string, string>) {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return import('@/lib/runtime-mode')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('vilket läge appen kör i', () => {
  it('skarpt är förvalt: demoläge kräver ett aktivt val', async () => {
    const { runtimeMode } = await load({ NODE_ENV: 'development', DEMO_MODE: '' })
    expect(runtimeMode()).toBe('SHARP')
  })

  it('en osatt variabel är skarpt läge, också i utveckling', async () => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('DEMO_MODE', undefined)
    const { runtimeMode } = await import('@/lib/runtime-mode')
    expect(runtimeMode()).toBe('SHARP')
  })

  it('bara exakt "true" ger demoläge', async () => {
    for (const value of ['TRUE', 'True', '1', 'yes', 'true ', ' true', 'false', 'on']) {
      const { runtimeMode } = await load({ DEMO_MODE: value })
      expect(runtimeMode(), `DEMO_MODE=${JSON.stringify(value)}`).toBe('SHARP')
    }
    const { runtimeMode } = await load({ DEMO_MODE: 'true' })
    expect(runtimeMode()).toBe('DEMO')
  })

  it('läget följer bara DEMO_MODE, oavsett NODE_ENV (ruling 121)', async () => {
    for (const nodeEnv of ['development', 'production', 'test']) {
      const demo = await load({ NODE_ENV: nodeEnv, DEMO_MODE: 'true' })
      expect(demo.runtimeMode(), `${nodeEnv} + DEMO_MODE`).toBe('DEMO')

      const sharp = await load({ NODE_ENV: nodeEnv, DEMO_MODE: '' })
      expect(sharp.runtimeMode(), `${nodeEnv} utan DEMO_MODE`).toBe('SHARP')
    }
  })
})

describe('ett produktionsbygge i demoläge (den publika demon)', () => {
  it('startar i demoläge och skriver det i loggen vid varje start', async () => {
    const { runtimeMode, assertBootable, logModeAtStartup } = await load({
      NODE_ENV: 'production',
      DEMO_MODE: 'true',
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(runtimeMode()).toBe('DEMO')
    expect(() => assertBootable()).not.toThrow()

    logModeAtStartup()
    const lines = log.mock.calls.map((call) => String(call[0]))
    expect(lines.some((line) => /Demoläge/.test(line) && /attrapp/i.test(line))).toBe(true)
  })

  it('loggar skarpt läge och dess varningar, också', async () => {
    const { logModeAtStartup } = await load({ ...SHARP_ENV })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    logModeAtStartup()

    expect(log.mock.calls.map((call) => String(call[0])).some((line) => /Skarpt läge/.test(line))).toBe(true)
    // BANKID_ENV=test är en varning, inget stopp.
    expect(warn.mock.calls.map((call) => String(call[0])).some((line) => /test-BankID/.test(line))).toBe(true)
  })
})

describe('skarpt läge är en checklista, inte en boolean', () => {
  it('räknar upp exakt vad som saknas', async () => {
    const { sharpModeRequirements } = await load({
      ...SHARP_ENV,
      COOKIE_SECURE: 'false',
      APP_ORIGIN: 'http://val.example',
      IDENTITY_PEPPER: EXAMPLE_PEPPER,
      BANKID_ENV: '',
    })

    const unmet = sharpModeRequirements().filter((requirement) => !requirement.met)

    expect(unmet.map((requirement) => requirement.id).sort()).toEqual([
      'bankid-client-certificate',
      'bankid-env',
      'bankid-reader-tested',
      'bankid-real',
      'bankid-root-not-mock',
      'bankid-server-root',
      'cookie-secure',
      'https-origin',
      'pepper-changed',
    ])
    expect(unmet.every((requirement) => requirement.blocking)).toBe(true)
  })

  it('varje krav har ett id, ett utfall, en text och en allvarlighetsgrad', async () => {
    const { sharpModeRequirements } = await load({ ...SHARP_ENV })
    for (const requirement of sharpModeRequirements()) {
      expect(requirement.id).toMatch(/^[a-z-]+$/)
      expect(typeof requirement.met).toBe('boolean')
      expect(requirement.detail.length).toBeGreaterThan(10)
      expect(typeof requirement.blocking).toBe('boolean')
    }
  })

  it('BankID-klienten finns i bygget (17c), och kravet är uppfyllt när BANKID_ENV pekar ut en miljö', async () => {
    const { sharpModeRequirements } = await load({ ...SHARP_ENV })
    const real = sharpModeRequirements().find((requirement) => requirement.id === 'bankid-real')!
    expect(real.met).toBe(true)
    expect(real.blocking).toBe(true)

    const none = await load({ ...SHARP_ENV, BANKID_ENV: '' })
    expect(none.sharpModeRequirements().find((requirement) => requirement.id === 'bankid-real')!.met).toBe(false)
  })

  it('serverrotens fingeravtryck prövas för den miljö BANKID_ENV pekar ut', async () => {
    for (const environment of ['test', 'production']) {
      const { sharpModeRequirements } = await load({ ...SHARP_ENV, BANKID_ENV: environment })
      const root = sharpModeRequirements().find((requirement) => requirement.id === 'bankid-server-root')!
      expect(root.met, environment).toBe(true)
      expect(root.blocking).toBe(true)
    }
    const none = await load({ ...SHARP_ENV, BANKID_ENV: '' })
    expect(none.sharpModeRequirements().find((requirement) => requirement.id === 'bankid-server-root')!.met).toBe(false)
  })

  it('RP-certifikatet krävs, går att läsa med frasen och vägras i produktion om det är BankID:s publika testcertifikat', async () => {
    const missing = await load({ ...SHARP_ENV, BANKID_CERT_PATH: '' })
    const requirement = missing.sharpModeRequirements().find((entry) => entry.id === 'bankid-client-certificate')!
    expect(requirement.met).toBe(false)
    expect(requirement.blocking).toBe(true)

    const files = sharpFiles()
    const wrong = await load({ ...SHARP_ENV, ...files, BANKID_CERT_PASSPHRASE: 'fel' })
    expect(wrong.sharpModeRequirements().find((entry) => entry.id === 'bankid-client-certificate')!.met).toBe(false)

    const right = await load({ ...SHARP_ENV, ...files })
    expect(right.sharpModeRequirements().find((entry) => entry.id === 'bankid-client-certificate')!.met).toBe(true)
  })

  it('skarpt läge med BANKID_ENV=test startar när alla krav är uppfyllda, och säger att det är testmiljön', async () => {
    const { assertBootable, describeMode, sharpModeRequirements } = await load({ ...SHARP_ENV, ...sharpFiles() })

    expect(sharpModeRequirements().filter((entry) => !entry.met && entry.blocking)).toEqual([])
    expect(() => assertBootable()).not.toThrow()
    expect(describeMode().summary).toBe('Skarpt läge, BankID testmiljö')
    expect(describeMode().bankId).toEqual({ kind: 'test', label: 'BankID testmiljö' })
  })

  it('läsaren är inte prövad mot en riktig underskrift: en varning i testmiljön, ett stopp i produktion (spec 10)', async () => {
    const test = await load({ ...SHARP_ENV, BANKID_ENV: 'test' })
    const warning = test.sharpModeRequirements().find((entry) => entry.id === 'bankid-reader-tested')!
    expect(warning.met).toBe(false)
    expect(warning.blocking).toBe(false)
    expect(warning.detail).toMatch(/riktig underskrift/)

    const production = await load({ ...SHARP_ENV, ...sharpFiles(), BANKID_ENV: 'production' })
    const stop = production.sharpModeRequirements().find((entry) => entry.id === 'bankid-reader-tested')!
    expect(stop.met).toBe(false)
    expect(stop.blocking).toBe(true)
    expect(() => production.assertBootable()).toThrow(/bankid-reader-tested/)
  })

  it('demoläget fortsätter med attrappen', async () => {
    const { describeMode } = await load({ DEMO_MODE: 'true', BANKID_ENV: 'test' })
    expect(describeMode().bankId.kind).toBe('mock')
    expect(describeMode().summary).toBe('Demoläge, attrappen')
  })

  it('BankID:s testmiljö är en varning och inget stopp', async () => {
    const { sharpModeRequirements } = await load({ ...SHARP_ENV, BANKID_ENV: 'test' })
    const test = sharpModeRequirements().find((requirement) => requirement.id === 'bankid-test-environment')!

    expect(test.met).toBe(false)
    expect(test.blocking).toBe(false)
    expect(test.detail).toMatch(/test-BankID/)
    expect(test.detail).toMatch(/inte med riktiga personer/)

    const production = await load({ ...SHARP_ENV, BANKID_ENV: 'production' })
    expect(
      production.sharpModeRequirements().find((requirement) => requirement.id === 'bankid-test-environment')!.met,
    ).toBe(true)
  })

  it('en exempelpeppar, en för kort peppar och en saknad peppar är samma sak', async () => {
    for (const pepper of [EXAMPLE_PEPPER, 'kort', '']) {
      const { sharpModeRequirements } = await load({ ...SHARP_ENV, IDENTITY_PEPPER: pepper })
      expect(
        sharpModeRequirements().find((requirement) => requirement.id === 'pepper-changed')!.met,
        JSON.stringify(pepper),
      ).toBe(false)
    }
  })

  it('varje origin i APP_ORIGIN måste vara https, och en saknad lista räknas inte', async () => {
    for (const origin of ['', 'https://a.example,http://b.example', 'http://localhost:3000']) {
      const { sharpModeRequirements } = await load({ ...SHARP_ENV, APP_ORIGIN: origin })
      expect(
        sharpModeRequirements().find((requirement) => requirement.id === 'https-origin')!.met,
        JSON.stringify(origin),
      ).toBe(false)
    }
    const ok = await load({ ...SHARP_ENV, APP_ORIGIN: 'https://a.example, https://b.example' })
    expect(ok.sharpModeRequirements().find((requirement) => requirement.id === 'https-origin')!.met).toBe(true)
  })

  it('kravet om rot är ouppfyllt utan fil, och en okänd fil stoppar i stället för att godtas', async () => {
    const none = await load({ ...SHARP_ENV, BANKID_ROOT_CERTIFICATES: '' })
    expect(none.sharpModeRequirements().find((requirement) => requirement.id === 'bankid-root-not-mock')!.met).toBe(false)

    const missing = await load({ ...SHARP_ENV, BANKID_ROOT_CERTIFICATES: 'finns-inte.pem' })
    expect(missing.sharpModeRequirements().find((requirement) => requirement.id === 'bankid-root-not-mock')!.met).toBe(false)
  })

  it('kravet om rot är ouppfyllt när filen är attrappens egen rot', async () => {
    const { MOCK_BANKID_ROOT_CERTIFICATE } = await import(
      '@/modules/eligibility/bankid/mock-ca/root-certificate'
    )
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const directory = mkdtempSync(join(tmpdir(), 'rot-'))
    const path = join(directory, 'attrappen.pem')
    writeFileSync(path, MOCK_BANKID_ROOT_CERTIFICATE)

    const { sharpModeRequirements } = await load({ ...SHARP_ENV, BANKID_ROOT_CERTIFICATES: path })
    expect(sharpModeRequirements().find((requirement) => requirement.id === 'bankid-root-not-mock')!.met).toBe(false)
  })

  it('vägrar starta så länge ett stoppande krav är ouppfyllt, och säger vilket', async () => {
    const { assertBootable } = await load({ ...SHARP_ENV, COOKIE_SECURE: 'false' })

    expect(() => assertBootable()).toThrow(/cookie-secure/)
    expect(() => assertBootable()).toThrow(/bankid-client-certificate/)
  })

  it('vägrar starta skarpt utan RP-certifikat och BankID:s rot, också när allt annat är rätt', async () => {
    const { assertBootable } = await load({ ...SHARP_ENV })
    expect(() => assertBootable()).toThrow(/bankid-client-certificate/)
    expect(() => assertBootable()).toThrow(/bankid-root-not-mock/)
  })

  it('vägrar starta skarpt utan BANKID_ENV, också med certifikat och rot', async () => {
    const { assertBootable } = await load({ ...SHARP_ENV, ...sharpFiles(), BANKID_ENV: '' })
    expect(() => assertBootable()).toThrow(/bankid-real/)
  })

  it('en varning stoppar inte och nämns inte som orsak', async () => {
    const { assertBootable } = await load({ ...SHARP_ENV })
    try {
      assertBootable()
      throw new Error('skulle ha kastat')
    } catch (error) {
      expect(String(error)).not.toMatch(/bankid-test-environment/)
    }
  })

  it('demoläget behöver inte uppfylla listan', async () => {
    const { assertBootable } = await load({ NODE_ENV: 'development', DEMO_MODE: 'true' })
    expect(() => assertBootable()).not.toThrow()
  })

  it('listan går att läsa i demoläget och visar vad som saknas för skarpt läge', async () => {
    const { sharpModeRequirements } = await load({ NODE_ENV: 'development', DEMO_MODE: 'true' })
    const unmet = sharpModeRequirements().filter((requirement) => !requirement.met)
    expect(unmet.map((requirement) => requirement.id)).toContain('bankid-real')
  })
})
