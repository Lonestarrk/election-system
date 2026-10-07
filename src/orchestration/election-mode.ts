import { electionBelongsToThisServer } from '@/lib/election-environment'
import { votesDb } from '@/modules/ballot-box/db'
import { votersDb } from '@/modules/eligibility/db'

/**
 * Hör omröstningen till det läge och den BankID-miljö servern kör i? (uppgift
 * 17, och härdningen, punkt 3)
 *
 * Läget och miljön står i båda databaserna, och BÅDA raderna ska stämma: en rad
 * som skrivits om ensam ska inte räcka. Svaret har tre värden:
 *
 *   ok       båda raderna finns och stämmer med serverns läge och miljö
 *   wrong    någon rad har ett annat läge eller en annan miljö. Anroparen
 *            vägrar, och rör ingenting
 *   unknown  omröstningen saknar rad i röstlängden. Då finns ingen fas att
 *            skydda, och anroparen ger samma svar som för en okänd omröstning.
 *            En omröstning som bara har en rad i röstdatabasen får alltså inte
 *            ett lägesbesked, och det är avsiktligt och inte ett förbiseende.
 *
 * Den som kan skriva i båda databaserna kan ändra läget och miljön. Spärren
 * skyddar mot ett misstag, inte mot en sådan skrivning, se
 * `demo-trustee-passphrases-known` i src/lib/known-limitations.ts.
 */
export type ModeCheck = 'ok' | 'wrong' | 'unknown'

const SELECTED = { mode: true, bankIdEnvironment: true } as const

export async function checkElectionMode(electionId: string): Promise<ModeCheck> {
  const voters = await votersDb.election.findUnique({ where: { id: electionId }, select: SELECTED })
  if (!voters) return 'unknown'

  const votes = await votesDb.election.findUnique({ where: { id: electionId }, select: SELECTED })

  const rows = votes ? [voters, votes] : [voters]
  return rows.every(electionBelongsToThisServer) ? 'ok' : 'wrong'
}
