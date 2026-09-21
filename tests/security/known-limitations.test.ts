import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHECKABLE_LIMITATIONS, KNOWN_LIMITATIONS } from '@/lib/known-limitations'

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
      const marker = limitation.stillTrueIf!
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
          '  Arkitektursidan läser listan därifrån och uppdateras då av sig själv.\n\n' +
          '  Om du bara har flyttat eller döpt om kod: peka om markören.\n',
      ).toBe(true)
    },
  )
})

describe('arkitektursidan läser listan i stället för att upprepa den', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/demo/page.tsx'), 'utf8')

  it('importerar begränsningarna', () => {
    expect(page).toMatch(/from '@\/lib\/known-limitations'/)
  })

  it('upprepar inga rubriker som fri text', () => {
    /**
     * Det här är felet som orsakade problemet från början: samma påstående
     * skrivet på flera ställen, och bara ett av dem uppdaterat.
     *
     * Rubrikerna ska komma från listan, inte stå i JSX. Hittas en rubrik som
     * hårdkodad text betyder det att någon lagt tillbaka en dubblett.
     */
    for (const limitation of KNOWN_LIMITATIONS) {
      expect(
        page.includes(`<td>${limitation.title}</td>`),
        `${limitation.id}: rubriken står hårdkodad i sidan i stället för att läsas ur listan`,
      ).toBe(false)
    }
  })
})
