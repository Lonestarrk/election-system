import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Testpunkt 8: en väljaridentitet kan inte användas för att få fram en token.
 * Testpunkt 12: verifieringen avslöjar inte väljarens identitet.
 *
 * Testet granskar API-ytan som helhet, inte bara enskilda svar. Poängen är att
 * visa att den farliga funktionen inte finns någonstans — inte att den råkar
 * vara avstängd på ett ställe.
 */

const API_ROOT = join(process.cwd(), 'src/app/api')

function collectRoutes(directory: string): Array<{ path: string; content: string }> {
  const routes: Array<{ path: string; content: string }> = []

  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) {
      routes.push(...collectRoutes(full))
    } else if (entry === 'route.ts') {
      routes.push({
        path: relative(process.cwd(), full).split(sep).join('/'),
        content: readFileSync(full, 'utf8'),
      })
    }
  }

  return routes
}

const routes = collectRoutes(API_ROOT)

describe('API-ytan', () => {
  it('hittar samtliga rutter', () => {
    const paths = routes.map((route) => route.path).sort()
    expect(paths).toEqual([
      'src/app/api/admin/elections/route.ts',
      'src/app/api/admin/login/route.ts',
      'src/app/api/admin/stats/route.ts',
      'src/app/api/auth/bankid/collect/route.ts',
      'src/app/api/auth/bankid/start/route.ts',
      'src/app/api/demo/database-state/route.ts',
      'src/app/api/elections/route.ts',
      'src/app/api/verify/route.ts',
      'src/app/api/vote/ballot/route.ts',
      'src/app/api/vote/cast/route.ts',
      'src/app/api/vote/credential/route.ts',
          ])
  })

  it('endast röstläggningen returnerar en token', () => {
    const returningToken = routes
      .filter((route) => /token:\s*(outcome\.token|data\.token|token)\b/.test(route.content))
      .map((route) => route.path)

    expect(returningToken).toEqual(['src/app/api/vote/cast/route.ts'])
  })

  it('ingen rutt tar emot ett personnummer och svarar med en token', () => {
    for (const route of routes) {
      const handlesPersonalNumber = /personalNumber/.test(route.content)
      const returnsToken = /token:/.test(route.content)

      expect(
        handlesPersonalNumber && returnsToken,
        `${route.path} tar både emot personnummer och returnerar token`,
      ).toBe(false)
    }
  })

  it('ingen rutt läser en token ur URL:en', () => {
    for (const route of routes) {
      // Token i sökväg eller query hamnar i accessloggar, proxyloggar,
      // webbläsarhistorik och Referer-headern.
      expect(route.content, `${route.path} läser token från query`).not.toMatch(
        /searchParams\.get\(['"]token/,
      )
      expect(route.content, `${route.path} har token i sökvägen`).not.toMatch(/params.*token/i)
    }
  })

  it('inget dynamiskt segment i API-trädet kan bära en token', () => {
    function findDynamicSegments(directory: string): string[] {
      const segments: string[] = []
      for (const entry of readdirSync(directory)) {
        const full = join(directory, entry)
        if (!statSync(full).isDirectory()) continue
        if (entry.startsWith('[')) segments.push(entry)
        segments.push(...findDynamicSegments(full))
      }
      return segments
    }

    expect(findDynamicSegments(API_ROOT)).toEqual([])
  })
})

describe('verifieringsrutten', () => {
  const verify = routes.find((route) => route.path === 'src/app/api/verify/route.ts')!

  it('verifierar bara via POST', () => {
    expect(verify.content).toMatch(/export async function POST/)
    expect(verify.content).toMatch(/export async function GET/)
    // GET finns, men bara för att svara 405 med en förklaring.
    const getBody = verify.content.match(/export async function GET[\s\S]*$/)?.[0] ?? ''
    expect(getBody).toMatch(/405/)
    expect(getBody).not.toMatch(/verifyToken/)
  })

  it('svarar aldrig med identitetsuppgifter', () => {
    for (const forbidden of [
      'personalNumber',
      'voterId',
      'voterStatusId',
      'identityHash',
      'externalIdentityHash',
      'sessionId',
      'ipAddress',
    ]) {
      expect(verify.content, `verifieringen nämner ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('importerar ingenting från väljarmodulen', () => {
    expect(verify.content).not.toMatch(/@\/modules\/eligibility/)
  })

  it('hastighetsbegränsas', () => {
    expect(verify.content).toMatch(/checkRateLimit/)
  })
})

describe('adminytan', () => {
  const stats = routes.find((route) => route.path === 'src/app/api/admin/stats/route.ts')!

  it('har ingen sökfunktion', () => {
    for (const forbidden of ['findUnique', 'findFirst', 'search', 'query', 'where']) {
      expect(stats.content, `adminstatistiken innehåller ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('hämtar bara aggregat', () => {
    expect(stats.content).toMatch(/getVoterStatistics/)
    expect(stats.content).toMatch(/getElectionResults/)
    expect(stats.content).not.toMatch(/findMany/)
  })

  it('kräver inloggning', () => {
    expect(stats.content).toMatch(/isAdminAuthenticated/)
  })
})

describe('skydd på tillståndsändrande rutter', () => {
  const mutating = routes.filter(
    (route) =>
      /export async function POST/.test(route.content) &&
      route.path !== 'src/app/api/verify/route.ts',
  )

  it('kontrollerar Origin', () => {
    for (const route of mutating) {
      expect(route.content, `${route.path} saknar Origin-kontroll`).toMatch(/hasValidOrigin/)
    }
  })

  it('hastighetsbegränsar', () => {
    for (const route of mutating) {
      expect(route.content, `${route.path} saknar hastighetsbegränsning`).toMatch(/checkRateLimit/)
    }
  })

  it('utfärdandet av röstintyg kräver dessutom CSRF-token', () => {
    /**
     * KRAVET FLYTTADE, DET FÖRSVANN INTE.
     *
     * CSRF-skyddet bygger på en hemlighet knuten till röstsessionen. Sedan
     * röstintygen infördes har röstläggningen ingen session alls — den
     * auktoriseras av ett kryptografiskt intyg i stället, vilket är ett
     * starkare skydd än en cookie: en angripande sajt kan inte framkalla en
     * giltig signatur.
     *
     * Den sessionsbärande rutten är nu utfärdandet, och det är där CSRF-kravet
     * hör hemma.
     */
    const issue = routes.find((route) => route.path === 'src/app/api/vote/credential/route.ts')!
    expect(issue.content).toMatch(/isValidCsrfToken/)
  })

  it('röstläggningen läser ingen sessionscookie', () => {
    // Det här är vinsten med röstintygen: rutten KAN inte veta vem som röstar.
    const cast = routes.find((route) => route.path === 'src/app/api/vote/cast/route.ts')!

    expect(cast.content).not.toMatch(/SESSION_COOKIE/)
    expect(cast.content).not.toMatch(/getValidVotingSession/)
    expect(cast.content).not.toMatch(/@\/modules\/eligibility/)
  })
})
