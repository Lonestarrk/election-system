import { cookies } from 'next/headers'
import { clearVotingCookies, SESSION_COOKIE } from '@/lib/cookies'
import { isValidCsrfToken } from '@/lib/csrf'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { castVoteSchema, parseJsonBody } from '@/lib/validation'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import { getValidVotingSession } from '@/modules/eligibility/voting-session.service'
import { castVote } from '@/orchestration/cast-vote.usecase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/vote/cast
 *
 * Lägger rösten och returnerar token.
 *
 * Token returneras i svarskroppen, en enda gång. Den finns inte i någon URL,
 * skrivs inte till någon logg, sätts inte i någon cookie och sparas inte i
 * webbläsarens lagring. Efter det här svaret existerar klartexten bara på
 * väljarens skärm.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    await recordAuditEvent(AUDIT_EVENTS.CSRF_REJECTED)
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('cast-vote', getClientIp(request), RATE_LIMITS.castVote)
  if (!rate.allowed) {
    await recordAuditEvent(AUDIT_EVENTS.RATE_LIMITED)
    return errorResponse('RATE_LIMITED', 'För många försök.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const cookieStore = await cookies()
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value

  if (!sessionId) {
    return errorResponse('NO_SESSION', 'Din röstsession har upphört. Legitimera dig igen.', 401)
  }

  const session = await getValidVotingSession(sessionId)
  if (!session) {
    await recordAuditEvent(AUDIT_EVENTS.VOTING_SESSION_EXPIRED)
    const response = errorResponse(
      'SESSION_EXPIRED',
      'Din röstsession har upphört. Legitimera dig igen.',
      401,
    )
    clearVotingCookies(response)
    return response
  }

  // CSRF-kontrollen görs mot sessionens hemlighet i databasen, inte bara mot
  // cookien. En angripare som kan sätta cookies kan annars sätta både cookie
  // och header till samma påhittade värde och passera en ren double-submit.
  if (!isValidCsrfToken(request, session.csrfSecret)) {
    await recordAuditEvent(AUDIT_EVENTS.CSRF_REJECTED)
    return errorResponse('CSRF_FAILED', 'Begäran avvisades.', 403)
  }

  const body = await parseJsonBody(request, castVoteSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  const outcome = await castVote(session, body.data)

  if (outcome.status === 'already_voted') {
    // Sessionen rensas INTE här. Väljaren kan ha valsedlar kvar att rösta på
    // i samma omröstning, och att kasta ut hen för att en valsedel redan var
    // lagd skulle tvinga fram en ny legitimering i onödan.
    return errorResponse('ALREADY_VOTED', 'Du har redan röstat på den här valsedeln.', 409)
  }

  if (outcome.status === 'ballot_not_for_voter') {
    // Samma svar oavsett om valsedeln gäller en annan kommun eller inte finns
    // alls. Skilda svar skulle göra endpointen till ett uppslagsverk över
    // vilka valsedlar som finns var.
    return errorResponse('INVALID_BALLOT', 'Valsedeln gäller inte dig.', 400)
  }

  if (outcome.status === 'invalid_choice') {
    return errorResponse('INVALID_CHOICE', outcome.reason, 400)
  }

  if (outcome.status === 'recording_failed') {
    const response = errorResponse(
      'RECORDING_FAILED',
      'Rösten kunde tyvärr inte registreras. Kontakta valmyndigheten.',
      500,
    )
    clearVotingCookies(response)
    return response
  }

  const response = jsonResponse({
    token: outcome.token,
    electionComplete: outcome.electionComplete,
    warning:
      'Detta är enda gången din token visas. Spara den om du vill kunna kontrollera din röst senare.',
  })

  // EN TOKEN PER VALSEDEL. Väljaren i ett riksdagsval får tre — en för
  // kommunvalet, en för landstingsvalet, en för riksdagsvalet. En gemensam
  // token skulle binda ihop de tre partivalen till en profil, som är
  // väsentligt mer identifierande än något enskilt av dem.
  //
  // Cookies rensas först när sista valsedeln är lagd. Fram till dess behöver
  // sessionen finnas kvar för att väljaren ska kunna fortsätta. Orkestreringen
  // har redan raderat sessionsraden ur databasen i samma ögonblick den blev
  // överflödig; här rensas motsvarande spår i webbläsaren.
  if (outcome.electionComplete) {
    clearVotingCookies(response)
  }

  return response
}
