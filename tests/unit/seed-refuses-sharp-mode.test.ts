import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Seedningen vägrar köra utanför demoläget (uppgift 17).
 *
 * Den skapar demovalet med förtroendemännens kända fraser och en administratör
 * med ett känt personnummer. Skriptet körs här som en egen process, eftersom
 * vägran ska gälla den som kör `npm run seed` och inte bara en funktion i
 * testprocessen. Databasadressen pekar på en port där ingen lyssnar: vägran
 * ska komma före varje databasåtkomst, så ett försök att nå databasen vore
 * ett annat fel än det testet väntar sig.
 */

function runSeed(demoMode: string) {
  return spawnSync(
    process.execPath,
    [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'prisma/seed.ts'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        DEMO_MODE: demoMode,
        IDENTITY_PEPPER: 'test-pepper-minst-trettiotva-tecken-langt-0000',
        VOTERS_DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/voters_test?schema=public&connect_timeout=1',
        VOTES_DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/votes_test?schema=public&connect_timeout=1',
      },
    },
  )
}

describe('seedningen', () => {
  it('vägrar i skarpt läge, med ett besked som säger varför, utan att nå databasen', () => {
    const result = runSeed('')

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/skarpt läge/i)
    expect(result.stderr).toMatch(/DEMO_MODE/)
    expect(result.stderr).not.toMatch(/Can't reach database|P1001|ECONNREFUSED/)
    expect(result.stdout).not.toMatch(/demo-fortroendeman/)
  })

  it('vägrar också när DEMO_MODE har ett värde som inte är exakt "true"', () => {
    for (const value of ['TRUE', '1', 'false']) {
      const result = runSeed(value)
      expect(result.status, value).toBe(1)
      expect(result.stderr, value).toMatch(/skarpt läge/i)
    }
  })

  it('går vidare i demoläget, och felar där först på databasen', () => {
    const result = runSeed('true')

    expect(result.status).toBe(1)
    expect(result.stderr).not.toMatch(/skarpt läge/i)
  })
})
