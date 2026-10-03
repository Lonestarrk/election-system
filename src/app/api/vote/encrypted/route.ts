import { cookies } from 'next/headers'
import { clearVotingCookies, SESSION_COOKIE } from '@/lib/cookies'
import { isValidCsrfToken } from '@/lib/csrf'
import {
  VerificationAborted,
  VerificationQueueFull,
  reserveVerification,
} from '@/lib/crypto/server'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { getOrder, takeOrder } from '@/lib/order-state'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { castEncryptedBallotSchema, parseJsonBody } from '@/lib/validation'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import { bankIdService } from '@/modules/eligibility/bankid'
import { castEncryptedBallot, type CastOutcome } from '@/modules/eligibility/pending-vote.service'
import { getValidVotingSession } from '@/modules/eligibility/voting-session.service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/vote/encrypted
 *
 * Andra halvan av det tvådelade signeringsflödet: lägger den krypterade
 * valsedeln, med signaturen hämtad från BankID i stället för från begäran.
 *
 * KROPPEN ÄR BARA `orderRef` (uppgift 14e).
 *
 * Röstsidan frågar den här rutten varannan sekund tills BankID är klart.
 * Valsedeln lämnades förut med varje fråga, omkring 170 kB. Nu lämnar
 * /api/vote/sign-start den en gång, och servern håller den med ordern i
 * orderlagret (src/lib/order-state.ts), bunden till väljarens session. En
 * order som saknas, har förfallit eller hör till en annan session ger samma
 * svar, och BankID frågas då inte.
 *
 * SIGNATUREN OCH CERTIFIKATKEDJAN FÅR ALDRIG KOMMA FRÅN BEGÄRANS KROPP.
 *
 * Sedan uppgift 14f prövas kedjan mot BankID:s rot, så ett eget nyckelpar med
 * ett påhittat certifikat underkänns också om en klient skickar in det. Att
 * rutten ändå aldrig tar emot dem är en andra spärr, och den är billig: den
 * som hittar ett fel i kedjeprövningen ska inte också få välja vad som prövas.
 * `castEncryptedBallotSchema` har därför inget fält för dem, och Zod stryper
 * okända fält som standard, så de försvinner redan vid valideringen om en
 * klient ändå skickar med dem.
 *
 * Servern hämtar i stället `signature`, `certificateChain` OCH `signedData` ur
 * sitt eget `bankIdService.collect(orderRef)` — svaret BankID gav för just
 * den order `/api/vote/sign-start` startade. `castSequence` läses ur
 * `signedData` av `castEncryptedBallot` självt (se `SignedEnvelope`s
 * dokumentation för varför den INTE räknas fram på nytt här — det var
 * precis den bugg fixrunda 1 av granskningen fångade), och
 * `electionId`/`voterStatusId` kommer från röstsessionen. Ingenting som
 * ingår i den signerade nyttolasten kommer från något klienten påstår.
 *
 * OMRÖSTNINGENS KRYPTERINGSNYCKEL OCH ANTAL ALTERNATIV HÄMTAS HÄR.
 *
 * `castEncryptedBallot` bor i väljarmodulen och får aldrig importera från den
 * anonyma röstmodulen (tests/security/module-boundaries.test.ts). Den
 * uppgiften finns bara på den anonyma sidan, så rutten — som får se båda
 * modulerna — hämtar den via `getEncryptedBallotShape` och skickar med den.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    await recordAuditEvent(AUDIT_EVENTS.CSRF_REJECTED)
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit(
    'vote-encrypted',
    getClientIp(request),
    RATE_LIMITS.castEncryptedBallot,
  )
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

  const body = await parseJsonBody(request, castEncryptedBallotSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  const { orderRef } = body.data

  /**
   * KÖN RESERVERAR SIN PLATS INNAN BANKID-ORDERN HÄMTAS (uppgift 14e).
   *
   * Ordern förbrukas när den hämtas. Avvisades valsedeln först efteråt, för att
   * verifieringskön var full, hade väljaren fått skriva under en gång till. Här
   * lever ordern kvar, så svaret blir `queued`, som när BankID ännu inte är
   * klart, och röstsidan frågar igen vid nästa varv. 503 säger samma sak till
   * den som bara läser statusraden.
   *
   * Det räcker inte att fråga om kön är full. Mellan frågan och verifieringen
   * hämtas BankID-ordern och omröstningen läses, och när en plats var kvar
   * klarade fem samtidiga röster frågan: fyra fick kön full först efter att
   * deras order förbrukats. Platsen RESERVERAS därför här, och verifieringen
   * tar över den. Reservationen släpps i `finally` på varje väg ut: svar,
   * fel och avbrott.
   */
  const reservation = reserveVerification()
  if (!reservation) {
    return jsonResponse(
      { status: 'queued', message: 'Många röstar just nu. Rösten prövas så fort det finns plats.' },
      503,
      { 'Retry-After': '1' },
    )
  }

  try {
    /**
     * VALSEDELN HÅLLS AV SERVERN, BUNDEN TILL SESSIONEN.
     *
     * Ordern lades av /api/vote/sign-start, med valsedeln. En order som saknas
     * eller tillhör en annan session ger samma svar, och BankID frågas då inte:
     * annars hade en annan väljare kunnat förbruka ordern. En order som saknas
     * har förfallit, eller servern har startat om, och väljaren får skriva under
     * igen.
     */
    if (!getOrder(orderRef, sessionId)) {
      return jsonResponse({
        status: 'failed',
        message: 'Signeringen gick inte att slutföra, och rösten lades inte. Försök igen.',
      })
    }

    const collected = await bankIdService.collect(orderRef)

    if (collected.status === 'pending') {
      return jsonResponse({ status: 'pending', message: 'Väntar på BankID …' })
    }

    // Ordern är förbrukad hos BankID, klar eller misslyckad, och valsedeln
    // hålls inte längre. En order kan bara förbrukas en gång.
    const order = takeOrder(orderRef, sessionId)

    if (collected.status === 'failed' || !order) {
      return jsonResponse({
        status: 'failed',
        message:
          collected.status === 'failed' && collected.hintCode === 'userCancel'
            ? 'Signeringen avbröts.'
            : 'Signeringen misslyckades. Försök igen.',
      })
    }

    const shape = await getEncryptedBallotShape(order.ballotId)

    let outcome: CastOutcome
    try {
      outcome = await castEncryptedBallot(
        session.voterStatusId,
        session.electionId,
        order.ballotId,
        order.ballot,
        {
          // ENDAST FRÅN BANKID:S EGET SVAR — se dokumentationen ovan.
          signature: collected.completionData.signature,
          certificateChain: collected.completionData.certificateChain,
          signedData: collected.completionData.signedData,
        },
        shape,
        request.signal,
        reservation,
      )
    } catch (error) {
      /**
       * Kön fylldes ändå, och ordern är redan förbrukad. Det kan hända när
       * andra uppgifter än besökare, som valideringen före stängningen, tar
       * platser. Svaret säger rakt ut att rösten inte lades, i stället för
       * `queued`, som hade fått röstsidan att vänta på en order som inte finns
       * längre.
       */
      if (error instanceof VerificationQueueFull) {
        return errorResponse(
          'BUSY',
          'Servern har för mycket att göra just nu, och rösten lades inte. Försök igen om en stund.',
          503,
          { 'Retry-After': '5' },
        )
      }
      /**
       * Besökaren gav upp, och ingenting lades. Ingen läser svaret, men det ska
       * inte bli ett serverfel i loggen. 499 är den vedertagna koden för en
       * begäran som klienten stängde.
       */
      if (error instanceof VerificationAborted) {
        return errorResponse('CLIENT_CLOSED', 'Begäran avbröts innan rösten lades.', 499)
      }
      throw error
    }

    return jsonResponse(outcome, httpStatusFor(outcome.status))
  } finally {
    reservation.release()
  }
}

/**
 * Rösten avslöjar aldrig VARFÖR den avvisades i sin HTTP-statuskod mer än
 * grovt — svarskroppen bär redan `status`, och den detaljerade texten hör
 * inte hemma här. Koderna följer ändå HTTP:s allmänna betydelse, så att
 * proxyar och loggverktyg som bara tittar på statusraden inte vilseleds.
 */
function httpStatusFor(status: CastOutcome['status']): number {
  switch (status) {
    case 'recorded':
      return 200
    case 'closed':
    case 'wrong_mode':
    case 'stale_sequence':
    case 'voted_in_old_flow':
      return 409
    case 'invalid_proof':
      return 400
    case 'invalid_signature':
    case 'not_eligible':
      return 403
  }
}
