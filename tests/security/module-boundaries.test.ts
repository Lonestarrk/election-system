import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Testpunkt 9 (statisk del): det finns ingen väg i koden från en identitet
 * till en röst.
 *
 * Det här testet läser källkoden i stället för att köra den. Ett
 * integrationstest kan visa att kopplingen saknas i databasen just nu; det här
 * visar att den inte kan införas av misstag i koden.
 */

const SRC = join(process.cwd(), 'src')

function collectSourceFiles(directory: string): string[] {
  const found: string[] = []

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      if (entry === 'generated') continue
      found.push(...collectSourceFiles(path))
    } else if (/\.tsx?$/.test(path)) {
      found.push(path)
    }
  }

  return found
}

const sourceFiles = collectSourceFiles(SRC).map((path) => ({
  path: relative(process.cwd(), path).split(sep).join('/'),
  content: readFileSync(path, 'utf8'),
}))

function importsFrom(content: string, modulePath: string): boolean {
  return new RegExp(`from ['"]${modulePath}`).test(content)
}

describe('modulgränser', () => {
  it('hittar källfiler att granska', () => {
    expect(sourceFiles.length).toBeGreaterThan(15)
  })

  it('den anonyma röstmodulen importerar ingenting från väljarmodulen', () => {
    const offenders = sourceFiles
      .filter((file) => file.path.startsWith('src/modules/anonymous-vote/'))
      .filter(
        (file) =>
          importsFrom(file.content, '@/modules/eligibility') ||
          /from ['"]\.\.\/eligibility/.test(file.content),
      )
      .map((file) => file.path)

    expect(offenders).toEqual([])
  })

  it('väljarmodulen importerar ingenting från den anonyma röstmodulen', () => {
    const offenders = sourceFiles
      .filter((file) => file.path.startsWith('src/modules/eligibility/'))
      .filter(
        (file) =>
          importsFrom(file.content, '@/modules/anonymous-vote') ||
          /from ['"]\.\.\/anonymous-vote/.test(file.content),
      )
      .map((file) => file.path)

    expect(offenders).toEqual([])
  })

  it('ingen modul importerar orkestreringslagret', () => {
    const offenders = sourceFiles
      .filter((file) => file.path.startsWith('src/modules/'))
      .filter((file) => importsFrom(file.content, '@/orchestration'))
      .map((file) => file.path)

    expect(offenders).toEqual([])
  })

  it('endast godkända filer ser båda sidorna', () => {
    /**
     * Tillåtna undantag, med motivering:
     *
     *  – cast-vote.usecase.ts: orkestreringen. Enda stället där en identifierad
     *    väljare och ett partival finns i samma anropsstack.
     *  – admin/stats: hämtar två aggregat, ett från varje databas. Ser antal,
     *    aldrig rader.
     *  – demo/database-state: demosidans underlag. Visar båda tabellerna med
     *    avkortade värden, sorterade så att skrivordningen inte röjs.
     */
    const allowed = [
      'src/orchestration/cast-vote.usecase.ts',
      'src/app/api/admin/stats/route.ts',
      'src/app/api/demo/database-state/route.ts',
    ]

    const filesSeeingBoth = sourceFiles
      .filter(
        (file) =>
          /from ['"]@\/modules\/anonymous-vote/.test(file.content) &&
          /from ['"]@\/modules\/eligibility/.test(file.content),
      )
      .map((file) => file.path)

    expect(filesSeeingBoth.sort()).toEqual(allowed.sort())
  })

  it('admin- och demovyerna rör aldrig röstläggning eller legitimering', () => {
    const aggregateOnly = sourceFiles.filter(
      (file) =>
        file.path === 'src/app/api/admin/stats/route.ts' ||
        file.path === 'src/app/api/demo/database-state/route.ts',
    )

    expect(aggregateOnly).toHaveLength(2)

    for (const file of aggregateOnly) {
      expect(file.content, `${file.path} lägger röster`).not.toMatch(/castAnonymousVote/)
      expect(file.content, `${file.path} verifierar tokens`).not.toMatch(/verifyToken/)
      expect(file.content, `${file.path} utvärderar röstberättigande`).not.toMatch(
        /evaluateEligibility/,
      )
      expect(file.content, `${file.path} läser identitetshash för uppslag`).not.toMatch(
        /hashPersonalNumber/,
      )
    }
  })
})

describe('röstmodulens publika kontrakt', () => {
  const moduleApi = readFileSync(join(SRC, 'modules/anonymous-vote/index.ts'), 'utf8')

  it('tar bara emot ett parti-id', () => {
    expect(moduleApi).toMatch(/export type CastAnonymousVoteInput = \{\s*partyId: string\s*\}/)
  })

  it('har inga parametrar som kan bära identitet', () => {
    const inputType = moduleApi.match(/export type CastAnonymousVoteInput = \{[^}]*\}/)?.[0] ?? ''

    for (const forbidden of [
      'voterId',
      'voterStatusId',
      'personalNumber',
      'identityHash',
      'sessionId',
      'ip',
      'requestId',
      'userAgent',
    ]) {
      expect(inputType, `${forbidden} finns i kontraktet`).not.toContain(forbidden)
    }
  })
})

describe('loggdisciplin', () => {
  it('ingen källfil loggar direkt till console utom loggern själv', () => {
    const offenders = sourceFiles
      .filter((file) => file.path !== 'src/lib/logger.ts')
      .filter((file) => /console\.(log|info|warn|error|debug)\(/.test(file.content))
      .map((file) => file.path)

    // All utskrift ska gå genom loggern, som maskerar kända hemlighetsmönster.
    // Ett direkt console-anrop kringgår det skyddet.
    expect(offenders).toEqual([])
  })

  it('Prismas frågeloggning är avstängd i båda klienterna', () => {
    for (const path of ['src/modules/eligibility/db.ts', 'src/modules/anonymous-vote/db.ts']) {
      const content = sourceFiles.find((file) => file.path === path)?.content ?? ''
      expect(content, `${path} saknas`).toBeTruthy()
      // 'query' i loggnivåerna skulle skriva ut identitetshashar respektive
      // token-hashar till applikationsloggen.
      expect(content).toMatch(/log: \['error'\]/)
      expect(content).not.toMatch(/'query'/)
    }
  })
})
