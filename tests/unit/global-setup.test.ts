import { describe, expect, it, vi } from 'vitest'
import { prepareTestDatabases, type PreparationSteps } from '../global-setup'
import {
  TEST_DATABASES,
  resolveTestDatabase,
  type EnvironmentVariables,
  type ResolvedTestDatabase,
  type TestDatabase,
} from '../test-databases'

/**
 * Beslutet i tests/global-setup.ts om de databasberoende testerna ska köras,
 * hoppas över eller fallera — provat utan databas.
 *
 * Stegen som når nätverket byts ut: servern "svarar" eller "svarar inte" på
 * testets begäran, och migreringen är en attrapp som bara registrerar anropen.
 * Så går det att visa att en satt men otillgänglig server ger ett rött besked,
 * utan att någon databas behöver vara igång — eller stoppas mitt under en
 * utvecklingssession.
 */

const [voters, votes] = TEST_DATABASES as [TestDatabase, TestDatabase]

const DEV_ENV: EnvironmentVariables = {
  VOTERS_DATABASE_URL: 'postgresql://election:hemligt@localhost:5432/voters_db?schema=public',
  VOTES_DATABASE_URL: 'postgresql://election:hemligt@localhost:5432/votes_db?schema=public',
}

function resolve(env: EnvironmentVariables): Array<ResolvedTestDatabase | null> {
  return [resolveTestDatabase(voters, env), resolveTestDatabase(votes, env)]
}

function fakeSteps(serverAnswers: boolean, migrate: PreparationSteps['migrate'] = () => {}) {
  return {
    isServerReachable: vi.fn(async () => serverAnswers),
    migrate: vi.fn(migrate),
  }
}

describe('beskedet från global-setup till testfilerna', () => {
  it('fallerar när adressen är härledd och servern inte svarar', async () => {
    // Det här var den sista vägen till en grön körning utan databastester. En
    // stoppad container, en felskriven port i .env eller en tjänstecontainer i
    // CI som inte startat såg ut som en maskin utan Docker, och allt hoppades
    // över med slutkod 0.
    const steps = fakeSteps(false)

    const status = await prepareTestDatabases(resolve(DEV_ENV), DEV_ENV, steps)

    expect(status).toMatchObject({
      state: 'broken',
      reason: expect.stringContaining('localhost:5432 (härledd ur VOTERS_DATABASE_URL)'),
    })
    expect(status).toMatchObject({ reason: expect.stringContaining('SKIP_DB_TESTS=1') })
    expect(steps.migrate).not.toHaveBeenCalled()
  })

  it('fallerar när en uttryckligen satt server inte svarar', async () => {
    const env: EnvironmentVariables = {
      TEST_VOTERS_DATABASE_URL: 'postgresql://ci:hemligt@db.example:6543/voters_ci_test',
      TEST_VOTES_DATABASE_URL: 'postgresql://ci:hemligt@db.example:6543/votes_ci_test',
    }

    const status = await prepareTestDatabases(resolve(env), env, fakeSteps(false))

    expect(status).toMatchObject({
      state: 'broken',
      reason: expect.stringContaining('db.example:6543 (från TEST_VOTERS_DATABASE_URL)'),
    })
  })

  it('nämner aldrig lösenordet när servern inte svarar', async () => {
    // Beskedet skrivs ut i terminalen och i varje databasfils felmeddelande,
    // och testutdata hamnar i CI-loggar.
    const status = await prepareTestDatabases(resolve(DEV_ENV), DEV_ENV, fakeSteps(false))

    expect(status.state).toBe('broken')
    expect(JSON.stringify(status)).not.toContain('hemligt')
  })

  it('hoppar över när ingen adress är satt, utan att fråga någon server', async () => {
    // En nyklonad maskin utan .env: ingen har bett om databastester, och
    // enhetstesterna ska gå att köra ändå.
    const steps = fakeSteps(false)

    const status = await prepareTestDatabases(resolve({}), {}, steps)

    expect(status.state).toBe('skip')
    expect(steps.isServerReachable).not.toHaveBeenCalled()
    expect(steps.migrate).not.toHaveBeenCalled()
  })

  it('fallerar när bara den ena adressen är satt', async () => {
    // Testerna tömmer båda databaserna. En halv konfiguration är ingen maskin
    // utan databas, utan ett fel som ska synas.
    const env: EnvironmentVariables = { VOTERS_DATABASE_URL: DEV_ENV.VOTERS_DATABASE_URL }

    const status = await prepareTestDatabases(resolve(env), env, fakeSteps(true))

    expect(status).toMatchObject({
      state: 'broken',
      reason: expect.stringContaining('saknas för VOTES_DATABASE_URL'),
    })
  })

  it('hoppar över när SKIP_DB_TESTS=1, utan att fråga servern eller migrera', async () => {
    const env: EnvironmentVariables = { ...DEV_ENV, SKIP_DB_TESTS: '1' }
    const steps = fakeSteps(false)

    const status = await prepareTestDatabases(resolve(env), env, steps)

    expect(status).toMatchObject({
      state: 'skip',
      reason: expect.stringContaining('SKIP_DB_TESTS'),
    })
    expect(steps.isServerReachable).not.toHaveBeenCalled()
    expect(steps.migrate).not.toHaveBeenCalled()
  })

  it('räknar bara "1" och "true" som en begäran att hoppa över', async () => {
    // Ett värde som tolkas fel ska ge ett rött test för mycket, aldrig ett
    // tyst hoppat.
    for (const value of ['1', 'true', 'TRUE', ' 1 ']) {
      const env: EnvironmentVariables = { ...DEV_ENV, SKIP_DB_TESTS: value }
      const status = await prepareTestDatabases(resolve(env), env, fakeSteps(false))
      expect(status.state, `SKIP_DB_TESTS="${value}"`).toBe('skip')
    }

    for (const value of ['0', 'false', '', 'ja']) {
      const env: EnvironmentVariables = { ...DEV_ENV, SKIP_DB_TESTS: value }
      const status = await prepareTestDatabases(resolve(env), env, fakeSteps(false))
      expect(status.state, `SKIP_DB_TESTS="${value}"`).toBe('broken')
    }
  })

  it('migrerar båda testdatabaserna när servern svarar', async () => {
    const steps = fakeSteps(true)

    const status = await prepareTestDatabases(resolve(DEV_ENV), DEV_ENV, steps)

    expect(status.state).toBe('ready')
    expect(steps.migrate.mock.calls.map(([database]) => database.databaseName)).toEqual([
      'voters_test',
      'votes_test',
    ])
  })

  it('fallerar när migreringen misslyckas fast servern svarar', async () => {
    const steps = fakeSteps(true, () => {
      throw new Error('P3009: migreringen gick inte')
    })

    const status = await prepareTestDatabases(resolve(DEV_ENV), DEV_ENV, steps)

    expect(status).toMatchObject({
      state: 'broken',
      reason: expect.stringContaining('voters_test kunde inte migreras'),
    })
  })
})
