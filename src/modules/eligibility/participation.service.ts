import { ballotsForVoter } from './election.service'
import { votersDb } from './db'

/**
 * VALDELTAGANDET, OCH VÄLJARENS BESKED "DU HAR RÖSTAT" (uppgift 13).
 *
 * Båda svarar på frågan OM någon röstat, aldrig VAD eller NÄR. Underlaget är
 * kuvertmodellens två tabeller i röstlängden, och vilken som gäller beror på
 * fasen:
 *
 *   – fram till skalningen (OPEN, CLOSED, VALIDATED) ligger väljarens kuvert i
 *     pending_vote. Ett kuvert betyder att väljaren har en röst som räknas om
 *     ingenting ändras före stängningen
 *   – från skalningen (STRIPPED och senare) är kuverten raderade, och
 *     markeringen "har röstat" i voted_marker står kvar. Skalningen skriver den
 *     i samma transaktion som raderar kuverten, en per flyttat kuvert och utan
 *     tidsstämpel (spec 3.1 punkt 6)
 *
 * VAD BESKEDET INTE SÄGER (spec 10). Markeringen skrivs ur kuverten som
 * raderas, så ett kuvert som tagits bort före stängningen syns som "har inte
 * röstat". Ett äldre äkta kuvert som lagts tillbaka syns inte: det ger en
 * markering som vilket annat. Och den som kan skriva i röstlängden kan skriva
 * eller radera en markering. Beskedet är alltså röstlängdens, inte ett bevis.
 */

/** Faserna där kuverten fortfarande ligger i röstlängden. */
const ENVELOPES_LIE_IN: ReadonlySet<string> = new Set(['OPEN', 'CLOSED', 'VALIDATED'])

export type ParticipationBasis = 'envelopes' | 'markers'

function basisFor(phase: string): ParticipationBasis {
  return ENVELOPES_LIE_IN.has(phase) ? 'envelopes' : 'markers'
}

export type BallotTurnout = { ballotId: string; label: string; kind: string; voted: number }

/**
 * Hur många som röstat på varje valsedel i omröstningen. Bara antal.
 *
 * Det enda som publiceras medan röstningen pågår (spec 6.2): valdeltagandet
 * kräver ingen dekryptering, och det är en offentlig uppgift i ett riktigt val.
 */
export async function turnoutByBallot(
  electionId: string,
): Promise<{ phase: string; basis: ParticipationBasis; ballots: BallotTurnout[] } | null> {
  const election = await votersDb.election.findUnique({
    where: { id: electionId },
    select: {
      phase: true,
      ballots: { select: { id: true, label: true, kind: true }, orderBy: { displayOrder: 'asc' } },
    },
  })
  if (!election) return null

  const basis = basisFor(election.phase)
  const ballotIds = election.ballots.map((ballot) => ballot.id)
  const grouped =
    basis === 'envelopes'
      ? await votersDb.pendingVote.groupBy({
          by: ['ballotId'],
          where: { ballotId: { in: ballotIds } },
          _count: { _all: true },
        })
      : await votersDb.votedMarker.groupBy({
          by: ['ballotId'],
          where: { ballotId: { in: ballotIds } },
          _count: { _all: true },
        })
  const byBallot = new Map(grouped.map((row) => [row.ballotId, row._count._all]))

  return {
    phase: election.phase,
    basis,
    ballots: election.ballots.map((ballot) => ({
      ballotId: ballot.id,
      label: ballot.label,
      kind: ballot.kind,
      voted: byBallot.get(ballot.id) ?? 0,
    })),
  }
}

export type BallotParticipation = { ballotId: string; label: string; kind: string; voted: boolean }

/**
 * Om väljaren har röstat, per valsedel som gäller henne. Inget annat.
 *
 * Svaret säger inte vad hon röstade på, inte när och inte med vilket kuvert:
 * frågan ställs med `count`, och varken chiffret, chifferhashen, räknaren eller
 * en tid läses. Den som vill se sin röst före stängningen gör det på röstsidan,
 * på enheten hon röstade från, där servern bara svarar lika, olika eller ingen
 * röst (spec 3.1 punkt 1).
 */
export async function participationOf(
  voterStatusId: string,
  electionId: string,
): Promise<{ phase: string; ballots: BallotParticipation[] } | null> {
  const election = await votersDb.election.findUnique({ where: { id: electionId }, select: { phase: true } })
  if (!election) return null

  const basis = basisFor(election.phase)
  const ballots = await ballotsForVoter(voterStatusId, electionId)

  const participation: BallotParticipation[] = []
  for (const ballot of ballots) {
    const where = { voterStatusId, ballotId: ballot.id }
    const found =
      basis === 'envelopes'
        ? await votersDb.pendingVote.count({ where })
        : await votersDb.votedMarker.count({ where })
    participation.push({ ballotId: ballot.id, label: ballot.label, kind: ballot.kind, voted: found > 0 })
  }

  return { phase: election.phase, ballots: participation }
}
