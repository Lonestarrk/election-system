import { getAdminSession } from '@/lib/admin-auth'
import { isValidCsrfToken } from '@/lib/csrf'
import { DEMO_TRUSTEE_PASSPHRASES } from '@/lib/demo-election'
import { isDemoMode } from '@/lib/demo-mode'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/demo/trustee-passphrases
 *
 * Demovalets tre fraser, för knapparna "Fyll i demofrasen" på adminsidan
 * (uppgift 12c). Finns bara i demoläget.
 *
 * VARFÖR EN RUTT OCH INTE EN KONSTANT I SIDAN. Fraserna ska inte följa med
 * klientkoden till en webbläsare i skarpt läge. Sidans kod är densamma i båda
 * lägena, så fraserna hämtas först när en administratör ber om dem, och
 * rutten svarar 404 när demoläget är avslaget.
 *
 * Fraserna är kända för alla som läser repot, se `demo-trustee-passphrases-known`
 * i src/lib/known-limitations.ts. Rutten kräver ändå adminsessionen och
 * CSRF-token: den ska inte vara en öppen lista, och den hör till ceremonin.
 */
export async function POST(request: Request) {
  if (!isDemoMode()) {
    return errorResponse('NOT_FOUND', 'Rutten finns inte.', 404)
  }

  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('demo-trustee-passphrases', getClientIp(request), RATE_LIMITS.adminStats)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const session = await getAdminSession()
  if (!session) return errorResponse('UNAUTHORISED', 'Inte inloggad.', 401)

  if (!isValidCsrfToken(request, session.csrfSecret)) {
    return errorResponse('CSRF_FAILED', 'Begäran avvisades.', 403)
  }

  return jsonResponse({ passphrases: DEMO_TRUSTEE_PASSPHRASES })
}
