import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * INGET NYTT PAKET KÖR SKRIPT VID INSTALLATIONEN UTAN ATT NÅGON HAR SETT DET.
 *
 * Ett installationsskript kör godtycklig kod på utvecklardatorn och i CI vid ett vanligt
 * `npm install`. Uppgift 18 lade till Swagger UI, och med det `@scarf/scarf`, som skickar
 * telemetri, och `tree-sitter`, som bygger inbyggd kod. Listan nedan är de paket som är kända
 * och motiverade i ARCHITECTURE.md (11b). Ett paket som tillkommer med `hasInstallScript`
 * fäller testet, så att någon måste ta ställning till det.
 */
const KNOWN_INSTALL_SCRIPTS = [
  // Prisma genererar klienten och hämtar motorn.
  '@prisma/client',
  '@prisma/engines',
  'prisma',
  // tsx och vitest bygger med esbuild, som hämtar sin binär.
  'esbuild',
  // macOS-beroende för filbevakning, installeras inte på Windows eller Linux.
  'fsevents',
  // Swagger UI (uppgift 18). Scarf är avstängt i package.json.
  '@scarf/scarf',
  '@tree-sitter-grammars/tree-sitter-yaml',
  'core-js-pure',
  'tree-sitter',
  'tree-sitter-json',
].sort()

type Lockfile = { packages: Record<string, { hasInstallScript?: boolean }> }

function packagesWithInstallScripts(): string[] {
  const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8')) as Lockfile
  const names = new Set<string>()
  for (const [path, entry] of Object.entries(lock.packages)) {
    // Roten, "", är projektet självt. Dess postinstall kör `npm run generate`, och den står i
    // package.json för alla att se.
    if (path === '') continue
    if (entry.hasInstallScript) names.add(path.replace(/^.*node_modules\//, ''))
  }
  return [...names].sort()
}

describe('installationsskript i beroendeträdet', () => {
  it('bara de kända paketen kör skript vid installationen', () => {
    expect(packagesWithInstallScripts()).toEqual(KNOWN_INSTALL_SCRIPTS)
  })

  it('Scarfs telemetri är avstängd i package.json', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scarfSettings?: { enabled?: boolean }
    }
    expect(pkg.scarfSettings?.enabled).toBe(false)
  })

  it('bygget i Docker installerar utan skript', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8')
    const installs = dockerfile.match(/npm (?:ci|install)[^\n]*/g) ?? []
    expect(installs.length).toBeGreaterThan(0)
    for (const line of installs) expect(line).toContain('--ignore-scripts')
  })
})
