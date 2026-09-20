import { isAdminAuthenticated } from '@/lib/admin-auth'
import { errorResponse, jsonResponse } from '@/lib/http'
import { getVoteStatistics } from '@/modules/anonymous-vote'
import { getVoterStatistics } from '@/modules/eligibility/voter-status.service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/stats
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
 *
 * En administratör kan alltså se att 3 av 8 röstberättigade har röstat och hur
 * rösterna fördelar sig, men kan inte ta reda på vem som röstat på vad.
 * Begränsningen ligger inte i gränssnittet utan i datan: kopplingen finns inte
 * i någon databas administratören når.
 */
export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return errorResponse('UNAUTHORISED', 'Inte inloggad.', 401)
  }

  // Två oberoende aggregat från två oberoende databaser.
  const [voterStats, voteStats] = await Promise.all([getVoterStatistics(), getVoteStatistics()])

  return jsonResponse({
    electorate: {
      totalEligible: voterStats.totalEligible,
      totalVoted: voterStats.totalVoted,
      turnoutPercent:
        voterStats.totalEligible === 0
          ? 0
          : Math.round((voterStats.totalVoted / voterStats.totalEligible) * 1000) / 10,
    },
    results: {
      totalVotes: voteStats.totalVotes,
      perParty: voteStats.perParty,
    },
    /**
     * Skillnaden mellan antal markerade väljare och antal registrerade röster.
     *
     * Ska normalt vara noll. Ett värde skilt från noll betyder att en röst
     * gick förlorad mellan de två skrivningarna — se resonemanget om ordning
     * i orchestration/cast-vote.usecase.ts. Det är avsiktligt synligt för
     * administratören, eftersom det är ett integritetsfel som måste kunna
     * upptäckas.
     */
    integrity: {
      markedAsVoted: voterStats.totalVoted,
      recordedVotes: voteStats.totalVotes,
      discrepancy: voterStats.totalVoted - voteStats.totalVotes,
    },
  })
}
