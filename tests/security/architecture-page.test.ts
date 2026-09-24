import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CURRENTLY,
  neverWritten,
  PHASES,
  REMAINING,
  STRIPPING_HELPERS,
  STRIPPING_TRANSACTION,
  VOTERS_MODELS_TODAY,
  VOTER_MODEL_FIELDS_TODAY,
  MARKING_ONLY_IN_OLD_FLOW,
  ONE_MARKING_WRITE_EACH,
  NO_WRITES_BESIDE_THE_CODE,
  OLD_FLOW_VOTES_AND_RECEIPTS,
  type CodeFact,
  type Marker,
} from '@/app/architecture/code-facts'
import { MOMENTS } from '@/app/architecture/timeline/moments'
import { KNOWN_LIMITATIONS } from '@/lib/known-limitations'
import { vaultClaimProblems } from '../vault-claims'

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
 *
 * Sidan är uppdelad på tre: huvudsidan (/architecture) för den som aldrig
 * hört ordet kryptering, Tekniska detaljer (/architecture/technical) och
 * Utvecklingsstatus (/architecture/status). Kontrollerna gäller alla tre.
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
    // Migreringar och scheman granskas också: en trigger står i en .sql-fil.
    // Bicep-filerna under infra/azure granskas sedan uppgift 11g, eftersom
    // sidan påstår saker om Azure-uppsättningen, bland annat att ingen av
    // mallarna slår på valvets granskningslogg.
    return /\.(tsx?|sql|prisma|bicep)$/.test(child) ? [child] : []
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

  if ('onlyIn' in marker) {
    const files = sourceFilesUnder(marker.under, { skipPage: true })
    if (files.length === 0) {
      return { holds: false, detail: `${marker.under} innehåller inga filer att granska` }
    }

    const offenders = files.filter(
      (file) => !marker.onlyIn.includes(file) && marker.matches.test(read(file)),
    )
    return offenders.length === 0
      ? { holds: true, detail: '' }
      : { holds: false, detail: `${marker.matches} finns nu också i ${offenders.join(', ')}` }
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

/** Sidorna under /architecture: huvudsidan och de två undersidorna. */
const PAGES = sourceFilesUnder(PAGE_DIRECTORY, { skipPage: false }).filter((file) =>
  file.endsWith('/page.tsx'),
)

/**
 * En sidfil och allt den importerar under src/app/architecture, följt
 * rekursivt. `stopAt` utesluter en fil och det den i sin tur importerar.
 */
function filesRenderedBy(page: string, stopAt: RegExp[] = []): string[] {
  const seen = new Set<string>()

  const visit = (file: string) => {
    if (seen.has(file) || stopAt.some((pattern) => pattern.test(file))) return
    seen.add(file)

    for (const [, specifier] of read(file).matchAll(
      /from '(\.{1,2}\/[^']+|@\/app\/architecture\/[^']+)'/g,
    )) {
      const base = specifier!.startsWith('@/')
        ? join('src', specifier!.slice(2))
        : join(dirname(file), specifier!)
      const resolved = [`${base}.tsx`, `${base}.ts`]
        .map((candidate) => candidate.split(sep).join('/'))
        .find((candidate) => existsSync(join(ROOT, candidate)))
      if (resolved) visit(resolved)
    }
  }

  visit(page)
  return [...seen]
}

/** Källtexten utan kommentarer, alltså det som kan hamna på sidan. */
function withoutComments(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/**
 * Texten som en läsare ungefär ser, som i tests/security/known-limitations.test.ts:
 * utan taggar, med hopfogade strängar som en sträng och med `{' '}` och
 * radbrytningar som ett mellanslag. Meningar som står uppdelade på flera rader
 * i källan blir då hela igen.
 */
function visibleText(source: string): string {
  return source
    .replace(/(['"])\s*\+\s*\1/g, '')
    .replace(/\{\s*(['"])\s*\1\s*\}/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
}

describe('arkitektursidans påståenden om koden', () => {
  it.each(Object.entries(CURRENTLY))('"%s" stämmer fortfarande', (id, fact) => {
    expectFactHolds(id, fact)
  })

  it.each(PHASES)('fasen $phase: kolumnen "I koden i dag" stämmer fortfarande', (row) => {
    expectFactHolds(`fasen ${row.phase}`, row.today)
  })

  it.each(REMAINING)('det som återstår återstår fortfarande: "$text"', (fact) => {
    expectFactHolds(`återstår: ${fact.text}`, fact)
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

    // Bicep-filerna granskas faktiskt när en markör letar i infra/azure. Utan
    // det hade påståendet att ingen mall slår på valvets granskningslogg
    // hållit också den dag en mall gör det, eftersom ingen fil lästes.
    expect(sourceFilesUnder('infra/azure', { skipPage: true })).toEqual(
      expect.arrayContaining(['infra/azure/keyvault.bicep', 'infra/azure/app.bicep', 'infra/azure/db-init.sql']),
    )
    expect(check({ nowhereIn: 'infra/azure', matches: /keyVaultUrl/ }).holds).toBe(false)

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

describe('markeringen "har röstat" kan inte skrivas förbi påståendet', () => {
  /**
   * Påståendet votedMarkerNotKept säger att ingenting i röstlängden markerar
   * en kuvertröst efter stängningen. Uppgift 11d ska skriva en sådan
   * markering i skalningens transaktion (spec 3.1 punkt 6), kanske i en ny
   * modell eller genom en hjälpfunktion. Markören som fanns innan letade bara
   * efter två namn i tre filer, och hade stått kvar grönt.
   *
   * Här prövas att varje sådan skrivning fäller påståendet: en ny rad i
   * transaktionen, ett nytt anrop med `tx`, en ny skrivning i hjälpfunktionen
   * den anropar och en ny tabell i röstlängden.
   */
  function textMarker(marker: Marker): { file: string; contains: string } {
    if (!('file' in marker)) throw new Error('Väntade en markör av formen { file, contains }.')
    return marker
  }
  const contains = (marker: Marker) => textMarker(marker).contains

  const transaction = read(textMarker(STRIPPING_TRANSACTION).file)
  const pendingVoteService = read(textMarker(STRIPPING_HELPERS[0]!).file)

  it('markörerna ingår i påståendet och håller i dag', () => {
    const markers = CURRENTLY.votedMarkerNotKept.holdsWhile
    expect(markers).toContain(STRIPPING_TRANSACTION)
    expect(markers).toContain(VOTERS_MODELS_TODAY)
    expect(markers).toContain(MARKING_ONLY_IN_OLD_FLOW)
    for (const marker of [
      ...STRIPPING_HELPERS,
      ...VOTER_MODEL_FIELDS_TODAY,
      ...ONE_MARKING_WRITE_EACH,
      ...NO_WRITES_BESIDE_THE_CODE,
    ]) {
      expect(markers).toContain(marker)
    }

    expect(transaction.includes(contains(STRIPPING_TRANSACTION))).toBe(true)
    expect(check(VOTERS_MODELS_TODAY).holds).toBe(true)
  })

  it('en ny skrivning i skalningens transaktion fäller påståendet', () => {
    const opening = '      async (tx) => {\n'
    expect(transaction).toContain(opening)

    const insertions = [
      // En markering i en ny modell.
      '        await tx.votedMarker.createMany({ data: [] })\n',
      // Det gamla flödets markering.
      '        await tx.voterBallotStatus.createMany({ data: [] })\n',
      // En hjälpfunktion som får transaktionen.
      '        await markEnvelopesAsVoted(electionId, tx)\n',
    ]

    for (const insertion of insertions) {
      const first = transaction.replace(opening, opening + insertion)
      const beforeReturn = transaction.replace(
        '        return removed\n',
        insertion + '        return removed\n',
      )
      expect(first.includes(contains(STRIPPING_TRANSACTION)), insertion).toBe(false)
      expect(beforeReturn.includes(contains(STRIPPING_TRANSACTION)), insertion).toBe(false)
    }
  })

  it('en ny skrivning i raderingen som transaktionen anropar fäller påståendet', () => {
    const [clearPendingVotes, pendingVoteClient] = STRIPPING_HELPERS.map(contains)
    const deletion = '  const result = await client.pendingVote.deleteMany({\n'
    expect(pendingVoteService).toContain(deletion)

    const mutated = pendingVoteService.replace(
      deletion,
      '  await client.voterBallotStatus.createMany({ data: [] })\n' + deletion,
    )
    expect(mutated.includes(clearPendingVotes!)).toBe(false)

    // Och för att nå en annan tabell genom transaktionen måste klienttypen vidgas.
    const widened = pendingVoteService.replace(
      "'electionBallot' | 'pendingVote'>",
      "'electionBallot' | 'pendingVote' | 'votedMarker'>",
    )
    expect(widened.includes(pendingVoteClient!)).toBe(false)
  })

  it('en ny tabell i röstlängden fäller påståendet', () => {
    if (!('matches' in VOTERS_MODELS_TODAY)) throw new Error('Väntade ett mönster.')
    const schema = read('prisma/voters/schema.prisma')

    expect(VOTERS_MODELS_TODAY.matches.test(schema)).toBe(false)
    expect(VOTERS_MODELS_TODAY.matches.test(`${schema}\nmodel VotedMarker {\n  id String\n}\n`)).toBe(
      true,
    )
    // Ett namn som börjar som ett befintligt räknas inte som det befintliga.
    expect(VOTERS_MODELS_TODAY.matches.test('model PendingVoteMark {\n  id String\n}')).toBe(true)
  })

  it('en ny kolumn i VoterStatus eller VoterBallotStatus fäller påståendet, en ändrad kommentar inte', () => {
    const schema = read('prisma/voters/schema.prisma')
    const [voterStatus, voterBallotStatus] = VOTER_MODEL_FIELDS_TODAY.map((marker) => {
      if (!('matches' in marker)) throw new Error('Väntade ett mönster.')
      return marker.matches
    })

    expect(voterStatus!.test(schema)).toBe(false)
    expect(voterBallotStatus!.test(schema)).toBe(false)

    const withColumn = schema.replace(
      '  isEligible Boolean',
      '  votedInElection Boolean @default(false)\n\n  isEligible Boolean',
    )
    expect(withColumn).not.toBe(schema)
    expect(voterStatus!.test(withColumn)).toBe(true)

    const withMarkingColumn = schema.replace(
      '  votedAt DateTime @map("voted_at")',
      '  votedAt DateTime @map("voted_at")\n  fromEnvelope Boolean @default(false)',
    )
    expect(withMarkingColumn).not.toBe(schema)
    expect(voterBallotStatus!.test(withMarkingColumn)).toBe(true)

    const withEditedComment = schema.replace('/// HMAC-SHA256(personnummer, IDENTITY_PEPPER).', '/// scrypt.')
    expect(withEditedComment).not.toBe(schema)
    expect(voterStatus!.test(withEditedComment)).toBe(false)
  })

  it('markeringen nämnd i en fil utanför det gamla flödet fäller påståendet, också i src/orchestration', () => {
    if (!('onlyIn' in MARKING_ONLY_IN_OLD_FLOW)) throw new Error('Väntade en markör med onlyIn.')
    expect(check(MARKING_ONLY_IN_OLD_FLOW).holds).toBe(true)

    // Kontrasten mot den riktiga koden: tas en av det gamla flödets filer bort
    // ur listan är den genast en fil utanför listan som nämner markeringen.
    const [first, ...rest] = MARKING_ONLY_IN_OLD_FLOW.onlyIn
    const narrowed = { ...MARKING_ONLY_IN_OLD_FLOW, onlyIn: rest }
    const verdict = check(narrowed)
    expect(verdict.holds).toBe(false)
    expect(verdict.detail).toContain(first!)

    // Markören täcker hela src, alltså också src/orchestration och alla rutter.
    expect(MARKING_ONLY_IN_OLD_FLOW.under).toBe('src')
    expect(MARKING_ONLY_IN_OLD_FLOW.matches.test('await tx.voterBallotStatus.createMany({ data })')).toBe(
      true,
    )
  })

  it('en andra skrivning av markeringen i det gamla flödets filer fäller påståendet', () => {
    for (const marker of ONE_MARKING_WRITE_EACH) {
      if (!('nowhereIn' in marker)) throw new Error('Väntade ett mönster.')
      const content = read(marker.nowhereIn)

      expect(marker.matches.test(content), marker.nowhereIn).toBe(false)
      expect(
        marker.matches.test(`${content}\nawait tx.voterBallotStatus.createMany({ data: [] })\n`),
        marker.nowhereIn,
      ).toBe(true)
    }
  })

  it('en trigger eller rå SQL som skriver fäller påståendet', () => {
    const [inPrisma, inSource, rawWrite] = NO_WRITES_BESIDE_THE_CODE.map((marker) => {
      if (!('matches' in marker) || !('nowhereIn' in marker)) throw new Error('Väntade ett mönster.')
      return marker
    })

    // Migreringarna granskas faktiskt, inte bara TypeScript.
    expect(sourceFilesUnder(inPrisma!.nowhereIn, { skipPage: true })).toEqual(
      expect.arrayContaining(['prisma/voters/migrations/20260101000000_init/migration.sql']),
    )
    for (const marker of [inPrisma!, inSource!, rawWrite!]) expect(check(marker).holds).toBe(true)

    expect(
      inPrisma!.matches.test(
        'CREATE OR REPLACE TRIGGER mark_voted AFTER DELETE ON "pending_vote" FOR EACH ROW',
      ),
    ).toBe(true)
    expect(rawWrite!.matches.test('await tx.$executeRawUnsafe(sql)')).toBe(true)
    expect(rawWrite!.matches.test("'INSERT INTO voter_ballot_status (id) VALUES ($1)'")).toBe(true)
    expect(rawWrite!.matches.test('UPDATE "voter_status" SET voted = true')).toBe(true)
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
  const allPageFiles = sourceFilesUnder(PAGE_DIRECTORY, { skipPage: false })

  it('hittar sidornas komponenter', () => {
    expect(PAGES.sort()).toEqual([
      'src/app/architecture/page.tsx',
      'src/app/architecture/status/page.tsx',
      'src/app/architecture/technical/page.tsx',
    ])
    expect(pageFiles).toEqual(
      expect.arrayContaining([
        'src/app/architecture/page.tsx',
        'src/app/architecture/LiveDatabaseView.tsx',
        'src/app/architecture/FollowAVote.tsx',
        'src/app/architecture/LinkQuestion.tsx',
        'src/app/architecture/timeline/Timeline.tsx',
        'src/app/architecture/timeline/TimelineScene.tsx',
      ]),
    )
  })

  it('hänvisar bara till begränsningar som finns i listan', () => {
    /**
     * Uppslagen görs på alla tre sidorna och i sektionernas gemensamma fil.
     * Varje `limitation('id')` i någon av dem ska peka på en post som finns;
     * annars kastar sidan när den renderas.
     */
    const referenced = allPageFiles.flatMap((file) =>
      [...read(file).matchAll(/limitation\('([a-z0-9-]+)'\)/g)].map((match) => ({
        file,
        id: match[1]!,
      })),
    )

    expect(referenced.length).toBeGreaterThan(0)
    // Alla tre sidorna slår upp något, direkt eller genom pageLimitations().
    for (const page of PAGES) {
      expect(read(page), `${page} slår inte upp någon begränsning`).toMatch(
        /limitation\('|pageLimitations\(\)/,
      )
    }

    const ids = KNOWN_LIMITATIONS.map((limitation) => limitation.id)
    for (const { file, id } of referenced) {
      expect(ids, `${file} hänvisar till ${id}, som inte finns i listan`).toContain(id)
    }
  })

  it('upprepar inga påståenden om koden som fri text', () => {
    /**
     * Samma fel som known-limitations.test.ts vaktar mot: ett påstående som
     * står på två ställen blir rättat på det ena. Texterna ska läsas ur
     * code-facts.ts, inte kopieras in i sidan.
     */
    const facts = [...Object.values(CURRENTLY), ...PHASES.map((row) => row.today), ...REMAINING]
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

  it('sidans egna filer lägger inte heller röster i det gamla flödet eller frågar efter kvitton', () => {
    /**
     * Påståendet oldFlowRoutesRemain gäller alla sidor, och arkitektursidan är
     * en av dem. Markörgranskningen ovan hoppar alltid över sidans egna filer,
     * eftersom de bär påståendena och deras mönster, så samma mönster prövas
     * här för sig. code-facts.ts skriver mönstret med snedstreck som inte
     * matchar mönstret självt.
     */
    const offenders = allPageFiles.filter((file) => OLD_FLOW_VOTES_AND_RECEIPTS.test(read(file)))
    expect(allPageFiles.length).toBeGreaterThan(10)
    expect(offenders).toEqual([])

    // Kontrasten: mönstret hittar ett anrop och en import av blindningen.
    expect(OLD_FLOW_VOTES_AND_RECEIPTS.test("await fetch('/api/vote/cast', {")).toBe(true)
    expect(OLD_FLOW_VOTES_AND_RECEIPTS.test("post(`/api/verify`, { token })")).toBe(true)
    expect(OLD_FLOW_VOTES_AND_RECEIPTS.test("import { x } from '@/lib/blind-client'")).toBe(true)
  })
})

describe('livevyn finns bara i demoläget', () => {
  /**
   * Komponenterna i livevyn, de enda som hämtar databasernas innehåll. Utan
   * g-flagga: ett globalt mönster minns var det slutade, och `test` på nästa
   * fil hade börjat leta därifrån.
   */
  const LIVE = /<(LiveDatabaseView|LiveLinkQuestion)\b/
  const ALL_LIVE = new RegExp(LIVE.source, 'g')

  it('bara livevyn frågar efter databasernas innehåll', () => {
    /**
     * Frågar någon annan fil efter /api/demo/database-state har den också
     * ett eget ställe där demoläget måste respekteras, och det glöms när
     * predikatet byts. Båda delarna av livevyn hämtar genom samma krok i
     * samma fil.
     */
    const askers = sourceFilesUnder('src', { skipPage: false })
      .filter((file) => file !== 'src/app/api/demo/database-state/route.ts')
      .filter((file) => read(file).includes("'/api/demo/database-state'"))

    expect(askers).toEqual(['src/app/architecture/LiveDatabaseView.tsx'])
    expect(read(askers[0]!).match(/'\/api\/demo\/database-state'/g)).toHaveLength(1)
  })

  it('varje sida som visar livevyn frågar predikatet en gång och renderar den bara när det säger ja', () => {
    /**
     * Demoläget avgörs i src/lib/demo-mode.ts, som också varje rutt under
     * /api/demo frågar (se tests/security/api-surface.test.ts). Sidorna läser
     * aldrig bankIdIsMocked själva: gjorde de det kunde predikatet bytas på
     * ett ställe och en sida fortsätta på det gamla.
     */
    const showing = PAGES.filter((page) => LIVE.test(read(page)))
    expect(showing.sort()).toEqual([
      'src/app/architecture/page.tsx',
      'src/app/architecture/technical/page.tsx',
    ])

    for (const page of showing) {
      const content = read(page)
      expect(content, page).toMatch(/import \{ isDemoMode \} from '@\/lib\/demo-mode'/)
      expect(content.match(/isDemoMode\(\)/g), page).toHaveLength(1)
      expect(content, page).not.toMatch(/bankIdIsMocked/)
      expect(content, page).toMatch(/const demo = isDemoMode\(\)/)

      const renders = content.match(ALL_LIVE) ?? []
      expect(renders, page).toHaveLength(1)
      expect(content, page).toMatch(/\{demo \?\s*\(\s*<(LiveDatabaseView|LiveLinkQuestion)\b/)
    }
  })

  it('rutten läser röstlängden i en enda ögonblicksbild', () => {
    /**
     * Omröstningarnas fas och raderna i pending_vote måste komma ur samma
     * ögonblick. Annars kan "Följ en röst" mitt i en stängning se kopplingen
     * som raderad och ändå hitta kuvert kvar, och varna utan skäl. Därför går
     * varje läsning av röstlängden genom en transaktion med REPEATABLE READ,
     * och ingen läsning går förbi den.
     */
    const route = read('src/app/api/demo/database-state/route.ts')

    expect(route).toContain('votersDb.$transaction(')
    expect(route).toContain('isolationLevel: VotersPrisma.TransactionIsolationLevel.RepeatableRead')
    expect(route).not.toMatch(/votersDb\.(?!\$transaction\()[$\w]+[.(]/)
    expect(route.match(/\btx\.(election|electionBallot|voterStatus|pendingVote|\$queryRawUnsafe)\b/g)?.length).toBe(8)
  })

  it('utvecklingsstatus visar ingen livevy och frågar inte efter demoläget', () => {
    const status = read('src/app/architecture/status/page.tsx')
    expect(status).not.toMatch(LIVE)
    expect(status).not.toMatch(/isDemoMode|bankIdIsMocked/)
  })
})

describe('tidslinjen är en simulering', () => {
  /**
   * Tidslinjen visar hur valet är tänkt att fungera, med en påhittad väljare.
   * Den hämtar ingenting, läser ingenting ur databasen eller livevyn och
   * frågar inte efter demoläget, så den fungerar likadant överallt och kan
   * aldrig råka visa något om en verklig väljare.
   */
  const timelineFiles = filesRenderedBy('src/app/architecture/timeline/Timeline.tsx')

  it('hittar tidslinjens filer', () => {
    expect(timelineFiles.sort()).toEqual([
      'src/app/architecture/timeline/Timeline.tsx',
      'src/app/architecture/timeline/TimelineScene.tsx',
      'src/app/architecture/timeline/moments.ts',
    ])
  })

  it.each(timelineFiles)('%s hämtar ingenting och läser inte livevyn', (file) => {
    const content = read(file)

    expect(content).not.toMatch(/\bfetch\(|XMLHttpRequest|EventSource|WebSocket|\/api\//)
    expect(content).not.toMatch(/isDemoMode|bankIdIsMocked/)
    expect(content).not.toMatch(
      /from '[^']*(LiveDatabaseView|follow-a-vote|live-refresh|db-table|database-state|code-facts)'/,
    )
    expect(content).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/)
  })

  it('bara livevyn på huvudsidan ser databasen, och tidslinjen renderas utanför dess gren', () => {
    const page = read('src/app/architecture/page.tsx')
    const timelineAt = page.indexOf('<Timeline />')
    const demoBranchAt = page.indexOf('{demo ?')

    expect(timelineAt).toBeGreaterThan(-1)
    expect(demoBranchAt).toBeGreaterThan(-1)
    expect(timelineAt, 'tidslinjen ligger inuti demolägets gren').toBeLessThan(demoBranchAt)
  })
})

describe('huvudsidan talar vardagsspråk', () => {
  /**
   * Huvudsidan är skriven för den som aldrig har hört ordet kryptering.
   * Fackorden står på Tekniska detaljer, och huvudsidan länkar dit.
   *
   * Kontrollen gäller texten i huvudsidans egna filer, utan kommentarer. Den
   * gäller inte livevyn: den visar databaserna som de är, med tabellnamn och
   * chiffer, och användaren har bett att få behålla den som den är.
   */
  const JARGON = /krypt|chiff|homomorf|tröskel|hash|merkle|signatur/i
  const mainFiles = filesRenderedBy('src/app/architecture/page.tsx', [/LiveDatabaseView\.tsx$/])

  it('hittar huvudsidans egna filer, utan livevyn', () => {
    expect(mainFiles).toEqual(
      expect.arrayContaining([
        'src/app/architecture/page.tsx',
        'src/app/architecture/sections/Intro.tsx',
        'src/app/architecture/sections/TwoEnvelopes.tsx',
        'src/app/architecture/sections/Weaknesses.tsx',
        'src/app/architecture/timeline/Timeline.tsx',
        'src/app/architecture/timeline/moments.ts',
      ]),
    )
    expect(mainFiles.some((file) => /LiveDatabaseView|FollowAVote|LinkQuestion/.test(file))).toBe(
      false,
    )
  })

  it.each(mainFiles)('%s använder inga fackord', (file) => {
    const text = withoutComments(read(file))
    const found = text.match(new RegExp(`[^\\s'"<>{}]*(${JARGON.source})[^\\s'"<>{}]*`, 'gi')) ?? []

    expect(found, `fackord i ${file}`).toEqual([])
  })

  it('tidslinjens texter använder inga fackord', () => {
    for (const moment of MOMENTS) {
      expect(`${moment.label} ${moment.title} ${moment.text}`, `moment ${moment.number}`).not.toMatch(
        JARGON,
      )
    }
  })

  it.each(mainFiles)('%s låter aldrig valvet hålla nyckelns delar eller ta bort kopplingen', (file) => {
    /**
     * Uppgift 11g. Valvet ska aldrig se ut att hålla förtroendepersonernas
     * nycklar, och ingenting får antyda att det är valvet som gör kopplingen
     * omöjlig: det gör raderingen vid stängningen. Reglerna står i
     * tests/vault-claims.ts, och de prövas här mot texten i varje fil som
     * huvudsidan renderar, inte bara mot momenten.
     */
    expect(vaultClaimProblems(visibleText(withoutComments(read(file)))), file).toEqual([])
  })

  it('valvet lyser i scenen bara när momentet säger det, och scenen ritar aldrig en nyckel i det', () => {
    /**
     * Scenen läser valvets läge ur momentets `vault.inScene`, som
     * tests/unit/timeline-moments.test.ts prövar, och har inget eget. Med en
     * egen uppgift i tabellen över zoner hade bilden kunnat lysa upp valvet i
     * moment 9, när kopplingen tas bort, eller i moment 11, när summan öppnas,
     * utan att någon text ändrats. Valvets figurer innehåller aldrig en nyckel:
     * nycklarna i scenen är förtroendepersonernas.
     */
    const scene = read('src/app/architecture/timeline/TimelineScene.tsx')
    const zones = scene.slice(scene.indexOf('const ACTIVE'), scene.indexOf('function isActive'))
    expect(zones).toContain('const ACTIVE')
    expect(zones).not.toMatch(/vault/)
    expect(scene).toMatch(/vault\?\.inScene === true/)

    const vaultParts = ['function VaultZone', 'function Vault(', 'function SecretBadge', 'function SecretMark']
    for (const name of vaultParts) {
      const start = scene.indexOf(name)
      expect(start, name).toBeGreaterThan(-1)
      const end = scene.indexOf('\nfunction ', start + name.length)
      expect(scene.slice(start, end === -1 ? undefined : end), name).not.toMatch(/<Key\b|tl-key/)
    }
  })

  it('kontrollen hittar ett fackord, också i en sträng eller i JSX', () => {
    // Kontrasten: utan den kunde en borttagning av kommentarer som äter all
    // text få kontrollen ovan att passera.
    expect(withoutComments("const x = 'krypterad röst'")).toMatch(JARGON)
    expect(withoutComments('<p>Chiffret är ett tal</p>')).toMatch(JARGON)
    expect(withoutComments('// krypterad\nconst y = 1')).not.toMatch(JARGON)
    expect(withoutComments('{/* hashen */}<p>Hej</p>')).not.toMatch(JARGON)
  })
})
