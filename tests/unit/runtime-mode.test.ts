import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Demoläge och skarpt läge (uppgift 17).
 *
 * Läget sätts vid driftsättning och följer bara DEMO_MODE=true. Skarpt är
 * förvalt, oavsett NODE_ENV. Ingen väg i appen byter läge.
 */

const EXAMPLE_PEPPER = 'byt-ut-mig-detta-ar-bara-for-lokal-utveckling-0000'

/** En miljö där alla krav utom BankID-klienten är uppfyllda. */
const SHARP_ENV = {
  DEMO_MODE: '',
  NODE_ENV: 'production',
  COOKIE_SECURE: 'true',
  APP_ORIGIN: 'https://val.example',
  IDENTITY_PEPPER: 'en-riktig-peppar-som-ar-minst-trettiotva-tecken-lang',
  BANKID_ENV: 'test',
  BANKID_ROOT_CERTIFICATES: '',
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
      'bankid-env',
      'bankid-real',
      'bankid-root-not-mock',
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

  it('BankID-klienten saknas i bygget, och kravet stoppar tills 17c', async () => {
    const { sharpModeRequirements } = await load({ ...SHARP_ENV })
    const real = sharpModeRequirements().find((requirement) => requirement.id === 'bankid-real')!

    expect(real.met).toBe(false)
    expect(real.blocking).toBe(true)
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
    expect(() => assertBootable()).toThrow(/bankid-real/)
  })

  it('vägrar starta skarpt med attrapp-BankID, också när allt annat är rätt', async () => {
    const { assertBootable } = await load({ ...SHARP_ENV })
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
