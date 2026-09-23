import { execSync } from 'node:child_process'
import { connect } from 'node:net'
import type { TestProject } from 'vitest/node'
import {
  REPO_ROOT,
  SKIP_DATABASE_TESTS_VARIABLE,
  TEST_DATABASES,
  isDatabaseSkipRequested,
  loadDotEnvFile,
  redirectToTestDatabases,
  type EnvironmentVariables,
  type ResolvedTestDatabase,
  type TestDatabaseStatus,
} from './test-databases'

/**
 * Migrerar testdatabaserna innan testsviten startar, och berättar för
 * testfilerna om de får hoppa över sig själva.
 *
 * `prisma migrate deploy` körs vid varje testkörning, mot voters_test och
 * votes_test — aldrig mot utvecklingsdatabaserna. En migrering som läggs till
 * senare kan därför inte lämna testerna mot ett gammalt schema: nästa körning
 * tar in den innan första testet. Deploy och inte `migrate dev`: deploy
 * tillämpar bara befintliga migreringar och genererar ingen klient, så den rör
 * inte query-motorn som en körande utvecklingsserver håller låst på Windows.
 * Den skapar också en databas som saknas, så en Docker-volym från tiden före
 * testdatabaserna fungerar utan något manuellt steg.
 *
 * Utfallet lämnas till testfilerna via `provide`. Tidigare avgjorde varje fil
 * själv, med ett `SELECT 1`, och ett misslyckat anrop blev ett hoppat test. Då
 * såg en körning där testdatabasen saknades likadan ut som en lyckad.
 */

export default async function globalSetup(project: TestProject): Promise<void> {
  loadDotEnvFile()

  // Samma omdirigering som tests/setup.ts gör i varje testprocess, med samma
  // indata — så att det som migreras här är exakt det testerna sedan ansluter
  // till. En ogiltig adress kastar, och får avbryta körningen: då går det inte
  // att veta vilken databas testerna skulle ha hamnat i.
  const databases = redirectToTestDatabases()

  const status = await prepareTestDatabases(databases)

  if (status.state !== 'ready') {
    const banner = `\n  ${status.reason.split('\n').join('\n  ')}\n`
    if (status.state === 'skip') console.warn(banner)
    else console.error(banner)
  }

  project.provide('testDatabases', status)
}

/**
 * De två stegen som når nätverket. De går att byta ut, så att beslutet nedan
 * kan provas utan att någon databas behöver vara igång — eller stoppas.
 */
export type PreparationSteps = {
  isServerReachable: (databaseUrl: string) => Promise<boolean>
  migrate: (database: ResolvedTestDatabase) => void
}

/**
 * Avgör om de databasberoende testerna ska köras, hoppas över eller fallera,
 * och migrerar testdatabaserna när testerna ska köras.
 *
 * Hoppas över får testerna bara i två lägen, och i båda har någon valt det:
 *
 * - Ingen databasadress är satt alls. Då har ingen bett om databastester — en
 *   nyklonad maskin utan .env, där enhetstesterna ändå ska gå att köra.
 * - SKIP_DB_TESTS=1 är satt. Då har någon uttryckligen bett om att slippa dem.
 *
 * Allt annat är ett fel. En adress i .env, i skalet eller i CI betyder att
 * databastesterna ska köras. Tidigare hoppades de över när servern bakom en
 * härledd adress inte svarade, men då såg en maskin utan Docker likadan ut som
 * en stoppad container, en felskriven port eller en tjänstecontainer i CI som
 * inte hunnit starta — och alla fyra gav en grön körning där inget
 * databastest hade körts.
 */
export async function prepareTestDatabases(
  databases: Array<ResolvedTestDatabase | null>,
  env: EnvironmentVariables = process.env,
  steps: PreparationSteps = { isServerReachable, migrate: migrateTestDatabase },
): Promise<TestDatabaseStatus> {
  // Före allt annat, så att den som bett om att slippa databasen inte heller
  // får vänta på en anslutning eller en migrering.
  if (isDatabaseSkipRequested(env)) {
    return {
      state: 'skip',
      reason:
        `${SKIP_DATABASE_TESTS_VARIABLE} är satt — de databasberoende testerna hoppas över ` +
        'på begäran.',
    }
  }

  const resolved = databases.filter((database) => database !== null)

  if (resolved.length === 0) {
    return {
      state: 'skip',
      reason:
        'Inga databasadresser är satta — de databasberoende testerna hoppas över.\n' +
        'Kopiera .env.example till .env och starta databasen med: docker compose up -d postgres',
    }
  }

  // Den ena adressen men inte den andra är ingen maskin utan databas, utan en
  // halv konfiguration. Testerna rör båda databaserna och kan inte köras mot
  // bara den ena.
  if (resolved.length < TEST_DATABASES.length) {
    const missing = TEST_DATABASES.filter(
      (database) => !resolved.some((present) => present.variable === database.variable),
    )
    return {
      state: 'broken',
      reason:
        `Databasadress saknas för ${missing.map((database) => database.variable).join(' och ')}, ` +
        `fast ${resolved.map(addressOrigin).join(' och ')} är satt. De databasberoende ` +
        'testerna behöver båda databaserna och fallerar hellre än att hoppas över tyst — ' +
        'sätt båda adresserna, eller ingen av dem.',
    }
  }

  for (const database of resolved) {
    if (await steps.isServerReachable(database.url)) continue

    // Värd och port, men aldrig hela adressen: den innehåller lösenordet, och
    // testutdata hamnar i CI-loggar.
    const { host, port } = serverAddress(database.url)
    return {
      state: 'broken',
      reason:
        `Databasservern på ${host}:${port} (${addressOriginDescription(database)}) svarar inte. ` +
        'En databasadress är satt, så de databasberoende testerna ska köras — de fallerar ' +
        'hellre än att hoppas över tyst. Övriga tester körs som vanligt.\n' +
        'Starta databasen med: docker compose up -d postgres\n' +
        `Ska testerna uttryckligen köras utan databas: sätt ${SKIP_DATABASE_TESTS_VARIABLE}=1.`,
    }
  }

  for (const database of resolved) {
    try {
      steps.migrate(database)
    } catch (error) {
      return {
        state: 'broken',
        reason:
          `Testdatabasen ${database.databaseName} kunde inte migreras, fast databasservern ` +
          'svarar. Integrationstesterna fallerar hellre än att köra mot ett gammalt schema ' +
          'eller hoppas över tyst.\n' +
          processOutput(error),
      }
    }
  }

  return { state: 'ready' }
}

/** Variabeln som adressen kom från — den som ska rättas om något är fel. */
function addressOrigin(database: ResolvedTestDatabase): string {
  return database.source === 'explicit' ? database.override : database.variable
}

function addressOriginDescription(database: ResolvedTestDatabase): string {
  return database.source === 'explicit'
    ? `från ${database.override}`
    : `härledd ur ${database.variable}`
}

function migrateTestDatabase(database: ResolvedTestDatabase): void {
  execSync(`npx prisma migrate deploy --schema=${database.schema}`, {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    // process.env är redan omdirigerad i globalSetup. Prisma-CLI:t läser också
    // .env, men skriver inte över en variabel som redan är satt.
    env: process.env,
  })
}

function serverAddress(databaseUrl: string): { host: string; port: number } {
  const url = new URL(databaseUrl)
  return {
    host: url.hostname.replace(/^\[|\]$/g, '') || 'localhost',
    port: Number(url.port || 5432),
  }
}

/**
 * Svarar det någon på databasens värd och port?
 *
 * Frågan besvaras med en TCP-anslutning i stället för genom att tolka Prismas
 * felutskrift. Svaret avgör inte OM testerna ska köras — en satt adress betyder
 * att de ska det — utan vilket fel som rapporteras. "Servern svarar inte" pekar
 * mot en stoppad container eller en felskriven värd eller port. Allt som
 * händer efter en lyckad anslutning — fel lösenord, en databas som inte går att
 * skapa, en trasig migrering — rapporteras som ett migreringsfel. Utan
 * kontrollen skulle en server som inte svarar beskrivas som en migrering som
 * misslyckats, och felsökningen börja på fel ställe.
 */
function isServerReachable(databaseUrl: string, timeoutMs = 2_000): Promise<boolean> {
  const { host, port } = serverAddress(databaseUrl)

  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const settle = (reachable: boolean) => {
      socket.destroy()
      resolve(reachable)
    }
    socket.setTimeout(timeoutMs, () => settle(false))
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}

function processOutput(error: unknown): string {
  const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer }
  const output = `${stderr?.toString() ?? ''}\n${stdout?.toString() ?? ''}`.trim()
  return output || String(error)
}
