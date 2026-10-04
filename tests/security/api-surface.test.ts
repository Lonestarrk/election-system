import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KNOWN_LIMITATIONS } from '@/lib/known-limitations'
import { demoRouteProblems } from './demo-route-source'

/**
 * Ingen rutt lämnar ut en token eller en kod som pekar på en röst, och ingen tar emot en
 * identitet och svarar med något som kan kopplas till en röst.
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
      'src/app/api/admin/elections/check-status/route.ts',
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
      /**
       * Förtroendepersonens bidrag (uppgift 12). Tar emot en fras och låser
       * upp andelen i serverns minne, se posten `server-sees-trustee-share`
       * i src/lib/known-limitations.ts och "förtroendepersonernas rutter"
       * nedan.
       */
      'src/app/api/admin/elections/decrypt/route.ts',
      /**
       * Räkneverken per valsedel efter TALLIED (uppgift 12c, 7c). Bakom
       * adminsessionen, inte offentlig: publiceringen är uppgift 13.
       */
      'src/app/api/admin/elections/results/route.ts',
      'src/app/api/admin/elections/route.ts',
      /** Omröstningens fas och antal, för adminsidan (uppgift 12c). Inget per väljare. */
      'src/app/api/admin/elections/state/route.ts',
      /** Räkningen av en valsedel, när två bidrag finns (uppgift 12). */
      'src/app/api/admin/elections/tally/route.ts',
      'src/app/api/admin/login/route.ts',
      /**
       * Läget och kraven för skarpt läge, för adminsidans kort (uppgift 17).
       * Bara GET, bakom adminsessionen. Ingen rutt byter läge.
       */
      'src/app/api/admin/mode/route.ts',
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
      'src/app/api/demo/reset-election/route.ts',
      'src/app/api/demo/reset-rate-limits/route.ts',
      'src/app/api/demo/trustee-passphrases/route.ts',
      'src/app/api/elections/route.ts',
      /** Bara läget, för banderollen (uppgift 17). Ingen checklista. */
      'src/app/api/mode/route.ts',
      /**
       * Observatörens överblick: fasen, valdeltagandet och rötterna. Inget
       * resultat i någon fas (uppgift 13, spec 6.2).
       */
      'src/app/api/observer/election/route.ts',
      /**
       * Det publicerade resultatet med bevis, efter TALLIED (uppgift 13). Det
       * oberoende verktyget läser det. /api/observer/votes, som lämnade ut
       * varje röst med innehåll, finns inte.
       */
      'src/app/api/observer/results/route.ts',
      'src/app/api/push/subscribe/route.ts',
      'src/app/api/vote/ballot/route.ts',
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
      'src/app/api/vote/encrypted/route.ts',
      /**
       * Verifieringssidans besked "Du har röstat" per valsedel (uppgift 13).
       * Kräver session och svarar bara om den egna väljaren, med ett ja eller
       * nej per valsedel. Se "verifieringssidans besked" nedan.
       */
      'src/app/api/vote/participation/route.ts',
      'src/app/api/vote/session/route.ts',
      'src/app/api/vote/sign-start/route.ts',
    ])
  })

  it('ingen rutt returnerar en token som pekar på en röst', () => {
    const returningToken = routes
      .filter((route) => /token:\s*(outcome\.token|data\.token|token)\b/.test(route.content))
      .map((route) => route.path)

    expect(returningToken).toEqual([])
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

describe('adminytan', () => {
  const stats = routes.find((route) => route.path === 'src/app/api/admin/stats/route.ts')!

  it('har ingen sökfunktion', () => {
    for (const forbidden of ['findUnique', 'findFirst', 'search', 'query', 'where']) {
      expect(stats.content, `adminstatistiken innehåller ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('hämtar bara aggregat', () => {
    expect(stats.content).toMatch(/getVoterStatistics/)
    expect(stats.content).toMatch(/turnoutByBallot/)
    expect(stats.content).not.toMatch(/findMany/)
  })

  it('visar inga löpande resultat (uppgift 13, spec 6.2)', () => {
    // Fram till uppgift 13 räknade rutten röster per parti medan röstningen pågick.
    expect(stats.content).not.toMatch(/ballotTally|votesDb/)
  })

  it('kräver inloggning', () => {
    expect(stats.content).toMatch(/isAdminAuthenticated/)
  })
})

describe('skydd på tillståndsändrande rutter', () => {
  const mutating = routes.filter((route) => /export async function POST/.test(route.content))

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

  it('rutterna som tar emot ett kuvert eller startar dess underskrift kräver dessutom CSRF-token', () => {
    // CSRF-skyddet bygger på en hemlighet knuten till röstsessionen, och båda rutterna kräver
    // en session. En angripande sajt kan inte framkalla en underskrift i någon annans BankID,
    // men kan försöka starta en.
    for (const path of ['src/app/api/vote/sign-start/route.ts', 'src/app/api/vote/encrypted/route.ts']) {
      const route = routes.find((candidate) => candidate.path === path)!
      expect(route.content, path).toMatch(/isValidCsrfToken/)
    }
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

describe('publiceringen och observatören (uppgift 13)', () => {
  /**
   * BARA SUMMORNA PUBLICERAS, OCH INGENTING UNDER RÖSTNINGEN.
   *
   * Observatörsrutterna läser inte urnans rader själva. Resultatet går genom publiceringen, som räknar om
   * det ur urnan och de prövade bidragen. Att svaren saknar allt per röst prövas
   * mot riktiga databaser i tests/integration/independent-verification.test.ts.
   * Kommentarerna tas bort först, eftersom rutterna förklarar det här i text.
   */
  function code(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
  }

  const observerRoutes = routes.filter((route) => route.path.startsWith('src/app/api/observer/'))
  const results = code(routes.find((route) => route.path === 'src/app/api/observer/results/route.ts')!.content)

  it('observatörsrutterna läser inget per röst', () => {
    for (const route of observerRoutes) {
      const content = code(route.content)
      expect(content, route.path).not.toMatch(
        /votesDb|votersDb|encryptedVote|ciphertextHash/,
      )
    }
  })

  it('resultatet lämnas bara ut genom publiceringen, som räknar om det', () => {
    expect(results).toMatch(/from '@\/orchestration\/publish-results\.usecase'/)
    expect(results).not.toMatch(/@\/modules\//)
    expect(results).toMatch(/export async function GET\(/)
    expect(results).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)\b/)
    expect(results).not.toMatch(/cookies\(/)
    expect(results).toMatch(/checkRateLimit\('observer-results', getClientIp\(request\), RATE_LIMITS\.observerResults\)/)
  })
})

describe('verifieringssidans besked (uppgift 13)', () => {
  const participation = routes.find((route) => route.path === 'src/app/api/vote/participation/route.ts')!
  const content = participation.content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')

  it('kräver egen origin, en hastighetsgräns och en session, och svarar bara om sessionens väljare', () => {
    expect(content).toMatch(/if \(!hasValidOrigin\(request\)\)/)
    expect(content).toMatch(/checkRateLimit\('vote-participation'/)
    expect(content).toMatch(/await getValidVotingSession\(sessionId\)/)
    expect(content).toMatch(/participationOf\(session\.voterStatusId, session\.electionId\)/)
    expect(content).not.toMatch(/body\.data|parseJsonBody/)
  })

  it('svarar med ett ja eller nej per valsedel, utan chiffer, hash, räknare eller tid', () => {
    expect(content).not.toMatch(/ciphertext|castSequence|updatedAt|createdAt|closesAt|votedMarker|pendingVote/)
    expect(content).toContain('voted: ballot.voted,')
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
   * under /api/demo ska börja med att fråga `isDemoMode()`. Sedan uppgift 17
   * avgörs läget av DEMO_MODE, i src/lib/mode-flag.ts, och `isDemoMode()` är
   * lägesfunktionen.
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
      'src/app/api/demo/reset-election/route.ts',
      'src/app/api/demo/reset-rate-limits/route.ts',
      'src/app/api/demo/trustee-passphrases/route.ts',
    ])
  })

  it.each(demoRoutes.map((route) => [route.path, route.content] as const))(
    '%s är skriven som en demorutt och börjar varje hanterare med att svara 404 utanför demoläget',
    (path, content) => {
      // Kontrollen och dess mutanttest ligger i tests/security/demo-route-source.ts
      // och demo-route-guard.test.ts. Beteendet prövas i demo-routes-behaviour.test.ts.
      expect(demoRouteProblems(path, content)).toEqual([])
    },
  )

  it('inga filer under src/app/api/demo heter något annat än route.ts', () => {
    function everyFile(directory: string): string[] {
      return readdirSync(directory).flatMap((entry) => {
        const full = join(directory, entry)
        return statSync(full).isDirectory() ? everyFile(full) : [full]
      })
    }

    const others = everyFile(join(API_ROOT, 'demo'))
      .map((file) => relative(process.cwd(), file).split(sep).join('/'))
      .filter((file) => !file.endsWith('/route.ts'))

    expect(others).toEqual([])
  })

  it('ingen fil utom lägesfunktionen läser läget, och ingen läser BankID-attrappen för att avgöra det', () => {
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

    // Variabeln finns inte längre. Läget följer DEMO_MODE, inte implementationen.
    expect(readers).toEqual([])
  })
})
