import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('röstsidan sparar valet och hashen på ett enda ställe, och ingen kod', () => {
  /**
   * Röstsidan delar inte ut någon kod eller token, så det finns ingenting att kopiera eller
   * varna för.
   *
   * Lagringen är avsiktlig. Enheten sparar valet och chifferhashen för att
   * kunna visa den nuvarande rösten (spec 3.1 punkt 1), men aldrig slumptalet.
   * Det som låses fast här är att det sker på ett ställe och i en form, och
   * att ingenting från sidan går till urklipp eller adressfältet. Vad som
   * faktiskt hamnar i lagringen prövas i tests/unit/device-vote.test.ts och i
   * tests/e2e/voting-flow.spec.ts.
   *
   * Koden granskas utan kommentarerna, som förklarar just det här i löpande
   * text.
   */
  const directory = join(process.cwd(), 'src/app/vote')
  const files = readdirSync(directory)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => ({
      name,
      code: readFileSync(join(directory, name), 'utf8')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n'),
    }))

  it('hittar röstsidans filer', () => {
    expect(files.map((file) => file.name).sort()).toEqual([
      'BankIdSigning.tsx',
      'device-vote.ts',
      'page.tsx',
      'phase-watch.ts',
    ])
  })

  it('bara lagringsmodulen rör webbläsarens lagring', () => {
    const touching = files
      .filter((file) => /localStorage|sessionStorage|indexedDB|document\.cookie\s*=/.test(file.code))
      .map((file) => file.name)
    expect(touching).toEqual(['device-vote.ts'])
  })

  it('lagringsmodulen skriver bara poster som den själv rensat', () => {
    const storage = files.find((file) => file.name === 'device-vote.ts')!.code
    // En enda skrivning, och den skriver posterna som `asDeviceVote` plockat
    // ut fält för fält. Ett objekt som sprids in hade tagit med allt det bär.
    expect(storage.match(/\.setItem\(/g)).toHaveLength(1)
    expect(storage).toContain('storage.setItem(keyFor(electionId), JSON.stringify(votes))')
    expect(storage).toContain('const clean = asDeviceVote(vote)')
    expect(storage).toContain(
      'return { ciphertextHash: candidate.ciphertextHash, choice, label: candidate.label }',
    )
  })

  it('ingenting går till urklipp, och ingen hash läggs i en adress', () => {
    for (const file of files) {
      expect(file.code, file.name).not.toMatch(/clipboard/)
      expect(file.code, file.name).not.toMatch(/useRouter|useSearchParams|history\.(push|replace)State/)
      expect(file.code, file.name).not.toMatch(
        /(location\.(href|assign|replace)|searchParams)[^\n]*ciphertextHash/,
      )
    }
  })
})
