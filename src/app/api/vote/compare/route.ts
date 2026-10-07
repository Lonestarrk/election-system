import { cookies } from 'next/headers'
import { clearVotingCookies, SESSION_COOKIE } from '@/lib/cookies'
import { isValidCsrfToken } from '@/lib/csrf'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { compareDeviceVotesSchema, parseJsonBody } from '@/lib/validation'
import { AUDIT_EVENTS, recordAuditEvent, recordRejectedOrigin } from '@/modules/eligibility/audit.service'
import { ballotBelongsToElection } from '@/modules/eligibility/election.service'
import { compareWithPendingVotes } from '@/modules/eligibility/pending-vote.service'
import { getValidVotingSession } from '@/modules/eligibility/voting-session.service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/vote/compare
 *
 * Stämmer rösten som den här enheten lade med den som ligger hos servern?
 *
 * Röstsidan sparar valet och chifferhashen för varje röst den lägger (spec
 * 3.1 punkt 1). När sidan laddas skickar den hit de hashar den sparat, och
 * får per valsedel tillbaka `same`, `different` eller `none`. Stämmer det
 * visar sidan valet. Annars har rösten ändrats från en annan enhet, eller
 * finns inte längre, och innehållet visas inte.
 *
 * SVARET INNEHÅLLER ALDRIG EN HASH.
 *
 * Servern jämför, den lämnar inte ut. Gav rutten i stället ut hashen för det
 * liggande kuvertet fick en enhet veta hashen för en röst som lagts från en
 * annan enhet, alltså den som räknas, och med läsrätt i votes_db pekar den ut
 * rätt rad efter stängningen. Se `compareWithPendingVotes` för hela
 * resonemanget, och tests/integration/device-comparison.test.ts för provet
 * att inget svar bär en.
 *
 * VARFÖR EN EGEN RUTT OCH INTE EN DEL AV /api/vote/session
 *
 * Sessionsrutten tar inte emot något och svarar med vad som gäller väljaren.
 * Den här tar emot en hemlighet från enheten och är ett orakel: den svarar ja
 * eller nej på om en viss hash är väljarens kuvert. Ett orakel ska synas som
 * ett eget ställe i API-ytan, med egen hastighetsgräns, CSRF-kontroll och en
 * gräns på en fråga per valsedel. Inbakad i sessionsrutten hade den ärvt den
 * ruttens mildare villkor, och en granskare hade behövt läsa koden för att
 * se att den fanns.
 *
 * POST, med hasharna i kroppen. En hash i en URL hamnar i loggar och
 * webbläsarhistorik, och tests/security/api-surface.test.ts förbjuder
 * dynamiska segment i hela API-trädet.
 *
 * Väljaren och omröstningen kommer från sessionen, aldrig från kroppen. Det
 * finns ingen parameter för att fråga om någon annan.
 *
 * BARA MEDAN RÖSTNINGEN PÅGÅR (ruling 144). Efter closesAt, eller när fasen
 * lämnat OPEN, svarar rutten 409 utan att jämföra, med samma villkor som
 * sessionens `acceptsVotes`. Annars hade `same` efter stängningen varit ett
 * kvitto på att rösten räknas, se `compareWithPendingVotes`.
 */
export async function POST(request: Request) {
  // Posten om fel Origin har en egen gräns per adress (helgrensgranskningen, ruling 145).
  if (!hasValidOrigin(request)) {
    await recordRejectedOrigin(request)
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('vote-compare', getClientIp(request), RATE_LIMITS.compareDeviceVotes)
  if (!rate.allowed) {
    if (rate.firstRejection) await recordAuditEvent(AUDIT_EVENTS.RATE_LIMITED)
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
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
    const response = errorResponse(
      'SESSION_EXPIRED',
      'Din röstsession har upphört. Legitimera dig igen.',
      401,
    )
    clearVotingCookies(response)
    return response
  }

  if (!isValidCsrfToken(request, session.csrfSecret)) {
    await recordAuditEvent(AUDIT_EVENTS.CSRF_REJECTED)
    return errorResponse('CSRF_FAILED', 'Begäran avvisades.', 403)
  }

  const body = await parseJsonBody(request, compareDeviceVotesSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  for (const entry of body.data.ballots) {
    if (!(await ballotBelongsToElection(entry.ballotId, session.electionId))) {
      return errorResponse('INVALID_BALLOT', 'Valsedeln gäller inte den här omröstningen.', 400)
    }
  }

  const compared = await compareWithPendingVotes(session.voterStatusId, session.electionId, body.data.ballots)

  // Efter stängningen jämförs ingenting (spec 3.1, ruling 144). Svaret är detsamma
  // för rätt och fel hash, och röstsidan visar då bara att en röst finns.
  if (compared.status === 'closed') {
    return errorResponse('VOTING_CLOSED', 'Röstningen har stängt, och rösten jämförs inte längre.', 409)
  }
  if (compared.status === 'wrong_mode') {
    return errorResponse('WRONG_MODE', 'Omröstningen hör inte till det läge eller den BankID-miljö servern kör i.', 409)
  }
  const results = compared.ballots

  // Fälten räknas upp ett och ett, så att ett nytt fält i tjänstens svar inte
  // följer med hit utan att någon bestämt det.
  return jsonResponse({
    ballots: results.map((entry) => ({ ballotId: entry.ballotId, result: entry.result })),
  })
}
