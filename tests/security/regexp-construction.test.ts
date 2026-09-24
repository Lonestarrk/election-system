import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * INGET REGULJÄRT UTTRYCK BYGGS AV TEMPLATE-STRÄNGAR SOM FÖRENAS MED `+`.
 *
 * `STORED` i `sealed-chain.ts` var delat på två template-strängar som förenades
 * med `+`. SWC:s minifiering i `next build` slog ihop dem och tappade `}):` i
 * skarven. Produktionsbygget fick då ett ogiltigt uttryck ("Unterminated group")
 * och föll på /api/vote/compare. Vitest och `next dev` minifierar inte, så felet
 * syntes bara i bygget, och ingen annan test i sviten hade kunnat se det.
 *
 * Ett helt produktionsbygge i sviten tar minuter. Det här testet vaktar i stället
 * mönstret som utlöste felet: en template-sträng direkt följd av `+` inuti
 * `new RegExp(`. Skriv uttrycket som en enda template-sträng, även om raden blir
 * lång.
 */

const SOURCE_ROOT = join(process.cwd(), 'src')

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full))
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) files.push(full)
  }
  return files
}

/**
 * En template-sträng inuti `new RegExp(` som direkt följs av `+`, eller ett
 * uttryck utan backtick som följs av `+` och sedan en template-sträng.
 * Template-strängar i koden innehåller inga backticks, så `[^`]*` räcker för att
 * hitta slutet på en. Den andra grenen får inte gå in i en template-sträng: då
 * hade ett `+` som kvantifierare, som i `\d+`, sett ut som en sammanfogning.
 */
const JOINED_TEMPLATES = /new RegExp\(\s*(?:`[^`]*`\s*\+|[^)`]*\+\s*`)/

describe('reguljära uttryck byggs så att minifieringen inte kan skada dem', () => {
  it('upptäcker mönstret som föll i produktionsbygget', () => {
    const broken = 'const STORED = new RegExp(\n  `^v2:([0-9a-f]{${a}}):` +\n    `([0-9a-f]{${b}})$`,\n)'
    const fixed = 'const STORED = new RegExp(\n  `^v2:([0-9a-f]{${a}}):([0-9a-f]{${b}})$`,\n)'

    // En kvantifierare precis före den avslutande backticken är ingen sammanfogning.
    const quantifier = 'const DIGITS = new RegExp(`^\\\\d+`)'
    const prefixed = 'const TAGGED = new RegExp(prefix + `:([0-9a-f]{${n}})$`)'

    expect(JOINED_TEMPLATES.test(broken)).toBe(true)
    expect(JOINED_TEMPLATES.test(prefixed)).toBe(true)
    expect(JOINED_TEMPLATES.test(fixed)).toBe(false)
    expect(JOINED_TEMPLATES.test(quantifier)).toBe(false)
  })

  it('ingen fil i src bygger ett uttryck av template-strängar som förenas med +', () => {
    const offenders = sourceFiles(SOURCE_ROOT)
      .filter((file) => JOINED_TEMPLATES.test(readFileSync(file, 'utf8')))
      .map((file) => relative(process.cwd(), file).split(sep).join('/'))

    expect(offenders).toEqual([])
  })
})
