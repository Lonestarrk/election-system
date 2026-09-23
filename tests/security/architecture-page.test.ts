import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CURRENTLY,
  neverWritten,
  PHASES,
  type CodeFact,
  type Marker,
} from '@/app/architecture/code-facts'
import { KNOWN_LIMITATIONS } from '@/lib/known-limitations'

/**
 * ARKITEKTURSIDAN FÅR INTE PÅSTÅ NÅGOT OM KODEN SOM KODEN INTE LÄNGRE GÖR.
 *
 * Sidan beskriver en modell som byggs i etapper, och en del av det den säger
 * gäller just nu: att röstsidan fortfarande kör det gamla flödet, att
 * dekrypteringen inte är byggd, vilka faser som faktiskt skrivs, hur
 * tidsstämplar lagras. Varje sådant påstående står i
 * src/app/architecture/code-facts.ts med markörer som är sanna så länge
 * påståendet är sant. Testet här prövar markörerna.
 *
 * Det går rött när systemet blir BÄTTRE, precis som
 * tests/security/known-limitations.test.ts. Den som bygger dekrypteringen får
 * alltså veta att arkitektursidan fortfarande säger att den inte finns, i
 * stället för att sidan ljuger vidare tills någon råkar läsa den.
 */

const ROOT = process.cwd()

/**
 * Sidans egna filer räknas aldrig när en markör letar efter något som INTE
 * ska finnas. De innehåller påståendena och deras mönster, och en markör som
 * letar efter "phase: 'CLOSED'" skulle annars hitta sig själv i fastabellen.
 */
const PAGE_DIRECTORY = 'src/app/architecture'

function toRelative(path: string): string {
  return relative(ROOT, path).split(sep).join('/')
}

/** Radslut normaliseras: arbetskopian har CRLF på Windows, markörerna har \n. */
function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n')
}

function sourceFilesUnder(path: string, { skipPage }: { skipPage: boolean }): string[] {
  const full = join(ROOT, path)
  if (!existsSync(full)) return []

  if (statSync(full).isFile()) return [toRelative(full)]

  return readdirSync(full).flatMap((entry) => {
    const child = toRelative(join(full, entry))
    if (skipPage && (child === PAGE_DIRECTORY || child.startsWith(`${PAGE_DIRECTORY}/`))) return []
    if (statSync(join(ROOT, child)).isDirectory()) return sourceFilesUnder(child, { skipPage })
    return /\.tsx?$/.test(child) ? [child] : []
  })
}

/** Sant eller falskt, med en förklaring som går att agera på när det är falskt. */
function check(marker: Marker): { holds: boolean; detail: string } {
  if ('file' in marker) {
    if (!existsSync(join(ROOT, marker.file))) {
      return { holds: false, detail: `filen ${marker.file} finns inte längre` }
    }
    return read(marker.file).includes(marker.contains)
      ? { holds: true, detail: '' }
      : { holds: false, detail: `"${marker.contains}" finns inte längre i ${marker.file}` }
  }

  const files = sourceFilesUnder(marker.nowhereIn, { skipPage: true })
  if (files.length === 0) {
    return { holds: false, detail: `${marker.nowhereIn} innehåller inga filer att granska` }
  }

  const offenders = files.filter((file) => marker.matches.test(read(file)))
  return offenders.length === 0
    ? { holds: true, detail: '' }
    : { holds: false, detail: `${marker.matches} finns nu i ${offenders.join(', ')}` }
}

function expectFactHolds(label: string, fact: CodeFact): void {
  expect(fact.holdsWhile.length, `${label} saknar markör`).toBeGreaterThan(0)

  for (const marker of fact.holdsWhile) {
    const { holds, detail } = check(marker)
    expect(
      holds,
      `\n\n  ARKITEKTURSIDANS PÅSTÅENDE "${label}" STÄMMER INTE LÄNGRE.\n\n` +
        `  Sidan säger: "${fact.text}"\n` +
        `  Men ${detail}.\n\n` +
        '  Har koden blivit bättre: skriv om påståendet i src/app/architecture/code-facts.ts,\n' +
        '  och titta på sidan i en webbläsare. Har du bara flyttat kod: peka om markören.\n',
    ).toBe(true)
  }
}

describe('arkitektursidans påståenden om koden', () => {
  it.each(Object.entries(CURRENTLY))('"%s" stämmer fortfarande', (id, fact) => {
    expectFactHolds(id, fact)
  })

  it.each(PHASES)('fasen $phase: kolumnen "I koden i dag" stämmer fortfarande', (row) => {
    expectFactHolds(`fasen ${row.phase}`, row.today)
  })

  it('markörerna kan faktiskt slå fel', () => {
    /**
     * Kontrasten. Utan den kunde en `check` som alltid svarar sant få varje
     * test ovan att passera, och sidan ljuga i evighet med grönt bygge.
     */
    expect(check({ file: 'src/app/architecture/page.tsx', contains: 'finns-inte-i-sidan' }).holds).toBe(
      false,
    )
    expect(check({ nowhereIn: 'src', matches: /export async function GET/ }).holds).toBe(false)
    expect(check({ file: 'src/finns-inte.ts', contains: 'x' }).holds).toBe(false)

    // Mönstret för "fasen skrivs aldrig" hittar den fas som faktiskt skrivs.
    // Utan det kunde ett mönster som inte matchar någonting alls hålla
    // fastabellen grön för varje fas, också den dag koden börjar skriva dem.
    expect(check(neverWritten('STRIPPED')).holds).toBe(false)

    // Schemamönstren håller sig inom sin modell: PendingVote har ett
    // voterStatusId, och det får inte räknas som ett fält i AuditEvent.
    const auditActor: Marker | undefined = CURRENTLY.auditChain.holdsWhile.find(
      (marker) => 'nowhereIn' in marker && marker.nowhereIn === 'prisma/voters/schema.prisma',
    )
    if (!auditActor || !('matches' in auditActor)) {
      throw new Error('Markören för revisionsloggens fält saknas eller har fel form.')
    }
    expect(check(auditActor).holds).toBe(true)
    expect(auditActor.matches.test('model AuditEvent {\n  id String\n  actorId String\n}')).toBe(
      true,
    )
  })
})

describe('fastabellen', () => {
  it('har specens sex faser i specens ordning', () => {
    expect(PHASES.map((row) => row.phase)).toEqual([
      'OPEN',
      'CLOSED',
      'VALIDATED',
      'STRIPPED',
      'TALLIED',
      'CERTIFIED',
    ])
  })

  it('säger vad specens tabell säger om kopplingen och om röster tas emot', () => {
    // Spec 6.1. Kopplingen finns till och med VALIDATED; röster tas bara emot i OPEN.
    expect(PHASES.map((row) => row.linkExists)).toEqual([true, true, true, false, false, false])
    expect(PHASES.map((row) => row.acceptsVotes)).toEqual([true, false, false, false, false, false])
  })
})

describe('arkitektursidan skriver inte själv det den läser', () => {
  const pageFiles = sourceFilesUnder(PAGE_DIRECTORY, { skipPage: false }).filter((file) =>
    file.endsWith('.tsx'),
  )
  const page = read('src/app/architecture/page.tsx')

  it('hittar sidans komponenter', () => {
    expect(pageFiles).toEqual(
      expect.arrayContaining([
        'src/app/architecture/page.tsx',
        'src/app/architecture/LiveDatabaseView.tsx',
        'src/app/architecture/FollowAVote.tsx',
        'src/app/architecture/LinkQuestion.tsx',
      ]),
    )
  })

  it('hänvisar bara till begränsningar som finns i listan', () => {
    const referenced = [...page.matchAll(/limitation\('([a-z0-9-]+)'\)/g)].map((match) => match[1])

    expect(referenced.length).toBeGreaterThan(0)
    const ids = KNOWN_LIMITATIONS.map((limitation) => limitation.id)
    for (const id of referenced) {
      expect(ids, `sidan hänvisar till ${id}, som inte finns i listan`).toContain(id)
    }
  })

  it('upprepar inga påståenden om koden som fri text', () => {
    /**
     * Samma fel som known-limitations.test.ts vaktar mot: ett påstående som
     * står på två ställen blir rättat på det ena. Texterna ska läsas ur
     * code-facts.ts, inte kopieras in i sidan.
     */
    const facts = [...Object.values(CURRENTLY), ...PHASES.map((row) => row.today)]
    for (const file of pageFiles) {
      const content = read(file)
      for (const fact of facts) {
        expect(content.includes(fact.text), `${file} upprepar "${fact.text}"`).toBe(false)
      }
    }
  })

  it('ingen del av sidan söker på en verifikationskod', () => {
    /**
     * Spec 3.1. En sökning på kod efter stängningen var köparens verktyg: den
     * som sett en röst läggas kunde se om koden fanns kvar, och alltså om
     * väljaren ändrat sig. Sidan får beskriva att ingen kod visas, men inte
     * erbjuda en ruta att klistra in en.
     */
    for (const file of pageFiles) {
      expect(read(file), `${file} har ett fält för kod`).not.toMatch(
        /(htmlFor|id)="verifikationskod"|lookUpVerificationCode|findInEncryptedVotes/,
      )
    }
  })
})

describe('livevyn finns bara i demoläget', () => {
  const page = read('src/app/architecture/page.tsx')

  it('bara livevyn frågar efter databasernas innehåll', () => {
    /**
     * Frågar någon annan sida efter /api/demo/database-state har den också
     * ett eget ställe där demoläget måste respekteras, och det glöms när
     * predikatet byts.
     */
    const askers = sourceFilesUnder('src', { skipPage: false })
      .filter((file) => file !== 'src/app/api/demo/database-state/route.ts')
      .filter((file) => read(file).includes("'/api/demo/database-state'"))

    expect(askers).toEqual(['src/app/architecture/LiveDatabaseView.tsx'])
  })

  it('sidan frågar predikatet en gång och renderar livevyn bara när det säger ja', () => {
    /**
     * Demoläget avgörs i src/lib/demo-mode.ts, som också varje rutt under
     * /api/demo frågar (se tests/security/api-surface.test.ts). Sidan läser
     * aldrig bankIdIsMocked själv: gjorde den det kunde predikatet bytas på
     * ett ställe och sidan fortsätta på det gamla.
     */
    expect(page).toMatch(/import \{ isDemoMode \} from '@\/lib\/demo-mode'/)
    expect(page.match(/isDemoMode\(\)/g)).toHaveLength(1)
    expect(page).not.toMatch(/bankIdIsMocked/)

    const renders = page.match(/<LiveDatabaseView\b/g) ?? []
    expect(renders).toHaveLength(1)
    expect(page).toMatch(/const demo = isDemoMode\(\)/)
    expect(page).toMatch(/\{demo \?\s*\(\s*<LiveDatabaseView\b/)
  })
})
