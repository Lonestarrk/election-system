import { isAdminAuthenticated } from '@/lib/admin-auth'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, statsRequestSchema } from '@/lib/validation'
import { listElections } from '@/modules/ballot-box'
import { turnoutByBallot } from '@/modules/eligibility/participation.service'
import { getVoterStatistics } from '@/modules/eligibility/voter-status.service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/stats
 *
 * Valstatistik för administratören: omröstningarna, och för en omröstning
 * antalet röstberättigade och valdeltagandet per valsedel.
 *
 * INGA LÖPANDE RESULTAT, INTE HELLER FÖR ADMINISTRATÖREN (uppgift 13, spec
 * 6.2). Fram till uppgiften visade rutten antalet röster per parti ur det
 * gamla flödets tabell medan röstningen pågick. Spec 6.2 gäller alla: den som
 * kan titta på ett löpande resultat kan också påverka när det slutliga kommer.
 * Resultatet finns först när omröstningen är räknad, i
 * /api/admin/elections/results och offentligt, med bevis, i
 * /api/observer/results.
 *
 * Valdeltagandet räknas ur kuvertmodellen: liggande kuvert före skalningen,
 * markeringar "har röstat" efter. Bara antal.
 *
 * Vad som medvetet saknas, och inte kommer att läggas till:
 *   – sökning på väljare
 *   – listning av enskilda väljare eller enskilda röster
 *   – tidsserier med fin upplösning (som skulle kunna korreleras)
 *   – korsningar mellan valsedlar
 *
 * VARFÖR POST FÖR EN LÄSNING
 *
 * Omröstningens id ligger i kroppen. Att läsa det ur URL:ens frågesträng hade
 * krävt webb-API:t för frågeparametrar, och API-ytans test förbjuder just de
 * orden i den här filen — en spärr mot att adminvyn någonsin får en
 * uppslagsfunktion över väljare.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('admin-stats', getClientIp(request), RATE_LIMITS.adminStats)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  if (!(await isAdminAuthenticated())) {
    return errorResponse('UNAUTHORISED', 'Inte inloggad.', 401)
  }

  const body = await parseJsonBody(request, statsRequestSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  const electionId = body.data.electionId ?? null

  const elections = await listElections()

  if (!electionId) {
    // Utan vald omröstning: bara listan, inga siffror.
    return jsonResponse({
      elections: elections.map((election) => ({
        id: election.id,
        name: election.name,
        kind: election.kind,
        opensAt: election.opensAt.toISOString(),
        closesAt: election.closesAt.toISOString(),
      })),
    })
  }

  if (!elections.some((election) => election.id === electionId)) {
    return errorResponse('UNKNOWN_ELECTION', 'Omröstningen finns inte.', 404)
  }

  const [voterStats, turnout] = await Promise.all([getVoterStatistics(electionId), turnoutByBallot(electionId)])
  if (!turnout) return errorResponse('UNKNOWN_ELECTION', 'Omröstningen finns inte.', 404)

  return jsonResponse({
    electionId,
    phase: turnout.phase,
    electorate: { totalEligible: voterStats.totalEligible },
    turnoutBasis: turnout.basis,
    ballots: turnout.ballots.map((ballot) => ({
      ballotId: ballot.ballotId,
      ballot: ballot.label,
      kind: ballot.kind,
      voted: ballot.voted,
      turnoutPercent:
        voterStats.totalEligible === 0 ? 0 : Math.round((ballot.voted / voterStats.totalEligible) * 1000) / 10,
    })),
  })
}
