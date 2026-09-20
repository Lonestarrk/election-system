import { cookies } from 'next/headers'
import { ADMIN_COOKIE } from './cookies'
import {
  getValidAdminSession,
  type AdminSession,
} from '@/modules/eligibility/admin-session.service'

/**
 * Adminautentisering.
 *
 * Behörigheten hänger på IDENTITETEN, inte på en delad hemlighet: den som ska
 * kunna skapa en omröstning legitimerar sig med BankID precis som en väljare,
 * och får adminvyn först om hens rad i röstlängden har `isAdmin`.
 *
 * Det ersätter ett delat ADMIN_PASSWORD som hade tre problem: det gick inte
 * att se vem som varit inne, det gick inte att återkalla en enskild session,
 * och lösenordet låg i klartext i varje .env-fil och driftsmiljö.
 *
 * Det som INTE ändrats är den viktigaste egenskapen: hur stark eller svag
 * inloggningen än är kan en angripare som tar sig in i adminvyn ändå inte se
 * vem som röstat på vad. Adminvyn har inga sådana funktioner, och underlaget
 * finns inte i någon databas den når. Behörighetsskyddet är alltså inte det
 * som bär valhemligheten — det är databasseparationen som gör det.
 *
 * Kvar att lösa för ett riktigt system: flerpartskontroll. Att skapa eller
 * stänga en omröstning borde kräva att flera behöriga personer agerar
 * tillsammans, så att en ensam administratör inte kan göra något avgörande på
 * egen hand. Se SECURITY.md.
 */

/**
 * Hämtar den inloggade administratörens session, eller null.
 *
 * Kontrollerar adminflaggan mot databasen vid varje anrop — en cookie är ett
 * bevis på att någon loggade in, inte på att personen fortfarande är behörig.
 */
export async function getAdminSession(): Promise<AdminSession | null> {
  const cookieStore = await cookies()
  const sessionId = cookieStore.get(ADMIN_COOKIE)?.value
  if (!sessionId) return null

  return getValidAdminSession(sessionId)
}

export async function isAdminAuthenticated(): Promise<boolean> {
  return (await getAdminSession()) !== null
}
