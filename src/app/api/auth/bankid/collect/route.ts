import { setCsrfCookie, setSessionCookie } from '@/lib/cookies'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { collectAuthSchema, parseJsonBody } from '@/lib/validation'
import { bankIdService } from '@/modules/eligibility/bankid'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import { AdmissionQueueFull, admissionStats } from '@/lib/admission-queue'
import { evaluateEligibility } from '@/modules/eligibility/voter-status.service'
import { createVotingSession } from '@/modules/eligibility/voting-session.service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/bankid/collect
 *
 * Frågar efter status för en pågående legitimering. När den är klar kontrolleras
 * röstberättigande, och vid godkänt skapas en röstsession.
 *
 * Detta är den enda endpoint i systemet som hanterar ett personnummer i
 * klartext, och det lämnar aldrig den här funktionen: det går rakt in i
 * `evaluateEligibility`, som hashar det. Det skrivs inte till svaret, inte till
 * loggen och inte till databasen.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    await recordAuditEvent(AUDIT_EVENTS.CSRF_REJECTED)
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('auth-collect', getClientIp(request), RATE_LIMITS.authCollect)
  if (!rate.allowed) {
    await recordAuditEvent(AUDIT_EVENTS.RATE_LIMITED)
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const body = await parseJsonBody(request, collectAuthSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  const result = await bankIdService.collect(body.data.orderRef)

  if (result.status === 'pending') {
    return jsonResponse({ status: 'pending', message: 'Väntar på BankID …' })
  }

  if (result.status === 'failed') {
    await recordAuditEvent(AUDIT_EVENTS.AUTH_FAILED)
    return jsonResponse({
      status: 'failed',
      message:
        result.hintCode === 'userCancel'
          ? 'Legitimeringen avbröts.'
          : 'Legitimeringen misslyckades. Försök igen.',
    })
  }

  /**
   * Identitetshashningen går genom antagningskön och kan avvisas när systemet
   * är verkligen överlastat.
   *
   * Svaret blir då `queued` och inte ett fel. Skillnaden spelar roll: rutten
   * pollas redan, så klienten kan visa "du står i kö" och fortsätta fråga.
   * Ett felmeddelande hade fått väljaren att börja om, vilket ökar lasten
   * precis när den redan är för hög.
   *
   * BankID-ordern lever kvar under väntan, så ingenting behöver göras om.
   */
  let decision
  try {
    decision = await evaluateEligibility(
      result.completionData.personalNumber,
      body.data.electionId,
    )
  } catch (error) {
    if (error instanceof AdmissionQueueFull) {
      const stats = admissionStats()

      return jsonResponse({
        status: 'queued',
        message:
          'Många legitimerar sig samtidigt just nu. Du står i kö — sidan fortsätter ' +
          'att försöka automatiskt.',
        estimatedWaitSeconds: stats.estimatedWaitSeconds,
      })
    }
    throw error
  }

  if (decision.outcome === 'not_in_roll') {
    await recordAuditEvent(AUDIT_EVENTS.NOT_IN_ELECTORAL_ROLL)
    return jsonResponse({
      status: 'rejected',
      reason: 'not_eligible',
      message: 'Du finns inte i röstlängden för det här valet.',
    })
  }

  if (decision.outcome === 'not_eligible') {
    await recordAuditEvent(AUDIT_EVENTS.NOT_ELIGIBLE)
    return jsonResponse({
      status: 'rejected',
      reason: 'not_eligible',
      message: 'Du är inte röstberättigad i det här valet.',
    })
  }

  if (decision.outcome === 'no_ballots') {
    return jsonResponse({
      status: 'rejected',
      reason: 'not_eligible',
      // Inträffar när omröstningen bara innehåller valsedlar för andra
      // kommuner än där personen är folkbokförd.
      message: 'Ingen valsedel i den här omröstningen gäller dig.',
    })
  }

  if (decision.outcome === 'already_voted') {
    await recordAuditEvent(AUDIT_EVENTS.DOUBLE_VOTE_BLOCKED)
    return jsonResponse({
      status: 'rejected',
      reason: 'already_voted',
      // Systemet vet ATT personen röstat. Det vet inte VAD, och kan inte ta
      // reda på det: uppgiften finns i en annan databas utan koppling hit.
      message: 'Du har redan röstat i det här valet.',
    })
  }

  const session = await createVotingSession(decision.voterStatusId, body.data.electionId)
  await recordAuditEvent(AUDIT_EVENTS.AUTH_COMPLETED)
  await recordAuditEvent(AUDIT_EVENTS.VOTING_SESSION_CREATED)

  const response = jsonResponse({
    status: 'complete',
    // Namnet visas för väljaren som bekräftelse på vem som legitimerats. Det
    // lagras inte och kommer från BankID-svaret, inte från röstlängden.
    name: result.completionData.name,
    // Valsedlarna som gäller just den här väljaren, med status per valsedel.
    // Innehåller ingenting om vad som står på dem — bara vilka de är.
    ballots: decision.ballots.map((ballot) => ({
      id: ballot.id,
      kind: ballot.kind,
      label: ballot.label,
      hasVoted: ballot.hasVoted,
    })),
  })

  setSessionCookie(response, session.id)
  setCsrfCookie(response, session.csrfSecret)

  return response
}
