import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, verifyTokenSchema } from '@/lib/validation'
import { verifyToken } from '@/modules/anonymous-vote'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/verify
 *
 * Kontrollerar att en token motsvarar en registrerad röst.
 *
 * AVVIKELSE FRÅN SPECIFIKATIONEN, MEDVETEN:
 *
 * Specifikationen beskriver `GET /api/verify/{token}` men kräver samtidigt att
 * token aldrig hamnar i en URL. De två kraven går inte att uppfylla samtidigt.
 * En token i sökvägen skrivs till webbserverns accessloggar, till proxyloggar,
 * till webbläsarens historik och följer med i Referer-headern vid utgående
 * länkar. Kravet "ingen token i URL" är det som skyddar väljaren, så det är
 * det som får styra.
 *
 * Svarets form följer specifikationen exakt:
 *
 *     { "registered": true, "party": "Exempelpartiet" }
 *
 * Svaret innehåller aldrig väljaridentitet, BankID-identitet, IP-adress,
 * väljar-id eller sessions-id. Det finns ingen omvänd endpoint: det går inte
 * att fråga systemet vilken token som hör till en viss person. Den frågan har
 * inget svar någonstans i systemet.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('verify', getClientIp(request), RATE_LIMITS.verify)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många försök. Försök igen om en stund.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const body = await parseJsonBody(request, verifyTokenSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  const result = await verifyToken(body.data.token)

  if (!result.registered) {
    return jsonResponse({
      registered: false,
      message: 'Ingen röst hittades för den här token.',
    })
  }

  return jsonResponse({
    registered: true,
    party: result.party,
    message: 'Din röst är registrerad.',
  })
}

/**
 * Sökvägen finns med som GET enbart för att ge ett begripligt svar till den
 * som följer specifikationens ursprungliga form. Den utför ingen verifiering.
 */
export async function GET() {
  return errorResponse(
    'METHOD_NOT_ALLOWED',
    'Verifiering sker med POST och token i begärans kropp, aldrig i URL:en.',
    405,
    { Allow: 'POST' },
  )
}
