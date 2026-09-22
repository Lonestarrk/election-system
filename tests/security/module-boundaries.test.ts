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
      .filter((file) => file.path.startsWith('src/modules/ballot-box/'))
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
          importsFrom(file.content, '@/modules/ballot-box') ||
          /from ['"]\.\.\/ballot-box/.test(file.content),
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
     * Listan KRYMPTE när röstintygen infördes.
     *
     * Röstläggningen behöver ingen session längre och orkestreras därför inte
     * — rutten anropar bara den anonyma modulen. Ingen fil i systemet ser
     * numera båda sidorna i samband med att en röst läggs.
     *
     * Kvarvarande undantag:
     *  – admin/stats: hämtar två aggregat, ett från varje databas. Ser antal,
     *    aldrig rader.
     *  – demo/database-state: demosidans underlag. Visar båda tabellerna med
     *    avkortade värden, sorterade så att skrivordningen inte röjs.
     *  – final-check.usecase: slutkontrollen. Jämför ANTAL godkända röstningar
     *    mot ANTAL registrerade röster. Läser aldrig en enskild väljare, och
     *    kan inte para ihop sidorna — det finns ingen gemensam identifierare.
     *  – observer/election: samma siffra, publicerad. Utan den kan en
     *    observatör inte kontrollera att antalet godkända röstningar motsvarar
     *    antalet registrerade röster, vilket är ett uttryckligt krav.
     */
    const allowed = [
      // Skapar omröstningen i båda databaserna. Rör bara offentlig metadata —
      // namn, valsedlar, öppettider. Vid den tidpunkten finns varken en
      // väljare eller en röst att koppla ihop.
      'src/orchestration/create-election.usecase.ts',
      'src/orchestration/final-check.usecase.ts',
      'src/app/api/admin/stats/route.ts',
      'src/app/api/demo/database-state/route.ts',
      'src/app/api/observer/election/route.ts',
    ]

    const filesSeeingBoth = sourceFiles
      .filter(
        (file) =>
          /from ['"]@\/modules\/ballot-box/.test(file.content) &&
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
      expect(file.content, `${file.path} lägger röster`).not.toMatch(/castVote/)
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
  const moduleApi = readFileSync(join(SRC, 'modules/ballot-box/index.ts'), 'utf8')

  it('tar bara emot identifierare som pekar på rader i röstdatabasen', () => {
    const inputType = moduleApi.match(/export type CastVoteInput = \{[^}]*\}/)?.[0] ?? ''
    expect(inputType).toBeTruthy()

    const fields = [...inputType.matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1])

    // Exakt den här mängden, varken mer eller mindre. Ett nytt fält i
    // kontraktet ska tvinga fram ett medvetet beslut här, inte glida igenom.
    expect(fields.sort()).toEqual([
      'ballotId',
      'ballotPartyId',
      'candidateId',
      'credentialId',
      'credentialSignature',
      'optionId',
    ])
  })

  it('har ingen parameter som knyter ihop flera röster', () => {
    /**
     * Väljaren i ett riksdagsval anropar modulen tre gånger, en gång per
     * valsedel. De tre anropen får inte ha något gemensamt som lagras: en
     * kombination av kommun-, landstings- och riksdagsval är betydligt mer
     * identifierande än något enskilt av dem.
     *
     * Det räcker alltså inte att kontraktet saknar identitet — det måste också
     * sakna varje fält som skulle kunna gruppera rösterna i efterhand.
     */
    const inputType = moduleApi.match(/export type CastVoteInput = \{[^}]*\}/)?.[0] ?? ''

    for (const forbidden of [
      'receiptId',
      'groupId',
      'batchId',
      'electionId',
      'correlationId',
      'sequence',
    ]) {
      expect(inputType, `${forbidden} finns i kontraktet`).not.toContain(forbidden)
    }
  })

  it('har inga parametrar som kan bära identitet', () => {
    const inputType = moduleApi.match(/export type CastVoteInput = \{[^}]*\}/)?.[0] ?? ''

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
    for (const path of ['src/modules/eligibility/db.ts', 'src/modules/ballot-box/db.ts']) {
      const content = sourceFiles.find((file) => file.path === path)?.content ?? ''
      expect(content, `${path} saknas`).toBeTruthy()
      // 'query' i loggnivåerna skulle skriva ut identitetshashar respektive
      // token-hashar till applikationsloggen.
      expect(content).toMatch(/log: \['error'\]/)
      expect(content).not.toMatch(/'query'/)
    }
  })
})
