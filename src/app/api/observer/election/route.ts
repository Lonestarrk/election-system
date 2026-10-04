import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, statsRequestSchema } from '@/lib/validation'
import { listElections } from '@/modules/ballot-box'
import { getObserverOverview } from '@/orchestration/election-overview.usecase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/observer/election
 *
 * OBSERVATÖRSGRÄNSSNITTET. Öppet, utan inloggning.
 *
 * Utan omröstning: listan, så att observatören hittar rätt. Med en omröstning:
 *
 *   1. FASEN, som röstlängden står i (spec 6.1).
 *   2. VALDELTAGANDET per valsedel, alltså hur många som röstat. Det är det
 *      enda som publiceras medan röstningen pågår (spec 6.2).
 *   3. KUVERTROTEN, URNROTEN OCH SUMMAN AV MARKERINGARNA, från skalningen
 *      (ruling 135). Antalet kuvert som skalades lagras inte för sig, så
 *      summan av markeringarna "har röstat" står i stället.
 *      De visas före räkningen, så att den som vill kan spara dem innan något
 *      dekrypteras och jämföra med publiceringen efteråt.
 *   4. VAR RESULTATET FINNS, när omröstningen är räknad. Själva resultatet,
 *      med bevis, lämnar /api/observer/results.
 *
 * INGA LÖPANDE RESULTAT (uppgift 13, spec 6.2). Fram till uppgiften lämnade
 * rutten ut antalet röster per parti medan röstningen pågick, till vem som helst. Delsiffror påverkar dem som ännu inte
 * röstat, och differensen mellan två hämtningar är rösterna som lades
 * däremellan. Nu finns inget resultat här alls, i någon fas.
 *
 * INGENTING PER RÖST OCH INGENTING PER VÄLJARE. Valdeltagandet är ett antal
 * per valsedel. Rötterna är hashar och binder vilka kuvert som fanns utan att
 * peka ut något av dem.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('observer', getClientIp(request), RATE_LIMITS.adminStats)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const body = await parseJsonBody(request, statsRequestSchema)
  if (!body.ok) return errorResponse('INVALID_INPUT', body.message, 400)

  if (!body.data.electionId) {
    const elections = await listElections()

    return jsonResponse({
      elections: elections.map((election) => ({
        id: election.id,
        name: election.name,
        kind: election.kind,
        opensAt: election.opensAt.toISOString(),
        closesAt: election.closesAt.toISOString(),
      })),
    })
  }

  const overview = await getObserverOverview(body.data.electionId)
  if (!overview) return errorResponse('UNKNOWN_ELECTION', 'Omröstningen finns inte.', 404)

  const resultsPath = `/api/observer/results?electionId=${encodeURIComponent(overview.election.id)}`

  return jsonResponse({
    election: overview.election,
    ballots: overview.ballots,
    turnoutBasis: overview.turnoutBasis,
    envelopeRoot: overview.envelopeRoot,
    urnRoot: overview.urnRoot,
    markedAsVotedTotal: overview.markedAsVotedTotal,
    publishedResults: overview.resultsAvailable ? resultsPath : null,
    howToVerify: overview.resultsAvailable
      ? `Hämta ${resultsPath} och kör node tools/verify-election.mjs med adressen eller den sparade filen.`
      : 'Resultatet publiceras med bevis när omröstningen är räknad. Spara kuvertroten och urnroten ' +
        'när de visas här, så kan du jämföra dem med publiceringen.',
  })
}
