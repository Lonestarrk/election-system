import { cookies } from 'next/headers'
import { clearVotingCookies, SESSION_COOKIE } from '@/lib/cookies'
import { isValidCsrfToken } from '@/lib/csrf'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { issueCredentialSchema, parseJsonBody } from '@/lib/validation'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import { issueCredential } from '@/modules/eligibility/credential.service'
import {
  destroyVotingSession,
  getValidVotingSession,
} from '@/modules/eligibility/voting-session.service'
import { hasCompletedElection } from '@/modules/eligibility/voter-status.service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/vote/credential
 *
 * Utfärdar ett röstintyg för en valsedel. Kräver en giltig röstsession.
 *
 * DETTA ÄR SYSTEMETS ENDA IDENTIFIERADE STEG I RÖSTNINGEN.
 *
 * Här vet systemet vem väljaren är, markerar att hen använt sin röst på
 * valsedeln, och signerar ett BLINDAT intyg. Vad intyget innehåller ser
 * servern aldrig — väljarens webbläsare skapade det och multiplicerade det med
 * en slumpfaktor som aldrig lämnar enheten.
 *
 * Nästa steg, den faktiska rösten, går till /api/vote/cast UTAN sessionscookie
 * och utan något som kan kopplas hit.
 *
 * MARKERINGEN OCH SIGNERINGEN ÄR EN TRANSAKTION.
 *
 * Båda rör röstlängdsdatabasen och sker odelbart. Det är därför systemet inte
 * längre har något fönster där en krasch ger antingen dubbelröstning eller en
 * förlorad röst: väljaren får ett intyg eller så får hen inget, och ett intyg
 * går att lösa in när som helst efteråt.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    await recordAuditEvent(AUDIT_EVENTS.CSRF_REJECTED)
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('issue-credential', getClientIp(request), RATE_LIMITS.castVote)
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

  const body = await parseJsonBody(request, issueCredentialSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  const outcome = await issueCredential(
    session.voterStatusId,
    session.electionId,
    body.data.ballotId,
    body.data.blinded,
  )

  if (outcome.status === 'already_issued') {
    await recordAuditEvent(AUDIT_EVENTS.DOUBLE_VOTE_BLOCKED)
    return errorResponse('ALREADY_VOTED', 'Du har redan röstat på den här valsedeln.', 409)
  }

  if (outcome.status === 'ballot_not_for_voter' || outcome.status === 'unknown_ballot') {
    // Samma svar i båda fallen. Skilda svar skulle göra rutten till ett
    // uppslagsverk över vilka valsedlar som gäller var.
    return errorResponse('INVALID_BALLOT', 'Valsedeln gäller inte dig.', 400)
  }

  await recordAuditEvent(AUDIT_EVENTS.CREDENTIAL_ISSUED)

  // Är alla valsedlar avklarade raderas sessionen omedelbart. Varje extra
  // sekund är en extra sekund då identitet och pågående röstning finns
  // samtidigt.
  const complete = await hasCompletedElection(session.voterStatusId, session.electionId)
  if (complete) {
    await destroyVotingSession(session.id)
  }

  const response = jsonResponse({
    blindSignature: outcome.blindSignature,
    // Skickas med så att väljarens webbläsare kan verifiera signaturen INNAN
    // rösten lämnas in. Utan den kontrollen skulle en server kunna svara med
    // skräp, och felet upptäckas först när rösträtten redan är förbrukad.
    publicKeyPem: outcome.publicKeyPem,
    electionComplete: complete,
  })

  if (complete) {
    clearVotingCookies(response)
  }

  return response
}
