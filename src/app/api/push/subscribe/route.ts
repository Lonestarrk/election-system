import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, pushSubscriptionSchema, pushUnsubscribeSchema } from '@/lib/validation'
import { isPushConfigured, publicVapidKey, removeSubscription, saveSubscription } from '@/modules/notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/push/subscribe
 *
 * Den publika VAPID-nyckeln, som webbläsaren behöver för att kunna skapa en
 * prenumeration. Den är publik per definition — den identifierar avsändaren
 * mot push-tjänsterna och är värdelös utan sin privata halva.
 */
export async function GET() {
  return jsonResponse({
    enabled: isPushConfigured(),
    publicKey: publicVapidKey(),
  })
}

/**
 * POST /api/push/subscribe
 *
 * Sparar en enhets prenumeration på notiser om nya omröstningar.
 *
 * INGEN KOPPLING TILL EN IDENTITET, OCH RUTTEN KRÄVER INGEN INLOGGNING.
 *
 * Det är avsiktligt i båda riktningarna. Kräver man legitimering för att
 * prenumerera vet systemet vem som äger vilken enhet — och en push-endpoint är
 * i praktiken en enhetsidentifierare. Den skulle då ligga bredvid identiteten i
 * röstlängden, och en databasdump avslöja vilken telefon som hör till vilken
 * person. En helt ny avanonymiseringsyta, införd för en bekvämlighetsfunktion.
 *
 * Priset är att notiser går till alla prenumeranter, även till den som inte är
 * röstberättigad. Det är ett accepterat pris: meddelandet säger bara att en
 * omröstning öppnat, vilket är offentlig information ändå.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('push-subscribe', getClientIp(request), RATE_LIMITS.pushSubscribe)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många försök.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const body = await parseJsonBody(request, pushSubscriptionSchema)
  if (!body.ok) return errorResponse('INVALID_INPUT', body.message, 400)

  await saveSubscription(body.data)

  return jsonResponse({ status: 'subscribed' })
}

/**
 * DELETE /api/push/subscribe
 *
 * Avslutar prenumerationen. Raden raderas, inte markeras — en enhet som sagt
 * nej ska inte ligga kvar som en sparad enhetsidentifierare.
 */
export async function DELETE(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('push-unsubscribe', getClientIp(request), RATE_LIMITS.pushSubscribe)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många försök.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const body = await parseJsonBody(request, pushUnsubscribeSchema)
  if (!body.ok) return errorResponse('INVALID_INPUT', body.message, 400)

  await removeSubscription(body.data.endpoint)

  return jsonResponse({ status: 'unsubscribed' })
}
