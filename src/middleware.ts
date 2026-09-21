import { NextResponse, type NextRequest } from 'next/server'

/**
 * Säkerhetsheaders och CORS.
 *
 * CORS är avsiktligt restriktivt: systemet har inga externa konsumenter. Varje
 * tillåten främmande origin vore en extra väg in till ett API som hanterar
 * röstsessioner, utan att ge någon nytta alls.
 */

const APP_ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:3000'

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
  `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
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
    if (origin && origin !== APP_ORIGIN) {
      return new NextResponse(null, { status: 403 })
    }
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': APP_ORIGIN,
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
    if (origin === APP_ORIGIN) {
      response.headers.set('Access-Control-Allow-Origin', APP_ORIGIN)
      response.headers.set('Access-Control-Allow-Credentials', 'true')
      response.headers.set('Vary', 'Origin')
    }
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
