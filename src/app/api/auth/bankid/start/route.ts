import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, startAuthSchema } from '@/lib/validation'
import { bankIdService } from '@/modules/eligibility/bankid'
import { launchUrl, renderQrPng } from '@/modules/eligibility/bankid/qr'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/bankid/start
 *
 * Startar en BankID-legitimering enligt v6 (Secure Start).
 *
 * RUTTEN TAR INTE EMOT NÅGOT PERSONNUMMER, OCH KAN INTE GÖRA DET.
 *
 * BankID v6 tillåter inte flöden där användaren skriver in sitt personnummer.
 * Legitimeringen startas i stället av väljaren själv, på sin egen enhet:
 * antingen genom att skanna den animerade QR-koden, eller genom att
 * autostart-token öppnar BankID-appen lokalt.
 *
 * Det tar bort en svaghet den tidigare versionen hade. Den gamla rutten
 * svarade medvetet likadant oavsett om personnumret fanns i röstlängden eller
 * inte — men den tog ändå emot godtyckliga personnummer från vem som helst.
 * Nu finns ingenting att mata in: personnumret kommer först i BankID:s svar,
 * efter att personen bevisat vem hen är.
 *
 * SVARET INNEHÅLLER INTE qrStartSecret.
 *
 * BankID:s specifikation anger att hemligheten bara delas mellan BankID och
 * den anropande tjänsten. Nådde den klienten kunde vem som helst räkna fram
 * giltiga koder för ordern i all framtid, och animeringen vore verkningslös.
 * Klienten hämtar i stället färdiga koder från /api/auth/bankid/qr, en per
 * sekund.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    await recordAuditEvent(AUDIT_EVENTS.CSRF_REJECTED)
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  // IP-adressen används till hastighetsbegränsning, och hashas inuti
  // rate-limit-modulen. Den skickas dessutom vidare till BankID som
  // `endUserIp`, vilket deras API kräver för sin riskbedömning — men den
  // lagras aldrig och loggas aldrig här.
  const clientIp = getClientIp(request)

  const rate = checkRateLimit('auth-start', clientIp, RATE_LIMITS.authStart)
  if (!rate.allowed) {
    await recordAuditEvent(AUDIT_EVENTS.RATE_LIMITED)
    return errorResponse('RATE_LIMITED', 'För många försök. Försök igen om en stund.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const body = await parseJsonBody(request, startAuthSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  const order = await bankIdService.auth({
    endUserIp: clientIp,
    /**
     * Texten visas i BankID-appen innan personen skriver sin kod.
     *
     * Att den säger vad legitimeringen gäller är ett skydd mot att någon blir
     * lurad att signera något annat: den som ringts upp och ombetts "verifiera
     * sig" ser här att det handlar om att rösta.
     */
    userVisibleData: body.data.purpose === 'admin'
      ? 'Legitimering för valadministration'
      : 'Legitimering för att rösta',
  })

  await recordAuditEvent(AUDIT_EVENTS.AUTH_STARTED)

  const initialQr = await bankIdService.qrData(order.orderRef)

  return jsonResponse({
    orderRef: order.orderRef,
    /**
     * Två URL:er, eftersom plattformarna kräver olika former. iOS behöver
     * universal link-varianten; Safari följer inte app-schemat i alla
     * sammanhang. Klienten väljer utifrån sin egen user agent — servern ska
     * inte behöva gissa enhet utifrån en header som går att sätta fritt.
     */
    launchUrls: {
      ios: launchUrl(order.autoStartToken, 'ios'),
      other: launchUrl(order.autoStartToken, 'other'),
    },
    /** Första QR-koden. Därefter hämtas nya från /api/auth/bankid/qr. */
    qrImage: initialQr ? await renderQrPng(initialQr.qrData) : null,
  })
}
