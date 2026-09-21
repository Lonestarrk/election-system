import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { bankIdQrSchema, parseJsonBody } from '@/lib/validation'
import { bankIdService } from '@/modules/eligibility/bankid'
import { renderQrPng } from '@/modules/eligibility/bankid/qr'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/bankid/qr
 *
 * Den animerade QR-kodens aktuella data.
 *
 * BankID v6 kräver att koden byts varje sekund. Klienten pollar därför den här
 * rutten en gång per sekund, medan `collect` pollas var annan sekund — två
 * olika takter för två olika saker.
 *
 * VARFÖR KODEN RÄKNAS FRAM PÅ SERVERN
 *
 * Beräkningen är HMAC-SHA256 över `qrStartSecret`, och den hemligheten delas
 * enligt BankID:s specifikation bara mellan BankID och den anropande
 * tjänsten. Skickades den till klienten för att spara ett anrop per sekund
 * kunde vem som helst räkna fram giltiga koder för ordern i all framtid — och
 * animeringen, som finns till för att en fotograferad kod ska vara död innan
 * den hunnit vidarebefordras, vore meningslös.
 *
 * Svaret innehåller bara den färdiga strängen, som är värdelös en sekund
 * senare.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  // Generös gräns: rutten pollas en gång per sekund under legitimeringen, och
  // en order lever i 30 sekunder. Gränsen finns mot skript som pollar i
  // oändlighet, inte mot väljaren.
  const rate = checkRateLimit('bankid-qr', getClientIp(request), RATE_LIMITS.authCollect)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const body = await parseJsonBody(request, bankIdQrSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  const qr = await bankIdService.qrData(body.data.orderRef)

  if (!qr) {
    // Ordern finns inte, är avbruten eller har gått ut. Samma svar i alla tre
    // fallen — att skilja dem åt vore att berätta för den som prövar
    // order-referenser vilka som funnits.
    return jsonResponse({ qrImage: null, expired: true })
  }

  return jsonResponse({
    // Bilden, inte strängen. Klienten behöver inget QR-bibliotek och policyn
    // behöver inte tillåta något nytt — data-URI-bilder är redan tillåtna.
    qrImage: await renderQrPng(qr.qrData),
    elapsedSeconds: qr.elapsedSeconds,
    expired: false,
  })
}
