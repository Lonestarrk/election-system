import { getAdminSession, isAdminAuthenticated } from '@/lib/admin-auth'
import { isValidCsrfToken } from '@/lib/csrf'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { describeErrorChain, logger } from '@/lib/logger'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, partialDecryptionRequestSchema } from '@/lib/validation'
import {
  submitPartialDecryption,
  TallyAbortedError,
  type PartialDecryptionOutcome,
} from '@/orchestration/tally.usecase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/elections/decrypt
 *
 * En förtroendeperson lämnar sin fras för en valsedel. Servern låser upp
 * hennes andel i minnet, räknar hennes partiella dekryptering av valsedelns
 * summa, med bevis, och sparar den. Bara valsedelns summa dekrypteras, inte
 * raderna i urnan var för sig. När två förtroendepersoner har lämnat sina
 * bidrag kan valsedeln räknas, se /api/admin/elections/tally.
 *
 * FRASEN LAGRAS ALDRIG OCH LOGGAS ALDRIG AV APPEN. Den lämnas vidare till
 * räkningen på ett enda ställe och står inte i något svar. Att servern ser
 * andelen medan den räknar är en känd begränsning,
 * `server-sees-trustee-share` i src/lib/known-limitations.ts: i ett riktigt
 * val räknar förtroendepersonen på sin egen enhet.
 *
 * VARFÖR EN ADMINSESSION. Frasen autentiserar förtroendepersonen för hennes
 * andel, och adminsessionen och CSRF-skyddet är ett djupförsvar mot gissningar
 * från internet, som för de andra adminrutterna. Administratören kan stoppa
 * en ceremoni, men inte öppna ett resultat utan två förtroendepersoners
 * fraser. I demoläget är fraserna kända, se `demo-trustee-passphrases-known`.
 *
 * TVÅ HASTIGHETSGRÄNSER. Den första gäller adressen och står före
 * inloggningen, så att en ström av begäranden inte når databasen. Den andra
 * gäller förtroendepersonen och står efter tolkningen (ruling 64): det som
 * gissas är en förtroendepersons fras, och den som byter adress för varje
 * försök ska inte få fler försök.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const flood = checkRateLimit('tally-ceremony', getClientIp(request), RATE_LIMITS.tallyCeremony)
  if (!flood.allowed) {
    return errorResponse('RATE_LIMITED', 'För många försök.', 429, {
      'Retry-After': String(flood.retryAfterSeconds),
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

  const body = await parseJsonBody(request, partialDecryptionRequestSchema)
  if (!body.ok) return errorResponse('INVALID_INPUT', body.message, 400)

  const guesses = checkRateLimit(
    'trustee-contribution',
    `förtroendeperson-${body.data.trusteeIndex}`,
    RATE_LIMITS.trusteeContribution,
  )
  if (!guesses.allowed) {
    return errorResponse(
      'RATE_LIMITED',
      'För många försök för den här förtroendepersonen. Vänta en stund och försök igen.',
      429,
      { 'Retry-After': String(guesses.retryAfterSeconds) },
    )
  }

  let outcome: PartialDecryptionOutcome
  try {
    outcome = await submitPartialDecryption(body.data.ballotId, body.data.trusteeIndex, body.data.passphrase)
  } catch (error) {
    /**
     * ETT AVBROTT ÄR ETT BESKED, INTE EN NAKEN 500. Räkningen kastar
     * `TallyAbortedError` när något i röstdatabasen inte stämmer, och dess
     * meddelande säger vad och var, utan fras och utan andel. Hela kedjan
     * står i loggen, som maskerar chifferhashar.
     */
    logger.error('Förtroendepersonens bidrag avbröts', { reason: describeErrorChain(error) })
    if (error instanceof TallyAbortedError) {
      return jsonResponse({ status: 'aborted', message: error.message }, 409)
    }
    return errorResponse(
      'INTERNAL',
      'Bidraget kunde inte tas emot, av ett skäl som står i serverloggen. Ett bidrag som redan ' +
        'hunnit sparas ger beskedet att det är lämnat, så det går att försöka igen.',
      500,
    )
  }

  return responseFor(outcome)
}

/** Serverns besked, som de är. Varje besked säger om något sparades. */
function responseFor(outcome: PartialDecryptionOutcome) {
  switch (outcome.status) {
    case 'accepted':
      return jsonResponse({
        status: 'accepted',
        message:
          'Bidraget är godkänt och sparat. När två förtroendepersoner har lämnat sina bidrag kan ' +
          'valsedeln räknas.',
      })
    case 'duplicate':
      return jsonResponse(
        {
          status: 'duplicate',
          message: 'Förtroendepersonen har redan lämnat sitt bidrag för valsedeln. Ingenting nytt sparades.',
        },
        409,
      )
    case 'wrong_passphrase':
      return jsonResponse(
        {
          status: 'wrong_passphrase',
          message: 'Frasen låste inte upp andelen, och ingenting sparades. Försöket står i revisionsloggen.',
        },
        403,
      )
    case 'rejected':
      return jsonResponse({ status: 'rejected', message: outcome.message }, 422)
    case 'wrong_phase':
      return jsonResponse({ status: 'wrong_phase', phase: outcome.phase, message: outcome.message }, 409)
    case 'unknown_ballot':
      return jsonResponse(
        { status: 'unknown_ballot', message: 'Valsedeln finns inte, eller räknas inte i kuvertmodellen.' },
        404,
      )
    case 'unknown_trustee':
      return jsonResponse(
        { status: 'unknown_trustee', message: 'Förtroendepersonen har ingen andel i omröstningen.' },
        404,
      )
  }
}
