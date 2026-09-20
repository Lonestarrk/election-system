import { truncateToDay } from '@/lib/time'
import { votersDb } from './db'
import { hashPersonalNumber } from './identity'
import { ballotsForVoter, type BallotForVoter } from './election.service'

/**
 * Röstberättigande och "har röstat"-status.
 *
 * Modulen svarar på exakt två frågor:
 *   – Får den här personen rösta i den här omröstningen?
 *   – Vilka av omröstningens valsedlar har hen redan röstat på?
 *
 * Den kan inte svara på "vad röstade den här personen på?", eftersom svaret
 * inte finns i den databas modulen har tillgång till.
 *
 * STATUSEN ÄR PER VALSEDEL, INTE PER PERSON. Att ha röstat i riksdagsvalet men
 * inte i kommunvalet är ett fullt giltigt tillstånd i ett svenskt val, och den
 * tidigare booleanen på VoterStatus kunde inte uttrycka det.
 */

export type EligibilityDecision =
  | {
      outcome: 'eligible'
      voterStatusId: string
      isAdmin: boolean
      /** Valsedlar som gäller personen, med status per valsedel. */
      ballots: BallotForVoter[]
    }
  | { outcome: 'not_in_roll' }
  | { outcome: 'not_eligible' }
  | { outcome: 'already_voted' }
  | { outcome: 'no_ballots' }

/**
 * Avgör om personen får rösta i en viss omröstning.
 *
 * Personnumret hashas direkt och lämnar aldrig funktionen i klartext.
 */
export async function evaluateEligibility(
  personalNumber: string,
  electionId: string,
): Promise<EligibilityDecision> {
  const identityHash = hashPersonalNumber(personalNumber)

  const voter = await votersDb.voterStatus.findUnique({
    where: { externalIdentityHash: identityHash },
    select: { id: true, isEligible: true, isAdmin: true },
  })

  if (!voter) return { outcome: 'not_in_roll' }
  if (!voter.isEligible) return { outcome: 'not_eligible' }

  const ballots = await ballotsForVoter(voter.id, electionId)

  // Ingen valsedel gäller personen. Inträffar om omröstningen bara innehåller
  // kommunvalsedlar för andra kommuner än där personen är folkbokförd.
  if (ballots.length === 0) return { outcome: 'no_ballots' }

  // Alla valsedlar avklarade. Systemet vet ATT personen röstat — det vet inte
  // VAD, och kan inte ta reda på det.
  if (ballots.every((ballot) => ballot.hasVoted)) return { outcome: 'already_voted' }

  return { outcome: 'eligible', voterStatusId: voter.id, isAdmin: voter.isAdmin, ballots }
}

export type AdminIdentification =
  | { outcome: 'admin'; voterStatusId: string }
  | { outcome: 'not_admin' }
  | { outcome: 'not_in_roll' }

/**
 * Identifierar en administratör.
 *
 * Adminbehörighet hänger på identiteten, inte på ett delat lösenord: den som
 * ska kunna skapa en omröstning legitimerar sig med BankID precis som en
 * väljare och får adminvyn först om raden har `isAdmin`.
 *
 * Funktionen är medvetet skild från `evaluateEligibility`. En administratör
 * som loggar in för att administrera ska inte samtidigt få en röstsession —
 * det vore två olika saker i samma anrop, och den sortens sammanblandning är
 * precis hur en admin av misstag hamnar med en röstsession hen inte bett om.
 *
 * Det finns ingen funktion här som SÄTTER `isAdmin`. Flaggan sätts genom seed
 * eller direkt i databasen. En självbetjäningsväg till adminbehörighet vore
 * den enskilt farligaste knappen i systemet.
 */
export async function identifyAdmin(personalNumber: string): Promise<AdminIdentification> {
  const identityHash = hashPersonalNumber(personalNumber)

  const voter = await votersDb.voterStatus.findUnique({
    where: { externalIdentityHash: identityHash },
    select: { id: true, isAdmin: true },
  })

  if (!voter) return { outcome: 'not_in_roll' }
  if (!voter.isAdmin) return { outcome: 'not_admin' }

  return { outcome: 'admin', voterStatusId: voter.id }
}

/**
 * Markerar att personen röstat på en valsedel.
 *
 * DUBBELRÖSTNINGSSPÄRREN LIGGER I DATABASEN, INTE I KODEN.
 *
 * Raden skapas med ett unikt index på (voter_status_id, ballot_id). Två
 * samtidiga begäranden kan därför inte båda lyckas: PostgreSQL avvisar den
 * andra med en unikhetskonflikt, oavsett hur anropen ligger i tid.
 *
 * En kontroll av typen "läs status, testa i JavaScript, skriv sedan" hade haft
 * ett kapplöpningsfönster mellan läsning och skrivning där två parallella
 * begäranden båda ser "har inte röstat". Det unika indexet stänger det
 * fönstret.
 *
 * Returnerar false om personen redan röstat på valsedeln.
 */
export async function markBallotAsVoted(
  voterStatusId: string,
  ballotId: string,
): Promise<boolean> {
  try {
    await votersDb.voterBallotStatus.create({
      data: {
        voterStatusId,
        ballotId,
        // Dygnsupplösning: se kommentaren om tidskorrelation i lib/time.ts.
        votedAt: truncateToDay(new Date()),
      },
    })
    return true
  } catch (error) {
    const isUniqueViolation =
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'

    if (isUniqueViolation) return false
    throw error
  }
}

/**
 * Det finns medvetet ingen funktion som ÅNGRAR en markering.
 *
 * Det vore frestande: om röstregistreringen misslyckas efter markeringen har
 * väljaren förlorat sin röst på den valsedeln. Men ett fel från
 * röstregistreringen betyder inte säkert att ingen röst skrevs — en timeout
 * kan komma från ett anrop som faktiskt landade. Att då ta bort markeringen
 * skulle öppna för dubbelröstning, vilket är ett värre fel än en förlorad
 * röst. Se resonemanget om ordning i orchestration/cast-vote.usecase.ts.
 */

/** Har personen röstat på alla valsedlar som gäller hen? */
export async function hasCompletedElection(
  voterStatusId: string,
  electionId: string,
): Promise<boolean> {
  const ballots = await ballotsForVoter(voterStatusId, electionId)
  return ballots.length > 0 && ballots.every((ballot) => ballot.hasVoted)
}

/**
 * Aggregat för adminvyn. Inga individuella rader lämnar modulen.
 *
 * Räknas per valsedel, eftersom en person kan ha röstat på en valsedel men
 * inte en annan. "Antal som röstat" utan valsedel vore en siffra utan
 * innebörd i ett val med tre valsedlar.
 */
export async function getVoterStatistics(electionId: string): Promise<{
  totalEligible: number
  perBallot: Array<{ ballotId: string; markedAsVoted: number }>
}> {
  const [totalEligible, ballots] = await Promise.all([
    votersDb.voterStatus.count({ where: { isEligible: true } }),
    votersDb.electionBallot.findMany({ where: { electionId }, select: { id: true } }),
  ])

  const perBallot = await Promise.all(
    ballots.map(async (ballot) => ({
      ballotId: ballot.id,
      markedAsVoted: await votersDb.voterBallotStatus.count({ where: { ballotId: ballot.id } }),
    })),
  )

  return { totalEligible, perBallot }
}
