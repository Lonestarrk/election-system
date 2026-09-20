import type { NextResponse } from 'next/server'
import { env } from './env'

/**
 * Cookies.
 *
 * Röstsessionen bärs av en HttpOnly-cookie. Den är avsiktligt kortlivad och
 * raderas i samma ögonblick rösten lagts — efter det finns inget värde kvar i
 * webbläsaren som kan knyta besökaren till en lagd röst.
 */

export const SESSION_COOKIE = 'valsession'
export const CSRF_COOKIE = 'valcsrf'
export const ADMIN_COOKIE = 'valadmin'

/** Sessionens livslängd. Kort: fönstret där identitet och röstning möts. */
export const SESSION_TTL_MINUTES = 10

type CookieOptions = {
  httpOnly: boolean
  maxAgeSeconds: number
}

function baseOptions({ httpOnly, maxAgeSeconds }: CookieOptions) {
  return {
    httpOnly,
    // Strict, inte Lax: ingen tredjepartskontext ska någonsin få med sig
    // röstsessionen, inte ens vid toppnivånavigering.
    sameSite: 'strict' as const,
    secure: env.cookieSecure,
    path: '/',
    maxAge: maxAgeSeconds,
  }
}

export function setSessionCookie(response: NextResponse, sessionId: string): void {
  response.cookies.set(SESSION_COOKIE, sessionId, baseOptions({
    httpOnly: true,
    maxAgeSeconds: SESSION_TTL_MINUTES * 60,
  }))
}

/**
 * CSRF-token måste vara läsbar från JavaScript — det är hela poängen med
 * double-submit: klienten läser cookien och ekar tillbaka värdet i en header.
 * Den är därför inte HttpOnly. Den är inte heller hemlig på samma sätt som
 * sessionen: den skyddar mot att en annan sajt skickar begäran, inte mot att
 * någon läser vår egen sida.
 */
export function setCsrfCookie(response: NextResponse, csrfToken: string): void {
  response.cookies.set(CSRF_COOKIE, csrfToken, baseOptions({
    httpOnly: false,
    maxAgeSeconds: SESSION_TTL_MINUTES * 60,
  }))
}

export function setAdminCookie(response: NextResponse, value: string): void {
  response.cookies.set(ADMIN_COOKIE, value, baseOptions({
    httpOnly: true,
    maxAgeSeconds: 60 * 60,
  }))
}

/** Raderar röstsessionens spår i webbläsaren. */
export function clearVotingCookies(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, '', { ...baseOptions({ httpOnly: true, maxAgeSeconds: 0 }) })
  response.cookies.set(CSRF_COOKIE, '', { ...baseOptions({ httpOnly: false, maxAgeSeconds: 0 }) })
}
