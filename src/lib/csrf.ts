import { safeEqual, secureRandomBytes } from './crypto'

/**
 * CSRF-skydd med double-submit.
 *
 * Vid legitimering skapas en slumpad CSRF-hemlighet. Den lagras dels på
 * sessionsraden i databasen, dels i en icke-HttpOnly-cookie. Klienten läser
 * cookien och ekar tillbaka värdet i headern `X-CSRF-Token`. Servern jämför
 * headern mot sessionens hemlighet.
 *
 * Varför detta stoppar CSRF: en angripares sajt kan få webbläsaren att skicka
 * med våra cookies, men kan inte läsa dem (same-origin policy) och kan därför
 * inte sätta rätt header. Att hemligheten också ligger i databasen gör att en
 * angripare inte kan hitta på ett eget par av cookie och header.
 *
 * Skyddet kompletteras av Origin-kontroll i `http.ts` och SameSite=Strict på
 * cookien. Tre lager, eftersom varje enskilt lager har kända luckor.
 */

export const CSRF_HEADER = 'x-csrf-token'

export function generateCsrfSecret(): string {
  return secureRandomBytes(32).toString('hex')
}

export function isValidCsrfToken(request: Request, expectedSecret: string): boolean {
  const provided = request.headers.get(CSRF_HEADER)
  if (!provided) return false
  return safeEqual(provided, expectedSecret)
}
