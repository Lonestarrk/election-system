import { execSync } from 'node:child_process'

/**
 * Körs en gång före hela E2E-sviten.
 *
 * Nollställer röstdata och seedar om, så att sviten går att köra om. Utan det
 * blockeras andra körningen av dubbelröstningsspärren: testerna röstar på
 * riktigt och förbrukar väljarnas rösträtt.
 *
 * Seedningen körs EFTER nollställningen, i den ordningen. Omvänt skulle
 * nollställningen radera de markeringar seedningen just satt.
 */
export default function globalSetup() {
  const run = (script: string, label: string) => {
    try {
      const output = execSync(`npx tsx ${script}`, { encoding: 'utf8', stdio: 'pipe' })
      process.stdout.write(`[e2e-setup] ${output.trim()}\n`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `[e2e-setup] ${label} misslyckades. Kör databasen och migreringarna först:\n` +
          '  docker compose up -d postgres\n' +
          '  npm run migrate\n\n' +
          message,
      )
    }
  }

  run('prisma/reset-votes.ts', 'nollställningen')
  run('prisma/seed.ts', 'seedningen')
}
