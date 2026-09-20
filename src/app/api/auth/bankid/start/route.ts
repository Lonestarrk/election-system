import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, startAuthSchema } from '@/lib/validation'
import { bankIdService } from '@/modules/eligibility/bankid'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/bankid/start
 *
 * Startar en BankID-legitimering.
 *
 * Observera att röstberättigandet INTE kontrolleras här. Svaret ser likadant ut
 * oavsett om personnumret finns i röstlängden eller inte. Annars skulle
 * endpointen fungera som ett uppslagsverk över röstlängden för vem som helst
 * som matar in personnummer.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    await recordAuditEvent(AUDIT_EVENTS.CSRF_REJECTED)
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  // IP-adressen används enbart till hastighetsbegränsning, och hashas inuti
  // rate-limit-modulen. Den lagras aldrig och loggas aldrig.
  const rate = checkRateLimit('auth-start', getClientIp(request), RATE_LIMITS.authStart)
  if (!rate.allowed) {
    await recordAuditEvent(AUDIT_EVENTS.RATE_LIMITED)
    return errorResponse(
      'RATE_LIMITED',
      'För många försök. Försök igen om en stund.',
      429,
      { 'Retry-After': String(rate.retryAfterSeconds) },
    )
  }

  const body = await parseJsonBody(request, startAuthSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  const order = await bankIdService.auth({ personalNumber: body.data.personalNumber })

  await recordAuditEvent(AUDIT_EVENTS.AUTH_STARTED)

  return jsonResponse({
    orderRef: order.orderRef,
    qrData: order.qrData,
  })
}
