import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { demoScanSchema, parseJsonBody } from '@/lib/validation'
import { bankIdIsMocked } from '@/modules/eligibility/bankid'
import { selectDemoIdentity } from '@/modules/eligibility/bankid/MockBankIdService'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/demo/bankid-scan
 *
 * DEMOGENVÄG. Motsvarar att någon skannar QR-koden med sin BankID-app.
 *
 * VARFÖR DEN HÄR RUTTEN FINNS, OCH VARFÖR DEN LIGGER UNDER /api/demo
 *
 * BankID v6 tar inget personnummer: identiteten kommer ur BankID:s svar efter
 * att personen legitimerat sig med sin egen app. Det är rätt, och det är hela
 * skälet till att inmatningsrutan försvunnit ur röstningsflödet.
 *
 * Men en demonstration utan BankID-app måste ändå kunna visa olika fall —
 * röstberättigad, inte röstberättigad, folkbokförd i annan kommun,
 * administratör. Rutten står för det steg som i verkligheten sker i väljarens
 * telefon.
 *
 * TRE SPÄRRAR SÅ ATT DEN INTE KAN BLI EN BAKDÖRR
 *
 *  1. Sökvägen börjar med /api/demo. Den som granskar API-ytan ser omedelbart
 *     vad den är, i stället för att hitta en personnummerparameter begravd i
 *     legitimeringsflödet.
 *
 *  2. Rutten svarar 404 om BankID inte är en attrapp. Villkoret är skrivet mot
 *     implementationen, inte mot en miljövariabel — byts mocken ut blir svaret
 *     404 automatiskt, i stället för att hänga på att någon kommer ihåg att
 *     ändra konfigurationen.
 *
 *  3. `selectDemoIdentity` finns inte i `IBankIdService`. Byts mocken mot en
 *     riktig implementation slutar funktionen existera, och den här filen
 *     slutar kompilera. Ett trasigt bygge är ett bättre skydd än ett villkor
 *     som kan råka bli sant.
 */
export async function POST(request: Request) {
  if (!bankIdIsMocked) {
    // 404, inte 403: en rutt som inte finns ska inte gå att skilja från en som
    // finns men nekar. Med skarp BankID existerar den här funktionen inte.
    return errorResponse('NOT_FOUND', 'Rutten finns inte.', 404)
  }

  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('demo-scan', getClientIp(request), RATE_LIMITS.authCollect)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const body = await parseJsonBody(request, demoScanSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  const accepted = selectDemoIdentity(body.data.orderRef, body.data.personalNumber)

  if (!accepted) {
    return errorResponse('UNKNOWN_ORDER', 'Legitimeringen finns inte eller har gått ut.', 404)
  }

  return jsonResponse({ status: 'scanned' })
}
