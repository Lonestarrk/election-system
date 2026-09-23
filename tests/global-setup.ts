import { execSync } from 'node:child_process'
import { connect } from 'node:net'
import type { TestProject } from 'vitest/node'
import {
  REPO_ROOT,
  loadDotEnvFile,
  redirectToTestDatabases,
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

async function prepareTestDatabases(
  databases: Array<ResolvedTestDatabase | null>,
): Promise<TestDatabaseStatus> {
  const resolved = databases.filter((database) => database !== null)

  if (resolved.length < databases.length) {
    return {
      state: 'skip',
      reason:
        'Databasadresser saknas — integrationstesterna hoppas över.\n' +
        'Starta databasen med: docker compose up -d postgres',
    }
  }

  for (const database of resolved) {
    if (await isServerReachable(database.url)) continue

    if (database.source === 'derived') {
      return {
        state: 'skip',
        reason:
          'Databasservern svarar inte — integrationstesterna hoppas över.\n' +
          'Starta databasen med: docker compose up -d postgres',
      }
    }

    return {
      state: 'broken',
      reason:
        `Servern i ${database.override} svarar inte. Variabeln är uttryckligen satt, så ` +
        'testerna hoppas inte över tyst — kontrollera adressen eller ta bort variabeln.',
    }
  }

  for (const database of resolved) {
    try {
      execSync(`npx prisma migrate deploy --schema=${database.schema}`, {
        cwd: REPO_ROOT,
        stdio: 'pipe',
        // process.env är redan omdirigerad ovan. Prisma-CLI:t läser också .env,
        // men skriver inte över en variabel som redan är satt.
        env: process.env,
      })
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

/**
 * Svarar det någon på databasens värd och port?
 *
 * Frågan "finns det en server alls?" besvaras med en TCP-anslutning i stället
 * för genom att tolka Prismas felutskrift. En port där ingen svarar betyder
 * ingen databas på maskinen, och då får testerna hoppas över. Allt som händer
 * efter en lyckad anslutning — fel lösenord, en databas som inte går att
 * skapa, en trasig migrering — är fel som ska synas.
 */
function isServerReachable(databaseUrl: string, timeoutMs = 2_000): Promise<boolean> {
  const url = new URL(databaseUrl)
  const host = url.hostname.replace(/^\[|\]$/g, '') || 'localhost'
  const port = Number(url.port || 5432)

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
