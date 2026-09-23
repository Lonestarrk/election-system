import { describe, expect, it, vi, afterEach } from 'vitest'
import { describeErrorChain, logger, redact } from '@/lib/logger'
import { generateVoteToken } from '@/modules/ballot-box/token.service'

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

describe('orsakskedjan i ett fel', () => {
  /**
   * Ett fel som paketeras om bär sitt verkliga skäl i `cause`. Skrivs bara det
   * yttersta lagret ut försvinner diagnostiken precis där den behövs mest —
   * se `describeErrorChain` och stängningen (uppgift 11, fixrunda 4).
   */
  it('följer cause hela vägen', () => {
    const rot = new Error('anslutningen tappades')
    const yttre = new Error('kunde inte bekräftas', { cause: rot })

    const beskrivning = describeErrorChain(yttre)

    expect(beskrivning).toContain('kunde inte bekräftas')
    expect(beskrivning).toContain('anslutningen tappades')
  })

  it('fastnar inte i en cyklisk kedja', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    a.cause = b

    expect(describeErrorChain(b)).toContain('a')
  })

  it('maskerar även det som ligger i orsaken', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rot = new Error('slog upp 19900101-1234')

    logger.error('Fel', { error: new Error('yttre', { cause: rot }) })

    const written = spy.mock.calls.flat().join(' ')
    expect(written).not.toContain('19900101-1234')
    expect(written).toContain('yttre')
  })
})

describe('loggern kastar aldrig själv', () => {
  /**
   * INVARIANTEN: EN LOGGRAD SOM KASTAR ÄR VÄRRE ÄN EN SOM SAKNAS.
   *
   * Loggern anropas bland annat inifrån felhanterare — i stängningsrutten
   * ligger anropet INNE i catch-blocket, före svaret med säkerhetsbeskedet.
   * Kastar loggern där blir svaret en naken 500 i stället för beskedet om
   * huruvida kopplingen mellan väljare och röst finns kvar. Därför ska ingen
   * indata, hur trasig den än är, kunna få en loggrad att kasta.
   */
  it('en kontext med en getter som kastar ger en loggrad, inte ett kast', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const context = {
      get farlig(): string {
        throw new Error('getter kastade')
      },
    }

    expect(() => logger.error('Fel', context)).not.toThrow()

    const written = spy.mock.calls.flat().join(' ')
    expect(written).toContain('Fel')
    expect(written).toContain('[kunde inte serialiseras]')
  })

  it('ett led utan prototyp i orsakskedjan ger en loggrad, inte ett kast', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // `String(Object.create(null))` kastar TypeError — objektet saknar både
    // toString och valueOf.
    const yttre = new Error('yttre', { cause: Object.create(null) })

    expect(() => describeErrorChain(yttre)).not.toThrow()
    expect(describeErrorChain(yttre)).toContain('yttre')

    expect(() => logger.error('Fel', { error: yttre })).not.toThrow()
    expect(spy.mock.calls.flat().join(' ')).toContain('yttre')
  })
})
