import { errorResponse, getClientIp, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { observerResultsSchema } from '@/lib/validation'
import { publishedResults } from '@/orchestration/publish-results.usecase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/observer/results?electionId=<omröstningens id>
 *
 * DET PUBLICERADE RESULTATET, MED BEVIS (uppgift 13). Öppet, utan inloggning.
 *
 * Svaret är det som tools/verify-election.mjs läser: per valsedel summan per
 * alternativ, förtroendepersonernas partiella dekrypteringar med bevis och
 * resultatet, och per omröstning kuvertroten, urnroten och summan av markeringarna "har röstat". Se
 * src/orchestration/publish-results.usecase.ts för formatet och för vad som
 * aldrig publiceras: ingenting per röst.
 *
 * GET OCH ID:T I ADRESSEN, med avsikt. Adressen är det en granskare ger
 * verktyget, eller sparar svaret från, och den bär bara omröstningens id, som
 * är offentligt. Rutten ändrar ingenting och läser ingen cookie.
 *
 * FÖRST I TALLIED ELLER CERTIFIED. Före det svarar rutten 409 med fasen och
 * ingenting annat. Stämmer de sparade räkneverken inte med en omräkning ur
 * urnan och bidragen svarar den också 409, med beskedet att resultatet inte
 * stämmer, och lämnar inget tal.
 */
export async function GET(request: Request) {
  const rate = checkRateLimit('observer-results', getClientIp(request), RATE_LIMITS.observerResults)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const parsed = observerResultsSchema.safeParse({
    electionId: new URL(request.url).searchParams.get('electionId') ?? undefined,
  })
  if (!parsed.success) {
    return errorResponse('INVALID_INPUT', 'Ange omröstningens id som electionId i adressen.', 400)
  }

  const outcome = await publishedResults(parsed.data.electionId)

  if (outcome.status === 'unknown_election') {
    return errorResponse('UNKNOWN_ELECTION', 'Omröstningen finns inte.', 404)
  }

  if (outcome.status === 'not_published') {
    return jsonResponse(
      {
        status: 'not_published',
        phase: outcome.phase,
        message:
          `Omröstningen är inte räknad, och fasen står i ${outcome.phase}. Resultatet publiceras när ` +
          'varje valsedel är räknad, och ingenting av det före.',
      },
      409,
    )
  }

  if (outcome.status === 'wrong_mode') {
    // 409: omröstningen skapades i ett annat läge än serverns, och inget lämnas ut (uppgift 17).
    return jsonResponse(
      {
        status: 'wrong_mode',
        message:
          'Omröstningen skapades i ett annat läge än det servern kör i, så resultatet lämnas inte ut här. ' +
          'Läget sätts vid driftsättning.',
      },
      409,
    )
  }

  if (outcome.status === 'result_mismatch') {
    return jsonResponse(
      {
        status: 'result_mismatch',
        phase: outcome.phase,
        message:
          'Resultatet stämmer inte. En omräkning ur urnan och förtroendepersonernas bidrag ger inte det ' +
          'sparade resultatet, eller går inte att göra, och därför publiceras ingenting. Det ska utredas ' +
          'innan något resultat visas.',
      },
      409,
    )
  }

  return jsonResponse(outcome.publication)
}
