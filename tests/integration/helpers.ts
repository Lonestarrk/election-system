import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/anonymous-vote/db'
import { hashPersonalNumber } from '@/modules/eligibility/identity'

/**
 * Hjälpfunktioner för integrationstesterna.
 *
 * OBSERVERA: `resetElectionData` tömmer röstlängd, sessioner, röster och
 * revisionslogg. Kör testerna mot utvecklingsdatabasen och du förlorar
 * demodatan — kör `npm run seed` efteråt. Partierna lämnas kvar eftersom de är
 * referensdata.
 */

export async function isDatabaseAvailable(): Promise<boolean> {
  if (!process.env.VOTERS_DATABASE_URL || !process.env.VOTES_DATABASE_URL) return false

  try {
    await votersDb.$queryRaw`SELECT 1`
    await votesDb.$queryRaw`SELECT 1`
    return true
  } catch {
    return false
  }
}

export async function resetElectionData(): Promise<void> {
  await votersDb.votingSession.deleteMany()
  await votersDb.voterStatus.deleteMany()
  await votersDb.auditEvent.deleteMany()
  await votesDb.anonymousVote.deleteMany()

  const partyCount = await votesDb.party.count()
  if (partyCount === 0) {
    await votesDb.party.createMany({
      data: [
        { name: 'Socialdemokraterna', abbreviation: 'S', color: '#E8112D', displayOrder: 1 },
        { name: 'Moderaterna', abbreviation: 'M', color: '#52BDEC', displayOrder: 2 },
        { name: 'Centerpartiet', abbreviation: 'C', color: '#009933', displayOrder: 3 },
      ],
    })
  }
}

export async function createVoter(
  personalNumber: string,
  options: { isEligible?: boolean; hasVoted?: boolean } = {},
): Promise<string> {
  const voter = await votersDb.voterStatus.create({
    data: {
      externalIdentityHash: hashPersonalNumber(personalNumber),
      isEligible: options.isEligible ?? true,
      hasVoted: options.hasVoted ?? false,
      votedAt: options.hasVoted ? new Date() : null,
    },
    select: { id: true },
  })

  return voter.id
}

export async function firstPartyId(): Promise<string> {
  const party = await votesDb.party.findFirst({ orderBy: { displayOrder: 'asc' } })
  if (!party) throw new Error('Inga partier i databasen.')
  return party.id
}

export async function disconnect(): Promise<void> {
  await votersDb.$disconnect()
  await votesDb.$disconnect()
}
