import { getAdminSession } from '@/lib/admin-auth'
import { isValidCsrfToken } from '@/lib/csrf'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { createElectionSchema, parseJsonBody } from '@/lib/validation'
import { createElection } from '@/orchestration/create-election.usecase'
import { notifyNewElection } from '@/modules/notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/elections
 *
 * Skapar en omröstning. Kräver en inloggad administratör.
 *
 * Rutten importerar INTE från de två modulerna direkt, utan går via
 * orkestreringslagret. Det är därför den inte står på undantagslistan i
 * modulgränstestet: den ser bara ett användningsfall, inte båda databaserna.
 *
 * VAD SOM SKAPAS
 *
 * Ett riksdagsval får tre valsedlar — kommun, landsting, riksdag — där
 * alternativen är förskapade partier ur registret, med kandidater för
 * personröst. En allmän omröstning får de frågor administratören formulerat,
 * med sina svarsalternativ.
 *
 * Partier väljs ur registret och skrivs aldrig som fritext. Annars blir
 * "Socialdemokraterna" och "Socialdemokraterna " två partier i rösträkningen,
 * och felet upptäcks först när resultatet är fel.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('create-election', getClientIp(request), RATE_LIMITS.createElection)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många försök.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const session = await getAdminSession()
  if (!session) {
    return errorResponse('UNAUTHORISED', 'Inte inloggad.', 401)
  }

  // CSRF-kontrollen görs mot sessionens hemlighet i databasen, inte bara mot
  // cookien. En angripare som kan sätta cookies kan annars sätta både cookie
  // och header till samma påhittade värde och passera en ren double-submit.
  if (!isValidCsrfToken(request, session.csrfSecret)) {
    return errorResponse('CSRF_FAILED', 'Begäran avvisades.', 403)
  }

  const body = await parseJsonBody(request, createElectionSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  const outcome = await createElection(body.data)

  if (outcome.status === 'failed') {
    return errorResponse('CREATION_FAILED', outcome.message, 500)
  }

  // Notisen skickas efter att omröstningen är skapad i BÅDA databaserna.
  // Skickades den tidigare skulle en misslyckad spegling ge notiser om en
  // omröstning som sedan rullas tillbaka — och en push går inte att ta
  // tillbaka.
  //
  // Utskicket får inte fälla begäran: omröstningen ÄR skapad, och att svara
  // med fel för att en notis inte gick fram skulle få administratören att
  // skapa den igen.
  const notified = await notifyNewElection({
    electionId: outcome.election.id,
    name: outcome.election.name,
  }).catch(() => ({ sent: 0, failed: 0 }))

  return jsonResponse({
    status: 'created',
    election: {
      id: outcome.election.id,
      name: outcome.election.name,
      ballots: outcome.election.ballotIds,
    },
    notifications: notified,
  })
}
