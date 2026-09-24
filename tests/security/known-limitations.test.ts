import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHECKABLE_LIMITATIONS, KNOWN_LIMITATIONS } from '@/lib/known-limitations'
import { visibleText } from '../page-text'

/**
 * ETT TEST SOM FAILAR NÄR SYSTEMET BLIR BÄTTRE.
 *
 * Det låter bakvänt, och det är avsiktligt.
 *
 * Listan över kända begränsningar fanns tidigare som prosa på tre ställen:
 * arkitektursidan, SECURITY.md och VERIFIABILITY.md. Följden blev
 * förutsägbar. Ordningsproblemet mellan de två databasskrivningarna löstes av
 * röstintygen men stod kvar som ett kvarvarande problem långt efteråt — och en
 * demonstration som påstår att systemet är sämre än det är underminerar
 * tilliten lika säkert som en som påstår motsatsen.
 *
 * Varje begränsning pekar därför ut en markör i källkoden som är sann så länge
 * problemet finns kvar. Testet nedan kontrollerar att markören fortfarande
 * finns. Löser någon problemet försvinner markören, testet failar, och bygget
 * står still tills posten tagits bort ur listan.
 *
 * Den som fixar ett säkerhetsproblem kan alltså inte glömma att uppdatera
 * dokumentationen. Det är inte disciplin — det är att göra glömskan omöjlig.
 */

describe('kända begränsningar', () => {
  it('listan är inte tom, och varje post är fullständig', () => {
    // En tom lista skulle betyda antingen att allt är löst — vilket det inte
    // är — eller att någon tömt listan i stället för att lösa problemen.
    expect(KNOWN_LIMITATIONS.length).toBeGreaterThan(0)

    for (const limitation of KNOWN_LIMITATIONS) {
      expect(limitation.id, 'begränsning utan id').toMatch(/^[a-z0-9-]+$/)
      expect(limitation.title.length, `${limitation.id} saknar rubrik`).toBeGreaterThan(5)
      // Varför det är allvarligt måste stå med. En begränsning utan förklaring
      // är en punktlista, och en punktlista hjälper ingen att bedöma risken.
      expect(limitation.why.length, `${limitation.id} saknar förklaring`).toBeGreaterThan(80)
    }
  })

  it('inga dubbletter', () => {
    const ids = KNOWN_LIMITATIONS.map((limitation) => limitation.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(CHECKABLE_LIMITATIONS)(
    'begränsningen "$id" är fortfarande sann i koden',
    (limitation) => {
      // En post kan bära flera markörer, en per sak den påstår om koden. Alla
      // måste hålla, annars stämmer inte längre allt i texten.
      const markers = [limitation.stillTrueIf!].flat()
      expect(markers.length, `${limitation.id} saknar markör`).toBeGreaterThan(0)

      for (const marker of markers) {
        const path = join(process.cwd(), marker.file)

        /**
         * Filen saknas — antingen har den flyttats eller så har den funktion den
         * bar tagits bort. Båda betyder att listan behöver ses över.
         */
        expect(
          existsSync(path),
          `${limitation.id}: filen ${marker.file} finns inte längre. ` +
            'Har begränsningen lösts? Ta då bort posten ur src/lib/known-limitations.ts.',
        ).toBe(true)

        const content = readFileSync(path, 'utf8')

        expect(
          content.includes(marker.contains),
          `\n\n  BEGRÄNSNINGEN "${limitation.id}" SER UT ATT VARA LÖST.\n\n` +
            `  Markören "${marker.contains}" finns inte längre i ${marker.file}.\n\n` +
            '  Om du har löst problemet: ta bort posten ur src/lib/known-limitations.ts.\n' +
            '  Arkitektursidan läser listan därifrån och uppdateras då av sig själv.\n' +
            '  Har du löst en del av det posten beskriver: skriv om texten och stryk markören.\n\n' +
            '  Om du bara har flyttat eller döpt om kod: peka om markören.\n',
        ).toBe(true)
      }
    },
  )
})

describe('ingen dokumentation upprepar listan', () => {
  /**
   * FYRA KOPIOR EXISTERADE, OCH DE HADE HUNNIT BLI OLIKA.
   *
   * Listan stod i prosa i README, SECURITY.md, VERIFIABILITY.md och på
   * arkitektursidan. Två av dem hade blivit direkt felaktiga:
   *
   *   – README beskrev blinda signaturer som något "ett riktigt system skulle
   *     göra i stället". De var implementerade och bar hela konstruktionen.
   *
   *   – SECURITY.md påstod att identitet och partival finns i samma minne under
   *     röstningen. Det slutade vara sant den dag röstläggningen tappade sin
   *     session.
   *
   * Ingenting hindrade det, eftersom ingenting kontrollerade det. Nu gör det.
   *
   * Dokumenten får beskriva PROBLEMOMRÅDET och peka på källan. De får inte
   * numrera avvikelserna som en egen lista — det är då kopiorna glider isär.
   */
  const docs = ['README.md', 'SECURITY.md', 'VERIFIABILITY.md']

  it.each(docs)('%s numrerar inte avvikelserna som en egen lista', (doc) => {
    const content = readFileSync(join(process.cwd(), doc), 'utf8')

    /**
     * Mönstret som gick fel: en numrerad punkt som inleds med en fetmarkerad
     * rubrik, alltså "1. **Serverkompromiss bryter…**". Det är formen en
     * handunderhållen avvikelselista tar.
     *
     * Löpande text som nämner ett problem är tillåten och önskvärd — det är
     * upprepningen av LISTAN som är felet, inte att ämnet diskuteras.
     */
    const numreradLista = content.match(/^\d+\. \*\*[^*]{15,}\*\*/gm) ?? []

    const rapport = [
      '',
      `  ${doc} innehåller en numrerad avvikelselista:`,
      ...numreradLista.map((rad) => `    ${rad}`),
      '',
      '  Listan hör i src/lib/known-limitations.ts. Peka dit i stället —',
      '  fyra handunderhållna kopior hade redan hunnit bli olika.',
      '',
    ].join('\n')

    expect(numreradLista, rapport).toEqual([])
  })

  it.each(docs)('%s pekar på den enda källan', (doc) => {
    const content = readFileSync(join(process.cwd(), doc), 'utf8')

    // Varje dokument som berör begränsningar ska hänvisa vidare, så att läsaren
    // hittar den aktuella listan i stället för att tro att den står där.
    expect(
      /known-limitations|ARCHITECTURE\.md|VERIFIABILITY\.md|SECURITY\.md/.test(content),
      `${doc} nämner varken den enda källan eller de andra dokumenten`,
    ).toBe(true)
  })
})

describe('arkitektursidan läser listan i stället för att upprepa den', () => {
  /**
   * Listan visas på Tekniska detaljer, inte på huvudsidan. Huvudsidan är
   * skriven för den som aldrig hört ordet kryptering, och tabellen med
   * begränsningarna är inte det. Men ingen läsare får kunna missa riskerna,
   * så huvudsidan måste länka dit.
   *
   * Kontrollerna gäller filerna som faktiskt gör jobbet: den som renderar
   * tabellen, sidan som visar den och huvudsidan som länkar dit. En kontroll
   * av bara page.tsx hade passerat en tabell som slutat läsa listan, eftersom
   * tabellen ligger i en sektionskomponent.
   */
  const ROOT = process.cwd()
  const PAGE_DIRECTORY = join(ROOT, 'src/app/architecture')

  function sourceFilesUnder(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const full = join(directory, entry)
      if (statSync(full).isDirectory()) return sourceFilesUnder(full)
      return /\.tsx?$/.test(entry) ? [full] : []
    })
  }

  const toRelative = (file: string) => relative(ROOT, file).split(sep).join('/')
  const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const files = sourceFilesUnder(PAGE_DIRECTORY)

  /**
   * Huvudsidans egna filer: page.tsx och det den importerar under
   * src/app/architecture, utom livevyn. Livevyn visas bara i demoläget, och en
   * länk som bara finns där når inte den som läser sidan i skarpt läge.
   */
  function mainPageFiles(): string[] {
    const seen = new Set<string>()
    const visit = (file: string) => {
      if (seen.has(file) || /LiveDatabaseView\.tsx$/.test(file)) return
      seen.add(file)
      for (const [, specifier] of read(file).matchAll(/from '(\.{1,2}\/[^']+|@\/app\/architecture\/[^']+)'/g)) {
        const base = specifier.startsWith('@/')
          ? join(ROOT, 'src', specifier.slice(2))
          : join(dirname(file), specifier)
        const resolved = [`${base}.tsx`, `${base}.ts`].find((candidate) => existsSync(candidate))
        if (resolved) visit(resolved)
      }
    }
    visit(join(PAGE_DIRECTORY, 'page.tsx'))
    return [...seen]
  }

  /*
   * Rubrikerna söks i texten som en läsare ungefär ser, `visibleText` i
   * tests/page-text.ts. Tidigare jämfördes bara formen `<td>Rubrik</td>`.
   * Listans egen form är `<td><strong>…</strong></td>`, och en rubrik som
   * radbryts i JSX hade inte heller hittats. Båda hade alltså kunnat stå
   * hårdkodade utan att testet sa något.
   */

  it('tabellen renderas av en enda fil, och den läser listan', () => {
    const renderers = files.filter((file) => read(file).includes('KNOWN_LIMITATIONS.map('))

    expect(renderers.map(toRelative)).toEqual(['src/app/architecture/sections/LimitationsList.tsx'])
    expect(read(renderers[0]!)).toMatch(
      /import \{[^}]*\bKNOWN_LIMITATIONS\b[^}]*\} from '@\/lib\/known-limitations'/,
    )
  })

  it('tabellen visas på Tekniska detaljer', () => {
    const showing = files
      .filter((file) => file.endsWith('page.tsx'))
      .filter((file) => /<LimitationsList\b/.test(read(file)))

    expect(showing.map(toRelative)).toEqual(['src/app/architecture/technical/page.tsx'])
    expect(read(showing[0]!)).toMatch(/import \{ LimitationsList \} from '\.\.\/sections\/LimitationsList'/)
    // Ankaret som huvudsidans länk pekar på.
    expect(read(join(PAGE_DIRECTORY, 'sections/LimitationsList.tsx'))).toContain('id="begransningar"')
  })

  it('huvudsidan länkar till listan, också utanför demoläget', () => {
    const linking = mainPageFiles().filter((file) =>
      read(file).includes('/architecture/technical#begransningar'),
    )

    expect(mainPageFiles().map(toRelative)).toContain('src/app/architecture/page.tsx')
    expect(linking.length, 'ingen av huvudsidans filer länkar till begränsningslistan').toBeGreaterThan(0)
  })

  it('upprepar inga rubriker som fri text', () => {
    /**
     * Det här är felet som orsakade problemet från början: samma påstående
     * skrivet på flera ställen, och bara ett av dem uppdaterat.
     *
     * Rubrikerna ska komma från listan, inte stå i koden. Hittas en rubrik som
     * hårdkodad text betyder det att någon lagt tillbaka en dubblett. Hela
     * sidans katalog granskas, med undersidorna.
     */
    expect(files.length).toBeGreaterThan(1)

    for (const file of files) {
      const text = visibleText(read(file))
      for (const limitation of KNOWN_LIMITATIONS) {
        expect(
          text.includes(limitation.title),
          `${limitation.id}: rubriken står hårdkodad i ${toRelative(file)} i stället för att läsas ur listan`,
        ).toBe(false)
      }
    }
  })

  it('kontrollen hittar en rubrik i listans egen form, radbruten och uppdelad', () => {
    // Kontrasten. Utan den kunde en normalisering som äter all text få
    // kontrollen ovan att passera för evigt.
    const title = KNOWN_LIMITATIONS[0]!.title
    const [first, ...rest] = title.split(' ')
    const forms = [
      `<td>${title}</td>`,
      `<td>\n  <strong>${title}</strong>\n</td>`,
      `<td>\n  ${first}\n  ${rest.join('\n  ')}\n</td>`,
      `<p>${first}{' '}\n${rest.join(' ')}</p>`,
      `const x = '${first} ' +\n  '${rest.join(' ')}'`,
    ]

    for (const form of forms) {
      expect(visibleText(form).includes(title), form).toBe(true)
    }
    expect(visibleText('<td>{entry.title}</td>').includes(title)).toBe(false)
  })
})
