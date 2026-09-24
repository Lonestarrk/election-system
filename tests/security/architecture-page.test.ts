import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUILT,
  CURRENTLY,
  describeStatus,
  dedupeStatuses,
  LIMITATION_STATUS,
  neverWritten,
  OUT_OF_SCOPE,
  PHASES,
  REMAINING,
  STATUS_DONE,
  STATUS_OUT_OF_SCOPE,
  statusPlanned,
  STRIPPING_HELPERS,
  STRIPPING_TRANSACTION,
  VOTERS_MODELS_TODAY,
  VOTER_MODEL_FIELDS_TODAY,
  MARKING_ONLY_IN_OLD_FLOW,
  ONE_MARKING_WRITE_EACH,
  NO_WRITES_BESIDE_THE_CODE,
  MARKER_WRITTEN_ONLY_IN_STRIPPING,
  VOTED_MARKER_HAS_NO_TIME,
  OLD_FLOW_VOTES_AND_RECEIPTS,
  type CodeFact,
  type Marker,
  type Status,
} from '@/app/architecture/code-facts'
import { MOMENTS } from '@/app/architecture/timeline/moments'
import { KNOWN_LIMITATIONS } from '@/lib/known-limitations'
import { visibleText } from '../page-text'
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
    // mallarna slår på valvets granskningslogg. Skripten, som deploy.sh,
    // granskas sedan granskningen av 11g (M7): samma sak kan göras med az i
    // ett skript som med en resurs i Bicep.
    return /\.(tsx?|sql|prisma|bicep|sh)$/.test(child) ? [child] : []
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

/**
 * HUVUDSIDANS MENINGAR OM VALVET I DAG, KNUTNA TILL SAMMA MARKÖRER
 * (granskningen av 11g, V3).
 *
 * Huvudsidan får inte importera code-facts.ts: påståendena där är skrivna med
 * fackord, och fackordstestet nedan hade gått rött. Huvudsidan säger därför
 * samma sak med egna ord, och den här listan knyter varje sådan mening till
 * påståendena på Tekniska detaljer som bär markörerna. Går en markör röd visar
 * felmeddelandet både den tekniska texten och huvudsidans meningar, så att
 * ingen av dem blir kvar och lovar för mycket.
 *
 * Citaten ska stå ordagrant i sina filer, som en läsare ser dem. Ett citat som
 * inte längre finns betyder att meningen skrivits om, och då ska listan följa
 * med; testet nedan kräver det.
 */
const MAIN_PAGE_VAULT_CLAIMS: ReadonlyArray<{
  file: string
  quote: string
  facts: ReadonlyArray<keyof typeof CURRENTLY>
}> = [
  // Svagheterna.
  {
    file: 'src/app/architecture/sections/Weaknesses.tsx',
    quote: 'Uppsättningen i Azure slår i dag inte på någon logg över vem som läser valvet',
    facts: ['vaultNoAuditLog'],
  },
  {
    file: 'src/app/architecture/sections/Weaknesses.tsx',
    quote:
      'Systemet får de hemligheter det använder ur valvet när det startar och har dem sedan i minnet, också nycklarna till båda urnorna',
    facts: ['vaultToEnvironment', 'appHoldsEverything'],
  },
  {
    file: 'src/app/architecture/sections/Weaknesses.tsx',
    quote: 'Resten, bland dem huvudnyckeln till båda urnorna, kan det hämta ur valvet när som helst',
    facts: ['vaultAccess', 'vaultPgAdmin'],
  },
  {
    file: 'src/app/architecture/sections/Weaknesses.tsx',
    quote: 'och det gör också den som driver systemet i Azure',
    facts: ['azureOwner'],
  },
  {
    file: 'src/app/architecture/sections/Weaknesses.tsx',
    quote: 'Att urnorna har var sin nyckel skyddar bara mot att en av nycklarna läcker',
    facts: ['vaultDatabaseUrls', 'appHoldsEverything'],
  },
  {
    file: 'src/app/architecture/sections/Weaknesses.tsx',
    quote: 'Starkare vore ett valv som gjorde fingeravtrycken själv, utan att lämna ut hemligheten. Det är inte byggt',
    facts: ['azureNotBuilt'],
  },
  {
    file: 'src/app/architecture/sections/Weaknesses.tsx',
    quote: 'står hemligheterna i en textfil bredvid programmet',
    facts: ['secretsInFilesLocally'],
  },
  {
    file: 'src/app/architecture/sections/Weaknesses.tsx',
    quote: 'Valvet finns bara när systemet körs i Azure',
    facts: ['secretsInFilesLocally', 'vaultToEnvironment'],
  },
  {
    file: 'src/app/architecture/sections/Weaknesses.tsx',
    quote: 'Demon körs också i Azure, med hemligheterna i valvet',
    facts: ['azureRunsDemo', 'vaultToEnvironment'],
  },
  {
    file: 'src/app/architecture/sections/Weaknesses.tsx',
    quote:
      'Men lösenorden som låser nyckelns delar i demovalet står i koden och skrivs ut varje gång systemet startar',
    facts: ['azureRunsDemo'],
  },
  {
    file: 'src/app/architecture/sections/Weaknesses.tsx',
    quote: 'Hemligheten i valvet gör fingeravtryck av personnummer',
    facts: ['vaultPepper'],
  },
  {
    file: 'src/app/architecture/sections/Weaknesses.tsx',
    quote: 'Hemligheten låser också upp intygen i de yttre kuverten',
    facts: ['vaultPepper'],
  },
  {
    file: 'src/app/architecture/sections/Weaknesses.tsx',
    quote: 'både i urnan medan röstningen pågår och i en kopia av urnan från före stängningen',
    facts: ['azureBackups'],
  },
  {
    file: 'src/app/architecture/sections/Weaknesses.tsx',
    quote: 'behöver då hemligheten ur valvet, som också visar namnen på dem som röstat',
    facts: ['vaultPepper'],
  },
  // Förklaringen ovanför tidslinjen.
  {
    file: 'src/app/architecture/sections/TwoEnvelopes.tsx',
    quote: 'Valvet förvarar systemets egna hemligheter i Microsofts moln, Azure, där systemet körs',
    facts: ['vaultToEnvironment'],
  },
  {
    file: 'src/app/architecture/sections/TwoEnvelopes.tsx',
    quote: 'I valvet finns hemligheten som gör ditt personnummer till ett fingeravtryck',
    facts: ['vaultPepper'],
  },
  {
    file: 'src/app/architecture/sections/TwoEnvelopes.tsx',
    quote: 'var sin nyckel till de två urnorna, så att den som får tag i den ena inte ens kommer in i den andra',
    facts: ['vaultDatabaseUrls'],
  },
  {
    file: 'src/app/architecture/sections/TwoEnvelopes.tsx',
    quote: 'Samma valv har också en huvudnyckel till båda urnorna, och systemet kan läsa den',
    facts: ['vaultPgAdmin', 'vaultAccess'],
  },
  {
    // Kopplingen ligger under röstningen i pending_vote, i röstlängden, som bär
    // både väljaren och chiffret. Flyttas en del av den till röstdatabasen före
    // stängningen slutar meningen att stämma, och markörerna i de två
    // påståendena går rött.
    file: 'src/app/architecture/sections/TwoEnvelopes.tsx',
    quote:
      'Uppdelningen skyddar inte heller kopplingen mellan namn och röst, eftersom den under röstningen ligger i urnan med namn ensam',
    facts: ['votePageLaysEnvelopes', 'copiesKeepLink'],
  },
  {
    file: 'src/app/architecture/sections/TwoEnvelopes.tsx',
    quote: 'Nyckelns tre delar finns inte i valvet',
    facts: ['sharesNotInVault', 'electionKeyNotStored'],
  },
  {
    file: 'src/app/architecture/sections/TwoEnvelopes.tsx',
    quote: 'märket i hörnet är ditt intyg från BankID, inlåst med en hemlighet ur valvet',
    facts: ['vaultPepper'],
  },
  // Tidslinjen och momentens anteckningar.
  {
    file: 'src/app/architecture/timeline/Timeline.tsx',
    quote: 'Systemet får de hemligheter det använder ur valvet när det startar och har dem sedan i minnet',
    facts: ['vaultToEnvironment'],
  },
  {
    file: 'src/app/architecture/timeline/moments.ts',
    quote: 'Systemets egna hemligheter förvaras i ett valv',
    facts: ['vaultToEnvironment'],
  },
  {
    file: 'src/app/architecture/timeline/moments.ts',
    quote: 'Låsets nyckel finns inte i valvet, varken hel eller i delar',
    facts: ['sharesNotInVault', 'electionKeyNotStored'],
  },
  {
    file: 'src/app/architecture/timeline/moments.ts',
    quote: 'Systemet gör om ditt personnummer till ett fingeravtryck med en hemlighet ur valvet',
    facts: ['vaultPepper'],
  },
  {
    file: 'src/app/architecture/timeline/moments.ts',
    quote: 'låser sedan in intyget i det yttre kuvertet med en nyckel som görs av samma hemlighet ur valvet',
    facts: ['vaultPepper'],
  },
  {
    file: 'src/app/architecture/timeline/moments.ts',
    quote: 'Hemligheten ur valvet låser upp intygen',
    facts: ['vaultPepper'],
  },
  {
    file: 'src/app/architecture/timeline/moments.ts',
    quote: 'för till dem har valvet ingen nyckel',
    facts: ['sharesNotInVault', 'electionKeyNotStored'],
  },
  {
    file: 'src/app/architecture/timeline/moments.ts',
    quote: 'I en kopia av urnan från före stängningen låser den däremot fortfarande upp namnen',
    facts: ['azureBackups'],
  },
  {
    file: 'src/app/architecture/timeline/moments.ts',
    quote: 'Valvet har ingen del av nyckeln till summan',
    facts: ['sharesNotInVault'],
  },
  {
    file: 'src/app/architecture/timeline/moments.ts',
    quote: 'och de finns inte heller i valvet',
    facts: ['sharesNotInVault'],
  },
]

/** Huvudsidans meningar som bygger på ett påstående, som de ska stå i ett felmeddelande. */
function mainPageQuotesFor(id: string): string[] {
  return MAIN_PAGE_VAULT_CLAIMS.filter((claim) =>
    (claim.facts as readonly string[]).includes(id),
  ).map((claim) => `${claim.file}: "${claim.quote}"`)
}

/** Felmeddelandet när en markör inte längre håller, med huvudsidans meningar när det finns några. */
function factFailureMessage(label: string, fact: CodeFact, detail: string, mainPage: string[]): string {
  return (
    `\n\n  ARKITEKTURSIDANS PÅSTÅENDE "${label}" STÄMMER INTE LÄNGRE.\n\n` +
    `  Sidan säger: "${fact.text}"\n` +
    (mainPage.length > 0
      ? `  Huvudsidan säger samma sak med egna ord:\n${mainPage.map((quote) => `    ${quote}\n`).join('')}`
      : '') +
    `  Men ${detail}.\n\n` +
    '  Har koden blivit bättre: skriv om påståendet i src/app/architecture/code-facts.ts,\n' +
    (mainPage.length > 0 ? '  och meningarna på huvudsidan ovan,\n' : '') +
    '  och titta på sidan i en webbläsare. Har du bara flyttat kod: peka om markören.\n'
  )
}

function expectFactHolds(label: string, fact: CodeFact, mainPage: string[] = []): void {
  expect(fact.holdsWhile.length, `${label} saknar markör`).toBeGreaterThan(0)

  for (const marker of fact.holdsWhile) {
    const { holds, detail } = check(marker)
    expect(holds, factFailureMessage(label, fact, detail, mainPage)).toBe(true)
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

describe('arkitektursidans påståenden om koden', () => {
  it.each(Object.entries(CURRENTLY))('"%s" stämmer fortfarande', (id, fact) => {
    expectFactHolds(id, fact, mainPageQuotesFor(id))
  })

  it('huvudsidans meningar om valvet står ordagrant i sina filer och bygger på påståenden som finns', () => {
    /**
     * Listan ovan är värd något bara om citaten fortfarande är sidans text:
     * ett citat som inte finns kvar vaktar ingenting. Och varje citat ska peka
     * på ett påstående med markörer.
     */
    expect(MAIN_PAGE_VAULT_CLAIMS.length).toBeGreaterThan(20)
    for (const claim of MAIN_PAGE_VAULT_CLAIMS) {
      const text = visibleText(withoutComments(read(claim.file)))
      expect(text.includes(claim.quote), `${claim.file} säger inte längre "${claim.quote}"`).toBe(true)
      expect(claim.facts.length, claim.quote).toBeGreaterThan(0)
      for (const id of claim.facts) expect(Object.keys(CURRENTLY), claim.quote).toContain(id)
    }
  })

  it('en röd markör visar huvudsidans mening bredvid den tekniska texten', () => {
    // Kontrasten: meddelandet som testet ovan skriver när en markör fallerar.
    const message = factFailureMessage(
      'vaultNoAuditLog',
      CURRENTLY.vaultNoAuditLog,
      'mönstret finns nu i infra/azure/deploy.sh',
      mainPageQuotesFor('vaultNoAuditLog'),
    )
    expect(message).toContain(CURRENTLY.vaultNoAuditLog.text)
    expect(message).toContain('Uppsättningen i Azure slår i dag inte på någon logg över vem som läser valvet')
    expect(message).toContain('src/app/architecture/sections/Weaknesses.tsx')
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
      expect.arrayContaining([
        'infra/azure/keyvault.bicep',
        'infra/azure/app.bicep',
        'infra/azure/db-init.sql',
        'infra/azure/deploy.sh',
      ]),
    )
    expect(check({ nowhereIn: 'infra/azure', matches: /keyVaultUrl/ }).holds).toBe(false)
    // Och skriptet läses: ett mönster som bara står i deploy.sh fäller en
    // katalogmarkör. Utan det hade en granskningslogg som slogs på med az gått
    // förbi påståendet att ingen logg slås på.
    expect(check({ nowhereIn: 'infra/azure', matches: /secret_exists\(\) \{/ }).holds).toBe(false)

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

describe('markeringen "har röstat" skrivs bara i skalningens transaktion', () => {
  /**
   * Fram till uppgift 11d sa påståendet votedMarkerNotKept att ingenting i
   * röstlängden markerade en kuvertröst efter stängningen, och markörerna här
   * vaktade att ingen sådan markering kunde glida förbi. Uppgift 11d skrev
   * markeringen, i skalningens transaktion (spec 3.1 punkt 6), och påståendet
   * är nu det omvända: votedMarkerWritten säger att markeringen skrivs just
   * där, ur de kuvert som raderas, en per flyttat kuvert och utan tid.
   *
   * Markörerna är till stor del desamma, och här prövas att varje sätt att
   * skriva en markering någon annanstans fäller påståendet: en ny rad i
   * transaktionen, en ny skrivning i en hjälpfunktion, en skrivning av
   * markeringen eller ett anrop till hjälpfunktionen utanför stängningen, en
   * kolumn för tid, en ny tabell och en trigger.
   */
  function textMarker(marker: Marker): { file: string; contains: string } {
    if (!('file' in marker)) throw new Error('Väntade en markör av formen { file, contains }.')
    return marker
  }
  const contains = (marker: Marker) => textMarker(marker).contains

  const transaction = read(textMarker(STRIPPING_TRANSACTION).file)
  const pendingVoteService = read(textMarker(STRIPPING_HELPERS[0]!).file)

  it('markörerna ingår i påståendet och håller i dag', () => {
    const markers = CURRENTLY.votedMarkerWritten.holdsWhile
    expect(markers).toContain(STRIPPING_TRANSACTION)
    expect(markers).toContain(VOTERS_MODELS_TODAY)
    expect(markers).toContain(MARKING_ONLY_IN_OLD_FLOW)
    expect(markers).toContain(VOTED_MARKER_HAS_NO_TIME)
    for (const marker of [
      ...STRIPPING_HELPERS,
      ...MARKER_WRITTEN_ONLY_IN_STRIPPING,
      ...VOTER_MODEL_FIELDS_TODAY,
      ...ONE_MARKING_WRITE_EACH,
      ...NO_WRITES_BESIDE_THE_CODE,
    ]) {
      expect(markers).toContain(marker)
    }

    expect(transaction.includes(contains(STRIPPING_TRANSACTION))).toBe(true)
    expect(check(VOTERS_MODELS_TODAY).holds).toBe(true)

    // Transaktionen skriver markeringen före raderingen, och prövar antalet.
    const stripping = contains(STRIPPING_TRANSACTION)
    expect(stripping.indexOf('markEnvelopesAsVoted(')).toBeGreaterThan(-1)
    expect(stripping.indexOf('markEnvelopesAsVoted(')).toBeLessThan(stripping.indexOf('clearPendingVotes('))
    expect(stripping).toContain('marked !== moved || !markersMatch')
  })

  it('en ny skrivning i skalningens transaktion fäller påståendet', () => {
    // Förankrad i transaktionens första sats: stängningens lås har en egen
    // transaktion längre upp i filen, som också börjar med `async (tx) => {`.
    const opening = '      async (tx) => {\n        const stripped = await tx.election.updateMany({\n'
    expect(transaction).toContain(opening)

    const insertions = [
      // En markering i en annan modell.
      '        await tx.votedAt.createMany({ data: [] })\n',
      // Det gamla flödets markering.
      '        await tx.voterBallotStatus.createMany({ data: [] })\n',
      // En hjälpfunktion som får transaktionen.
      '        await markEnvelopesAsVotedAgain(electionId, tx)\n',
    ]

    for (const insertion of insertions) {
      const first = transaction.replace(opening, opening.replace('{\n', `{\n${insertion}`))
      const beforeReturn = transaction.replace(
        '        return removed\n',
        insertion + '        return removed\n',
      )
      expect(first.includes(contains(STRIPPING_TRANSACTION)), insertion).toBe(false)
      expect(beforeReturn.includes(contains(STRIPPING_TRANSACTION)), insertion).toBe(false)
    }

    // Och en markering efter raderingen i stället för före fäller det också.
    const marking = [
      '        // Markeringarna, ur exakt de kuvert som raderas, före raderingen.',
      '        const { marked, markersByBallot } = await markEnvelopesAsVoted(electionId, envelopes, tx)',
    ].join('\n')
    const clearing = [
      '        // Exakt de kuvert som validerades och flyttades, och inga andra.',
      '        const { removed, left } = await clearPendingVotes(electionId, envelopes, tx)',
    ].join('\n')
    const swapped = transaction.replace(`${marking}\n\n${clearing}`, `${clearing}\n\n${marking}`)
    expect(swapped).not.toBe(transaction)
    expect(swapped.includes(contains(STRIPPING_TRANSACTION))).toBe(false)
  })

  it('en ny skrivning i en hjälpfunktion som transaktionen anropar fäller påståendet', () => {
    const [clearPendingVotes, pendingVoteClient, markHelper, votedMarkerClient] = STRIPPING_HELPERS.map(contains)
    const deletion = '  const result = await client.pendingVote.deleteMany({\n'
    expect(pendingVoteService).toContain(deletion)

    const mutated = pendingVoteService.replace(
      deletion,
      '  await client.voterBallotStatus.createMany({ data: [] })\n' + deletion,
    )
    expect(mutated.includes(clearPendingVotes!)).toBe(false)

    // Markeringen utan sortering, eller utan skipDuplicates, fäller påståendet.
    expect(pendingVoteService).toContain(markHelper!)
    expect(pendingVoteService.replace('  voters.sort(byBallotThenVoter)\n', '').includes(markHelper!)).toBe(false)
    expect(pendingVoteService.replace('      skipDuplicates: true,\n', '').includes(markHelper!)).toBe(false)

    // Och för att nå en annan tabell genom transaktionen måste en klienttyp vidgas.
    const widened = pendingVoteService.replace(
      "'electionBallot' | 'pendingVote'>",
      "'electionBallot' | 'pendingVote' | 'votedAt'>",
    )
    expect(widened.includes(pendingVoteClient!)).toBe(false)
    const widenedMarker = pendingVoteService.replace(
      "'electionBallot' | 'pendingVote' | 'votedMarker'>",
      "'electionBallot' | 'pendingVote' | 'votedMarker' | 'voterStatus'>",
    )
    expect(widenedMarker.includes(votedMarkerClient!)).toBe(false)
  })

  it('en skrivning av markeringen, eller ett anrop till hjälpfunktionen, utanför skalningen fäller påståendet', () => {
    const [writes, calls] = MARKER_WRITTEN_ONLY_IN_STRIPPING
    if (!writes || !('onlyIn' in writes) || !calls || !('onlyIn' in calls)) {
      throw new Error('Väntade två markörer med onlyIn.')
    }
    expect(check(writes).holds).toBe(true)
    expect(check(calls).holds).toBe(true)

    // Kontrasten mot den riktiga koden: tas filen där markeringen skrivs bort
    // ur listan är den genast en fil utanför listan.
    const narrowedWrites = check({ ...writes, onlyIn: [] })
    expect(narrowedWrites.holds).toBe(false)
    expect(narrowedWrites.detail).toContain('src/modules/eligibility/pending-vote.service.ts')
    const narrowedCalls = check({ ...calls, onlyIn: ['src/modules/eligibility/pending-vote.service.ts'] })
    expect(narrowedCalls.holds).toBe(false)
    expect(narrowedCalls.detail).toContain('src/orchestration/close-election.usecase.ts')

    // Mönstren gäller hela src och träffar en skrivning och ett anrop.
    expect(writes.under).toBe('src')
    expect(calls.under).toBe('src')
    expect(writes.matches.test('await votersDb.votedMarker.create({ data })')).toBe(true)
    expect(writes.matches.test('await votersDb.votedMarker.count()')).toBe(false)
    expect(calls.matches.test('await markEnvelopesAsVoted(electionId, envelopes, votersDb)')).toBe(true)
  })

  it('en ny tabell i röstlängden fäller påståendet', () => {
    if (!('matches' in VOTERS_MODELS_TODAY)) throw new Error('Väntade ett mönster.')
    const schema = read('prisma/voters/schema.prisma')

    expect(VOTERS_MODELS_TODAY.matches.test(schema)).toBe(false)
    expect(VOTERS_MODELS_TODAY.matches.test(`${schema}\nmodel VotedAt {\n  id String\n}\n`)).toBe(true)
    // Ett namn som börjar som ett befintligt räknas inte som det befintliga.
    expect(VOTERS_MODELS_TODAY.matches.test('model PendingVoteMark {\n  id String\n}')).toBe(true)
    expect(VOTERS_MODELS_TODAY.matches.test('model VotedMarkerAt {\n  id String\n}')).toBe(true)
  })

  it('en ny kolumn i VoterStatus, VoterBallotStatus eller VotedMarker fäller påståendet, en ändrad kommentar inte', () => {
    const schema = read('prisma/voters/schema.prisma')
    const [voterStatus, voterBallotStatus] = VOTER_MODEL_FIELDS_TODAY.map((marker) => {
      if (!('matches' in marker)) throw new Error('Väntade ett mönster.')
      return marker.matches
    })
    if (!('matches' in VOTED_MARKER_HAS_NO_TIME)) throw new Error('Väntade ett mönster.')
    const votedMarker = VOTED_MARKER_HAS_NO_TIME.matches

    expect(voterStatus!.test(schema)).toBe(false)
    expect(voterBallotStatus!.test(schema)).toBe(false)
    expect(votedMarker.test(schema)).toBe(false)

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

    // En tid i kuvertmodellens markering är just det den inte får ha.
    const withTime = schema.replace(
      '  @@map("voted_marker")',
      '  markedAt DateTime @map("marked_at")\n\n  @@map("voted_marker")',
    )
    expect(withTime).not.toBe(schema)
    expect(votedMarker.test(withTime)).toBe(true)

    const withEditedComment = schema.replace(
      '/// scrypt av personnumret, med IDENTITY_PEPPER som salt (se',
      '/// scrypt.',
    )
    expect(withEditedComment).not.toBe(schema)
    expect(voterStatus!.test(withEditedComment)).toBe(false)
    const withEditedMarkerComment = schema.replace(
      '/// INGEN TIDSSTÄMPEL. Markeringen säger att väljaren röstade, men inte när.',
      '/// Ingen tid.',
    )
    expect(withEditedMarkerComment).not.toBe(schema)
    expect(votedMarker.test(withEditedMarkerComment)).toBe(false)
  })

  it('det gamla flödets markering nämnd i en fil utanför det gamla flödet fäller påståendet, också i src/orchestration', () => {
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

  it('en andra skrivning av det gamla flödets markering i dess filer fäller påståendet', () => {
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
      expect.arrayContaining([
        'prisma/voters/migrations/20260101000000_init/migration.sql',
        'prisma/voters/migrations/20260924230000_voted_marker/migration.sql',
      ]),
    )
    for (const marker of [inPrisma!, inSource!, rawWrite!]) expect(check(marker).holds).toBe(true)

    expect(
      inPrisma!.matches.test(
        'CREATE OR REPLACE TRIGGER mark_voted AFTER DELETE ON "pending_vote" FOR EACH ROW',
      ),
    ).toBe(true)
    expect(rawWrite!.matches.test('await tx.$executeRawUnsafe(sql)')).toBe(true)
    expect(rawWrite!.matches.test("'INSERT INTO voted_marker (id) VALUES ($1)'")).toBe(true)
    expect(rawWrite!.matches.test('UPDATE "voter_status" SET voted = true')).toBe(true)
    // Läggningens prövning av fasen läser bara, och fäller inte påståendet.
    expect(
      rawWrite!.matches.test('SELECT phase, closes_at, link_cleared_at FROM election WHERE id = $1 FOR SHARE'),
    ).toBe(false)
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
    const facts: Array<{ text: string }> = [
      ...Object.values(CURRENTLY),
      ...PHASES.map((row) => row.today),
      ...REMAINING,
      ...BUILT,
      ...OUT_OF_SCOPE,
    ]
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
    // Citattecknen blir mellanslag. I en .ts-fil slutar en text med punkt och
    // citattecken, och utan mellanslaget hade den slagits ihop med nästa sträng
    // till en enda mening, med valvet ur ett moment och kopplingen ur nästa.
    const text = visibleText(withoutComments(read(file))).replace(/['"`]/g, ' ')
    expect(vaultClaimProblems(text), file).toEqual([])
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

  it('valvets tider i scenen finns för exakt de moment som tänder valvet, utom moment 1', () => {
    /**
     * Granskningen av 11g, M12: tabellen hade ett tyst förval, så att ett nytt
     * moment som tände valvet fick en gissad tid. Nu kastar scenen hellre, och
     * det här testet säger vilket moment som saknas innan scenen gör det.
     * Moment 1 har ingen tid, eftersom valvet görs i ordning där och ingen
     * hemlighet används. Valvets ratt vrids inte heller längre (M1).
     */
    const scene = read('src/app/architecture/timeline/TimelineScene.tsx')
    const table = scene.match(/const VAULT_USE_AT[^=]*=\s*\{([^}]*)\}/)
    expect(table, 'VAULT_USE_AT saknas').not.toBeNull()

    const timed = [...table![1]!.matchAll(/(\d+)\s*:/g)].map((match) => Number(match[1]))
    const lit = MOMENTS.filter((entry) => entry.vault?.inScene === true && entry.number !== 1).map(
      (entry) => entry.number,
    )
    expect(timed.sort((a, b) => a - b)).toEqual(lit)
    expect(scene).not.toMatch(/VAULT_USE_AT\[[^\]]*\]\s*\?\?/)
    expect(scene).not.toMatch(/kind="turn"|tl-turn/)
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

describe('Utvecklingsstatus: klart, kommer att implementeras, saknas (uppgift 11h)', () => {
  /**
   * KRAV 1: EN ENDA KÄLLA FÖR STATUS.
   *
   * Varje punkt på sidan får ett statusfält i code-facts.ts: `done`, `planned`
   * med uppgiftens nummer, eller `out_of_scope`. Både sammanfattningen överst
   * (BUILT/REMAINING/OUT_OF_SCOPE) och etiketterna längre ned
   * (CURRENTLY[x].status, PHASES[i].today.status, LIMITATION_STATUS) läser
   * samma fält, så de inte kan säga olika saker.
   *
   * Planens execution-rad prövas mot den riktiga filen, inte mot ett hopkopierat
   * citat, så att testet går rött om raden ändras utan att sidan hänger med.
   */
  const plan = read('docs/superpowers/plans/2026-09-22-dubbla-kuvert.md')

  const taskHeadings = new Set([...plan.matchAll(/^## Task (\w+):/gm)].map((match) => match[1]!))

  const executionOrderMatch = plan.match(/\*\*Exekveringsordning efter uppgift 11:\*\*([\s\S]*?18\.)/)
  if (!executionOrderMatch) {
    throw new Error('Hittar inte stycket "Exekveringsordning efter uppgift 11" i planen.')
  }
  const executionOrder = [...executionOrderMatch[1]!.matchAll(/\b\d+[a-z]?\b/g)].map((match) => match[0])

  /** Att statusen finns, och att ett planerat uppgiftsnummer faktiskt står i planen. */
  function expectValidStatus(label: string, status: Status | undefined): void {
    expect(status, `${label} saknar status`).toBeDefined()
    if (status?.kind === 'planned') {
      expect(taskHeadings, `${label}: "## Task ${status.task}:" finns inte i planen`).toContain(status.task)
    }
  }

  it('exekveringsordningen hittas i planen, med alla uppgifter efter uppgift 11', () => {
    // Kontrasten mot ett tomt eller trasigt regexträff: en riktig lista.
    expect(executionOrder).toEqual([
      '11a', '11b', '11c', '11f', '14', '14b', '14f', '11g', '11h', '11d', '14d', '12', '12b',
      '12c', '13', '17', '14e', '11e', '17b', '17c', '14c', '15', '16', '18',
    ])
  })

  describe('describeStatus och dedupeStatuses', () => {
    it('etiketten har alltid text', () => {
      expect(describeStatus(STATUS_DONE)).toBe('Klart')
      expect(describeStatus(STATUS_OUT_OF_SCOPE)).toBe('Ingår inte')
      expect(describeStatus(statusPlanned('11d'))).toBe('Kommer (uppgift 11d)')
    })

    it('slår ihop samma status men behåller olika status kvar', () => {
      expect(dedupeStatuses([STATUS_DONE, STATUS_DONE])).toEqual([STATUS_DONE])
      expect(dedupeStatuses([statusPlanned('12'), statusPlanned('13'), statusPlanned('12')])).toEqual([
        statusPlanned('12'),
        statusPlanned('13'),
      ])
    })
  })

  describe('Klart', () => {
    it('finns, och varje punkt bär en markör som håller', () => {
      expect(BUILT.length).toBeGreaterThan(0)
      for (const item of BUILT) expectFactHolds(item.text, item)
    })

    it('varje punkt har status "done"', () => {
      for (const item of BUILT) expect(item.status, item.text).toEqual(STATUS_DONE)
    })
  })

  describe('Kommer att implementeras', () => {
    it('varje punkt har ett planerat uppgiftsnummer som finns i planen', () => {
      expect(REMAINING.length).toBeGreaterThan(0)
      for (const item of REMAINING) expectValidStatus(item.text, item.status)
    })

    it('varje punkt bär en markör som visar att den INTE finns än', () => {
      // expectFactHolds (i den befintliga sviten ovan) prövar redan att
      // markörerna håller. Kontrasten hör hemma här: en byggd sak kan inte stå
      // kvar. neverWritten('STRIPPED') beskriver något som redan skrivs, och
      // ska alltså INTE hålla.
      expect(check(neverWritten('STRIPPED')).holds).toBe(false)
    })

    it('punkterna står i samma ordning som planens "Exekveringsordning efter uppgift 11"', () => {
      const positions = REMAINING.map((item) => {
        if (item.status?.kind !== 'planned') throw new Error(`"${item.text}" saknar en planerad uppgift`)
        const index = executionOrder.indexOf(item.status.task)
        expect(index, `uppgift ${item.status.task} finns inte i exekveringsordningen`).toBeGreaterThanOrEqual(0)
        return index
      })
      expect(positions).toEqual([...positions].sort((a, b) => a - b))
    })

    it('sidan anger inga datum', () => {
      for (const item of REMAINING) expect(item.text, item.text).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/)
    })
  })

  describe('Saknas och ingår inte i demon', () => {
    it('sex punkter, alla med status "out_of_scope"', () => {
      expect(OUT_OF_SCOPE.length).toBe(6)
      for (const item of OUT_OF_SCOPE) expect(item.status, item.text).toEqual(STATUS_OUT_OF_SCOPE)
    })

    it('punkter om koden bär en markör som håller', () => {
      const withMarkers = OUT_OF_SCOPE.filter((item) => (item.holdsWhile?.length ?? 0) > 0)
      expect(withMarkers.length).toBeGreaterThan(0)
      for (const item of withMarkers) {
        for (const marker of item.holdsWhile!) {
          expect(check(marker).holds, `${item.text}\n${JSON.stringify(marker)}`).toBe(true)
        }
      }
    })

    it('punkter utan markör finns, formulerade om något utanför koden', () => {
      const withoutMarkers = OUT_OF_SCOPE.filter((item) => (item.holdsWhile?.length ?? 0) === 0)
      expect(withoutMarkers.length).toBeGreaterThan(0)
    })

    it('cast-or-audit och distribuerad nyckelgenerering delar markör med known-limitations, inte påhittade', () => {
      const castOrAudit = OUT_OF_SCOPE.find((item) => /cast-or-audit|Benaloh/i.test(item.text))
      const dealer = OUT_OF_SCOPE.find((item) => /betrodd utdelare|distribuerad nyckelgenerering/i.test(item.text))
      const clientLimitation = KNOWN_LIMITATIONS.find((entry) => entry.id === 'client-code-from-server')
      const dealerLimitation = KNOWN_LIMITATIONS.find((entry) => entry.id === 'trusted-dealer')

      expect(castOrAudit, 'ingen punkt om cast-or-audit (Benaloh)').toBeDefined()
      expect(dealer, 'ingen punkt om distribuerad nyckelgenerering').toBeDefined()
      expect(clientLimitation?.stillTrueIf).toBeDefined()
      expect(dealerLimitation?.stillTrueIf).toBeDefined()
      expect(castOrAudit!.holdsWhile).toEqual([clientLimitation!.stillTrueIf])
      expect(dealer!.holdsWhile).toEqual([dealerLimitation!.stillTrueIf])
    })

    it('täcker specens utanför-specen-punkter, känd begränsning, Azures härdning och de två som bara ett riktigt val har', () => {
      /**
       * docs/spec/2026-09-22-dubbla-kuvert.md avsnitt 10 säger uttryckligen att
       * cast-or-audit och en pappersröst som upphäver den digitala ligger
       * utanför specen. Betrodd utdelare (distribuerad nyckelgenerering) och
       * Azures härdning (granskningslogg, rensningsskydd) står i samma avsnitt
       * som kända begränsningar, utan den kvalificeringen — granskningen av
       * fixrunda 1 fångade att rapporten till uppgift 11h påstod motsatsen om
       * den förra. Dispatchen lade till två som bara ett riktigt val har:
       * BankID i produktion och förtroendemän på egna enheter.
       */
      const spec = read('docs/spec/2026-09-22-dubbla-kuvert.md')
      expect(spec).toMatch(/cast-or-audit/)
      expect(spec).toMatch(/pappersröst/)
      expect(spec).toMatch(/distribuerad nyckelgenerering/)
      expect(spec).toMatch(/[Gg]ranskningslogg/)
      expect(spec).toMatch(/rensningsskydd/)

      const texts = OUT_OF_SCOPE.map((item) => item.text).join('\n')
      expect(texts).toMatch(/cast-or-audit|Benaloh/i)
      expect(texts).toMatch(/pappersröst/i)
      expect(texts).toMatch(/betrodd utdelare|distribuerad nyckelgenerering/i)
      expect(texts).toMatch(/granskningslogg/i)
      expect(texts).toMatch(/rensningsskydd/i)
      expect(texts).toMatch(/bank/i)
      expect(texts).toMatch(/egna|fristående enheter/i)
    })

    it('Azures härdning delar markör med CURRENTLY.azureNotBuilt, samma bevis som AzureStatus redan visar', () => {
      const azureItem = OUT_OF_SCOPE.find((item) => /granskningslogg/i.test(item.text))
      expect(azureItem, 'ingen punkt om Azures härdning').toBeDefined()
      expect(azureItem!.holdsWhile).toEqual(CURRENTLY.azureNotBuilt.holdsWhile)
    })
  })

  describe('LIMITATION_STATUS: status för de kända begränsningar sidan märker längre ned', () => {
    /** Id:n som Utvecklingsstatus faktiskt visar, i OldFlow och Remaining. */
    const usedOnStatusPage = [
      'receipt-proves-choice',
      'live-results-in-old-flow',
      'signing-keys-in-database',
      'no-guaranteed-anonymity-set',
      'bankid-order-carries-link',
      'no-revocation-check',
      'bankid-xmldsig-adapter-missing',
      'votes-db-writer-can-swap-ciphertext',
    ]

    it('varje id som visas på Utvecklingsstatus har en status', () => {
      for (const id of usedOnStatusPage) expect(LIMITATION_STATUS[id], id).toBeDefined()
    })

    it('varje nyckel finns i listan över kända begränsningar', () => {
      const ids = KNOWN_LIMITATIONS.map((limitation) => limitation.id)
      for (const id of Object.keys(LIMITATION_STATUS)) expect(ids, id).toContain(id)
    })

    it('varje planerat uppgiftsnummer finns i planen', () => {
      for (const [id, status] of Object.entries(LIMITATION_STATUS)) expectValidStatus(id, status)
    })
  })

  describe('status längre ned på sidan (kravet "samma status på varje punkt")', () => {
    it.each(PHASES)('fasen $phase har en status', (row) => {
      expectValidStatus(`fasen ${row.phase}`, row.today.status)
    })

    it('OPEN, CLOSED, VALIDATED och STRIPPED är klara; TALLIED och CERTIFIED är planerade', () => {
      // Uppgift 11d gjorde CLOSED och VALIDATED till verkliga tillstånd.
      const byPhase = Object.fromEntries(PHASES.map((row) => [row.phase, row.today.status]))
      expect(byPhase['OPEN']).toEqual(STATUS_DONE)
      expect(byPhase['CLOSED']).toEqual(STATUS_DONE)
      expect(byPhase['VALIDATED']).toEqual(STATUS_DONE)
      expect(byPhase['STRIPPED']).toEqual(STATUS_DONE)
      expect(byPhase['TALLIED']).toEqual(statusPlanned('12'))
      expect(byPhase['CERTIFIED']).toEqual(statusPlanned('12b'))
      // Och fastabellen säger inte längre "skrivs aldrig" om någon fas som skrivs.
      expect(check(neverWritten('CLOSED')).holds).toBe(false)
      expect(check(neverWritten('VALIDATED')).holds).toBe(false)
    })

    const labelled = [
      'validationGatesClose',
      'envelopeRootCommitment',
      'envelopeRootNotPublished',
      'deviceViewBuilt',
      'votedMarkerWritten',
      'votedMarkerNotShown',
      'decryptionNotBuilt',
      'decryptionGateNotBuilt',
      'sumsNotPublished',
      'auditChain',
      'certifyBlockedWhileLinked',
      'finalCheckOldModel',
      'oldFlowRoutesRemain',
      'oldFlowLiveResults',
      'azureSetupBuilt',
      'azureRunsDemo',
      'azureNotBuilt',
      'castOnlyWhileOpen',
    ] as const

    it.each(labelled)('CURRENTLY.%s har en status', (id) => {
      expectValidStatus(id, CURRENTLY[id].status)
    })

    it('azureNotBuilt är "ingår inte", inte "kommer": ingen uppgift i planen bygger det', () => {
      expect(CURRENTLY.azureNotBuilt.status).toEqual(STATUS_OUT_OF_SCOPE)
    })
  })

  describe('sidans sektioner läser status i stället för att gissa den', () => {
    const sectionFiles = [
      'src/app/architecture/sections/StatusOverview.tsx',
      'src/app/architecture/sections/ReviewToday.tsx',
      'src/app/architecture/sections/PhasesToday.tsx',
      'src/app/architecture/sections/OldFlow.tsx',
      'src/app/architecture/sections/Remaining.tsx',
      'src/app/architecture/sections/AzureStatus.tsx',
    ]

    it.each(sectionFiles)('%s visar en StatusBadge', (file) => {
      expect(read(file)).toMatch(/<StatusBadge\b/)
    })

    it('StatusBadge renderar text, inte bara en färgklass, och läser sin egen fil', () => {
      const content = read('src/app/architecture/sections/StatusBadge.tsx')
      expect(content).toMatch(/export function StatusBadge/)
      expect(content).toMatch(/describeStatus\(/)
    })

    it('shared.tsx importerar inte code-facts.ts: huvudsidan importerar shared.tsx och tillåter inga fackord', () => {
      // Regressionen som hittades under 11h: StatusBadge låg först i
      // shared.tsx, som huvudsidan också importerar (för limitation()). Det
      // drog in code-facts.ts, fullt av fackord, i huvudsidans egen graf, och
      // fällde "huvudsidan talar vardagsspråk" fast ingen text på huvudsidan
      // ändrats.
      expect(read('src/app/architecture/sections/shared.tsx')).not.toMatch(/from '\.\.\/code-facts'/)
    })

    it('StatusOverview läser BUILT, REMAINING och OUT_OF_SCOPE, upprepar dem inte som egna listor', () => {
      const content = read('src/app/architecture/sections/StatusOverview.tsx')
      expect(content).toMatch(/\bBUILT\.map\(/)
      expect(content).toMatch(/\bREMAINING\.map\(/)
      expect(content).toMatch(/\bOUT_OF_SCOPE\.map\(/)
    })

    it('StatusOverview säger direkt Klart, Kommer att implementeras och Saknas och ingår inte i demon', () => {
      const text = visibleText(read('src/app/architecture/sections/StatusOverview.tsx'))
      expect(text).toContain('Klart')
      expect(text).toContain('Kommer att implementeras')
      expect(text).toContain('Saknas och ingår inte i demon')
    })

    it('review-rows.tsx läser statusen ur CURRENTLY, radens etikett gissas inte fram', () => {
      const content = read('src/app/architecture/sections/review-rows.tsx')
      const statusFields = [...content.matchAll(/statuses:\s*\[([^\]]*)\]/g)]
      expect(statusFields.length).toBeGreaterThan(0)
      for (const [, group] of statusFields) expect(group).toMatch(/CURRENTLY\.\w+\.status/)
    })

    it('Remaining.tsx lovar inte att specen anger åtgärden för alla fyra "fixable"-begränsningar (fixrunda 1)', () => {
      /**
       * Granskningen av fixrunda 1: status/page.tsx skickar fyra kända
       * begränsningar som `fixable` till Remaining. En av dem
       * (no-revocation-check) är märkt "ingår inte", inte "kommer" — ingen
       * uppgift i planen prövar OCSP-svaret. Meningen ovanför länklistan i
       * Remaining.tsx får då inte påstå att specen redan anger åtgärden för
       * alla fyra.
       */
      const fixableIds = [
        'bankid-order-carries-link',
        'no-revocation-check',
        'bankid-xmldsig-adapter-missing',
        'votes-db-writer-can-swap-ciphertext',
      ]
      const kinds = fixableIds.map((id) => LIMITATION_STATUS[id]?.kind)
      expect(kinds, 'minst en fixable-begränsning ska vara "ingår inte"').toContain('out_of_scope')
      expect(kinds, 'minst en fixable-begränsning ska vara "kommer"').toContain('planned')

      const content = read('src/app/architecture/sections/Remaining.tsx')
      expect(content).not.toMatch(/kuvertmodellen som specen redan anger åtgärden för\./)
    })
  })
})
