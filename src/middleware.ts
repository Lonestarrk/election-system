import { NextResponse, type NextRequest } from 'next/server'

/**
 * Säkerhetsheaders och CORS.
 *
 * CORS är avsiktligt restriktivt: systemet har inga externa konsumenter. Varje
 * tillåten främmande origin vore en extra väg in till ett API som hanterar
 * röstsessioner, utan att ge någon nytta alls.
 */

const APP_ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:3000'

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // 'unsafe-inline' för stilar krävs av Next.js inbyggda stilinjektion.
  // Skript tillåts inte inline — det är där risken faktiskt ligger.
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
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

export function middleware(request: NextRequest) {
  const origin = request.headers.get('origin')

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

  const response = NextResponse.next()

  response.headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
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
