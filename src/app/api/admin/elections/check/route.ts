import { getAdminSession } from '@/lib/admin-auth'
import { isValidCsrfToken } from '@/lib/csrf'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, statsRequestSchema } from '@/lib/validation'
import { runFinalCheck } from '@/orchestration/final-check.usecase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/elections/check
 *
 * Kör den automatiska slutkontrollen och returnerar rapporten.
 *
 * ADMINISTRATÖREN SKA INTE KUNNA KLICKA FRAM ETT RESULTAT OCH GODKÄNNA DET.
 *
 * Den här rutten finns för att administratören ska se hela bilden INNAN
 * fastställandet: vilka kontroller som gått igenom, vilka som fallerat, vilka
 * avvikelser som finns, och om resultatet över huvud taget får fastställas.
 *
 * Rapporten är läsning. Den ändrar ingenting och ger ingen behörighet — och
 * fastställandet litar inte på den. /api/admin/elections/certify kör samma
 * kontroll om, på servern, och vägrar om något kritiskt fallerar.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('final-check', getClientIp(request), RATE_LIMITS.adminStats)
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

  const body = await parseJsonBody(request, statsRequestSchema)
  if (!body.ok) return errorResponse('INVALID_INPUT', body.message, 400)

  if (!body.data.electionId) {
    return errorResponse('INVALID_INPUT', 'Ange vilken omröstning som ska kontrolleras.', 400)
  }

  const report = await runFinalCheck(body.data.electionId)
  if (!report) return errorResponse('UNKNOWN_ELECTION', 'Omröstningen finns inte.', 404)

  return jsonResponse({ report })
}
