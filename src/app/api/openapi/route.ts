import { errorResponse, getClientIp, jsonResponse } from '@/lib/http'
import { openApiDocument } from '@/lib/openapi'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/openapi
 *
 * OpenAPI-specen, härledd ur valideringsschemana (src/lib/openapi.ts).
 *
 * Öppen utan inloggning. API-ytan är offentlig information, och att dölja den gör
 * systemet svårare att granska utan att göra det säkrare. Specen beskriver bara det
 * som är offentligt eller ligger bakom en session, aldrig demorutterna, och den
 * innehåller inga exempelvärden.
 *
 * Bara GET, så ingen origin-kontroll: rutten ändrar ingenting. Hastighetsgränsen
 * finns för att dokumentet är stort nog att inte vara gratis att hämta i en slinga.
 * Dokumentet byggs en gång per process, eftersom det inte beror på något som ändras.
 */
let document: ReturnType<typeof openApiDocument> | undefined

export async function GET(request: Request) {
  const rate = checkRateLimit('public-openapi', getClientIp(request), RATE_LIMITS.publicOpenApi)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  document ??= openApiDocument()
  return jsonResponse(document)
}
