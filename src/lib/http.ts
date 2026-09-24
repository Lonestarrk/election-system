import { NextResponse } from 'next/server'
import { clientAddressFrom, trustedProxyHops } from './client-address'
import { env } from './env'

/**
 * Svarshjälpare.
 *
 * Alla API-svar sätts till `no-store`. Röstrelaterade svar får aldrig hamna i
 * en mellanliggande cache, en proxy eller webbläsarens bakåtknapp — kvittosidan
 * innehåller en token som ska visas exakt en gång.
 */

export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      ...headers,
    },
  })
}

/**
 * Felsvar.
 *
 * Felkoden är maskinläsbar och meddelandet är på svenska för slutanvändaren.
 * Ingenting här får innehålla interna identifierare, stacktracear eller
 * databasfel — dels läcker de systemdetaljer, dels kan de innehålla värden som
 * pekar ut en enskild väljare.
 */
export function errorResponse(
  code: string,
  message: string,
  status: number,
  headers: HeadersInit = {},
): NextResponse {
  return jsonResponse({ error: { code, message } }, status, headers)
}

/**
 * Hämtar klientens IP-adress för hastighetsbegränsning.
 *
 * VIKTIGT: returvärdet får bara användas till hastighetsbegränsning och får
 * aldrig skickas vidare till den anonyma röstmodulen, loggas eller lagras.
 * En IP-adress tillsammans med en tidsstämpel är i praktiken en identitet.
 *
 * X-FORWARDED-FOR TROS BARA NÄR EN BETRODD PROXY ÄR KONFIGURERAD.
 *
 * Förut togs den första posten i rubriken, och den kan klienten välja själv.
 * Varje klient kunde då ta sig förbi varje hastighetsgräns genom att skicka en
 * ny adress per begäran. Nu tas anslutningens adress, eller den adress en
 * betrodd proxy skrev, se src/lib/client-address.ts. X-Real-IP läses inte
 * längre, av samma skäl: den kan också klienten sätta.
 */
export function getClientIp(request: Request): string {
  return clientAddressFrom(request.headers.get('x-forwarded-for'), trustedProxyHops())
}

/**
 * Kontrollerar att en tillståndsändrande begäran kommer från vår egen origin.
 *
 * Detta är andra lagret av CSRF-skyddet, utöver double-submit-token i
 * `csrf.ts`. Origin-kontrollen fångar de fall där en angripare lyckats gissa
 * eller läcka CSRF-token, och double-submit fångar de fall där webbläsaren
 * inte skickar någon Origin-header.
 */
export function hasValidOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')

  // Ingen Origin-header skickas vid navigering från samma sajt i vissa
  // webbläsare. Då förlitar vi oss på double-submit-token och SameSite=Strict.
  if (!origin) return true

  return env.appOrigins.includes(origin)
}
