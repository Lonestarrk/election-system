import { NextResponse, type NextRequest } from 'next/server'

/**
 * Säkerhetsheaders och CORS.
 *
 * CORS är avsiktligt restriktivt: systemet har inga externa konsumenter. Varje
 * tillåten främmande origin vore en extra väg in till ett API som hanterar
 * röstsessioner, utan att ge någon nytta alls.
 */

/**
 * Tillåtna origins. Kommaseparerade, samma format som lib/env.ts läser.
 *
 * Parsas här i stället för att importeras, eftersom middleware körs i en egen
 * runtime och inte ska dra in applikationens modulgraf. Formatet får inte
 * glida isär från env.ts — se testet i tests/unit/middleware-headers.test.ts.
 */
const APP_ORIGINS = (process.env.APP_ORIGIN ?? 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0)

/**
 * `Access-Control-Allow-Origin` får bara innehålla EN origin.
 *
 * Med flera tillåtna adresser måste svaret därför eka tillbaka just den som
 * frågade, aldrig hela listan. En header med "a,b" är inte en lista för
 * webbläsaren — den är en ogiltig origin, och alla anrop avvisas.
 */
function isAllowedOrigin(origin: string | null): origin is string {
  return origin !== null && APP_ORIGINS.includes(origin)
}

/**
 * Utvecklingsläge kräver 'unsafe-eval', och det är inte förhandlingsbart.
 *
 * Next.js dev-server kompilerar och byter moduler i webbläsaren med `eval`.
 * Utan tillåtelsen kastar bootstrapen EvalError, React hydrerar aldrig, och
 * resultatet är en sida som RENDERAS men är död: inga knappar fungerar, ingen
 * hämtning sker, ingenting loggas på servern.
 *
 * Det är exakt samma symptom som den tidigare CSP-buggen gav, och det är värt
 * att notera varför den här varianten ändå slank igenom: nonce-fixen löste
 * inline-skripten och gjorde produktionsbygget interaktivt, men dev-läget
 * behöver mer än så. Eftersom E2E-sviten kördes mot ett produktionsbygge
 * märktes det aldrig.
 *
 * FÅR ALDRIG NÅ PRODUKTION. 'unsafe-eval' upphäver en stor del av skyddet mot
 * kodinjektion, och i den här appen är klientkoden det enda som håller
 * blindningsfaktorn hemlig. Villkoret vaktas av ett test.
 */
const IS_DEVELOPMENT = process.env.NODE_ENV === 'development'

/**
 * CSP med NONCE för skript.
 *
 * VARFÖR NONCE OCH INTE BARA 'self'
 *
 * Next.js levererar sin hydreringsbootstrap som inline-skript. En policy med
 * enbart `script-src 'self'` blockerar dem, vilket i praktiken betyder att
 * React aldrig hydrerar: sidorna renderas men ingen klientkod körs, ingen
 * knapp fungerar och ingen hämtning sker. Det upptäcks inte av något test som
 * inte startar en riktig webbläsare.
 *
 * Alternativet 'unsafe-inline' hade löst det genom att tillåta VARJE
 * inline-skript, alltså också ett som en angripare lyckats injicera. Nonce ger
 * samma funktion utan den eftergiften: bara skript som bär just den här
 * begärans slumpade värde får köras, och värdet är omöjligt att gissa i förväg.
 *
 * 'strict-dynamic' låter de nonce-märkta skripten i sin tur ladda sina egna
 * moduler, vilket Next.js chunk-laddning kräver.
 */
function contentSecurityPolicy(nonce: string): string {
  return [
  "default-src 'self'",
  // 'unsafe-inline' för stilar krävs av Next.js inbyggda stilinjektion.
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${IS_DEVELOPMENT ? " 'unsafe-eval'" : ''}`,
  "img-src 'self' data:",
  "font-src 'self'",
  // Inga utgående anrop: ingen analytics, ingen felrapportering till tredje
  // part. Ett fel som skickas till en extern tjänst kan innehålla en token.
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  ].join('; ')
}

export function middleware(request: NextRequest) {
  const origin = request.headers.get('origin')

  /**
   * Ett nytt nonce per begäran.
   *
   * Återanvändes värdet mellan begäranden vore det gissningsbart för den som
   * sett en tidigare sida, och skyddet skulle falla.
   */
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')

  // Preflight: svara aldrig med tillåtelse till främmande origin.
  if (request.method === 'OPTIONS') {
    if (origin && !isAllowedOrigin(origin)) {
      return new NextResponse(null, { status: 403 })
    }
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : APP_ORIGINS[0]!,
        Vary: 'Origin',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '600',
      },
    })
  }

  // Nonce skickas vidare på BEGÄRAN, inte bara i svarsheadern. Next.js läser
  // `x-nonce` och märker sina egna skripttaggar med det.
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)

  const response = NextResponse.next({ request: { headers: requestHeaders } })

  response.headers.set('Content-Security-Policy', contentSecurityPolicy(nonce))
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('X-Frame-Options', 'DENY')
  // no-referrer: annars kan en utgående länk läcka vilken sida väljaren kom
  // ifrån, vilket i värsta fall är kvittosidan.
  response.headers.set('Referrer-Policy', 'no-referrer')
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  )
  // HSTS. Aktiveras av webbläsaren först vid HTTPS-svar, så den är ofarlig i
  // lokal utveckling över http.
  response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains')

  if (request.nextUrl.pathname.startsWith('/api/')) {
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    if (isAllowedOrigin(origin)) {
      response.headers.set('Access-Control-Allow-Origin', origin)
      response.headers.set('Access-Control-Allow-Credentials', 'true')
      response.headers.set('Vary', 'Origin')
    }
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
