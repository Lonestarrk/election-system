import { truncateToDay } from '@/lib/time'
import { votersDb } from './db'
import { hashPersonalNumber } from './identity'

/**
 * Röstberättigande och "har röstat"-status.
 *
 * Modulen svarar på exakt två frågor:
 *   – Får den här personen rösta?
 *   – Har den här personen redan röstat?
 *
 * Den kan inte svara på "vad röstade den här personen på?", eftersom svaret
 * inte finns i den databas modulen har tillgång till.
 */

export type EligibilityDecision =
  | { outcome: 'eligible'; voterStatusId: string }
  | { outcome: 'not_in_roll' }
  | { outcome: 'not_eligible' }
  | { outcome: 'already_voted' }

export async function evaluateEligibility(personalNumber: string): Promise<EligibilityDecision> {
  const identityHash = hashPersonalNumber(personalNumber)

  const voter = await votersDb.voterStatus.findUnique({
    where: { externalIdentityHash: identityHash },
    select: { id: true, isEligible: true, hasVoted: true },
  })

  if (!voter) return { outcome: 'not_in_roll' }
  if (!voter.isEligible) return { outcome: 'not_eligible' }
  if (voter.hasVoted) return { outcome: 'already_voted' }

  return { outcome: 'eligible', voterStatusId: voter.id }
}

/**
 * Markerar väljaren som röstande och konsumerar sessionen, atomiskt.
 *
 * Båda operationerna sker i samma transaktion med ett villkorat
 * `updateMany ... where hasVoted = false`. Det gör steget till den punkt där
 * dubbelröstning stoppas: två samtidiga anrop kan inte båda få
 * `count === 1`, eftersom PostgreSQL serialiserar raduppdateringarna.
 *
 * En kontroll av typen "läs hasVoted, testa i JavaScript, skriv sedan" hade
 * haft ett kapplöpningsfönster mellan läsning och skrivning där två parallella
 * begäranden båda ser `false`. Det villkorade skrivandet stänger det fönstret.
 *
 * Returnerar false om väljaren redan hunnit rösta.
 */
export async function markAsVotedAndConsumeSession(
  voterStatusId: string,
  sessionId: string,
): Promise<boolean> {
  return votersDb.$transaction(async (tx) => {
    const updated = await tx.voterStatus.updateMany({
      where: { id: voterStatusId, hasVoted: false, isEligible: true },
      data: {
        hasVoted: true,
        // Dygnsupplösning: se kommentaren om tidskorrelation i lib/time.ts.
        votedAt: truncateToDay(new Date()),
      },
    })

    if (updated.count !== 1) return false

    // Sessionen raderas, inte markeras som förbrukad. En kvarlämnad rad med
    // sessions-id skulle vara exakt den koppling mellan de två sidorna som
    // hela systemet är byggt för att undvika.
    await tx.votingSession.deleteMany({ where: { id: sessionId } })

    return true
  })
}

/** Aggregat för adminvyn. Inga individuella rader lämnar modulen. */
export async function getVoterStatistics(): Promise<{
  totalEligible: number
  totalVoted: number
}> {
  const [totalEligible, totalVoted] = await Promise.all([
    votersDb.voterStatus.count({ where: { isEligible: true } }),
    votersDb.voterStatus.count({ where: { hasVoted: true } }),
  ])

  return { totalEligible, totalVoted }
}
