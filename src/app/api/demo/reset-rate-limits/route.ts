import { errorResponse, hasValidOrigin, jsonResponse } from '@/lib/http'
import { resetRateLimits } from '@/lib/rate-limit'
import { bankIdIsMocked } from '@/modules/eligibility/bankid'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/demo/reset-rate-limits
 *
 * Nollställer hastighetsbegränsarens hinkar. Finns bara när BankID är en
 * attrapp.
 *
 * VARFÖR DEN BEHÖVS
 *
 * E2E-sviten legitimerar sig dussintals gånger från samma IP-adress inom ett
 * par minuter, och slog därför ut sin egen `authStart`-gräns (20/min) och
 * `adminLogin`-gräns (5 per 5 min, som dessutom bara tickas av MISSLYCKADE
 * inloggningar — och ett av testerna misslyckas med flit). Resultatet var tre
 * röda tester av tjugoett vid en full körning, alla med "Legitimeringen
 * misslyckades", och alla gröna när de kördes var för sig. En svit som bara
 * fungerar en fil i taget är inte en svit.
 *
 * VARFÖR INTE BARA SLÅ AV GRÄNSEN I ATTRAPPLÄGE
 *
 * Det var min första tanke, och den var fel. Säkerhetstestet i
 * tests/security/api-surface.test.ts kräver att varje tillståndsändrande rutt
 * innehåller `checkRateLimit` — ett statiskt villkor. Ett
 * `if (!bankIdIsMocked)` runt anropet hade passerat texten men urholkat
 * egenskapen testet finns för att garantera, alltså ett test som blir grönt
 * av fel skäl. Gränserna är därför orörda; det här är en nollställning
 * emellan, inte ett undantag.
 *
 * VARFÖR DEN INTE KAN FINNAS I DRIFT
 *
 * `bankIdIsMocked` är `bankIdService instanceof MockBankIdService`, alltså ett
 * påstående om implementationen och inte en miljövariabel. Byts attrappen mot
 * skarp BankID blir värdet falskt av sig själv — ingen konfiguration att komma
 * ihåg, ingen flagga att råka sätta.
 *
 * Svaret är 404 och inte 403: en rutt som inte finns ska inte gå att skilja
 * från en som finns men nekar.
 */
export async function POST(request: Request) {
  if (!bankIdIsMocked) {
    return errorResponse('NOT_FOUND', 'Rutten finns inte.', 404)
  }

  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  resetRateLimits()

  return jsonResponse({ status: 'reset' })
}
