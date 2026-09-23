import { describe, expect, it } from 'vitest'
import {
  TEST_DATABASES,
  redirectToTestDatabases,
  resolveTestDatabase,
  type EnvironmentVariables,
  type TestDatabase,
} from '../test-databases'

/**
 * Omdirigeringen till testdatabaserna, provad utan databas.
 *
 * Det är den som ser till att integrationstesterna tömmer voters_test och
 * votes_test i stället för det utvecklingsservern visar. Vakten i
 * tests/integration/helpers.ts fångar det som ändå slinker igenom, men den kan
 * bara vägra — det är omdirigeringen som gör att det finns något att köra mot.
 */

const [voters, votes] = TEST_DATABASES as [TestDatabase, TestDatabase]

const DEV_VOTERS = 'postgresql://election:election@localhost:5432/voters_db?schema=public'
const DEV_VOTES = 'postgresql://election:election@localhost:5432/votes_db?schema=public'

describe('omdirigeringen till testdatabaserna', () => {
  it('byter bara databasnamnet i utvecklingsadressen', () => {
    expect(resolveTestDatabase(voters, { VOTERS_DATABASE_URL: DEV_VOTERS })).toMatchObject({
      url: 'postgresql://election:election@localhost:5432/voters_test?schema=public',
      source: 'derived',
    })
    expect(resolveTestDatabase(votes, { VOTES_DATABASE_URL: DEV_VOTES })).toMatchObject({
      url: 'postgresql://election:election@localhost:5432/votes_test?schema=public',
      source: 'derived',
    })
  })

  it('skriver över en utvecklingsadress som redan står i miljön', () => {
    // Precis det här var felet: värdet från skalet eller .env vann, och varje
    // testkörning tömde databasen som utvecklingsservern visar.
    const env: EnvironmentVariables = { VOTERS_DATABASE_URL: DEV_VOTERS, VOTES_DATABASE_URL: DEV_VOTES }

    redirectToTestDatabases(env)

    expect(env.VOTERS_DATABASE_URL).toBe(
      'postgresql://election:election@localhost:5432/voters_test?schema=public',
    )
    expect(env.VOTES_DATABASE_URL).toBe(
      'postgresql://election:election@localhost:5432/votes_test?schema=public',
    )
  })

  it('ger samma adress när den körs igen', () => {
    // Omdirigeringen körs både i huvudprocessen och i varje testprocess. Gav
    // andra varvet en annan adress skulle testerna ansluta till något annat än
    // det global-setup migrerade.
    const env: EnvironmentVariables = { VOTERS_DATABASE_URL: DEV_VOTERS, VOTES_DATABASE_URL: DEV_VOTES }

    redirectToTestDatabases(env)
    const first = { ...env }
    redirectToTestDatabases(env)

    expect(env).toEqual(first)
  })

  it('använder TEST_*-variabeln som den är, före utvecklingsadressen', () => {
    const explicit = 'postgresql://ci:ci@db.example:6543/voters_ci_test?schema=public'

    expect(
      resolveTestDatabase(voters, {
        VOTERS_DATABASE_URL: DEV_VOTERS,
        TEST_VOTERS_DATABASE_URL: explicit,
      }),
    ).toMatchObject({ url: explicit, source: 'explicit' })
  })

  it('godtar inte en TEST_*-variabel vars databas inte slutar på _test, hur mycket "_test" adressen än innehåller', () => {
    // "_test" i lösenordet, värdnamnet och frågesträngen — men databasen är
    // votes_db. Bara sökvägen räknas.
    const env: EnvironmentVariables = {
      TEST_VOTES_DATABASE_URL:
        'postgresql://election:losen_test@db_test.example:5432/votes_db?schema=lockbete_test',
    }

    expect(() => resolveTestDatabase(votes, env)).toThrow(/"votes_db"/)
  })

  it('nämner aldrig adressen i ett fel, eftersom den innehåller lösenordet', () => {
    for (const value of ['mysql://election:hemligt@localhost/voters_db', '//election:hemligt@localhost/voters_db']) {
      const env: EnvironmentVariables = { VOTERS_DATABASE_URL: value }

      expect(() => resolveTestDatabase(voters, env)).toThrow(/VOTERS_DATABASE_URL/)
      expect(() => resolveTestDatabase(voters, env)).not.toThrow(/hemligt/)
    }
  })

  it('lägger inte till någon variabel när ingen adress finns', () => {
    // Enhetstesterna ska gå att köra utan .env och utan databas. Då finns
    // ingenting att peka om, och integrationstesterna hoppas över.
    const env: EnvironmentVariables = {}

    expect(redirectToTestDatabases(env)).toEqual([null, null])
    expect(env).toEqual({})
  })
})
