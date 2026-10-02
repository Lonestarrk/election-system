import { isAdminAuthenticated } from '@/lib/admin-auth'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, statsRequestSchema } from '@/lib/validation'
import { getElectionTallyResults } from '@/orchestration/election-overview.usecase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/elections/results
 *
 * Räkneverken per valsedel, efter TALLIED och CERTIFIED (uppgift 12c, punkt 7c).
 * Räkningens rutt vägrar efter TALLIED, och ingen annan rutt lämnar ut
 * räkneverken igen, så adminsidan behöver en läsväg, också efter en omladdning.
 *
 * INTE OFFENTLIG. Rutten kräver den inloggade administratören. Att publicera
 * resultatet, med bevis, är uppgift 13, och först då kan någon annan läsa det.
 * Före TALLIED svarar rutten att omröstningen inte är räknad och lämnar inga
 * räkneverk, också om några valsedlar redan är räknade.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('admin-election-results', getClientIp(request), RATE_LIMITS.adminStats)
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

  const outcome = await getElectionTallyResults(body.data.electionId)

  if (outcome.status === 'unknown_election') {
    return errorResponse('UNKNOWN_ELECTION', 'Omröstningen finns inte.', 404)
  }

  if (outcome.status === 'not_tallied') {
    return jsonResponse(
      {
        status: 'not_tallied',
        phase: outcome.phase,
        message: `Omröstningen är inte räknad, och fasen står i ${outcome.phase}. Ingen resultat lämnas ut före TALLIED.`,
      },
      409,
    )
  }

  return jsonResponse({ status: 'ok', phase: outcome.phase, ballots: outcome.ballots })
}
