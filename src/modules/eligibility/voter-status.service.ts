import { votersDb } from './db'
import { hashPersonalNumber } from './identity'
import { ballotsForVoter, type MirroredBallot } from './election.service'

/**
 * Röstberättigande och administratörer.
 *
 * Modulen svarar på: får den här personen rösta i den här omröstningen, och är hen administratör?
 *
 * Den svarar inte på om personen har röstat. Fram till stängningen kan väljaren ändra sin röst,
 * så ingen legitimering avvisas för att ett kuvert redan finns, och att ha röstat besvaras av
 * participation.service.ts ur kuvertmodellens tabeller. Den kan inte heller svara på "vad röstade
 * den här personen på?", eftersom svaret inte finns i den databas modulen har tillgång till.
 */

export type EligibilityDecision =
  | {
      outcome: 'eligible'
      voterStatusId: string
      isAdmin: boolean
      /** Valsedlar som gäller personen. */
      ballots: MirroredBallot[]
    }
  | { outcome: 'not_in_roll' }
  | { outcome: 'not_eligible' }
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
 * Antalet röstberättigade, till adminvyn. Inga individuella rader lämnar modulen. Antalet röstande per
 * valsedel räknas av `turnoutByBallot` i participation.service.ts, ur kuvertmodellens tabeller.
 */
export async function getVoterStatistics(): Promise<{ totalEligible: number }> {
  return { totalEligible: await votersDb.voterStatus.count({ where: { isEligible: true } }) }
}
