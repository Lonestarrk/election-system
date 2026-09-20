import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Kör migreringarna mot testdatabaserna innan testsviten startar.
 *
 * Om ingen databas är tillgänglig hoppas steget över: enhetstesterna och de
 * statiska arkitekturtesterna ska kunna köras utan Docker. Integrationstesterna
 * upptäcker själva att databasen saknas och rapporterar det som ett hoppat
 * test i stället för ett kraschat.
 */

function loadEnvFile() {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return

  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator === -1) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '')
    if (!(key in process.env)) process.env[key] = value
  }
}

export default function globalSetup() {
  loadEnvFile()

  if (!process.env.VOTERS_DATABASE_URL || !process.env.VOTES_DATABASE_URL) {
    console.warn(
      '\n  Databasadresser saknas — integrationstesterna hoppas över.\n' +
        '  Starta databasen med: docker compose up -d postgres\n',
    )
    return
  }

  try {
    execSync('npx prisma migrate deploy --schema=prisma/voters/schema.prisma', { stdio: 'pipe' })
    execSync('npx prisma migrate deploy --schema=prisma/votes/schema.prisma', { stdio: 'pipe' })
  } catch {
    // Testfilerna gör sin egen anslutningskontroll och hoppar över sig själva,
    // så migreringsfelet behöver inte signaleras vidare här.
    console.warn(
      '\n  Kunde inte migrera testdatabaserna — integrationstesterna hoppas över.\n' +
        '  Starta databasen med: docker compose up -d postgres\n',
    )
  }
}
