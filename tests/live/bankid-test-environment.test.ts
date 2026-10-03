import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BANKID_ENVIRONMENTS } from '@/modules/eligibility/bankid/bankid-environment'
import { BankIdRequestError, BankIdRpClient } from '@/modules/eligibility/bankid/BankIdRpClient'
import { loadRpCredentials } from '@/modules/eligibility/bankid/rp-certificate'

/**
 * ETT FRIVILLIGT PROV MOT BANKID:S TESTMILJÖ (uppgift 17c, krav 7).
 *
 * Körs bara med BANKID_LIVE_TEST=1 och ingår inte i den vanliga sviten. Provet
 * startar en legitimering, frågar efter den medan den väntar och avbryter den.
 * Ingen människa behövs, och ingen underskrift görs.
 *
 *   npx tsx scripts/fetch-bankid-test-cert.ts
 *   BANKID_LIVE_TEST=1 npx vitest run tests/live
 *
 * Certifikatet läses ur BANKID_CERT_PATH och BANKID_CERT_PASSPHRASE, och utan
 * dem ur det som skriptet hämtade, med BankID:s publika fras för testcertifikatet.
 */

const LIVE = process.env.BANKID_LIVE_TEST === '1'
const DEFAULT_CERT = join(process.cwd(), 'certs', 'bankid-test', 'FPTestcert5_20240610.p12')

function testClient(): BankIdRpClient {
  const path = process.env.BANKID_CERT_PATH?.trim() || DEFAULT_CERT
  if (!existsSync(path)) throw new Error(`Inget RP-certifikat i ${path}. Kör scripts/fetch-bankid-test-cert.ts först.`)
  const credentials = loadRpCredentials(path, process.env.BANKID_CERT_PASSPHRASE ?? 'qwerty123')
  return new BankIdRpClient({
    baseUrl: BANKID_ENVIRONMENTS.test.baseUrl,
    serverRoots: [BANKID_ENVIRONMENTS.test.serverRootPem],
    credentials: credentials.tls,
  })
}

describe.skipIf(!LIVE)('BankID:s testmiljö, på riktigt', () => {
  it('auth, collect på en väntande order och cancel', async () => {
    const client = testClient()

    const order = await client.auth({ endUserIp: '192.0.2.1', userVisibleData: 'Prov av valsystemets klient' })
    expect(order.orderRef).toMatch(/^[0-9a-f-]{36}$/)
    expect(order.autoStartToken).toMatch(/^[0-9a-f-]{36}$/)

    const qr = await client.qrData(order.orderRef)
    expect(qr?.qrData).toMatch(/^bankid\.[0-9a-f-]{36}\.\d+\.[0-9a-f]{64}$/)

    const pending = await client.collect(order.orderRef)
    expect(pending).toEqual({ status: 'pending', hintCode: 'outstandingTransaction' })

    await client.cancel(order.orderRef)

    // En avbruten order finns inte längre hos BankID, och klienten säger det som ett fel.
    let error: unknown
    try {
      await client.collect(order.orderRef)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(BankIdRequestError)
    expect((error as BankIdRequestError).code).toBe('invalidParameters')
  })
})
