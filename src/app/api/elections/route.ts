import { jsonResponse } from '@/lib/http'
import { listOpenElections } from '@/modules/ballot-box'

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
 * Svaret innehåller alla valsedlar i omröstningen, inte bara de som gäller en
 * viss person. Vilka som gäller just dig avgörs först efter legitimering, av
 * röstlängden, utifrån var du är folkbokförd.
 */
export async function GET() {
  const elections = await listOpenElections()

  return jsonResponse({
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
