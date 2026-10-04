import { cookies } from 'next/headers'
import { env } from '@/lib/env'
import { clearVotingCookies, SESSION_COOKIE } from '@/lib/cookies'
import { isValidCsrfToken } from '@/lib/csrf'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { hashCiphertext } from '@/lib/crypto/verify-ballot'
import { putOrder } from '@/lib/order-state'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, signStartSchema } from '@/lib/validation'
import { AUDIT_EVENTS, recordAuditEvent, recordRejectedOrigin } from '@/modules/eligibility/audit.service'
import { bankIdService } from '@/modules/eligibility/bankid'
import { startErrorReply } from '@/modules/eligibility/bankid/replies'
import {
  ciphertextCommitment,
  envelopePayload,
  newCommitmentSalt,
  signingText,
} from '@/modules/eligibility/bankid/envelope-signature'
import { launchUrl, renderQrPng } from '@/modules/eligibility/bankid/qr'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { signingSubject } from '@/modules/eligibility/election.service'
import { castWindow, nextCastSequence } from '@/modules/eligibility/pending-vote.service'
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
 * Klienten skickar `ballotId`, den krypterade valsedeln och hashen över den —
 * aldrig `castSequence`. Räknaren räknas fram HÄR,
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
 * VALSEDELN SKICKAS HIT, EN GÅNG, OCH SERVERN HÅLLER DEN MED ORDERN.
 *
 * Förut bar varje pollning av /api/vote/encrypted hela valsedeln, omkring
 * 170 kB varannan sekund. Nu lägger den här rutten valsedeln i orderlagret
 * (src/lib/order-state.ts), bunden till väljarens session, och pollningen bär
 * bara `orderRef`. Hashen i begäran måste vara valsedelns egen: det som
 * signeras är ett saltat åtagande om hashen (uppgift 11e), och en valsedel med
 * en annan hash hade bara fått rösten avvisad efter att väljaren skrivit under.
 *
 * FORMEN PRÖVAS HÄR, INNAN BANKID-ORDERN SKAPAS (fixrunda 1). Servern hämtar
 * omröstningens form, kräver att antalet chiffer är valsedelns antal alternativ
 * och räknar om hashen ur chiffret. Det är samma prövning som vid läggningen,
 * minus bevisen, som kostar en halv sekund. Utan den kunde väljaren skriva under
 * en valsedel som avvisas efteråt, och en order kunde hålla en valsedel större än
 * omröstningens, som lagret räknar minnet efter.
 *
 * BANKID FÅR ETT ÅTAGANDE, INTE CHIFFERHASHEN (uppgift 11e). BankID sparar det
 * väljaren skriver under, med hennes identitet. Bar det chifferhashen hade
 * kopplingen mellan väljaren och chiffret funnits kvar hos BankID efter
 * raderingen, eftersom hashen står i urnan. Det signerade bär därför
 * `ciphertextCommitment(hash, salt)`, med ett salt som skapas här, hålls med
 * ordern i orderlagret och sparas i `PendingVote` när rösten läggs. Saltet går
 * aldrig till klienten eller till BankID och loggas inte, och det raderas med
 * raden vid skalningen. Texten i appen säger vad som skrivs under, utan hashen
 * och utan åtagandet.
 *
 * Andra halvan, /api/vote/encrypted, hämtar den färdiga signaturen och
 * certifikatkedjan från BankID:s eget svar och verifierar mot exakt den här
 * nyttolasten — se den ruttens dokumentation.
 */
export async function POST(request: Request) {
  // Posten om fel Origin har en egen gräns per adress (helgrensgranskningen, ruling 145).
  if (!hasValidOrigin(request)) {
    await recordRejectedOrigin(request)
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const clientIp = getClientIp(request)

  const rate = checkRateLimit('vote-sign-start', clientIp, RATE_LIMITS.signStart)
  if (!rate.allowed) {
    if (rate.firstRejection) await recordAuditEvent(AUDIT_EVENTS.RATE_LIMITED)
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

  // Fasen, closesAt och läget innan BankID får en order (B8). Läggningen prövar dem igen.
  const window = await castWindow(session.electionId)
  if (window === 'closed') {
    return errorResponse('VOTING_CLOSED', 'Röstningen har stängt, och ingen röst kan läggas.', 409)
  }
  if (window === 'wrong_mode') {
    return errorResponse('WRONG_MODE', 'Omröstningen hör inte till det läge servern kör i.', 409)
  }

  const subject = await signingSubject(body.data.ballotId, session.electionId)
  if (!subject) {
    return errorResponse('INVALID_BALLOT', 'Valsedeln gäller inte den här omröstningen.', 400)
  }

  if (body.data.ballot.ciphertextHash !== body.data.ciphertextHash) {
    return errorResponse('INVALID_INPUT', 'Valsedelns hash stämmer inte.', 400)
  }

  const shape = await getEncryptedBallotShape(body.data.ballotId)
  if (!shape) {
    return errorResponse('INVALID_BALLOT', 'Valsedeln kan inte ta emot en krypterad röst.', 400)
  }
  if (body.data.ballot.ciphertext.length !== shape.optionCount) {
    return errorResponse('INVALID_BALLOT', 'Valsedeln har fel antal alternativ.', 400)
  }
  // Hashen täcker chiffret men inte bevisen. Ett bevis per alternativ, annars avvisas
  // valsedeln vid läggningen, efter att väljaren skrivit under.
  if (body.data.ballot.proofs.components.length !== shape.optionCount) {
    return errorResponse('INVALID_BALLOT', 'Valsedeln har fel antal bevis.', 400)
  }
  if (hashCiphertext(body.data.ballot.ciphertext) !== body.data.ballot.ciphertextHash) {
    return errorResponse('INVALID_BALLOT', 'Valsedelns hash stämmer inte med chiffret.', 400)
  }

  const castSequence = await nextCastSequence(session.voterStatusId, body.data.ballotId)

  // Hashen är prövad ovan, så åtagandet går alltid att räkna här.
  const commitmentSalt = newCommitmentSalt()
  const commitment = ciphertextCommitment(body.data.ballot.ciphertextHash, commitmentSalt)
  if (!commitment) {
    return errorResponse('INVALID_BALLOT', 'Valsedelns hash stämmer inte med chiffret.', 400)
  }

  // Ett fel från BankID ger BankID:s text för felet (uppgift 17c), och inget läggs i lagret.
  let order
  try {
    order = await bankIdService.sign({
      endUserIp: clientIp,
      // Texten visas i BankID-appen innan väljaren skriver sin kod — ett skydd
      // mot att bli lurad att signera något annat än man tror.
      userVisibleData: signingText(subject.electionName, subject.ballotKind, subject.ballotLabel),
      // Osynligt fält: valsedeln, åtagandet över chifferhashen och räknaren. Det
      // som binder signaturen till precis den här rösten och precis det här
      // tillfället, utan att BankID får något som går att matcha mot urnan.
      userNonVisibleData: envelopePayload({
        electionId: session.electionId,
        ballotId: body.data.ballotId,
        ciphertextCommitment: commitment,
        castSequence,
      }),
    })
  } catch (error) {
    const reply = startErrorReply(error)
    if (!reply) throw error
    return reply
  }

  // Lagret är fullt: ordern hos BankID avbryts, så att ingen order ligger kvar
  // som väljaren aldrig får veta något om. Ingenting har signerats ännu.
  const stored = putOrder(order.orderRef, sessionId, {
    ballotId: body.data.ballotId,
    ballot: body.data.ballot,
    commitmentSalt,
  })
  if (!stored) {
    // Avbrottet är en artighet mot BankID. Misslyckas det går ordern ut av sig själv,
    // och väljaren ska ändå få veta att rösten inte lades.
    await bankIdService.cancel(order.orderRef).catch(() => undefined)
    return errorResponse(
      'BUSY',
      'Servern har för mycket att göra just nu, och rösten lades inte. Försök igen om en stund.',
      503,
      { 'Retry-After': '5' },
    )
  }

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
