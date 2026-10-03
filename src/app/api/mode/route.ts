import { errorResponse, getClientIp, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { runtimeMode } from '@/lib/runtime-mode'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/mode
 *
 * Bara läget, "DEMO" eller "SHARP", som banderollen behöver. Offentlig, och
 * lämnar därför ut inget om konfigurationen: inte vilken BankID som används,
 * inte vilka krav som är uppfyllda. Checklistan går via /api/admin/mode, bakom
 * adminsessionen.
 *
 * Bara GET. Ingen rutt i appen byter läge, se src/lib/mode-flag.ts.
 */
export async function GET(request: Request) {
  const rate = checkRateLimit('public-mode', getClientIp(request), RATE_LIMITS.publicMode)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  return jsonResponse({ mode: runtimeMode() })
}
