import { listElectionPhases, type ElectionPhase } from '@/modules/eligibility/election.service'

/**
 * Fasen för varje omröstning, till den offentliga listan över omröstningar.
 *
 * Fasen bor i röstlängden, och listan över omröstningar läser den anonyma
 * modulens tabell. En rutt får inte importera båda modulerna, så fasen hämtas
 * här. Filen ser bara röstlängden och läser inget som räknar: id, namn och fas
 * (uppgift 14e, spec 6.2).
 */
export async function electionPhases(): Promise<ElectionPhase[]> {
  return listElectionPhases()
}

export type { ElectionPhase }
