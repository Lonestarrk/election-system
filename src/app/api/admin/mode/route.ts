import { isAdminAuthenticated } from '@/lib/admin-auth'
import { errorResponse, getClientIp, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { describeMode, sharpModeRequirements } from '@/lib/runtime-mode'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/mode
 *
 * Läget, vilken BankID som används och checklistan för skarpt läge, till
 * adminsidans lägeskort (uppgift 17). Bakom adminsessionen, eftersom
 * checklistan beskriver konfigurationen: vilka krav som är ouppfyllda är en
 * vägledning för den som vill angripa en felkonfigurerad driftsättning.
 * Den offentliga /api/mode ger bara läget.
 *
 * Bara GET, och rutten tar inte emot något. Läget sätts vid driftsättning och
 * kan inte ändras här, och ingen rutt i appen ändrar det.
 *
 * Svaret skiljer inte på varför en begäran nekas: ingen session ger 401.
 */
export async function GET(request: Request) {
  const rate = checkRateLimit('admin-mode', getClientIp(request), RATE_LIMITS.adminStats)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  if (!(await isAdminAuthenticated())) {
    return errorResponse('UNAUTHORISED', 'Inte inloggad.', 401)
  }

  return jsonResponse({ ...describeMode(), requirements: sharpModeRequirements() })
}
