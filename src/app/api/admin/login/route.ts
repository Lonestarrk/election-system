import type { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { ADMIN_COOKIE, setAdminCookie, setCsrfCookie } from '@/lib/cookies'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { adminLoginSchema, parseJsonBody } from '@/lib/validation'
import { bankIdService } from '@/modules/eligibility/bankid'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import {
  createAdminSession,
  destroyAdminSession,
} from '@/modules/eligibility/admin-session.service'
import { identifyAdmin } from '@/modules/eligibility/voter-status.service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/login
 *
 * Loggar in en administratör med BankID.
 *
 * Legitimeringen startas med samma /api/auth/bankid/start som en väljare
 * använder — den kontrollerar medvetet ingenting om personen, så att den inte
 * kan användas som uppslagsverk. Här hämtas resultatet och kontrolleras mot
 * adminflaggan i röstlängden.
 *
 * ADMINSKAP KAN INTE TILLDELAS HÄRIFRÅN. Flaggan sätts genom seed eller direkt
 * i databasen. En självbetjäningsväg till adminbehörighet vore den enskilt
 * farligaste knappen i systemet, och den finns inte.
 *
 * Personnumret passerar aldrig den här rutten. Det lämnades vid start och
 * finns bara i BankID-svaret, som går rakt in i `identifyAdmin` och hashas
 * där.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    await recordAuditEvent(AUDIT_EVENTS.CSRF_REJECTED)
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  /**
   * TVÅ OLIKA GRÄNSER FÖR TVÅ OLIKA SAKER.
   *
   * Den här rutten POLLAR BankID-statusen — den anropas flera gånger per
   * inloggning, inte en gång. En gräns avsedd för inloggningsförsök gör då att
   * andra inloggningen låses ut, eftersom den första redan förbrukat
   * utrymmet på att fråga "är du klar?".
   *
   * Pollningen får därför en generös gräns, precis som väljarsidans
   * /api/auth/bankid/collect. Den strama gränsen flyttas till att räkna
   * FALLERADE inloggningar längre ner, vilket är det som faktiskt ska
   * begränsas: den som prövar sig fram mot adminvyn.
   */
  const pollRate = checkRateLimit('admin-poll', getClientIp(request), RATE_LIMITS.authCollect)
  if (!pollRate.allowed) {
    await recordAuditEvent(AUDIT_EVENTS.RATE_LIMITED)
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(pollRate.retryAfterSeconds),
    })
  }

  const body = await parseJsonBody(request, adminLoginSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  const result = await bankIdService.collect(body.data.orderRef)

  if (result.status === 'pending') {
    return jsonResponse({ status: 'pending', message: 'Väntar på BankID …' })
  }

  if (result.status === 'failed') {
    await recordAuditEvent(AUDIT_EVENTS.ADMIN_LOGIN_FAILED)
    return jsonResponse({
      status: 'failed',
      message:
        result.hintCode === 'userCancel'
          ? 'Legitimeringen avbröts.'
          : 'Legitimeringen misslyckades. Försök igen.',
    })
  }

  const identification = await identifyAdmin(result.completionData.personalNumber)

  if (identification.outcome !== 'admin') {
    /**
     * Här, och bara här, räknas försöket.
     *
     * Gränsen förbrukas av MISSLYCKADE inloggningar. Den som legitimerar sig
     * med ett giltigt BankID och saknar adminflaggan kan alltså pröva fem
     * personnummer på fem minuter — inte hundra. Den som lyckas påverkas inte
     * alls, eftersom raden nedan aldrig nås vid ett godkänt försök.
     */
    const attemptRate = checkRateLimit(
      'admin-login-failed',
      getClientIp(request),
      RATE_LIMITS.adminLogin,
    )

    if (!attemptRate.allowed) {
      await recordAuditEvent(AUDIT_EVENTS.RATE_LIMITED)
      return errorResponse('RATE_LIMITED', 'För många försök.', 429, {
        'Retry-After': String(attemptRate.retryAfterSeconds),
      })
    }

    // SAMMA SVAR OAVSETT ORSAK.
    //
    // "Du finns inte i röstlängden" och "du är inte administratör" skulle
    // tillsammans göra rutten till ett uppslagsverk: den som har ett giltigt
    // BankID kunde ta reda på vilka personer som är administratörer, vilket är
    // första steget mot att rikta ett angrepp mot rätt person.
    //
    // Revisionsloggen skiljer däremot på fallen, eftersom mönstret spelar roll
    // vid en granskning. Raden säger fortfarande inte vem.
    await recordAuditEvent(
      identification.outcome === 'not_admin'
        ? AUDIT_EVENTS.ADMIN_ACCESS_DENIED
        : AUDIT_EVENTS.ADMIN_LOGIN_FAILED,
    )

    return jsonResponse({
      status: 'rejected',
      message: 'Du har inte behörighet till administrationen.',
    })
  }

  const session = await createAdminSession(identification.voterStatusId)
  await recordAuditEvent(AUDIT_EVENTS.ADMIN_LOGIN_SUCCEEDED)

  const response = jsonResponse({
    status: 'complete',
    // Namnet kommer från BankID-svaret, inte från röstlängden, och lagras inte.
    name: result.completionData.name,
  })

  setAdminCookie(response, session.id)
  setCsrfCookie(response, session.csrfSecret)

  return response as NextResponse
}

/**
 * DELETE /api/admin/login
 *
 * Loggar ut. Sessionsraden raderas, inte bara cookien — en session som lever
 * kvar i databasen efter utloggning är en session som fortfarande går att
 * använda för den som fått tag i cookievärdet.
 */
export async function DELETE(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('admin-logout', getClientIp(request), RATE_LIMITS.adminLogin)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många försök.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const cookieStore = await cookies()
  const sessionId = cookieStore.get(ADMIN_COOKIE)?.value

  if (sessionId) {
    await destroyAdminSession(sessionId)
  }

  const response = jsonResponse({ status: 'logged_out' })
  response.cookies.delete(ADMIN_COOKIE)

  return response
}
