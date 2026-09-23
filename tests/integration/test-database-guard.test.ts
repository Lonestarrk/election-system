import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { PrismaClient as VotersClient } from '.prisma/voters'
import { PrismaClient as VotesClient } from '.prisma/votes'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import {
  assertConnectedToTestDatabases,
  createTestElection,
  createVoter,
  disconnect,
  isDatabaseAvailable,
  resetElectionData,
  voteOnce,
} from './helpers'

/**
 * Vakten som hindrar testerna från att tömma något annat än testdatabaserna.
 *
 * Lockbetet är underhållsdatabasen `postgres`, som finns på varje
 * PostgreSQL-server och som testerna aldrig skriver i. Adressen dit får ändå
 * "_test" i frågesträngen, för att visa att vakten frågar servern i stället för
 * att läsa adressen. Mot lockbetet körs bara `SELECT current_database()`.
 */

const databaseAvailable = await isDatabaseAvailable()

/** Samma server och inloggning som testdatabasen, men databasen `postgres`. */
function decoyUrl(testDatabaseUrl: string): string {
  const url = new URL(testDatabaseUrl)
  url.pathname = '/postgres'
  url.searchParams.set('schema', 'lockbete_test')
  return url.toString()
}

const decoys = databaseAvailable
  ? {
      voters: new VotersClient({
        datasourceUrl: decoyUrl(process.env.VOTERS_DATABASE_URL!),
        log: ['error'],
      }),
      votes: new VotesClient({
        datasourceUrl: decoyUrl(process.env.VOTES_DATABASE_URL!),
        log: ['error'],
      }),
    }
  : null

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  if (!databaseAvailable) return
  await decoys?.voters.$disconnect()
  await decoys?.votes.$disconnect()
  await disconnect()
})

describe.skipIf(!databaseAvailable)('vakten mot fel databas', () => {
  it('släpper igenom när båda klienterna är anslutna till testdatabaser', async () => {
    await expect(assertConnectedToTestDatabases()).resolves.toBeUndefined()
  })

  it('stoppar när röstdatabasen inte är en testdatabas, trots "_test" i adressen', async () => {
    await expect(
      assertConnectedToTestDatabases({ voters: votersDb, votes: decoys!.votes }),
    ).rejects.toThrow('röstdatabasen → "postgres"')
  })

  it('stoppar när röstlängden inte är en testdatabas, även om röstdatabasen är det', async () => {
    // Båda måste klara kontrollen. En halvt omdirigerad körning skulle annars
    // tömma den ena databasen i någons riktiga data.
    await expect(
      assertConnectedToTestDatabases({ voters: decoys!.voters, votes: votesDb }),
    ).rejects.toThrow('röstlängden → "postgres"')
  })

  it('resetElectionData raderar ingenting när vakten slår till', async () => {
    await resetElectionData()
    const election = await createTestElection()
    const voterId = await createVoter('199001011234')
    expect((await voteOnce(voterId, election)).status).toBe('voted')

    // Servern "svarar" att röstdatabasen är utvecklingsdatabasen. Rösten ligger
    // i röstdatabasen och väljaren i röstlängden, så en enda radering före
    // vakten — på vilken sida som helst — syns i räkningen nedan.
    vi.spyOn(votesDb, '$queryRaw').mockResolvedValueOnce([{ name: 'votes_db' }] as never)

    await expect(resetElectionData()).rejects.toThrow('röstdatabasen → "votes_db"')

    vi.restoreAllMocks()
    expect(await votesDb.vote.count()).toBe(1)
    expect(await votersDb.voterStatus.count()).toBe(1)
    expect(await votersDb.voterBallotStatus.count()).toBe(1)
  })
})
