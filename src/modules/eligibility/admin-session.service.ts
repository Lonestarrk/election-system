import { generateCsrfSecret } from '@/lib/csrf'
import { votersDb } from './db'

/**
 * Adminsessioner.
 *
 * Sessionen skapas efter en lyckad BankID-legitimering där personens rad i
 * röstlängden har `isAdmin`. Det finns ingen annan väg in: inget delat
 * lösenord, ingen miljövariabel, ingen bakdörr för lokal utveckling.
 *
 * VARFÖR DET HÄR ÄR BÄTTRE ÄN DET DELADE LÖSENORDET
 *
 * Det tidigare ADMIN_PASSWORD hade tre problem som alla försvinner här:
 * det gick inte att se vem som varit inne, det gick inte att återkalla en
 * enskild session, och lösenordet låg i klartext i konfigurationen — alltså i
 * varje utvecklares .env och i varje driftsmiljö.
 *
 * Nu är behörigheten knuten till en identitet i röstlängden, sessionen är en
 * rad som går att radera, och det finns ingen hemlighet att läcka.
 *
 * Vad som INTE blev bättre: det är fortfarande en ensam administratör som kan
 * agera på egen hand. En riktig valadministration behöver flerpartskontroll —
 * att skapa eller stänga en omröstning borde kräva att flera behöriga personer
 * agerar tillsammans. Det ligger utanför den här POC:en och står i SECURITY.md.
 */

/**
 * Livslängd. Längre än röstsessionens tio minuter, eftersom att lägga upp en
 * omröstning med valsedlar, partier och kandidater tar tid — men fortfarande
 * kort nog att en glömd inloggning inte står öppen över natten.
 */
export const ADMIN_SESSION_TTL_MINUTES = 60

export type AdminSession = {
  id: string
  voterStatusId: string
  csrfSecret: string
}

export async function createAdminSession(voterStatusId: string): Promise<AdminSession> {
  // Gamla sessioner för samma person städas bort. En administratör som loggar
  // in på en ny enhet ska inte lämna en öppen session på den gamla.
  await votersDb.adminSession.deleteMany({ where: { voterStatusId } })

  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_MINUTES * 60 * 1000)

  return votersDb.adminSession.create({
    data: { voterStatusId, expiresAt, csrfSecret: generateCsrfSecret() },
    select: { id: true, voterStatusId: true, csrfSecret: true },
  })
}

/**
 * Hämtar en giltig adminsession.
 *
 * Adminflaggan kontrolleras om vid VARJE begäran, inte bara vid inloggning.
 * Den som fått flaggan borttagen ska tappa åtkomsten omedelbart, inte när
 * sessionen råkar gå ut. En sessionsrad är ett bevis på att någon loggade in,
 * inte på att personen fortfarande är behörig.
 */
export async function getValidAdminSession(sessionId: string): Promise<AdminSession | null> {
  const session = await votersDb.adminSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      voterStatusId: true,
      csrfSecret: true,
      expiresAt: true,
      voterStatus: { select: { isAdmin: true } },
    },
  })

  if (!session) return null

  if (session.expiresAt.getTime() <= Date.now() || !session.voterStatus.isAdmin) {
    await votersDb.adminSession.deleteMany({ where: { id: sessionId } })
    return null
  }

  return {
    id: session.id,
    voterStatusId: session.voterStatusId,
    csrfSecret: session.csrfSecret,
  }
}

export async function destroyAdminSession(sessionId: string): Promise<void> {
  await votersDb.adminSession.deleteMany({ where: { id: sessionId } })
}

/** Städar bort utgångna adminsessioner. */
export async function purgeExpiredAdminSessions(): Promise<number> {
  const result = await votersDb.adminSession.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  })
  return result.count
}
