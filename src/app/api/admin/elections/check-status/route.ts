import { isAdminAuthenticated } from '@/lib/admin-auth'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, statsRequestSchema } from '@/lib/validation'
import { readFinalCheck } from '@/orchestration/final-check-job'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/elections/check-status
 *
 * Läser slutkontrollens läge och rapport (uppgift 12c, punkt 7d). Sidan frågar
 * med jämna mellanrum medan kontrollen körs.
 *
 * `none` betyder att ingen kontroll körts sedan processen startade. Resultatet
 * ligger bara i minnet och går förlorat vid en omstart, och kontrollen får då
 * köras om. Rutten ändrar ingenting.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('final-check-status', getClientIp(request), RATE_LIMITS.adminStats)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  if (!(await isAdminAuthenticated())) {
    return errorResponse('UNAUTHORISED', 'Inte inloggad.', 401)
  }

  const body = await parseJsonBody(request, statsRequestSchema)
  if (!body.ok) return errorResponse('INVALID_INPUT', body.message, 400)
  if (!body.data.electionId) {
    return errorResponse('INVALID_INPUT', 'Ange vilken omröstning som ska läsas.', 400)
  }

  const job = readFinalCheck(body.data.electionId)
  if (!job) return jsonResponse({ status: 'none' })

  return jsonResponse(job)
}
