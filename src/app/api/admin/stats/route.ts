import { isAdminAuthenticated } from '@/lib/admin-auth'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, statsRequestSchema } from '@/lib/validation'
import { getElectionResults, listElections } from '@/modules/ballot-box'
import { getVoterStatistics } from '@/modules/eligibility/voter-status.service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/stats
 *
 * Valstatistik för administratören.
 *
 * Detta är den enda platsen i systemet där siffror från båda databaserna möts,
 * och de möts som AGGREGAT: antal, inte rader.
 *
 * Vad som medvetet saknas, och inte kommer att läggas till:
 *   – sökning på väljare
 *   – listning av enskilda väljare eller enskilda röster
 *   – utlämning av tokens eller token-hashar
 *   – tidsserier med fin upplösning (som skulle kunna korreleras)
 *   – korsningar mellan valsedlar ("hur röstade de som röstade på X i
 *     kommunvalet?") — den kopplingen finns inte lagrad någonstans
 *
 * VARFÖR POST FÖR EN LÄSNING
 *
 * Omröstningens id ligger i kroppen. Att läsa det ur URL:ens frågesträng hade
 * krävt webb-API:t för frågeparametrar, och API-ytans test förbjuder just de
 * orden i den här filen — en spärr mot att adminvyn någonsin får en
 * uppslagsfunktion över väljare. Att kringgå spärren med en annan stavning
 * vore att kringgå dess syfte, så rutten tar emot en kropp i stället.
 *
 * En administratör kan alltså se att 3 av 8 röstberättigade har röstat på
 * kommunvalsedeln och hur rösterna fördelar sig, men kan inte ta reda på vem
 * som röstat på vad. Begränsningen ligger inte i gränssnittet utan i datan:
 * kopplingen finns inte i någon databas administratören når.
 *
 * INTEGRITETSKONTROLLEN RÄKNAS PER VALSEDEL.
 *
 * Med tre valsedlar är "antal markerade väljare" mot "antal röster" en
 * meningslös jämförelse på omröstningsnivå — en person som röstat på två av
 * tre valsedlar skulle se ut som en avvikelse. Skillnaden räknas därför per
 * valsedel, där den faktiskt betyder något: ett värde skilt från noll betyder
 * att en röst gick förlorad mellan de två skrivningarna. Se resonemanget om
 * ordning i orchestration/cast-vote.usecase.ts.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('admin-stats', getClientIp(request), RATE_LIMITS.adminStats)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  if (!(await isAdminAuthenticated())) {
    return errorResponse('UNAUTHORISED', 'Inte inloggad.', 401)
  }

  const body = await parseJsonBody(request, statsRequestSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  const electionId = body.data.electionId ?? null

  const elections = await listElections()

  if (!electionId) {
    // Utan vald omröstning: bara listan, inga siffror.
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

  if (!elections.some((election) => election.id === electionId)) {
    return errorResponse('UNKNOWN_ELECTION', 'Omröstningen finns inte.', 404)
  }

  // Två oberoende aggregat från två oberoende databaser.
  const [voterStats, results] = await Promise.all([
    getVoterStatistics(electionId),
    getElectionResults(electionId),
  ])

  const markedByBallot = new Map(
    voterStats.perBallot.map((row) => [row.ballotId, row.markedAsVoted]),
  )

  return jsonResponse({
    electionId,
    electorate: { totalEligible: voterStats.totalEligible },
    ballots: results.map((ballot) => {
      const markedAsVoted = markedByBallot.get(ballot.ballotId) ?? 0

      return {
        ballotId: ballot.ballotId,
        ballot: ballot.ballot,
        kind: ballot.kind,
        totalVotes: ballot.totalVotes,
        turnoutPercent:
          voterStats.totalEligible === 0
            ? 0
            : Math.round((markedAsVoted / voterStats.totalEligible) * 1000) / 10,
        rows: ballot.rows,
        /**
         * Skillnaden mellan antal markerade väljare och antal registrerade
         * röster på valsedeln.
         *
         * Ska normalt vara noll. Ett värde skilt från noll betyder att en röst
         * gick förlorad mellan de två skrivningarna. Det är avsiktligt synligt
         * för administratören, eftersom det är ett integritetsfel som måste
         * kunna upptäckas.
         */
        integrity: {
          markedAsVoted,
          recordedVotes: ballot.totalVotes,
          discrepancy: markedAsVoted - ballot.totalVotes,
        },
      }
    }),
  })
}
