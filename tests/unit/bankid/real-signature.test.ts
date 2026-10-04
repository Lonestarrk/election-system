import { X509Certificate } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { signedOnDay } from '@/modules/eligibility/bankid/certificate-chain'
import { parseServiceName } from '@/modules/eligibility/bankid/service-name'
import { verifyBankIdSignature } from '@/modules/eligibility/bankid/xmldsig'

/**
 * RIKTIGA UNDERSKRIFTER FRÅN BANKID:S TESTMILJÖ (uppgift 17c, beslut 4).
 *
 * Mappen fixtures/real är tom tills en människa med test-BankID har skrivit under
 * en röst mot testmiljön med BANKID_CAPTURE_SIGNATURES_DIR satt. Då läggs:
 *
 *   fixtures/real/<namn>.json   filen som fångsten skrev, oförändrad
 *   fixtures/real/roots.pem     BankID:s rot för kundcertifikat i testmiljön
 *
 * och testet nedan prövar varje underskrift med läsaren, som läggningen gör, mot
 * roten, på dagen den fångades och med RP-certifikatets namn som srvInfo/name.
 * Utan filer hoppas testet över, och kravet `bankid-reader-tested` står kvar.
 */

const DIRECTORY = join(process.cwd(), 'tests', 'unit', 'bankid', 'fixtures', 'real')
const captures = existsSync(DIRECTORY) ? readdirSync(DIRECTORY).filter((name) => name.endsWith('.json')) : []

/** srvInfo/name för BankID:s publika testcertifikat FP Testcert 5, som fångsten kör med. */
const TEST_SERVICE = 'CN=FP Testcert 5,name=Test av BankID,serialNumber=5566304928,O=Testbank A AB (publ),C=SE'

/** Läses i testet och inte i describe, som vitest kör också när sviten hoppas över. */
function roots(): X509Certificate[] {
  return (readFileSync(join(DIRECTORY, 'roots.pem'), 'utf8').match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
  ) ?? []).map((pem) => new X509Certificate(pem))
}

describe.skipIf(captures.length === 0)('en riktig underskrift från BankID:s testmiljö', () => {
  it.each(captures)('%s godtas av läsaren', (name) => {
    const capture = JSON.parse(readFileSync(join(DIRECTORY, name), 'utf8')) as {
      environment: string
      capturedOn: string
      signature: string
    }
    expect(capture.environment).toBe('test')

    const verdict = verifyBankIdSignature(Buffer.from(capture.signature, 'base64'), {
      roots: roots(),
      signedDuring: signedOnDay(new Date(`${capture.capturedOn}T00:00:00Z`)),
      service: parseServiceName(TEST_SERVICE)!,
    })

    expect(verdict).toMatchObject({ ok: true })
  })
})
