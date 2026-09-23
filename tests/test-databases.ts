import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Testdatabaserna: vilka de är, hur testerna hittar dem och hur man känner
 * igen dem.
 *
 * Integrationstesterna tömmer båda databaserna före varje test. Tidigare läste
 * de samma VOTERS_DATABASE_URL och VOTES_DATABASE_URL som utvecklingsservern,
 * så varje testkörning raderade det som syntes i webbläsaren. Nu pekas
 * variablerna om till ett eget par, voters_test och votes_test, innan någon
 * klient hunnit skapas.
 *
 * Modulen importerar ingen Prisma-klient, och får inte göra det. Den körs både
 * i Vitests huvudprocess (tests/global-setup.ts) och i varje testprocess
 * (tests/setup.ts), och en klient som skapades här skulle läsa adressen innan
 * omdirigeringen hunnit göras.
 */

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * process.env eller ett vanligt objekt. Inte NodeJS.ProcessEnv: Next.js
 * typdefinitioner gör NODE_ENV obligatorisk där, och då går funktionerna inte
 * att prova med en egen, påhittad miljö.
 */
export type EnvironmentVariables = Record<string, string | undefined>

/**
 * Laddar .env för testkörningen.
 *
 * Enkel egen parser i stället för dotenv: det är tjugo rader, och ett
 * beroende mindre i ett projekt vars hela poäng är att gå att granska.
 *
 * Ett värde som redan finns i miljön vinner över filen, precis som hos dotenv.
 * Därför måste `redirectToTestDatabases` köras EFTER den här funktionen och
 * skriva över utan villkor — annars skulle en VOTERS_DATABASE_URL från skalet,
 * eller den som filen just fyllde i, gå rakt igenom till klienterna.
 *
 * Filen läses från projektroten och inte från arbetskatalogen. Prisma-klienten
 * läser själv <projektroten>/.env när den skapas och fyller i det som saknas.
 * Läste testerna en annan fil kunde klienten fylla i utvecklingsadressen i en
 * lucka som testerna lämnat tom.
 */
export function loadDotEnvFile(env: EnvironmentVariables = process.env): void {
  const envPath = join(REPO_ROOT, '.env')
  if (!existsSync(envPath)) return

  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const separator = trimmed.indexOf('=')
    if (separator === -1) continue

    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '')

    if (!(key in env)) env[key] = value
  }
}

/**
 * Namnregeln: en databas vars namn slutar på `_test` får tömmas av testerna.
 * Allt annat antas vara någons riktiga data — i praktiken den som
 * utvecklingsservern visar — och rörs inte.
 *
 * Regeln gäller databasens namn som servern själv rapporterar det. Se
 * `assertConnectedToTestDatabases` i tests/integration/helpers.ts för varför
 * texten i en anslutningsadress inte räcker.
 */
export const TEST_DATABASE_SUFFIX = '_test'

export function isTestDatabaseName(name: string): boolean {
  return name.endsWith(TEST_DATABASE_SUFFIX)
}

export type TestDatabase = {
  /** Variabeln som Prisma-schemat och klienten läser. */
  variable: 'VOTERS_DATABASE_URL' | 'VOTES_DATABASE_URL'
  /** Är den satt används den som den är, i stället för att härledas. */
  override: 'TEST_VOTERS_DATABASE_URL' | 'TEST_VOTES_DATABASE_URL'
  /** Namnet som härledningen sätter in i utvecklingsadressen. */
  databaseName: 'voters_test' | 'votes_test'
  schema: 'prisma/voters/schema.prisma' | 'prisma/votes/schema.prisma'
}

export const TEST_DATABASES: readonly TestDatabase[] = [
  {
    variable: 'VOTERS_DATABASE_URL',
    override: 'TEST_VOTERS_DATABASE_URL',
    databaseName: 'voters_test',
    schema: 'prisma/voters/schema.prisma',
  },
  {
    variable: 'VOTES_DATABASE_URL',
    override: 'TEST_VOTES_DATABASE_URL',
    databaseName: 'votes_test',
    schema: 'prisma/votes/schema.prisma',
  },
]

export type ResolvedTestDatabase = TestDatabase & {
  url: string
  /**
   * 'explicit' när adressen kom från TEST_*-variabeln, 'derived' när den
   * räknades fram ur utvecklingsadressen. Det avgör inte om testerna körs —
   * en server som inte svarar är ett fel i båda fallen — men felmeddelandet
   * måste peka på variabeln som faktiskt ska rättas.
   */
  source: 'explicit' | 'derived'
}

/**
 * Felmeddelandena nämner variabeln men aldrig värdet: adressen innehåller
 * lösenordet, och testutdata hamnar i CI-loggar.
 */
function parsePostgresUrl(value: string, variable: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${variable} går inte att tolka som en databasadress.`)
  }

  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error(`${variable} är ingen PostgreSQL-adress (schemat är "${url.protocol}").`)
  }

  return url
}

/**
 * Räknar fram adressen till en testdatabas.
 *
 * Utan TEST_*-variabel byts bara databasnamnet i utvecklingsadressen ut.
 * Användare, lösenord, värd, port och frågesträng behålls, så testerna hamnar
 * på samma server som utvecklingsservern utan att någon behöver hålla två
 * uppsättningar inloggningsuppgifter i synk.
 */
export function resolveTestDatabase(
  database: TestDatabase,
  env: EnvironmentVariables = process.env,
): ResolvedTestDatabase | null {
  const explicit = env[database.override]?.trim()

  if (explicit) {
    const name = decodeURIComponent(parsePostgresUrl(explicit, database.override).pathname.slice(1))

    // En förkontroll av adressens sökväg, så att en felskriven TEST_*-variabel
    // stoppas innan global-setup migrerar något. Den ersätter inte vakten i
    // helpers.ts — det är den som frågar servern och avgör vad en radering
    // faktiskt träffar.
    if (!isTestDatabaseName(name)) {
      throw new Error(
        `${database.override} pekar på databasen "${name}", vars namn inte slutar på ` +
          `"${TEST_DATABASE_SUFFIX}". Testerna tömmer databasen de kör mot; ange en ` +
          `databas som bara finns för testerna, till exempel "${database.databaseName}".`,
      )
    }

    return { ...database, url: explicit, source: 'explicit' }
  }

  const development = env[database.variable]?.trim()
  if (!development) return null

  const url = parsePostgresUrl(development, database.variable)
  url.pathname = `/${database.databaseName}`

  return { ...database, url: url.toString(), source: 'derived' }
}

/**
 * Pekar om klienternas variabler till testdatabaserna.
 *
 * Skriver över utan villkor, eftersom värdet som redan står där är precis det
 * som inte får vinna: utvecklingsadressen, från skalet eller från .env.
 * Omdirigeringen är idempotent — en redan omdirigerad adress härleds till sig
 * själv — så det gör inget att den körs både i huvudprocessen och i varje
 * testprocess.
 *
 * En variabel som saknas lämnas orörd, och tas aldrig bort: Prisma-klienten
 * fyller i det som saknas ur .env, och en borttagen variabel skulle därför
 * komma tillbaka som utvecklingsadressen.
 */
export function redirectToTestDatabases(
  env: EnvironmentVariables = process.env,
): Array<ResolvedTestDatabase | null> {
  return TEST_DATABASES.map((database) => {
    const resolved = resolveTestDatabase(database, env)
    if (resolved) env[database.variable] = resolved.url
    return resolved
  })
}

/**
 * Variabeln som uttryckligen ber om att de databasberoende testerna hoppas
 * över. Den enda vägen till ett hoppat databastest när en adress är satt.
 */
export const SKIP_DATABASE_TESTS_VARIABLE = 'SKIP_DB_TESTS'

/**
 * Har någon uttryckligen bett om att slippa de databasberoende testerna?
 *
 * Bara "1" och "true" räknas. "0", "false" eller ett felskrivet värde betyder
 * att testerna körs: en feltolkning ska hellre ge ett rött test för mycket än
 * tyst hoppa över dem, eftersom en hoppad körning ser lika grön ut som en
 * lyckad.
 */
export function isDatabaseSkipRequested(env: EnvironmentVariables = process.env): boolean {
  const value = env[SKIP_DATABASE_TESTS_VARIABLE]?.trim().toLowerCase()
  return value === '1' || value === 'true'
}

/**
 * Beskedet från tests/global-setup.ts till testfilerna, via `provide`/`inject`.
 *
 * - ready: testdatabaserna finns och har aktuellt schema.
 * - skip: ingen databasadress är satt alls, eller SKIP_DB_TESTS=1 ber om det.
 *   Bara då får testerna hoppas över — i båda fallen har någon valt det.
 * - broken: något som borde fungera gör det inte, till exempel en satt adress
 *   vars server inte svarar. Testfilerna fallerar på det.
 */
export type TestDatabaseStatus =
  | { state: 'ready' }
  | { state: 'skip'; reason: string }
  | { state: 'broken'; reason: string }

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabases: TestDatabaseStatus
  }
}
