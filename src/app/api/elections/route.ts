import { errorResponse, getClientIp, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { listOpenElections } from '@/modules/ballot-box'
import { electionPhases } from '@/orchestration/election-phases.usecase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/elections
 *
 * Omröstningar som är öppna just nu, med sina valsedlar.
 *
 * Öppen utan legitimering. Vilka omröstningar som pågår och vilka valsedlar de
 * har är offentlig information, och att kräva inloggning för det skulle bara
 * göra systemet svårare att granska — inte säkrare.
 *
 * FASEN FÖLJER MED, FÖR RÖSTSIDANS BEVAKNING (uppgift 14e).
 *
 * Röstsidan frågar medan den är öppen om röstningen har stängt, så att enheten
 * raderar det den sparat (spec 3.1 punkt 4). Förut frågade den väljarens
 * session, vars gräns delas av alla bakom samma adress, och ungefär trettio
 * synliga flikar bakom en adress fyllde den. Fasen är inte hemlig, och den här
 * listans gräns, `publicElections`, rymmer trehundra flikar bakom en adress
 * (helgrensgranskningen, B10).
 *
 * `phases` ger id, namn och fas för varje omröstning, och ingenting annat:
 * aldrig ett antal eller ett tal medan röstningen pågår (spec 6.2). Listan
 * `elections` väljer på tid och inte på fas, så en omröstning som stängts före
 * sin tid står kvar i den. Det är `phases` som säger att den stängt.
 *
 * Svaret innehåller alla valsedlar i omröstningen, inte bara de som gäller en
 * viss person. Vilka som gäller just dig avgörs först efter legitimering, av
 * röstlängden, utifrån var du är folkbokförd.
 */
export async function GET(request: Request) {
  const rate = checkRateLimit('public-elections', getClientIp(request), RATE_LIMITS.publicElections)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const [elections, phases] = await Promise.all([listOpenElections(), electionPhases()])

  return jsonResponse({
    phases: phases.map(({ id, name, phase }) => ({ id, name, phase })),
    elections: elections.map((election) => ({
      id: election.id,
      name: election.name,
      kind: election.kind,
      opensAt: election.opensAt.toISOString(),
      closesAt: election.closesAt.toISOString(),
      ballots: election.ballots.map((ballot) => ({
        id: ballot.id,
        kind: ballot.kind,
        label: ballot.label,
        areaCode: ballot.areaCode,
        allowsCandidateVote: ballot.allowsCandidateVote,
      })),
    })),
  })
}
