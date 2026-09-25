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
  const identityHash = await hashPersonalNumber(personalNumber)

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
  const identityHash = await hashPersonalNumber(personalNumber)

  const voter = await votersDb.voterStatus.findUnique({
    where: { externalIdentityHash: identityHash },
    select: { id: true, isAdmin: true },
  })

  if (!voter) return { outcome: 'not_in_roll' }
  if (!voter.isAdmin) return { outcome: 'not_admin' }

  return { outcome: 'admin', voterStatusId: voter.id }
}

/**
 * SPÄRREN MELLAN DET GAMLA FLÖDETS BOK OCH KUVERTEN (uppgift 12).
 *
 * En väljare får ha en röst på en valsedel i en av böckerna, inte i båda:
 * antingen en markering här, i det gamla flödets voter_ballot_status, eller ett
 * kuvert i pending_vote, och efter stängningen en markering i voted_marker.
 * Röstsidan spärrade det redan, men inte servern (granskningen av uppgift
 * 14). Ingen räkning dubblerar, eftersom böckerna aldrig räknas ihop, men
 * spärren ska finnas på servern innan kuverten räknas. Den tas bort med det
 * gamla flödet i uppgift 15.
 *
 * VÄLJARENS RAD ÄR LÅSET. Läggningen av ett kuvert och utfärdandet av ett
 * röstintyg skriver i var sin tabell, och ingen av dem ser den andras oskrivna
 * rad. Utan ett gemensamt lås hade båda kunnat pröva den andra boken, se
 * ingenting och skriva. Båda tar därför väljarens rad i röstlängden i sin
 * transaktion innan de prövar den andra boken: läggningen med `FOR SHARE` och
 * utfärdandet med `FOR NO KEY UPDATE`. De två lägena stänger ute varandra, så
 * den som kommer sist väntar tills den första är klar och ser då dess rad.
 *
 * TVÅ LÄGGNINGAR STÄNGER INTE UTE VARANDRA. `FOR SHARE` krockar inte med sig
 * självt, så två läggningar för samma väljare går som förut, och deras
 * kapplöpning avgörs av det unika indexet och räknaren i skrivningen (ruling
 * 127). Ett lås som gjorde läggningarna seriella hade dessutom ändrat det
 * flödet i onödan. Inget av lägena stänger ute främmande nycklar som pekar på
 * raden, så skalningens markeringar och en ny session väntar inte på dem.
 *
 * Läsningen av det gamla flödets bok står här, i det gamla flödets fil, så att
 * den försvinner med flödet.
 */
export type BallotBooksClient = Pick<typeof votersDb, '$queryRaw' | 'voterBallotStatus'>

/** Läggningens del av låset, i läggningens transaktion, innan det gamla flödets bok prövas. */
export async function holdVoterBooksForEnvelope(client: BallotBooksClient, voterStatusId: string): Promise<void> {
  await client.$queryRaw`SELECT 1 AS locked FROM voter_status WHERE id = ${voterStatusId} FOR SHARE`
}

/** Utfärdandets del av låset, i utfärdandets transaktion, innan kuvertens bok prövas. */
export async function holdVoterBooksForOldFlow(client: BallotBooksClient, voterStatusId: string): Promise<void> {
  await client.$queryRaw`SELECT 1 AS locked FROM voter_status WHERE id = ${voterStatusId} FOR NO KEY UPDATE`
}

/** Har väljaren en röst på valsedeln i det gamla flödet? Läses i läggningens transaktion, efter låset. */
export async function votedInOldFlow(
  client: BallotBooksClient,
  voterStatusId: string,
  ballotId: string,
): Promise<boolean> {
  const marking = await client.voterBallotStatus.findUnique({
    where: { voterStatusId_ballotId: { voterStatusId, ballotId } },
    select: { id: true },
  })
  return marking !== null
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
