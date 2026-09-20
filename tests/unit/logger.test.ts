import { describe, expect, it, vi, afterEach } from 'vitest'
import { logger, redact } from '@/lib/logger'
import { generateVoteToken } from '@/modules/anonymous-vote/token.service'

/**
 * Testpunkt 10 (enhetsnivå): klartext-token skrivs aldrig till loggen.
 *
 * Integrationsvarianten i tests/security/no-token-in-logs.test.ts kör ett helt
 * röstningsflöde och granskar allt som faktiskt skrevs ut.
 */

afterEach(() => {
  vi.restoreAllMocks()
})

describe('maskering', () => {
  it('maskerar en token i visningsformat', () => {
    const { token } = generateVoteToken()
    const output = redact(`Väljaren fick token ${token} vid röstningen`)

    expect(output).not.toContain(token)
    expect(output).toContain('[MASKERAT]')
  })

  it('maskerar en token utan bindestreck', () => {
    const { canonical } = generateVoteToken()
    expect(redact(`token=${canonical}`)).not.toContain(canonical)
  })

  it('maskerar personnummer i alla vanliga format', () => {
    const numbers = ['19900101-1234', '199001011234', '900101-1234', '900101+1234']

    for (const number of numbers) {
      const output = redact(`Legitimering för ${number}`)
      expect(output, `${number} maskerades inte`).not.toContain(number)
    }
  })

  it('maskerar hashvärden', () => {
    const hash = 'a'.repeat(64)
    expect(redact(`hash=${hash}`)).not.toContain(hash)
  })

  it('lämnar ofarlig text orörd', () => {
    const message = 'Röstsessionen upphörde efter tio minuter'
    expect(redact(message)).toBe(message)
  })
})

describe('logger', () => {
  it('maskerar innan något skrivs ut', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { token } = generateVoteToken()

    logger.info(`Detta borde aldrig hända: ${token}`)

    const written = spy.mock.calls.flat().join(' ')
    expect(written).not.toContain(token)
    expect(written).toContain('[MASKERAT]')
  })

  it('maskerar även värden som skickats in via kontextobjektet', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { token } = generateVoteToken()

    logger.error('Fel vid röstning', { token, personalNumber: '19900101-1234' })

    const written = spy.mock.calls.flat().join(' ')
    expect(written).not.toContain(token)
    expect(written).not.toContain('19900101-1234')
  })
})
