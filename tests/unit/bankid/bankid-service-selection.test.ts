import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BANKID_ENVIRONMENTS, SERVER_ROOT_SHA256 } from '@/modules/eligibility/bankid/bankid-environment'
import { authority, encryptedKeyPem, rpCredential } from './fake-rp-server'

/**
 * VILKEN BANKID SOM VÄLJS, OCH MED VILKEN ROT (uppgift 17c).
 *
 * index.ts är det enda stället där implementationen väljs. Klientens konstruktor
 * fångas här, så att testet ser exakt vilken adress, vilken rot och vilket
 * certifikat skarpt läge ger den, utan att något anrop går till BankID.
 */

const constructed = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('@/modules/eligibility/bankid/BankIdRpClient', () => ({
  BankIdRpClient: class {
    constructor(options: Record<string, unknown>) {
      constructed.push(options)
    }
    async auth() {
      return { orderRef: 'o', autoStartToken: 'a' }
    }
  },
  BankIdRequestError: class extends Error {},
}))

const directory = mkdtempSync(join(tmpdir(), 'val-'))
const rp = rpCredential(authority('rp-ca-val', 'RP-CA för valet'), 'rp-val')
const certPath = join(directory, 'rp.pem')
writeFileSync(certPath, `${rp.certPem}${encryptedKeyPem(rp, 'fras')}`)

async function service(env: Record<string, string>) {
  vi.resetModules()
  constructed.length = 0
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return (await import('@/modules/eligibility/bankid')).bankIdService
}

afterEach(() => vi.unstubAllEnvs())

describe('valet av BankID', () => {
  it.each(['test', 'production'] as const)('skarpt läge med BANKID_ENV=%s får miljöns adress och rot', async (environment) => {
    const bankId = await service({
      DEMO_MODE: '',
      BANKID_ENV: environment,
      BANKID_CERT_PATH: certPath,
      BANKID_CERT_PASSPHRASE: 'fras',
      BANKID_CAPTURE_SIGNATURES_DIR: '',
    })
    await bankId.auth({ endUserIp: '192.0.2.1' })

    expect(constructed).toHaveLength(1)
    const options = constructed[0]!
    expect(options.baseUrl).toBe(BANKID_ENVIRONMENTS[environment].baseUrl)
    const roots = options.serverRoots as string[]
    expect(roots).toHaveLength(1)
    const { X509Certificate } = await import('node:crypto')
    expect(new X509Certificate(roots[0]!).fingerprint256).toBe(SERVER_ROOT_SHA256[environment])
    expect((options.credentials as { cert: string }).cert).toContain(rp.certPem.trim().split('\n')[1])
    expect(options.onComplete).toBeUndefined()
  })

  it('fångsten kopplas in bara med katalogen, i testmiljön', async () => {
    const env = { DEMO_MODE: '', BANKID_CERT_PATH: certPath, BANKID_CERT_PASSPHRASE: 'fras', BANKID_CAPTURE_SIGNATURES_DIR: directory }

    await (await service({ ...env, BANKID_ENV: 'test' })).auth({ endUserIp: '192.0.2.1' })
    expect(typeof constructed[0]!.onComplete).toBe('function')

    await (await service({ ...env, BANKID_ENV: 'production' })).auth({ endUserIp: '192.0.2.1' })
    expect(constructed[0]!.onComplete).toBeUndefined()
  })

  it('demoläget använder attrappen, och klienten skapas aldrig', async () => {
    const bankId = await service({ DEMO_MODE: 'true', BANKID_ENV: 'test' })
    await bankId.auth({ endUserIp: '192.0.2.1' })
    expect(constructed).toHaveLength(0)
  })

  it('skarpt läge utan BANKID_ENV vägrar varje anrop', async () => {
    const bankId = await service({ DEMO_MODE: '', BANKID_ENV: '' })
    await expect(bankId.auth({ endUserIp: '192.0.2.1' })).rejects.toThrow(/saknar en BankID-klient/)
    expect(constructed).toHaveLength(0)
  })
})
