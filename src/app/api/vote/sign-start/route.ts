import { cookies } from 'next/headers'
import { env } from '@/lib/env'
import { clearVotingCookies, SESSION_COOKIE } from '@/lib/cookies'
import { isValidCsrfToken } from '@/lib/csrf'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, signStartSchema } from '@/lib/validation'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import { bankIdService } from '@/modules/eligibility/bankid'
import { envelopePayload } from '@/modules/eligibility/bankid/envelope-signature'
import { launchUrl, renderQrPng } from '@/modules/eligibility/bankid/qr'
import { ballotBelongsToElection } from '@/modules/eligibility/election.service'
import { nextCastSequence } from '@/modules/eligibility/pending-vote.service'
import { getValidVotingSession } from '@/modules/eligibility/voting-session.service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/vote/sign-start
 *
 * Första halvan av det tvådelade signeringsflödet: startar en BankID
 * /sign-order över det yttre kuvertets nyttolast.
 *
 * SERVERN BYGGER NYTTOLASTEN SJÄLV, AV EGNA VÄRDEN.
 *
 * Klienten skickar bara `ballotId` och hashen över det chiffer hon just
 * krypterat i webbläsaren — aldrig `castSequence`. Räknaren räknas fram HÄR,
 * av `nextCastSequence`, och läggs i `userNonVisibleData` innan BankID-appen
 * någonsin ser den. Fick klienten sätta räknaren kunde den ange ett
 * godtyckligt högt tal och senare spela upp ett äldre, lägre kuvert — hela
 * återuppspelningsspärren i `castEncryptedBallot` bygger på att räknaren
 * kommer från servern, inte från begäran.
 *
 * `electionId` och `voterStatusId` kommer från röstsessionen, aldrig från
 * kroppen — annars kunde vem som helst be servern signera ett kuvert åt en
 * annan väljares session.
 *
 * Andra halvan, /api/vote/encrypted, hämtar den färdiga signaturen och
 * certifikatet från BankID:s eget svar och verifierar mot exakt den här
 * nyttolasten — se den ruttens dokumentation.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    await recordAuditEvent(AUDIT_EVENTS.CSRF_REJECTED)
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const clientIp = getClientIp(request)

  const rate = checkRateLimit('vote-sign-start', clientIp, RATE_LIMITS.castVote)
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

  const body = await parseJsonBody(request, signStartSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  if (!(await ballotBelongsToElection(body.data.ballotId, session.electionId))) {
    return errorResponse('INVALID_BALLOT', 'Valsedeln gäller inte den här omröstningen.', 400)
  }

  const castSequence = await nextCastSequence(session.voterStatusId, body.data.ballotId)

  const order = await bankIdService.sign({
    endUserIp: clientIp,
    // Texten visas i BankID-appen innan väljaren skriver sin kod — ett skydd
    // mot att bli lurad att signera något annat än man tror.
    userVisibleData: 'Bekräfta din röst',
    // Osynligt fält: valsedeln, chifferhashen och räknaren. Det som binder
    // signaturen till precis den här rösten och precis det här tillfället.
    userNonVisibleData: envelopePayload({
      electionId: session.electionId,
      ballotId: body.data.ballotId,
      ciphertextHash: body.data.ciphertextHash,
      castSequence,
    }),
  })

  const origin = request.headers.get('origin')
  const baseOrigin = origin && env.appOrigins.includes(origin) ? origin : env.appOrigins[0]!
  const returnUrl = `${baseOrigin}/vote`

  const initialQr = await bankIdService.qrData(order.orderRef)

  return jsonResponse({
    orderRef: order.orderRef,
    launchUrls: {
      ios: launchUrl(order.autoStartToken, 'ios', returnUrl),
      other: launchUrl(order.autoStartToken, 'other', returnUrl),
    },
    qrImage: initialQr ? await renderQrPng(initialQr.qrData) : null,
  })
}
