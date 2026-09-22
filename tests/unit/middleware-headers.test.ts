import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * SÄKERHETSHEADERS OCH CORS.
 *
 * Två fel bodde här samtidigt, och båda hade samma symptom: en sida som
 * renderades men var död. Ingenting kastade på servern, inget test gick rött,
 * ingen logg sa något. Felen syntes bara i webbläsarens konsol.
 *
 *   1. CSP saknade 'unsafe-eval' i utvecklingsläge. Next.js dev-server byter
 *      moduler med `eval`, så bootstrapen kastade EvalError och React
 *      hydrerade aldrig. Varje knapp var overksam.
 *
 *   2. APP_ORIGIN blev en kommaseparerad lista, men middleware jämförde mot
 *      hela strängen och satte den som `Access-Control-Allow-Origin`. En
 *      header med "a,b" är inte en lista för webbläsaren — den är en ogiltig
 *      origin.
 *
 * Det första felet är det som gör testerna här viktiga i andra riktningen
 * också: fixen är 'unsafe-eval', och den får ALDRIG nå produktion. I den här
 * appen är klientkoden det enda som håller blindningsfaktorn hemlig.
 */

const ORIGIN_A = 'http://localhost:3000'
const ORIGIN_B = 'http://192.168.1.88:3000'
const FRÄMMANDE = 'http://angripare.example'

/**
 * Laddar middleware om med given miljö.
 *
 * Modulen läser NODE_ENV och APP_ORIGIN vid import, så varje variant kräver
 * en egen modulinstans. Det är också poängen: värdena får inte kunna växlas
 * i drift.
 */
async function loadMiddleware(env: Record<string, string>) {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  const module = await import('@/middleware')
  return module.middleware
}

function request(path: string, init: { origin?: string; method?: string } = {}) {
  const headers = new Headers()
  if (init.origin) headers.set('origin', init.origin)
  return new NextRequest(`${ORIGIN_A}${path}`, { method: init.method ?? 'GET', headers })
}

const csp = (response: { headers: Headers }) =>
  response.headers.get('Content-Security-Policy') ?? ''

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("'unsafe-eval' i produktion", () => {
  it('finns inte — detta är testets enda uppgift', async () => {
    /**
     * DET FARLIGA MED FIXEN.
     *
     * 'unsafe-eval' upphäver en stor del av skyddet mot kodinjektion. Slank
     * det med i ett produktionsbygge vore den enskilt allvarligaste
     * försvagningen i appen, eftersom en injicerad skriptsnutt kan läsa
     * blindningsfaktorn innan den används — och då finns kopplingen mellan
     * väljare och röst igen.
     */
    const middleware = await loadMiddleware({
      NODE_ENV: 'production',
      APP_ORIGIN: ORIGIN_A,
    })

    expect(csp(middleware(request('/')))).not.toContain('unsafe-eval')
  })

  it('finns inte heller i testmiljö eller vid okänt NODE_ENV', async () => {
    for (const nodeEnv of ['test', 'staging', '']) {
      const middleware = await loadMiddleware({ NODE_ENV: nodeEnv, APP_ORIGIN: ORIGIN_A })

      expect(csp(middleware(request('/')))).not.toContain('unsafe-eval')
    }
  })
})

describe("'unsafe-eval' i utvecklingsläge", () => {
  it('finns — annars är dev-servern en död sida', async () => {
    /**
     * Testet ser bakvänt ut: det kräver en försvagning. Men utan den kastar
     * Next.js bootstrap EvalError, React hydrerar aldrig, och appen går inte
     * att utveckla mot — sidorna syns men ingenting fungerar, vilket är
     * betydligt svårare att felsöka än det låter.
     */
    const middleware = await loadMiddleware({
      NODE_ENV: 'development',
      APP_ORIGIN: ORIGIN_A,
    })

    expect(csp(middleware(request('/')))).toContain("'unsafe-eval'")
  })
})

describe('CSP i övrigt', () => {
  it('bär ett nonce, och ett nytt för varje begäran', async () => {
    const middleware = await loadMiddleware({ NODE_ENV: 'production', APP_ORIGIN: ORIGIN_A })

    const first = csp(middleware(request('/')))
    const second = csp(middleware(request('/')))

    expect(first).toMatch(/'nonce-[A-Za-z0-9+/=]+'/)
    // Återanvänt nonce vore gissningsbart för den som sett en tidigare sida.
    expect(first).not.toBe(second)
  })

  it('tillåter inga utgående anrop och ingen inbäddning', async () => {
    const middleware = await loadMiddleware({ NODE_ENV: 'production', APP_ORIGIN: ORIGIN_A })
    const policy = csp(middleware(request('/')))

    expect(policy).toContain("connect-src 'self'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).not.toContain("script-src 'unsafe-inline'")
  })
})

describe('flera tillåtna origins', () => {
  const FLERA = `${ORIGIN_A},${ORIGIN_B}`

  it('ekar tillbaka den som frågade, aldrig hela listan', async () => {
    /**
     * FELET JAG SJÄLV INFÖRDE.
     *
     * När APP_ORIGIN blev en lista satte middleware hela strängen som
     * `Access-Control-Allow-Origin`. Webbläsaren läser inte det som två
     * tillåtna adresser — den läser det som en enda ogiltig, och avvisar
     * allt.
     */
    const middleware = await loadMiddleware({ NODE_ENV: 'production', APP_ORIGIN: FLERA })

    for (const origin of [ORIGIN_A, ORIGIN_B]) {
      const response = middleware(request('/api/elections', { origin }))

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
      expect(response.headers.get('Access-Control-Allow-Origin')).not.toContain(',')
      // Utan Vary kan en mellanliggande cache svara en origin med en annans header.
      expect(response.headers.get('Vary')).toBe('Origin')
    }
  })

  it('ger ingen tillåtelse till en främmande origin', async () => {
    const middleware = await loadMiddleware({ NODE_ENV: 'production', APP_ORIGIN: FLERA })

    const response = middleware(request('/api/elections', { origin: FRÄMMANDE }))

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('avvisar en preflight från främmande origin med 403', async () => {
    const middleware = await loadMiddleware({ NODE_ENV: 'production', APP_ORIGIN: FLERA })

    const response = middleware(
      request('/api/vote/cast', { origin: FRÄMMANDE, method: 'OPTIONS' }),
    )

    expect(response.status).toBe(403)
  })

  it('släpper igenom preflight från en uppräknad origin', async () => {
    const middleware = await loadMiddleware({ NODE_ENV: 'production', APP_ORIGIN: FLERA })

    const response = middleware(request('/api/vote/cast', { origin: ORIGIN_B, method: 'OPTIONS' }))

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN_B)
  })

  it('tål blanksteg runt kommatecknen', async () => {
    // Den som skriver listan i en .env-fil sätter mellanslag efter kommat.
    const middleware = await loadMiddleware({
      NODE_ENV: 'production',
      APP_ORIGIN: `${ORIGIN_A} , ${ORIGIN_B}`,
    })

    const response = middleware(request('/api/elections', { origin: ORIGIN_B }))

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN_B)
  })
})

describe('övriga säkerhetsheaders', () => {
  it('sätts på varje svar', async () => {
    const middleware = await loadMiddleware({ NODE_ENV: 'production', APP_ORIGIN: ORIGIN_A })
    const response = middleware(request('/'))

    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
    // no-referrer: en utgående länk får inte läcka att väljaren kom från
    // kvittosidan.
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
  })

  it('API-svar cachas aldrig', async () => {
    const middleware = await loadMiddleware({ NODE_ENV: 'production', APP_ORIGIN: ORIGIN_A })
    const response = middleware(request('/api/vote/session'))

    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(response.headers.get('Cache-Control')).toContain('private')
  })
})
