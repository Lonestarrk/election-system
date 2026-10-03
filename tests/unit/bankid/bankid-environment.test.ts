import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BANKID_ENVIRONMENTS,
  PUBLIC_TEST_RP_CERTIFICATE_SHA256,
  serverRootFor,
  serverRootProblem,
  SERVER_ROOT_SHA256,
} from '@/modules/eligibility/bankid/bankid-environment'
import { loadRpCredentials, rpCredentialProblem } from '@/modules/eligibility/bankid/rp-certificate'
import { authority, encryptedKeyPem, leafUnder, RP_SUBJECT, rpCredential } from './fake-rp-server'

/**
 * BANKID:S MILJÖER, FÖRANKRINGEN OCH RP-CERTIFIKATET (uppgift 17c).
 *
 * Källa för adresserna och rötterna: developers.bankid.com/getting-started/environments,
 * hämtad 2026-10-03.
 */

describe('adresserna', () => {
  it('är RP API v6.0 hos BankID, i respektive miljö', () => {
    expect(BANKID_ENVIRONMENTS.test.baseUrl).toBe('https://appapi2.test.bankid.com/rp/v6.0/')
    expect(BANKID_ENVIRONMENTS.production.baseUrl).toBe('https://appapi2.bankid.com/rp/v6.0/')
  })
})

describe('serverrotens fingeravtryck är låst per miljö', () => {
  it('fingeravtrycken är de som BankID:s rötter har', () => {
    expect(SERVER_ROOT_SHA256.test).toBe(
      'F3:D0:74:0E:BF:B3:70:0E:3B:81:AA:79:1F:EE:45:14:72:69:8C:84:E1:99:C2:EB:48:A4:43:FF:1D:5B:40:5C',
    )
    expect(SERVER_ROOT_SHA256.production).toBe(
      'E6:A2:D4:5C:0A:10:51:C9:59:42:86:49:F8:6A:09:A9:B2:15:2C:D5:51:99:3C:C2:EB:4C:F0:94:BD:AC:BE:CB',
    )
  })

  it('varje miljö får sin egen rot, och PEM:en stämmer med det låsta fingeravtrycket', () => {
    for (const environment of ['test', 'production'] as const) {
      const root = serverRootFor(environment)
      expect(root.fingerprint256).toBe(SERVER_ROOT_SHA256[environment])
      expect(root.ca).toBe(true)
      expect(serverRootProblem(environment)).toBeNull()
    }
    expect(serverRootFor('test').subject).toContain('CN=Test BankID SSL Root CA v1 Test')
    expect(serverRootFor('production').subject).toContain('CN=BankID SSL Root CA v1')
  })

  it('produktion vägrar testroten och test vägrar produktionsroten', () => {
    const testPem = BANKID_ENVIRONMENTS.test.serverRootPem
    const productionPem = BANKID_ENVIRONMENTS.production.serverRootPem

    expect(serverRootProblem('production', testPem)).toMatch(/fingeravtryck/)
    expect(serverRootProblem('test', productionPem)).toMatch(/fingeravtryck/)
    expect(() => serverRootFor('production', testPem)).toThrow(/fingeravtryck/)
    expect(() => serverRootFor('test', productionPem)).toThrow(/fingeravtryck/)
  })

  it('en annan rot vägras också', () => {
    const other = authority('inte-bankid', 'Inte BankID').pem
    expect(serverRootProblem('test', other)).toMatch(/fingeravtryck/)
  })
})

describe('RP-certifikatet', () => {
  const RP_CA = authority('rp-ca-miljö', 'RP-CA för miljön')
  const RP = rpCredential(RP_CA, 'rp-miljö')
  const directory = mkdtempSync(join(tmpdir(), 'rp-'))

  function pemFile(name: string, content: string): string {
    const path = join(directory, name)
    writeFileSync(path, content)
    return path
  }

  it('läses ur en PEM-fil med certifikatet och en krypterad nyckel, som BankID:s testfil', () => {
    const path = pemFile('rp.pem', `Bag Attributes\n    friendlyName: test\n${RP.certPem}${encryptedKeyPem(RP, 'qwerty123')}`)

    const credentials = loadRpCredentials(path, 'qwerty123')

    expect(credentials.certificate.fingerprint256).toBe(RP.certificate.fingerprint256)
    expect('cert' in credentials.tls && credentials.tls.passphrase).toBe('qwerty123')
  })

  it('fel fras, en saknad fil och en fil utan nyckel ger ett fel som säger vad som är fel', () => {
    const path = pemFile('rp2.pem', `${RP.certPem}${encryptedKeyPem(RP, 'qwerty123')}`)
    expect(() => loadRpCredentials(path, 'fel')).toThrow(/BANKID_CERT_PASSPHRASE|frasen/)
    expect(() => loadRpCredentials(join(directory, 'finns-inte.pem'), 'x')).toThrow(/BANKID_CERT_PATH/)
    expect(() => loadRpCredentials(pemFile('rp3.pem', RP.certPem), 'x')).toThrow(/nyckel/)
  })

  it('en nyckel som inte hör till certifikatet vägras', () => {
    const other = rpCredential(RP_CA, 'en annan nyckel')
    const path = pemFile('rp4.pem', `${RP.certPem}${other.keyPem}`)
    expect(() => loadRpCredentials(path, '')).toThrow(/hör inte till/)
  })

  it('i produktion vägras BankID:s publika testcertifikat, och ett utgånget certifikat vägras alltid', () => {
    const { certificate } = loadRpCredentials(pemFile('rp5.pem', `${RP.certPem}${RP.keyPem}`), '')
    expect(rpCredentialProblem('test', certificate, new Date('2030-01-01'))).toBeNull()
    expect(rpCredentialProblem('production', certificate, new Date('2030-01-01'))).toBeNull()

    const publicTest = {
      fingerprint256: PUBLIC_TEST_RP_CERTIFICATE_SHA256,
      validFromDate: certificate.validFromDate,
      validToDate: certificate.validToDate,
    }
    expect(rpCredentialProblem('production', publicTest, new Date('2030-01-01'))).toMatch(/testcertifikat/)
    expect(rpCredentialProblem('test', publicTest, new Date('2030-01-01'))).toBeNull()

    const expired = leafUnder(RP_CA, 'utgånget', RP_SUBJECT, { notAfter: new Date('2025-01-01') })
    const old = loadRpCredentials(pemFile('rp6.pem', `${expired.certPem}${expired.keyPem}`), '')
    expect(rpCredentialProblem('test', old.certificate, new Date('2026-10-03'))).toMatch(/gått ut/)
  })
})
