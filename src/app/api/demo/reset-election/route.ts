import { getAdminSession } from '@/lib/admin-auth'
import { isValidCsrfToken } from '@/lib/csrf'
import { isDemoMode } from '@/lib/demo-mode'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { describeErrorChain, logger } from '@/lib/logger'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, statsRequestSchema } from '@/lib/validation'
import { resetDemoElection } from '@/orchestration/reset-demo-election.usecase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/demo/reset-election
 *
 * Återställer demovalet till OPEN och tömmer urnan, bidragen, räkneverken,
 * markeringarna och de liggande kuverten (uppgift 12c, punkt 7b). Finns bara i
 * demoläget.
 *
 * VARFÖR. Sedan 11d lämnar en stängning som stoppas av valideringen
 * omröstningen i CLOSED, och ingenting i appen går tillbaka till OPEN. I skarpt
 * läge ska det vara så. I demon, också den i Azure, stoppade ett misslyckat
 * försök annars demon för gott.
 *
 * VAD SOM SKYDDAR DEN
 *   – `isDemoMode()` frågas först, och rutten svarar 404 annars, som de andra
 *     demorutterna. Det vaktas av tests/security/api-surface.test.ts.
 *   – den kräver adminsessionen och CSRF-token, som stängningen.
 *   – den återställer bara demovalet, det som seedningen skapar, och vägrar
 *     varje annan omröstning med 403.
 *   – den tar stängningens lås och väntar inte: kör en stängning svarar den 409.
 *
 * Revisionskedjan bryts inte. Återställningen skriver en ny post och raderar
 * ingen gammal.
 */
export async function POST(request: Request) {
  if (!isDemoMode()) {
    return errorResponse('NOT_FOUND', 'Rutten finns inte.', 404)
  }

  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('demo-reset-election', getClientIp(request), RATE_LIMITS.createElection)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många försök.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const session = await getAdminSession()
  if (!session) return errorResponse('UNAUTHORISED', 'Inte inloggad.', 401)

  if (!isValidCsrfToken(request, session.csrfSecret)) {
    return errorResponse('CSRF_FAILED', 'Begäran avvisades.', 403)
  }

  const body = await parseJsonBody(request, statsRequestSchema)
  if (!body.ok) return errorResponse('INVALID_INPUT', body.message, 400)
  if (!body.data.electionId) {
    return errorResponse('INVALID_INPUT', 'Ange vilken omröstning som ska återställas.', 400)
  }

  let outcome: Awaited<ReturnType<typeof resetDemoElection>>
  try {
    outcome = await resetDemoElection(body.data.electionId)
  } catch (error) {
    logger.error('Återställningen av demovalet avbröts', { reason: describeErrorChain(error) })
    return errorResponse(
      'INTERNAL',
      'Återställningen kunde inte slutföras, av ett skäl som står i serverloggen. Läs om fasen och ' +
        'kör återställningen igen.',
      500,
    )
  }

  if (outcome.status === 'unknown_election') {
    return errorResponse('UNKNOWN_ELECTION', 'Omröstningen finns inte.', 404)
  }

  if (outcome.status === 'not_demo_election') {
    return errorResponse('NOT_DEMO_ELECTION', 'Bara demovalet kan återställas. Den här omröstningen rörs inte.', 403)
  }

  if (outcome.status === 'in_progress') {
    return jsonResponse(
      {
        status: 'in_progress',
        message: 'En stängning av omröstningen pågår, och återställningen har inte gjort något. Försök igen när den är klar.',
      },
      409,
    )
  }

  return jsonResponse({
    status: 'reset',
    message: 'Demovalet är återställt: fasen är OPEN och urnan, bidragen, räkneverken och markeringarna är tömda.',
    removed: outcome.removed,
  })
}
