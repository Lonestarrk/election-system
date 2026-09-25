import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KNOWN_LIMITATIONS } from '@/lib/known-limitations'

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
      'src/app/api/admin/elections/certify/route.ts',
      'src/app/api/admin/elections/check/route.ts',
      /**
       * Stängningen: flyttar chiffren till den anonyma sidan och raderar
       * kopplingen mellan väljare och röst.
       *
       * Den enda oåterkalleliga rutten i systemet, och därför den enda som
       * med flit INTE är schemalagd — se rutten själv för varför skalningen
       * måste vara en åtgärd någon utför och inte något som sker när klockan
       * slår.
       */
      'src/app/api/admin/elections/close/route.ts',
      'src/app/api/admin/elections/commit/route.ts',
      /**
       * Förtroendepersonens bidrag (uppgift 12). Tar emot en fras och låser
       * upp andelen i serverns minne, se posten `server-sees-trustee-share`
       * i src/lib/known-limitations.ts och "förtroendepersonernas rutter"
       * nedan.
       */
      'src/app/api/admin/elections/decrypt/route.ts',
      'src/app/api/admin/elections/route.ts',
      /** Räkningen av en valsedel, när två bidrag finns (uppgift 12). */
      'src/app/api/admin/elections/tally/route.ts',
      'src/app/api/admin/login/route.ts',
      'src/app/api/admin/stats/route.ts',
      'src/app/api/auth/bankid/collect/route.ts',
      'src/app/api/auth/bankid/qr/route.ts',
      'src/app/api/auth/bankid/start/route.ts',
      'src/app/api/demo/bankid-scan/route.ts',
      'src/app/api/demo/database-state/route.ts',
      /**
       * Nollställer hastighetsbegränsarens hinkar åt E2E-sviten.
       *
       * Hör hemma bland demorutterna av samma skäl som bankid-scan: den är
       * villkorad på `isDemoMode()`, som i dag betyder att `bankIdService` är
       * en instans av MockBankIdService. Det är ett påstående om koden och
       * inte en miljövariabel — byts attrappen mot skarp BankID svarar rutten
       * 404 utan att någon behöver komma ihåg att ändra konfigurationen. Se
       * "demorutterna" längst ned för kravet att varje demorutt gör så.
       *
       * Den rör inga gränser, den tömmer bara hinkarna. Alternativet — att
       * villkora bort `checkRateLimit` i attrappläge — hade passerat testet
       * "hastighetsbegränsar" nedan textuellt men urholkat egenskapen det
       * finns för att garantera.
       */
      'src/app/api/demo/reset-rate-limits/route.ts',
      'src/app/api/elections/route.ts',
      'src/app/api/observer/election/route.ts',
      'src/app/api/observer/votes/route.ts',
      'src/app/api/push/subscribe/route.ts',
      'src/app/api/verify/route.ts',
      'src/app/api/vote/ballot/route.ts',
      'src/app/api/vote/cast/route.ts',
      /**
       * Jämförelsen av enhetens sparade chifferhash med väljarens liggande
       * kuvert (uppgift 14).
       *
       * Ett orakel, och därför en egen rutt i stället för en del av
       * sessionsrutten: den tar emot en hemlighet från enheten och svarar
       * bara lika, olika eller ingen röst. Den lämnar aldrig ut serverns
       * hash, se "jämförelsen" nedan och
       * tests/integration/device-comparison.test.ts.
       */
      'src/app/api/vote/compare/route.ts',
      'src/app/api/vote/credential/route.ts',
      'src/app/api/vote/encrypted/route.ts',
      'src/app/api/vote/session/route.ts',
      'src/app/api/vote/sign-start/route.ts',
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

describe('jämförelsen av enhetens röst', () => {
  /**
   * SERVERN JÄMFÖR, DEN LÄMNAR INTE UT.
   *
   * Röstsidan skickar den chifferhash enheten sparade och får bara lika, olika
   * eller ingen röst tillbaka. Lämnade någon rutt ut hashen för det liggande
   * kuvertet fick en enhet veta hashen för en röst som lagts från en annan
   * enhet, den som räknas, och med läsrätt i votes_db pekar den ut rätt rad
   * efter stängningen (spec 10).
   *
   * Här granskas koden. Att svaren faktiskt saknar hashar prövas mot riktiga
   * databaser i tests/integration/device-comparison.test.ts. Kommentarerna tas
   * bort först, eftersom rutterna förklarar just det här i löpande text.
   */
  function code(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
  }

  const compare = code(routes.find((route) => route.path === 'src/app/api/vote/compare/route.ts')!.content)
  const session = code(routes.find((route) => route.path === 'src/app/api/vote/session/route.ts')!.content)

  it('kräver egen origin, en egen hastighetsgräns, en session och CSRF-token', () => {
    expect(compare).toMatch(/if \(!hasValidOrigin\(request\)\)/)
    expect(compare).toMatch(/checkRateLimit\('vote-compare', getClientIp\(request\), RATE_LIMITS\.compareDeviceVotes\)/)
    expect(compare).toMatch(/await getValidVotingSession\(sessionId\)/)
    expect(compare).toMatch(/if \(!isValidCsrfToken\(request, session\.csrfSecret\)\)/)
  })

  it('läser aldrig själv ut ett kuvert, och jämför bara för sessionens väljare', () => {
    expect(compare).not.toMatch(/pendingVoteFor|votersDb|pendingVote\./)
    expect(compare).toMatch(/compareWithPendingVotes\(session\.voterStatusId, body\.data\.ballots\)/)
    expect(compare).not.toMatch(/body\.data\.(voterStatusId|electionId)/)
  })

  it('svarar med valsedel och utfall och ingenting annat', () => {
    expect(compare).toContain('ballots: results.map((entry) => ({ ballotId: entry.ballotId, result: entry.result })),')
    expect(compare.match(/jsonResponse\(/g)).toHaveLength(1)
  })

  it('sessionsrutten lämnar inte ut någon chifferhash', () => {
    expect(session).not.toMatch(/ciphertextHash|pendingVoteFor/)
  })
})

describe('förtroendepersonernas rutter', () => {
  /**
   * Räkningen öppnar valets resultat, och bidraget låser upp en andel av
   * nyckeln. Båda kräver en inloggad administratör och CSRF-token, som
   * stängningen. Frasen lagras aldrig och loggas aldrig: rutten nämner den på
   * exakt ett ställe, där den lämnas till räkningen. Kommentarerna tas bort
   * först, eftersom rutten förklarar just det här i löpande text.
   */
  function code(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
  }

  const decrypt = code(routes.find((route) => route.path === 'src/app/api/admin/elections/decrypt/route.ts')!.content)
  const tally = code(routes.find((route) => route.path === 'src/app/api/admin/elections/tally/route.ts')!.content)

  it.each([
    ['bidraget', decrypt],
    ['räkningen', tally],
  ])('%s kräver egen origin, en hastighetsgräns, en adminsession och CSRF-token', (_label, content) => {
    expect(content).toMatch(/if \(!hasValidOrigin\(request\)\)/)
    expect(content).toMatch(/checkRateLimit\(/)
    expect(content).toMatch(/if \(!\(await isAdminAuthenticated\(\)\)\)/)
    expect(content).toMatch(/if \(!isValidCsrfToken\(request, session\.csrfSecret\)\)/)
  })

  it('bidragets hastighetsgräns räknas per förtroendeperson (ruling 64)', () => {
    expect(decrypt).toMatch(
      /checkRateLimit\([^)]*body\.data\.trusteeIndex[^)]*RATE_LIMITS\.trusteeContribution[,\s]*\)/,
    )
  })

  it('frasen nämns bara där den lämnas till räkningen', () => {
    // Som identifierare. Statusen "wrong_passphrase" är ett beskeds namn, inte frasen.
    expect(decrypt.match(/\bpassphrase\b/g)).toEqual(['passphrase'])
    expect(decrypt).toContain('body.data.passphrase)')
    expect(tally).not.toMatch(/\bpassphrase\b/)
  })

  it('att servern ser andelen står bland de kända begränsningarna, med en markör i rutten', () => {
    // I ett riktigt val räknar förtroendepersonen på sin egen enhet. Så länge
    // rutten tar emot frasen ska listan säga det.
    const post = KNOWN_LIMITATIONS.find((limitation) => limitation.id === 'server-sees-trustee-share')
    expect(post, 'posten server-sees-trustee-share saknas').toBeDefined()
    expect([post!.stillTrueIf].flat().map((marker) => marker?.file)).toContain(
      'src/app/api/admin/elections/decrypt/route.ts',
    )
  })

  it('rutterna ser bara räkningen, inte någon av databaserna', () => {
    for (const content of [decrypt, tally]) {
      expect(content).not.toMatch(/@\/modules\/(eligibility|ballot-box)/)
      expect(content).toMatch(/from '@\/orchestration\/tally\.usecase'/)
    }
  })
})

describe('demorutterna', () => {
  /**
   * EN RUTT SOM GLÖMDE VILLKORET LÄMNADE UT RÖSTLÄNGDEN I SKARPT LÄGE.
   *
   * /api/demo/database-state hade inget villkor alls, medan arkitektursidan
   * som visar svaret bara frågade i demoläget. Villkoret lästes dessutom på
   * fyra ställen, var för sig. Det här testet hade fångat luckan: varje rutt
   * under /api/demo ska börja med att fråga `isDemoMode()`, och ingen fil utom
   * src/lib/demo-mode.ts får läsa `bankIdIsMocked` själv. Då är bytet i
   * uppgift 17 en rad, och ingen rutt kan hamna utanför det.
   *
   * Kommentarerna tas bort före granskningen. Rutterna förklarar sitt villkor
   * i löpande text, och en förklaring ska inte kunna fälla eller rädda testet.
   */
  function withoutComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
  }

  const demoRoutes = routes.filter((route) => route.path.startsWith('src/app/api/demo/'))

  it('hittar demorutterna', () => {
    expect(demoRoutes.map((route) => route.path).sort()).toEqual([
      'src/app/api/demo/bankid-scan/route.ts',
      'src/app/api/demo/database-state/route.ts',
      'src/app/api/demo/reset-rate-limits/route.ts',
    ])
  })

  it.each(demoRoutes.map((route) => [route.path, route.content] as const))(
    '%s börjar varje hanterare med att fråga om demoläget, och svarar 404 annars',
    (path, content) => {
      const code = withoutComments(content)

      expect(code, `${path} importerar inte predikatet`).toMatch(
        /import \{ isDemoMode \} from '@\/lib\/demo-mode'/,
      )

      const handlers = code.match(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g) ?? []
      const gated =
        code.match(
          /export async function (GET|POST|PUT|PATCH|DELETE)\([^)]*\)\s*\{\s*if \(!isDemoMode\(\)\) \{\s*return errorResponse\('NOT_FOUND'/g,
        ) ?? []

      expect(handlers.length, `${path} har ingen hanterare`).toBeGreaterThan(0)
      expect(gated.length, `${path}: varje hanterare ska börja med villkoret`).toBe(handlers.length)
      expect(code, `${path} läser bankIdIsMocked direkt`).not.toMatch(/bankIdIsMocked/)
    },
  )

  it('ingen fil utom predikatet läser bankIdIsMocked', () => {
    function sourceFiles(directory: string): string[] {
      return readdirSync(directory).flatMap((entry) => {
        const full = join(directory, entry)
        if (statSync(full).isDirectory()) return sourceFiles(full)
        return /\.tsx?$/.test(entry) ? [full] : []
      })
    }

    const readers = sourceFiles(join(process.cwd(), 'src'))
      .filter((file) => /bankIdIsMocked/.test(withoutComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(process.cwd(), file).split(sep).join('/'))
      .sort()

    // Definitionen, och den enda som läser den.
    expect(readers).toEqual(['src/lib/demo-mode.ts', 'src/modules/eligibility/bankid/index.ts'])
  })
})
