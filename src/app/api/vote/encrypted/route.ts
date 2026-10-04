import { cookies } from 'next/headers'
import { clearVotingCookies, SESSION_COOKIE } from '@/lib/cookies'
import { isValidCsrfToken } from '@/lib/csrf'
import {
  VerificationAborted,
  VerificationQueueFull,
  reserveVerification,
} from '@/lib/crypto/server'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { attachCompletion, getOrder, takeOrder } from '@/lib/order-state'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { castEncryptedBallotSchema, parseJsonBody } from '@/lib/validation'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { AUDIT_EVENTS, recordAuditEvent, recordRejectedOrigin } from '@/modules/eligibility/audit.service'
import { bankIdService } from '@/modules/eligibility/bankid'
import { collectErrorReply, failedReply, pendingReply } from '@/modules/eligibility/bankid/replies'
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
 * Servern hämtar i stället `signature` OCH `ocspResponse` ur sitt eget
 * `bankIdService.collect(orderRef)` — svaret BankID gav för just den order
 * `/api/vote/sign-start` startade. Underskriften är BankID:s XML-dokument, med
 * kedjan och det signerade inbäddade (uppgift 17b). `castSequence` läses ur det
 * signerade av `castEncryptedBallot` självt (se `SignedEnvelope`s
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
  // Posten om fel Origin har en egen gräns per adress (helgrensgranskningen, ruling 145).
  if (!hasValidOrigin(request)) {
    await recordRejectedOrigin(request)
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit(
    'vote-encrypted',
    getClientIp(request),
    RATE_LIMITS.castEncryptedBallot,
  )
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

  const body = await parseJsonBody(request, castEncryptedBallotSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  const { orderRef } = body.data

  /**
   * VALSEDELN HÅLLS AV SERVERN, BUNDEN TILL SESSIONEN.
   *
   * Ordern lades av /api/vote/sign-start, med valsedeln. En order som saknas
   * eller tillhör en annan session ger samma svar, och BankID frågas då inte:
   * annars hade en annan väljare kunnat förbruka ordern. En order som saknas
   * har förfallit, eller servern har startat om, och väljaren får skriva under
   * igen.
   */
  const held = getOrder(orderRef, sessionId)
  if (!held) {
    return jsonResponse({
      status: 'failed',
      message: 'Signeringen gick inte att slutföra, och rösten lades inte. Försök igen.',
    })
  }

  /**
   * BANKID FRÅGAS, OCH KÖN RÖRS BARA OM ORDERN ÄR KLAR (fixrunda 1).
   *
   * Ordern förbrukas när den hämtas. Avvisades valsedeln först efteråt, för att
   * verifieringskön var full, hade väljaren fått skriva under en gång till. Förut
   * reserverades därför en plats i kön före frågan, under varje pollning, också
   * de som bara fick `pending`: fler än 22 pollningar i flygning gav `queued`
   * fast ingen verifierade.
   *
   * Nu frågar rutten BankID först. Är ordern inte klar rörs kön aldrig. Är den
   * klar reserveras platsen, och är kön full läggs det insamlade svaret i
   * orderlagret och svaret blir `queued`: nästa pollning hittar svaret och
   * hoppar över BankID. Ordern är förbrukad hos BankID men väljaren slipper
   * skriva under igen.
   */
  let completion = held.completion
  if (!completion) {
    /**
     * Ett fel från BankID (uppgift 17c). Ett tillfälligt fel, nätet, en tidsgräns
     * eller maintenance, avslutar inte ordern: svaret är pending och nästa pollning
     * frågar igen (fixrunda 1). Varje annat fel avslutar ordern, eftersom BankID
     * säger att samma anrop inte ska göras igen. Då släpps valsedeln, ordern avbryts
     * hos BankID, och väljaren får BankID:s text för felet. Andra fel kastas vidare.
     */
    let collected
    try {
      collected = await bankIdService.collect(orderRef)
    } catch (error) {
      const reply = collectErrorReply(error, () => bankIdService.cancel(orderRef))
      if (!reply) throw error
      if (reply.ended) takeOrder(orderRef, sessionId)
      return reply.response
    }

    // BankID:s rekommenderade texter för varje hintCode, se src/lib/bankid-messages.ts.
    if (collected.status === 'pending') {
      return jsonResponse(pendingReply(collected.hintCode))
    }

    if (collected.status === 'failed') {
      // Ordern är förbrukad hos BankID, och valsedeln hålls inte längre.
      takeOrder(orderRef, sessionId)
      return jsonResponse(failedReply(collected.hintCode))
    }

    // ENDAST FRÅN BANKID:S EGET SVAR — se dokumentationen ovan.
    completion = {
      signature: collected.completionData.signature,
      ocspResponse: collected.completionData.ocspResponse,
    }
  }

  const reservation = reserveVerification()
  if (!reservation) {
    // Kunde svaret inte sparas har ordern förfallit eller tagits bort under tiden. Då
    // finns inget att vänta på, och `queued` hade låtit sidan fråga en order som inte finns.
    if (!attachCompletion(orderRef, sessionId, completion)) {
      return jsonResponse({
        status: 'failed',
        message: 'Signeringen gick inte att slutföra, och rösten lades inte. Försök igen.',
      })
    }
    return queuedResponse()
  }

  // Ordern tas ur lagret på varje väg utom en: kön fylldes under verifieringen, och
  // svaret ligger kvar med sitt ursprungliga förfall.
  let keepOrder = false
  const order = held

  try {
    const shape = await getEncryptedBallotShape(order.ballotId)

    let outcome: CastOutcome
    try {
      outcome = await castEncryptedBallot(
        session.voterStatusId,
        session.electionId,
        order.ballotId,
        order.ballot,
        // Saltet ur ordern, aldrig ur begäran: det har aldrig lämnat servern.
        { ...completion, commitmentSalt: order.commitmentSalt },
        shape,
        request.signal,
        reservation,
      )
    } catch (error) {
      /**
       * Kön fylldes ändå. Det kan hända när andra uppgifter än besökare, som
       * valideringen före stängningen, tar platser. Svaret och valsedeln läggs
       * tillbaka, och svaret blir `queued`: nästa pollning prövar igen utan ny
       * underskrift.
       */
      if (error instanceof VerificationQueueFull) {
        keepOrder = attachCompletion(orderRef, sessionId, completion)
        if (!keepOrder) {
          return jsonResponse({
            status: 'failed',
            message: 'Signeringen gick inte att slutföra, och rösten lades inte. Försök igen.',
          })
        }
        return queuedResponse()
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
    if (!keepOrder) takeOrder(orderRef, sessionId)
    reservation.release()
  }
}

function queuedResponse() {
  return jsonResponse(
    { status: 'queued', message: 'Många röstar just nu. Rösten prövas så fort det finns plats.' },
    503,
    { 'Retry-After': '1' },
  )
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
      return 409
    case 'invalid_proof':
      return 400
    case 'invalid_signature':
    case 'not_eligible':
      return 403
    // Serverns tak är för snålt, och felet är serverns (fixrunda 1 av 17b).
    case 'signature_too_large':
      return 500
  }
}
