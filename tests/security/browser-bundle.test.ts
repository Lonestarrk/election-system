import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * RÖSTSIDANS KOD MÅSTE GÅ ATT BUNTA FÖR WEBBLÄSAREN.
 *
 * Klientens kryptering importerade node:crypto, och röstsidan gick inte att
 * bygga: webbläsarens bunt kan inte läsa node:-moduler. Varken typkontrollen
 * eller enhetstesterna sa ifrån, eftersom båda körs i Node. Felet syntes först
 * när en sida i webbläsaren importerade modulen, och hade annars synts först
 * när någon försökte rösta.
 *
 * Testet följer röstsidans importer genom src, fil för fil, och kräver att
 * ingen fil på vägen importerar en Node-modul eller något som bara hör hemma
 * på servern: databasmodulerna, orkestreringen, miljövariablerna. Det sista är
 * inte bara en byggfråga. Kod som når röstlängden eller en hemlighet i miljön
 * har ingenting i väljarens webbläsare att göra.
 */

const ROOT = process.cwd()
const ENTRY = 'src/app/vote/page.tsx'

/** Paket utanför src som röstsidan får använda. */
const ALLOWED_PACKAGES = ['react', 'next/link']

/** Filer och kataloger i src som bara får köras på servern. */
const SERVER_ONLY = [
  'src/modules/',
  'src/orchestration/',
  'src/app/api/',
  'src/lib/crypto.ts',
  'src/lib/env.ts',
  'src/lib/http.ts',
  'src/lib/cookies.ts',
  'src/lib/csrf.ts',
  'src/lib/logger.ts',
  'src/lib/rate-limit.ts',
  'src/lib/admission-queue.ts',
  'src/lib/crypto/share-storage.ts',
]

const toRelative = (path: string) => relative(ROOT, path).split(sep).join('/')

/**
 * Vad en import vars modul inte står som en fast sträng ger, till exempel
 * `import(namn)`. Den går inte att följa, och den fälls som ett okänt paket.
 */
export const UNRESOLVED = '<modul som inte går att läsa ut>'

/**
 * Källtexten utan kommentarer. En import i en kommentar når aldrig bunten, och
 * kryptomodulernas kommentarer nämner just de moduler testet letar efter.
 *
 * `://` i en adress lämnas orörd, så att en rad som börjar med en sträng som
 * 'http://…' inte förlorar resten av raden.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
}

/** Modulen i ett anrop som `import(…)` eller `require(…)`, om den står som en fast sträng. */
function literalModule(argument: string): string {
  const match = argument.trim().match(/^(['"`])([^'"`$]+)\1$/)
  return match ? match[2]! : UNRESOLVED
}

/**
 * Varje modul en fil drar in, utom de som bara gäller typer.
 *
 * Tre former, var som helst i koden och inte bara först på en rad:
 *
 *   – importer och återexporter med `from`, också över flera rader;
 *   – `import 'modul'`, som bara kör modulen;
 *   – `import(…)` och `require(…)`, som laddar den när koden körs.
 *
 * En typimport försvinner vid kompileringen och når aldrig bunten, och räknas
 * därför inte. En import med blandade namn, `import { type A, b }`, räknas,
 * eftersom `b` följer med.
 *
 * Testet läser källtexten själv i stället för att fråga en bundlare. Esbuild
 * finns bara som ett beroende till andra paket, och ett test som vilade på det
 * kunde sluta fungera när de byter.
 */
export function importsOf(source: string): string[] {
  const code = withoutComments(source)
  const found: string[] = []

  for (const match of code.matchAll(
    /\b(?:import|export)\s+(type\s+)?[^'"`;()=]*?\bfrom\s*(['"])([^'"]+)\2/g,
  )) {
    if (!match[1]) found.push(match[3]!)
  }
  for (const match of code.matchAll(/\bimport\s*(['"])([^'"]+)\1/g)) {
    found.push(match[2]!)
  }
  for (const match of code.matchAll(/\b(?:import|require)\s*\(([^)]*)\)/g)) {
    found.push(literalModule(match[1]!))
  }

  return found
}

function resolve(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? join(ROOT, 'src', specifier.slice(2))
    : specifier.startsWith('.')
      ? join(dirname(join(ROOT, from)), specifier)
      : null
  if (!base) return null

  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate)) return toRelative(candidate)
  }
  throw new Error(`Kunde inte hitta ${specifier}, importerad från ${from}.`)
}

/** Alla filer röstsidan drar in, och alla paket utanför src som de importerar. */
function bundleOf(entry: string): { files: string[]; packages: Map<string, string[]> } {
  const files = new Set<string>()
  const packages = new Map<string, string[]>()
  const queue = [entry]

  while (queue.length > 0) {
    const file = queue.shift()!
    if (files.has(file)) continue
    files.add(file)

    for (const specifier of importsOf(readFileSync(join(ROOT, file), 'utf8'))) {
      const resolved = resolve(file, specifier)
      if (resolved) queue.push(resolved)
      else packages.set(specifier, [...(packages.get(specifier) ?? []), file])
    }
  }

  return { files: [...files].sort(), packages }
}

describe('röstsidans kod i webbläsaren', () => {
  const bundle = bundleOf(ENTRY)

  it('följer importerna hela vägen till krypteringen', () => {
    // Kontrasten: utan de här filerna i grafen har följningen slutat för tidigt,
    // och testerna nedan säger ingenting.
    expect(bundle.files).toEqual(
      expect.arrayContaining([
        'src/app/vote/page.tsx',
        'src/app/vote/BankIdSigning.tsx',
        'src/app/vote/device-vote.ts',
        'src/lib/encrypt-client.ts',
        'src/lib/crypto/group.ts',
        'src/lib/crypto/proofs.ts',
        'src/lib/crypto/sha256.ts',
        'src/lib/crypto/verify-ballot.ts',
        'src/lib/crypto/ballot-encoding.ts',
      ]),
    )
  })

  it('importerar ingen Node-modul, och bara de paket som behövs', () => {
    const offenders = [...bundle.packages.entries()].filter(
      ([specifier]) => !ALLOWED_PACKAGES.includes(specifier),
    )
    expect(Object.fromEntries(offenders)).toEqual({})
  })

  it('drar inte in något som bara hör hemma på servern', () => {
    const serverOnly = bundle.files.filter((file) =>
      SERVER_ONLY.some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path)),
    )
    expect(serverOnly).toEqual([])
  })

  it('upptäcker en Node-import, också på flera rader', () => {
    // Så såg felet ut, i src/lib/crypto/group.ts.
    expect(importsOf("import { randomBytes } from 'node:crypto'\n")).toEqual(['node:crypto'])
    expect(importsOf("import {\n  createHash,\n  randomBytes,\n} from 'crypto'\n")).toEqual(['crypto'])
    expect(importsOf("import type { Crypto } from 'node:crypto'\n")).toEqual([])
    expect(importsOf("export { x } from './y'\nimport './z'\n")).toEqual(['./y', './z'])
  })

  it('upptäcker varje form av import, också när den inte står först på raden', () => {
    // Kontrasten för varje form. Utan den kunde en import som laddas när
    // koden körs, eller som står efter något annat på raden, gå förbi testet
    // med grönt resultat.
    const forms: Array<[string, string[]]> = [
      ["const a = 1; import { b } from 'node:fs'\n", ['node:fs']],
      ["export * from 'node:path'\n", ['node:path']],
      ["export { createHash as hash } from 'node:crypto'\n", ['node:crypto']],
      ["import { type A, b } from 'node:util'\n", ['node:util']],
      ["x(); import 'node:worker_threads'\n", ['node:worker_threads']],
      ["const m = await import('node:crypto')\n", ['node:crypto']],
      ['const m = await import(`node:os`)\n', ['node:os']],
      ["const c = require('crypto')\n", ['crypto']],
      ['setup(); const n = require("node:net")\n', ['node:net']],
      ["const u = 'http://example.com'; import('node:dns')\n", ['node:dns']],
    ]
    for (const [source, expected] of forms) {
      expect(importsOf(source), source).toEqual(expected)
    }
  })

  it('en modul som inte står som en fast sträng går inte att följa, och fälls', () => {
    expect(importsOf('const m = await import(name)\n')).toEqual([UNRESOLVED])
    expect(importsOf('require(`node:${name}`)\n')).toEqual([UNRESOLVED])
    expect(ALLOWED_PACKAGES).not.toContain(UNRESOLVED)
  })

  it('räknar inte typer och inte kommentarer', () => {
    expect(importsOf("export type { Crypto } from 'node:crypto'\n")).toEqual([])
    expect(importsOf("// import('node:fs')\n/* require('fs') */\nconst a = 1\n")).toEqual([])
    expect(importsOf("{/* import 'node:crypto' */}\n")).toEqual([])
  })
})
