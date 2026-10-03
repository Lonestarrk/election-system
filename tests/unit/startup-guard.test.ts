import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Uppstartsvakten (uppgift 17).
 *
 * `register` i src/instrumentation.ts körs av Next en gång när servern startar.
 * Skarpt läge som inte uppfyller kraven ska aldrig komma så långt som att ta
 * emot en begäran, och läget ska stå i loggen vid varje start.
 */

async function register(env: Record<string, string>, runtimeName = 'nodejs') {
  vi.resetModules()
  for (const [key, value] of Object.entries({ NEXT_RUNTIME: runtimeName, ...env })) {
    vi.stubEnv(key, value)
  }
  const module = await import('@/instrumentation')
  return module.register()
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('uppstartsvakten', () => {
  it('stoppar skarpt läge med ouppfyllda krav, och räknar upp dem', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await expect(register({ DEMO_MODE: '', NODE_ENV: 'production', COOKIE_SECURE: 'false' })).rejects.toThrow(
      /cookie-secure/,
    )
  })

  it('stoppar skarpt läge när RP-certifikatet för BankID saknas', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await expect(
      register({
        DEMO_MODE: '',
        COOKIE_SECURE: 'true',
        APP_ORIGIN: 'https://val.example',
        IDENTITY_PEPPER: 'en-riktig-peppar-som-ar-minst-trettiotva-tecken-lang',
        BANKID_ENV: 'test',
        BANKID_CERT_PATH: '',
      }),
    ).rejects.toThrow(/bankid-client-certificate/)
  })

  it('släpper igenom demoläget, också i ett produktionsbygge, och loggar läget', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await register({ DEMO_MODE: 'true', NODE_ENV: 'production' })

    expect(log.mock.calls.map((call) => String(call[0])).some((line) => /Demoläge/.test(line))).toBe(true)
  })

  it('loggar läget vid varje start', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await register({ DEMO_MODE: 'true' })
    await register({ DEMO_MODE: 'true' })

    expect(log.mock.calls.filter((call) => /Demoläge/.test(String(call[0])))).toHaveLength(2)
  })

  it('kör bara i Node-miljön, där DEMO_MODE finns att läsa', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    // Edge-miljön har ingen egen start. Vakten körs i Node, en gång.
    await expect(register({ DEMO_MODE: '', NODE_ENV: 'production' }, 'edge')).resolves.toBeUndefined()
  })
})
