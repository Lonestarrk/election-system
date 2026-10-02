import { canonicalOptions } from '@/lib/crypto/ballot-encoding'
import { TRUSTEE_COUNT, TRUSTEE_THRESHOLD } from '@/lib/crypto/threshold'
import { getBallotChoices, getEncryptedBallotShape } from '@/modules/ballot-box'
import { votesDb } from '@/modules/ballot-box/db'
import { votersDb } from '@/modules/eligibility/db'

/**
 * Det adminsidan läser för att veta var avslutningen står (uppgift 12c).
 *
 * SERVERN ÄR AUKTORITETEN. Sidan drar aldrig slutsatser av sina egna klick: den
 * frågar här efter varje åtgärd och visar fasen som röstlängden står i.
 *
 * BARA ANTAL. Ingenting här är per väljare, och inget kuvert lämnas ut. Antalet
 * liggande kuvert är en summa över omröstningens valsedlar (spec 3.1), och
 * förtroendepersonernas bidrag räknas per förtroendeperson och valsedel, aldrig
 * per väljare. Funktionen rör inga rader i `pending_vote` utöver att räkna dem.
 *
 * Filen läser båda databaserna, som slutkontrollen och räkningen, och står på
 * modulgränstestets undantagslista av samma skäl: den kan inte para ihop sidorna,
 * eftersom det inte finns någon gemensam identifierare.
 */

export type BallotOverview = {
  id: string
  label: string
  kind: string
  /**
   * Förtroendepersonerna som lämnat ett fullständigt bidrag för valsedeln.
   * Ett bidrag är fullständigt när det har en rad för varje alternativ.
   */
  contributedBy: number[]
  /** Valsedeln har sina räkneverk, ett per alternativ. */
  tallied: boolean
}

export type ElectionOverview = {
  electionId: string
  name: string
  /** Fasen i röstlängden (spec 6.1). */
  phase: string
  /** Röstdatabasens markering efter en slutkontroll som fann en avvikelse. */
  underReview: boolean
  opensAt: string
  closesAt: string
  /** Hur många kuvert som ligger i röstlängden. Bara antalet. */
  waitingEnvelopes: number
  /** Hur många kuvert som ligger i urnan i röstdatabasen. Bara antalet. */
  urnEnvelopes: number
  envelopeRoot: string | null
  urnRoot: string | null
  /** Sant när skalningen har skrivit sin tidpunkt. Själva tidpunkten lämnas inte ut. */
  linkCleared: boolean
  /** Så många förtroendepersoner finns, och så många krävs. */
  trusteeCount: number
  trusteeThreshold: number
  /** Valsedlarna som räknas i kuvertmodellen. En fråga räknas inte här. */
  ballots: BallotOverview[]
  /** Förtroendepersonerna som lämnat ett fullständigt bidrag för varje valsedel. */
  trusteesReady: number[]
}

export async function getElectionOverview(electionId: string): Promise<ElectionOverview | null> {
  const election = await votersDb.election.findUnique({
    where: { id: electionId },
    select: {
      name: true,
      phase: true,
      opensAt: true,
      closesAt: true,
      linkClearedAt: true,
      envelopeRoot: true,
      urnRoot: true,
      ballots: { select: { id: true, label: true, kind: true }, orderBy: { displayOrder: 'asc' } },
    },
  })
  if (!election) return null

  const ballotIds = election.ballots.map((ballot) => ballot.id)
  const waitingEnvelopes = await votersDb.pendingVote.count({ where: { ballotId: { in: ballotIds } } })

  const votes = await votesDb.election.findUnique({ where: { id: electionId }, select: { status: true } })
  const urnEnvelopes = await votesDb.encryptedVote.count({ where: { ballotId: { in: ballotIds } } })

  const contributionRows = await votesDb.partialDecryption.groupBy({
    by: ['ballotId', 'trusteeIndex'],
    where: { ballotId: { in: ballotIds } },
    _count: { _all: true },
  })
  const tallyRows = await votesDb.ballotTally.groupBy({
    by: ['ballotId'],
    where: { ballotId: { in: ballotIds } },
    _count: { _all: true },
  })
  const talliedRows = new Map(tallyRows.map((row) => [row.ballotId, row._count._all]))

  const ballots: BallotOverview[] = []
  for (const ballot of election.ballots) {
    const shape = await getEncryptedBallotShape(ballot.id)
    // En valsedel utan form räknas inte i kuvertmodellen, se `getEncryptedBallotShape`.
    if (!shape) continue

    const contributedBy = contributionRows
      .filter((row) => row.ballotId === ballot.id && row._count._all === shape.optionCount)
      .map((row) => row.trusteeIndex)
      .sort((a, b) => a - b)

    ballots.push({
      id: ballot.id,
      label: ballot.label,
      kind: ballot.kind,
      contributedBy,
      tallied: talliedRows.get(ballot.id) === shape.optionCount,
    })
  }

  // En förtroendeperson är klar när hon har lämnat bidraget för varje valsedel.
  const trusteesReady =
    ballots.length === 0
      ? []
      : Array.from({ length: TRUSTEE_COUNT }, (_, index) => index + 1).filter((index) =>
          ballots.every((ballot) => ballot.contributedBy.includes(index)),
        )

  return {
    electionId,
    name: election.name,
    phase: election.phase,
    underReview: votes?.status === 'UNDER_REVIEW',
    opensAt: election.opensAt.toISOString(),
    closesAt: election.closesAt.toISOString(),
    waitingEnvelopes,
    urnEnvelopes,
    envelopeRoot: election.envelopeRoot,
    urnRoot: election.urnRoot,
    linkCleared: election.linkClearedAt !== null,
    trusteeCount: TRUSTEE_COUNT,
    trusteeThreshold: TRUSTEE_THRESHOLD,
    ballots,
    trusteesReady,
  }
}

// ---------------------------------------------------------------------------
// Resultatet (7c)
// ---------------------------------------------------------------------------

export type BallotResult = {
  ballotId: string
  label: string
  kind: string
  /** Alternativen i valsedelns kanoniska ordning, blankt först. */
  options: Array<{ label: string; count: number }>
  total: number
}

export type ElectionResultOutcome =
  | { status: 'ok'; phase: string; ballots: BallotResult[] }
  | { status: 'not_tallied'; phase: string }
  | { status: 'unknown_election' }

/**
 * Räkneverken per valsedel, efter TALLIED och CERTIFIED.
 *
 * Räkningens rutt vägrar efter TALLIED, och ingen annan rutt lämnar ut
 * räkneverken igen. Det här är läsvägen för adminsidan, också efter en
 * omladdning. Den ligger bakom adminsessionen och är inte offentlig:
 * publiceringen, med bevis, är uppgift 13.
 *
 * Före TALLIED svarar den `not_tallied` och lämnar inget ur räkneverken, också
 * om några valsedlar redan är räknade. Fasen är det som säger att varje
 * valsedel är det.
 */
export async function getElectionTallyResults(electionId: string): Promise<ElectionResultOutcome> {
  const election = await votersDb.election.findUnique({
    where: { id: electionId },
    select: {
      phase: true,
      ballots: { select: { id: true, label: true, kind: true }, orderBy: { displayOrder: 'asc' } },
    },
  })
  if (!election) return { status: 'unknown_election' }
  if (election.phase !== 'TALLIED' && election.phase !== 'CERTIFIED') {
    return { status: 'not_tallied', phase: election.phase }
  }

  const ballots: BallotResult[] = []
  for (const ballot of election.ballots) {
    const shape = await getEncryptedBallotShape(ballot.id)
    if (!shape) continue

    const rows = await votesDb.ballotTally.findMany({
      where: { ballotId: ballot.id },
      select: { optionIndex: true, count: true },
      orderBy: { optionIndex: 'asc' },
    })
    const labels = await optionLabelsOf(ballot.id)

    const options = rows.map((row) => ({
      label: labels[row.optionIndex] ?? `Alternativ ${row.optionIndex + 1}`,
      count: row.count,
    }))
    ballots.push({
      ballotId: ballot.id,
      label: ballot.label,
      kind: ballot.kind,
      options,
      total: options.reduce((sum, option) => sum + option.count, 0),
    })
  }

  return { status: 'ok', phase: election.phase, ballots }
}

/**
 * Alternativens namn i den kanoniska ordning räkningen använder (blankt,
 * partierna, sedan kandidaterna), som `getEncryptedBallotShape` bygger den.
 */
async function optionLabelsOf(ballotId: string): Promise<string[]> {
  const choices = await getBallotChoices(ballotId)
  if (!choices || choices.kind !== 'PARTY') return []

  const parties = choices.parties.map((party) => ({
    id: party.ballotPartyId,
    displayOrder: party.displayOrder,
    candidates: party.candidates.map((candidate) => ({ id: candidate.id, displayOrder: candidate.displayOrder })),
  }))
  const partyById = new Map(choices.parties.map((party) => [party.ballotPartyId, party]))
  const candidateById = new Map(
    choices.parties.flatMap((party) => party.candidates.map((candidate) => [candidate.id, candidate.name] as const)),
  )

  return canonicalOptions({ allowsCandidateVote: choices.allowsCandidateVote, parties }).map((option) => {
    if (option.kind === 'BLANK') return 'Blankt'
    const party = partyById.get(option.ballotPartyId)
    if (option.kind === 'PARTY') return party?.name ?? 'Okänt parti'
    return `${candidateById.get(option.candidateId) ?? 'Okänd kandidat'} (${party?.abbreviation ?? '?'})`
  })
}
