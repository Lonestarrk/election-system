import { getAdminSession, isAdminAuthenticated } from '@/lib/admin-auth'
import { isValidCsrfToken } from '@/lib/csrf'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { describeErrorChain, logger } from '@/lib/logger'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, tallyRequestSchema } from '@/lib/validation'
import { completeTally, TallyAbortedError, type TallyOutcome } from '@/orchestration/tally.usecase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/elections/tally
 *
 * Räknar en valsedel när två förtroendepersoner har lämnat sina bidrag, se
 * /api/admin/elections/decrypt. Bidragen prövas mot valsedelns summa en gång
 * till, kombineras, och svaret är antalet röster per alternativ, i valsedelns
 * kanoniska ordning med blankt först. När den sista valsedeln i omröstningen
 * är räknad går omröstningen till fasen TALLIED.
 *
 * EGEN RUTT OCH INTE ETT STEG I BIDRAGET. Räkningen är ett eget steg i
 * ceremonin, "Räkna" på adminsidan, och den tar ingen fras: den öppnar bara det
 * två förtroendepersoner redan har bidragit till. Ett bidrag räknar aldrig, så
 * appen öppnar summan först när administratören ber om det, och det syns i
 * revisionsloggen. Men två sparade bidrag bestämmer redan summan: den som kan
 * läsa röstdatabasen kan kombinera dem själv, och enligt spec 6.2 publiceras
 * varje bidrag när det kommer in.
 *
 * RESULTATET PUBLICERAS INTE HÄR. Räkneverken sparas i röstdatabasen, och
 * svaret går till den inloggade administratören. Publiceringen, med bevis, är
 * uppgift 13. I demoläget visar livevyn på arkitektursidan röstdatabasens
 * tabeller som en insider ser dem, och därmed också räkneverken.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('tally-ceremony', getClientIp(request), RATE_LIMITS.tallyCeremony)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många försök.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  if (!(await isAdminAuthenticated())) {
    return errorResponse('UNAUTHORISED', 'Inte inloggad.', 401)
  }

  // Sessionen hämtas för CSRF-hemligheten, som i stängningens rutt.
  const session = await getAdminSession()
  if (!session) return errorResponse('UNAUTHORISED', 'Inte inloggad.', 401)

  if (!isValidCsrfToken(request, session.csrfSecret)) {
    return errorResponse('CSRF_FAILED', 'Begäran avvisades.', 403)
  }

  const body = await parseJsonBody(request, tallyRequestSchema)
  if (!body.ok) return errorResponse('INVALID_INPUT', body.message, 400)

  let outcome: TallyOutcome
  try {
    outcome = await completeTally(body.data.ballotId)
  } catch (error) {
    /**
     * ETT AVBROTT ÄR ETT BESKED, INTE EN NAKEN 500. Räkningen kastar
     * `TallyAbortedError` hellre än att ge ett tal den inte kan stå för, och
     * meddelandet säger vad som inte stämde och var. Hela kedjan står i
     * loggen, som maskerar chifferhashar.
     */
    logger.error('Räkningen av valsedeln avbröts', { reason: describeErrorChain(error) })
    if (error instanceof TallyAbortedError) {
      return jsonResponse({ status: 'aborted', message: error.message }, 409)
    }
    return errorResponse(
      'INTERNAL',
      'Räkningen kunde inte slutföras, av ett skäl som står i serverloggen. En ny räkning ger ' +
        'räkneverken som redan hunnit sparas, eller räknar från början.',
      500,
    )
  }

  return responseFor(outcome)
}

/** Serverns besked, som de är. */
function responseFor(outcome: TallyOutcome) {
  switch (outcome.status) {
    case 'tallied': {
      const votes = outcome.counts.reduce((sum, count) => sum + count, 0)
      return jsonResponse({
        status: 'tallied',
        counts: outcome.counts,
        votes,
        phase: outcome.phase,
        message:
          outcome.phase === 'TALLIED'
            ? `Valsedeln är räknad, ${votes} röster. Varje valsedel i omröstningen är nu räknad.`
            : `Valsedeln är räknad, ${votes} röster.`,
      })
    }
    case 'needs_more_trustees':
      return jsonResponse(
        {
          status: 'needs_more_trustees',
          have: outcome.have,
          need: outcome.need,
          message:
            `${outcome.have} av ${outcome.need} förtroendepersoner har lämnat sina bidrag. Summan ` +
            'öppnas först när tillräckligt många har gjort det.',
        },
        409,
      )
    case 'wrong_phase':
      return jsonResponse({ status: 'wrong_phase', phase: outcome.phase, message: outcome.message }, 409)
    case 'unknown_ballot':
      return jsonResponse(
        { status: 'unknown_ballot', message: 'Valsedeln finns inte, eller räknas inte i kuvertmodellen.' },
        404,
      )
  }
}
