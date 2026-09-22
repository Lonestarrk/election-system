import { getAdminSession } from '@/lib/admin-auth'
import { isValidCsrfToken } from '@/lib/csrf'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, statsRequestSchema } from '@/lib/validation'
import { commitCurrentState } from '@/modules/ballot-box/commitment.service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/elections/commit
 *
 * Publicerar ett åtagande om det aktuella röstunderlaget.
 *
 * Ett åtagande är Merkleroten över samtliga röster plus antalet. Den som
 * publicerat en rot har bundit sig vid exakt den mängden röster — ändras något
 * i efterhand blir roten en annan, och avvikelsen syns.
 *
 * VARFÖR DET SKA GÖRAS OFTA
 *
 * En angripare kan bara gömma en ändring bland röster som ännu inte omfattats
 * av något publicerat åtagande. Täta åtaganden krymper det fönstret. I ett
 * riktigt system skulle detta köras automatiskt på schema och rötterna
 * publiceras utanför systemet — en rot som bara finns i samma databas som den
 * skyddar kan skrivas om tillsammans med rösterna.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('commit', getClientIp(request), RATE_LIMITS.createElection)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många försök.', 429, {
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
    return errorResponse('INVALID_INPUT', 'Ange vilken omröstning det gäller.', 400)
  }

  const commitment = await commitCurrentState(body.data.electionId)

  return jsonResponse({ commitment })
}
