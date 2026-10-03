import { TRUSTEE_COUNT, TRUSTEE_THRESHOLD } from '@/lib/crypto/threshold'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { votesDb } from '@/modules/ballot-box/db'
import { votersDb } from '@/modules/eligibility/db'
import { turnoutByBallot } from '@/modules/eligibility/participation.service'

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
// Observatörens överblick (uppgift 13)
// ---------------------------------------------------------------------------

export type ObserverOverview = {
  election: { id: string; name: string; kind: string; opensAt: string; closesAt: string; phase: string }
  /** Valdeltagandet per valsedel: hur många som röstat, och ingenting annat. */
  ballots: Array<{ id: string; label: string; kind: string; voted: number }>
  /** Var siffran kommer ifrån: liggande kuvert före skalningen, markeringar efter. */
  turnoutBasis: 'envelopes' | 'markers'
  /** Kuvertroten och urnroten, från skalningen. Null före den. */
  envelopeRoot: string | null
  urnRoot: string | null
  /**
   * Summan av markeringarna "har röstat" över valsedlarna, från skalningen. Null
   * före den. Skalningen skriver en markering per flyttat kuvert, men antalet
   * kuvert lagras inte för sig, så fältet heter efter vad det är (fixrunda 1 av
   * uppgift 13, Mindre 3).
   */
  markedAsVotedTotal: number | null
  /** Sant när omröstningen är räknad och resultatet går att hämta med bevis. */
  resultsAvailable: boolean
}

/**
 * Det observatörsgränssnittet visar om en omröstning, i varje fas.
 *
 * BARA VALDELTAGANDET MEDAN RÖSTNINGEN PÅGÅR (spec 6.2). Inget resultat,
 * ingen delsumma och ingenting per röst. Resultatet publiceras först i TALLIED,
 * med bevis, av /api/observer/results.
 *
 * RÖTTERNA FRÅN SKALNINGEN (ruling 135). Kuvertroten och urnroten skrivs med
 * STRIPPED och visas här från den fasen, före räkningen, så att den som vill
 * kan spara dem innan något dekrypteras och jämföra med publiceringen efteråt.
 * Roten skyddar bara om någon utanför systemet sparar den.
 */
export async function getObserverOverview(electionId: string): Promise<ObserverOverview | null> {
  const election = await votersDb.election.findUnique({
    where: { id: electionId },
    select: {
      name: true,
      kind: true,
      opensAt: true,
      closesAt: true,
      phase: true,
      envelopeRoot: true,
      urnRoot: true,
    },
  })
  if (!election) return null

  const turnout = await turnoutByBallot(electionId)
  if (!turnout) return null

  const stripped = turnout.basis === 'markers'

  return {
    election: {
      id: electionId,
      name: election.name,
      kind: election.kind,
      opensAt: election.opensAt.toISOString(),
      closesAt: election.closesAt.toISOString(),
      phase: election.phase,
    },
    ballots: turnout.ballots.map((ballot) => ({
      id: ballot.ballotId,
      label: ballot.label,
      kind: ballot.kind,
      voted: ballot.voted,
    })),
    turnoutBasis: turnout.basis,
    envelopeRoot: stripped ? election.envelopeRoot : null,
    urnRoot: stripped ? election.urnRoot : null,
    markedAsVotedTotal: stripped ? turnout.ballots.reduce((total, ballot) => total + ballot.voted, 0) : null,
    resultsAvailable: election.phase === 'TALLIED' || election.phase === 'CERTIFIED',
  }
}
