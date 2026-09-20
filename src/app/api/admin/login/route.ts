import { adminCookieValue, isCorrectAdminPassword } from '@/lib/admin-auth'
import { setAdminCookie } from '@/lib/cookies'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { adminLoginSchema, parseJsonBody } from '@/lib/validation'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('admin-login', getClientIp(request), RATE_LIMITS.adminLogin)
  if (!rate.allowed) {
    await recordAuditEvent(AUDIT_EVENTS.RATE_LIMITED)
    return errorResponse('RATE_LIMITED', 'För många försök.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const body = await parseJsonBody(request, adminLoginSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  if (!isCorrectAdminPassword(body.data.password)) {
    await recordAuditEvent(AUDIT_EVENTS.ADMIN_LOGIN_FAILED)
    return errorResponse('INVALID_CREDENTIALS', 'Fel lösenord.', 401)
  }

  await recordAuditEvent(AUDIT_EVENTS.ADMIN_LOGIN_SUCCEEDED)

  const response = jsonResponse({ ok: true })
  setAdminCookie(response, adminCookieValue())
  return response
}
