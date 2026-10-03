import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AUDIT_EVENTS, certifiedEventTypeFor } from '@/modules/eligibility/audit.service'

/**
 * Fastställandets granskningshändelse skriver ned BankID-miljön (uppgift 17).
 *
 * Typen går in i kedjans hash, så en miljö som skrivits om i efterhand syns som
 * en bruten kedja. Att varje miljö får sin egen typ prövas här. Att
 * fastställandet faktiskt skriver typen prövas i tests/integration/final-check.test.ts.
 */
describe('fastställandets händelsetyp', () => {
  it('ger varje BankID-miljö en egen typ, och attrappen den vanliga', () => {
    expect(certifiedEventTypeFor('mock')).toBe(AUDIT_EVENTS.ELECTION_CERTIFIED)
    expect(certifiedEventTypeFor('test')).toBe('ELECTION_CERTIFIED_BANKID_TEST')
    expect(certifiedEventTypeFor('production')).toBe('ELECTION_CERTIFIED_BANKID_PRODUCTION')
    expect(certifiedEventTypeFor('none')).toBe('ELECTION_CERTIFIED_BANKID_NONE')
  })

  it('typerna är olika, så att miljön går att läsa ur kedjan', () => {
    const types = (['mock', 'test', 'production', 'none'] as const).map(certifiedEventTypeFor)
    expect(new Set(types).size).toBe(4)
  })

  it('fastställandet skriver typen som hör till serverns BankID, och inte en fast', () => {
    const source = readFileSync('src/orchestration/final-check.usecase.ts', 'utf8')
    expect(source).toContain('recordAuditEvent(certifiedEventTypeFor(bankIdKind(runtimeMode())), tx)')
    expect(source).not.toContain('recordAuditEvent(AUDIT_EVENTS.ELECTION_CERTIFIED, tx)')
  })
})
