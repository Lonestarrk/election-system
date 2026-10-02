import { isAdminAuthenticated } from '@/lib/admin-auth'
import { DEMO_ELECTION_NAME } from '@/lib/demo-election'
import { isDemoMode } from '@/lib/demo-mode'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, statsRequestSchema } from '@/lib/validation'
import { getElectionOverview } from '@/orchestration/election-overview.usecase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/elections/state
 *
 * Var avslutningen står för en omröstning: fasen i röstlängden, om en
 * slutkontroll har markerat den som avvikande, antalet liggande kuvert,
 * rötterna och vilka förtroendepersoner som lämnat bidrag (uppgift 12c).
 *
 * Adminsidan läser den efter varje åtgärd och drar aldrig slutsatser av sina
 * egna klick. Servern är auktoriteten, och varje åtgärdsrutt prövar fasen själv
 * med jämför-och-sätt.
 *
 * BARA ANTAL. Rutten lämnar aldrig ut något per väljare: inget kuvert, ingen
 * tidpunkt för en röst, ingen markering. Den ändrar ingenting, så den kräver
 * inloggad administratör men inget CSRF-token, som statistikrutten.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('admin-election-state', getClientIp(request), RATE_LIMITS.adminStats)
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

  const overview = await getElectionOverview(body.data.electionId)
  if (!overview) return errorResponse('UNKNOWN_ELECTION', 'Omröstningen finns inte.', 404)

  /**
   * Läget avgörs bara av `isDemoMode()`. Sidan visar demoknapparna efter det
   * här svaret, och rutterna bakom dem frågar läget själva och svarar 404 i
   * skarpt läge. Återställningen erbjuds bara för demovalet, som rutten
   * kräver, så att sidan inte visar en knapp som skulle vägras.
   */
  const demoMode = isDemoMode()
  return jsonResponse({
    overview,
    demoMode,
    demoReset: demoMode && overview.name === DEMO_ELECTION_NAME,
  })
}
