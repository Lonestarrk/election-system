import { cookies } from 'next/headers'
import { clearVotingCookies, SESSION_COOKIE } from '@/lib/cookies'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { getMirroredElection } from '@/modules/eligibility/election.service'
import { participationOf } from '@/modules/eligibility/participation.service'
import { getValidVotingSession } from '@/modules/eligibility/voting-session.service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/vote/participation
 *
 * VERIFIERINGSSIDANS BESKED: "DU HAR RÖSTAT" ELLER "DU HAR INTE RÖSTAT", PER
 * VALSEDEL (uppgift 13, spec 3.1 punkt 6).
 *
 * Före skalningen kommer svaret ur väljarens liggande kuvert, efter skalningen
 * ur markeringen "har röstat", som skalningen skriver i samma transaktion som
 * raderar kuverten. Se src/modules/eligibility/participation.service.ts.
 *
 * ATT, INTE VAD OCH INTE NÄR. Svaret har valsedlarnas id, namn och sort, fasen
 * och ett ja eller nej per valsedel. Inget chiffer, ingen chifferhash, ingen
 * räknare och ingen tid: markeringen har ingen tidsstämpel, och kuvertets
 * läses inte. Före stängningen ser väljaren sin röst på röstsidan, på enheten
 * hon röstade från, och bara där.
 *
 * KRÄVER SESSION, OCH SVARAR BARA OM DEN EGNA VÄLJAREN, som /api/vote/session.
 * Det finns ingen parameter för att fråga om någon annan. Sessionen skapas av
 * samma legitimering som röstsidans, och den gäller den omröstning väljaren
 * valde, också en som är stängd.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('vote-participation', getClientIp(request), RATE_LIMITS.authCollect)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const cookieStore = await cookies()
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value
  if (!sessionId) {
    return errorResponse('NO_SESSION', 'Legitimera dig för att se om du har röstat.', 401)
  }

  const session = await getValidVotingSession(sessionId)
  if (!session) {
    const response = errorResponse('SESSION_EXPIRED', 'Din session har upphört. Legitimera dig igen.', 401)
    clearVotingCookies(response)
    return response
  }

  const [election, participation] = await Promise.all([
    getMirroredElection(session.electionId),
    participationOf(session.voterStatusId, session.electionId),
  ])
  if (!election || !participation) {
    return errorResponse('UNKNOWN_ELECTION', 'Omröstningen finns inte längre.', 404)
  }

  return jsonResponse({
    electionId: session.electionId,
    electionName: election.name,
    phase: participation.phase,
    ballots: participation.ballots.map((ballot) => ({
      id: ballot.ballotId,
      kind: ballot.kind,
      label: ballot.label,
      voted: ballot.voted,
    })),
  })
}
