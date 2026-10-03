import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * EN RIKTIG UNDERSKRIFT FÅNGAS SOM TESTFALL, BARA I TESTMILJÖN (uppgift 17c, beslut 4).
 *
 * Läsaren är byggd efter BankID:s beskrivning, och den ska prövas mot en riktig
 * underskrift. En sådan kräver en människa med test-BankID. Fångsten skriver
 * underskriften till en fil i en katalog som anges med en variabel, och bara när
 * appen kör skarpt mot BankID:s testmiljö. Den går aldrig till loggen.
 */

const directory = mkdtempSync(join(tmpdir(), 'fangst-'))

async function load(env: Record<string, string>) {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return import('@/modules/eligibility/bankid/signature-capture')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('när fångsten gäller', () => {
  it('bara i skarpt läge mot BankID:s testmiljö, med en uttalad katalog', async () => {
    const sharpTest = await load({ DEMO_MODE: '', BANKID_ENV: 'test', BANKID_CAPTURE_SIGNATURES_DIR: directory })
    expect(sharpTest.signatureCaptureDirectory()).toBe(directory)
  })

  it('aldrig i produktion, aldrig i demoläget och aldrig utan katalog', async () => {
    for (const env of [
      { DEMO_MODE: '', BANKID_ENV: 'production', BANKID_CAPTURE_SIGNATURES_DIR: directory },
      { DEMO_MODE: 'true', BANKID_ENV: 'test', BANKID_CAPTURE_SIGNATURES_DIR: directory },
      { DEMO_MODE: '', BANKID_ENV: '', BANKID_CAPTURE_SIGNATURES_DIR: directory },
      { DEMO_MODE: '', BANKID_ENV: 'test', BANKID_CAPTURE_SIGNATURES_DIR: '' },
    ]) {
      const capture = await load(env)
      expect(capture.signatureCaptureDirectory(), JSON.stringify(env)).toBeNull()
    }
  })
})

describe('fångsten', () => {
  it('skriver underskriften och spärrsvaret till en egen fil, med dagen och inget annat, och loggar inget', async () => {
    const capture = await load({ DEMO_MODE: '', BANKID_ENV: 'test', BANKID_CAPTURE_SIGNATURES_DIR: directory })
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    )

    const path = capture.captureSignature(
      directory,
      { signature: 'PFNpZ25hdHVyZS8+', ocspResponse: 'b2NzcA==' },
      new Date('2026-10-03T14:15:16Z'),
    )

    expect(readdirSync(directory)).toContain(path.split(/[\\/]/).pop())
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      environment: 'test',
      capturedOn: '2026-10-03',
      signature: 'PFNpZ25hdHVyZS8+',
      ocspResponse: 'b2NzcA==',
    })
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('skriver aldrig över en tidigare fångst', async () => {
    const capture = await load({ DEMO_MODE: '', BANKID_ENV: 'test', BANKID_CAPTURE_SIGNATURES_DIR: directory })
    const first = capture.captureSignature(directory, { signature: 'YQ==', ocspResponse: '' })
    const second = capture.captureSignature(directory, { signature: 'Yg==', ocspResponse: '' })
    expect(first).not.toBe(second)
  })
})
