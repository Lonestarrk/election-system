import { PrismaClient as VotersClient } from '.prisma/voters'
import { PrismaClient as VotesClient } from '.prisma/votes'

/**
 * Direkt databasåtkomst för E2E-testerna, på samma sätt som
 * prisma/reset-votes.ts och prisma/seed.ts som körs före sviten.
 *
 * Testerna använder det här för två saker som ingen rutt gör: att hämta
 * partiregistrets id:n när de skapar en egen omröstning, och att låta en
 * omröstning stänga NU. Stängningen vägrar före `closesAt`, och ett test som
 * röstar i den kan inte vänta på att den passerar. Ingenting här rör demovalet.
 */

const votersDb = new VotersClient()
const votesDb = new VotesClient()

/** Partiregistrets id för de angivna förkortningarna, i samma ordning. */
export async function partyIdsFor(...abbreviations: string[]): Promise<string[]> {
  const parties = await votesDb.party.findMany({ where: { abbreviation: { in: abbreviations } } })
  return abbreviations.map((abbreviation) => {
    const party = parties.find((candidate) => candidate.abbreviation === abbreviation)
    if (!party) throw new Error(`Partiet ${abbreviation} finns inte i registret. Har seedningen körts?`)
    return party.id
  })
}

/** Sätter omröstningens stängningstid till en minut sedan, i båda databaserna. */
export async function closeTimePassed(electionId: string): Promise<void> {
  const at = new Date(Date.now() - 60_000)
  await votersDb.election.update({ where: { id: electionId }, data: { closesAt: at } })
  await votesDb.election.update({ where: { id: electionId }, data: { closesAt: at } })
}

/**
 * Tar bort testets egen omröstning. De liggande kuverten måste bort först,
 * eftersom de saknar främmande nyckel mot valsedeln. Revisionskedjan lämnas
 * orörd: nollställningen före nästa körning tömmer den.
 */
export async function dropElection(electionId: string): Promise<void> {
  const ballots = await votersDb.electionBallot.findMany({ where: { electionId }, select: { id: true } })
  const ballotIds = ballots.map((ballot) => ballot.id)

  await votersDb.pendingVote.deleteMany({ where: { ballotId: { in: ballotIds } } })
  await votersDb.votedMarker.deleteMany({ where: { ballotId: { in: ballotIds } } })
  await votersDb.election.deleteMany({ where: { id: electionId } })
  await votesDb.election.deleteMany({ where: { id: electionId } })
}

export async function disconnect(): Promise<void> {
  await votersDb.$disconnect()
  await votesDb.$disconnect()
}
