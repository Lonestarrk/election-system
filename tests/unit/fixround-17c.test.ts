import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LIMITATION_STATUS, statusPlanned } from '@/app/architecture/code-facts'
import { KNOWN_LIMITATIONS } from '@/lib/known-limitations'

/**
 * FIXRUNDA 1 AV UPPGIFT 17c.
 *
 * Skarpt läge mot BankID:s testmiljö är inget riktigt val: vem som helst kan
 * skaffa ett test-BankID för vilket personnummer som helst. Varje sida, adminsidan
 * och loggen ska säga det, och listan över kända begränsningar likaså.
 */

async function load(env: Record<string, string>) {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return {
    banner: await import('@/lib/mode-banner'),
    mode: await import('@/lib/runtime-mode'),
  }
}

afterEach(() => vi.unstubAllEnvs())

describe('banderollen på varje sida', () => {
  it('säger i testmiljön att identiteten inte är säkrad', async () => {
    const { banner } = await load({ DEMO_MODE: '', BANKID_ENV: 'test' })
    const text = banner.modeBannerText()
    expect(text).toContain('BankID:s testmiljö')
    expect(text).toContain('Vem som helst kan skaffa ett test-BankID för vilket personnummer som helst')
    expect(text).toContain('identiteten är inte säkrad')
  })

  it('är demobanderollen i demoläget, och saknas i skarpt läge mot produktionen', async () => {
    expect((await load({ DEMO_MODE: 'true', BANKID_ENV: 'test' })).banner.modeBannerText()).toBe(
      'Demo, inte ett riktigt val. BankID är en attrapp.',
    )
    expect((await load({ DEMO_MODE: '', BANKID_ENV: 'production' })).banner.modeBannerText()).toBeNull()
  })

  it('layouten visar den, och avgör inte läget själv', () => {
    const layout = readFileSync('src/app/layout.tsx', 'utf8')
    expect(layout).toContain('const banner = modeBannerText()')
    expect(layout).not.toContain('Demo, inte ett riktigt val. BankID är en attrapp.')
  })
})

describe('adminsidan och loggen', () => {
  it('varningen för testmiljön säger att vem som helst kan rösta som vem som helst', async () => {
    const { mode } = await load({ DEMO_MODE: '', BANKID_ENV: 'test' })
    const warning = mode.sharpModeRequirements().find((entry) => entry.id === 'bankid-test-environment')!
    expect(warning.detail).toMatch(/vem som helst kan skaffa ett test-BankID för vilket personnummer som helst/i)
    expect(warning.detail).toMatch(/identiteten är inte säkrad/)
  })

  it('lägets innebörd i testmiljön låter inte som ett riktigt val', async () => {
    const test = (await load({ DEMO_MODE: '', BANKID_ENV: 'test' })).mode.describeMode().meaning
    expect(test).toMatch(/inte ett riktigt val/)
    expect(test).not.toMatch(/Legitimering och underskrift går till BankID/)

    const production = (await load({ DEMO_MODE: '', BANKID_ENV: 'production' })).mode.describeMode().meaning
    expect(production).not.toMatch(/inte ett riktigt val/)
  })

  it('kortet på adminsidan har samma innebörd', () => {
    const card = readFileSync('src/app/admin/ModeCard.tsx', 'utf8').replace(/\s+/g, ' ')
    expect(card).toContain('Vem som helst kan skaffa ett test-BankID för vilket personnummer som helst')
  })
})

describe('kända begränsningar', () => {
  it('testmiljön har en post, bunden till att kravet bara varnar där', () => {
    const entry = KNOWN_LIMITATIONS.find((item) => item.id === 'bankid-test-environment-identity-not-secured')
    expect(entry).toBeDefined()
    expect(entry!.stillTrueIf).toContainEqual({
      file: 'src/lib/runtime-mode.ts',
      contains: "blocking: bankIdEnvironment !== 'test',",
    })
  })

  it('ett RP-certifikat som byts under ett val har en post', () => {
    const entry = KNOWN_LIMITATIONS.find((item) => item.id === 'rp-certificate-change-fails-envelopes')
    expect(entry).toBeDefined()
    expect(entry!.why).toMatch(/service_name/)
    expect([entry!.stillTrueIf].flat().length).toBeGreaterThan(0)
  })

  it('läsaren mot en riktig underskrift är uppgift 17d', () => {
    expect(LIMITATION_STATUS['bankid-reader-untested-against-bankid']).toEqual(statusPlanned('17d'))
  })
})
