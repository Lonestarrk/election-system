import { cookies } from 'next/headers'
import { safeEqual, sha256Hex } from './crypto'
import { ADMIN_COOKIE } from './cookies'
import { env } from './env'

/**
 * Adminautentisering — POC-nivå.
 *
 * Ett delat lösenord ur konfigurationen, och en cookie vars värde härleds ur
 * samma lösenord. Det räcker för att demonstrera att adminvyn är skyddad, men
 * det är inte ett autentiseringssystem: det finns inga individuella konton,
 * ingen tvåfaktor, ingen möjlighet att återkalla en enskild session och ingen
 * spårbarhet till en person.
 *
 * En riktig valadministration behöver flerpartskontroll — funktioner som
 * kräver att flera behöriga personer agerar tillsammans — just för att en
 * ensam administratör inte ska kunna göra något avgörande på egen hand.
 *
 * Värt att notera: hur svag den här inloggningen än är kan en angripare som
 * tar sig in i adminvyn ändå inte se vem som röstat på vad. Adminvyn har inga
 * sådana funktioner, och underlaget finns inte i någon databas den når.
 * Behörighetsskyddet är alltså inte det som bär valhemligheten.
 */

function expectedCookieValue(): string {
  return sha256Hex(`admin-session:${env.adminPassword}`)
}

export function isCorrectAdminPassword(candidate: string): boolean {
  return safeEqual(candidate, env.adminPassword)
}

export function adminCookieValue(): string {
  return expectedCookieValue()
}

export async function isAdminAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies()
  const value = cookieStore.get(ADMIN_COOKIE)?.value
  if (!value) return false
  return safeEqual(value, expectedCookieValue())
}
