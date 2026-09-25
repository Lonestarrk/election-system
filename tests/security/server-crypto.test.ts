import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * SERVERN EXPONENTIERAR I OPENSSL, OCH DEN HÄR REGELN HÅLLER DET SANT FRAMÖVER.
 *
 * Klienten och servern delar kryptokoden. OpenSSL kopplas in först när
 * src/lib/crypto/server.ts importeras, och det gäller bara den modulgraf
 * importen ingår i. En serverfil som hämtar `verifyEncryptedBallot` eller
 * `partiallyDecrypt` direkt ur den delade modulen räknar därför kanske i ren
 * BigInt: 25 gånger långsammare, med händelseslingan stillastående, och med en
 * hemlig exponent i en exponentiering vars tid beror på dess bitar.
 *
 * Inget annat test märker det. Svaren blir desamma, så varje funktionellt test
 * är grönt. Därför läser testet källkoden: ingen serverfil får importera en
 * exponentierande funktion ur de delade modulerna. Den hämtas ur
 * `@/lib/crypto/server`, som registrerar OpenSSL.
 *
 * VILKA FILER, OCH HUR DE LÄSES (fixrunda 1, uppgift 14b)
 *
 * Den första versionen läste bara fyra kataloger och bara statiska, namngivna
 * importer. Granskaren fick igenom `import()`, `require`, `export * from`, en
 * specifierare som slutar på `.js`, en ny fil i src/lib och en serveråtgärd i
 * src/app utanför api. Nu gäller regeln varje fil i src och prisma, utom två
 * slag:
 *
 *   – kryptolagret självt, som klient och server delar och vars filer bygger
 *     på varandra, uppräknat nedan;
 *   – koden i webbläsaren: varje fil som börjar med 'use client', och allt
 *     den importerar. En fil med 'use server' är alltid serverkod, också när
 *     en klientfil importerar den, eftersom Next kör den på servern.
 *
 * Källtexten läses med TypeScripts egen parser, som redan är ett beroende.
 * Då räknas varje form av import, också på flera rader, men aldrig en import
 * som står i en kommentar eller i en sträng, som i src/lib/known-limitations.ts.
 */

const ROOT = process.cwd()

const SCANNED_ROOTS = ['src', 'prisma']

/**
 * Kryptolagret. Filerna här får importera varandra direkt, eftersom de är
 * implementationen. Serverns ingång och OpenSSL-vägen hör också hit.
 *
 * En ny fil i src/lib/crypto står inte här av sig själv. Den prövas som vilken
 * serverfil som helst, tills någon har bestämt att den hör till lagret.
 */
const CRYPTO_LAYER = [
  'src/lib/crypto/ballot-encoding.ts',
  'src/lib/crypto/elgamal.ts',
  'src/lib/crypto/fixed-base.ts',
  'src/lib/crypto/group.ts',
  'src/lib/crypto/native-exponentiation.ts',
  'src/lib/crypto/proofs.ts',
  'src/lib/crypto/server.ts',
  'src/lib/crypto/sha256.ts',
  'src/lib/crypto/threshold.ts',
  'src/lib/crypto/verify-ballot.ts',
  'src/lib/encrypt-client.ts',
]

/**
 * De delade modulerna, och de namn ur dem som exponentierar i gruppen.
 * `isInSubgroup` står också under elgamal, som exporterar den vidare.
 */
const EXPONENTIATING: Record<string, string[]> = {
  'src/lib/crypto/group': ['modPow', 'bigintModPow', 'isInSubgroup'],
  'src/lib/crypto/elgamal': [
    'generateKeyPair',
    'encrypt',
    'decryptWithSecret',
    'discreteLog',
    'isInSubgroup',
  ],
  'src/lib/crypto/proofs': [
    'proveZeroOrOne',
    'startZeroOrOne',
    'verifyZeroOrOne',
    'proveSumIsOne',
    'verifySumIsOne',
  ],
  'src/lib/crypto/threshold': [
    'publicShare',
    'partiallyDecrypt',
    'verifyPartialDecryption',
    'combine',
  ],
  'src/lib/crypto/verify-ballot': ['verifyEncryptedBallot', 'verifyEncryptedBallotInSteps'],
  'src/lib/encrypt-client': ['encryptBallot', 'encryptBallotInSteps'],
}

/** Vad `import(namn)` eller `require(namn)` ger när modulen inte står som en fast sträng. */
export const UNRESOLVED = '<modul som inte går att läsa ut>'

/** En import: modulen, och vilka namn som hämtas ur den. `all` är hela modulen. */
type ImportDeclaration = { specifier: string | null; names: string[] | 'all' }

type SourceFile = {
  path: string
  directives: string[]
  imports: ImportDeclaration[]
}

function parse(path: string, source: string): ts.SourceFile {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind)
}

/** Namnet som hämtas ur modulen, alltså det före `as`. */
function importedName(element: ts.ImportSpecifier | ts.ExportSpecifier): string {
  return (element.propertyName ?? element.name).text
}

/**
 * Varje import och återexport i filen, utom de som bara gäller typer.
 *
 *   – `import { a, type B } from` och `import d, { a } from` ger de namngivna;
 *   – `import * as`, `export * from` och `export * as` ger hela modulen;
 *   – `export { a } from` ger de namngivna;
 *   – `import()`, `require()` och `import x = require()` ger hela modulen,
 *     eftersom det inte går att se vilka namn som används.
 */
export function importDeclarations(path: string, source: string): ImportDeclaration[] {
  const found: ImportDeclaration[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      const clause = node.importClause

      if (!clause) {
        found.push({ specifier, names: [] })
      } else if (!clause.isTypeOnly) {
        const bindings = clause.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) {
          found.push({ specifier, names: 'all' })
        } else {
          const names = clause.name ? ['default'] : []
          for (const element of bindings?.elements ?? []) {
            if (!element.isTypeOnly) names.push(importedName(element))
          }
          found.push({ specifier, names })
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.isTypeOnly
    ) {
      const specifier = node.moduleSpecifier.text
      const clause = node.exportClause

      if (!clause || ts.isNamespaceExport(clause)) {
        found.push({ specifier, names: 'all' })
      } else {
        const names = clause.elements.filter((element) => !element.isTypeOnly).map(importedName)
        found.push({ specifier, names })
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression
      found.push({ specifier: ts.isStringLiteral(expression) ? expression.text : null, names: 'all' })
    } else if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const required = ts.isIdentifier(node.expression) && node.expression.text === 'require'

      if (dynamicImport || required) {
        const [argument] = node.arguments
        const literal =
          argument !== undefined &&
          (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
        found.push({ specifier: literal ? argument.text : null, names: 'all' })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(parse(path, source))
  return found
}

/** Direktiven först i filen, som 'use client' och 'use server'. */
function directivesOf(path: string, source: string): string[] {
  const found: string[] = []
  for (const statement of parse(path, source).statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break
    found.push(statement.expression.text)
  }
  return found
}

/**
 * Modulen som en specifierare pekar på, som sökväg i repot utan filändelse,
 * eller null för ett paket. Ändelsen tas bort, eftersom TypeScript läser
 * `./group.js` som `./group.ts`.
 */
function moduleOf(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? join('src', specifier.slice(2))
    : specifier.startsWith('.')
      ? join(dirname(from), specifier)
      : null
  if (base === null) return null

  return base
    .split(sep)
    .join('/')
    .replace(/\.(?:[cm]?[jt]sx?)$/, '')
    .replace(/\/index$/, '')
}

/** Exponentierande namn som filen hämtar direkt ur en delad modul. */
export function directExponentiation(path: string, source: string): string[] {
  const offenders: string[] = []

  for (const { specifier, names } of importDeclarations(path, source)) {
    if (specifier === null) {
      offenders.push(UNRESOLVED)
      continue
    }

    const shared = EXPONENTIATING[moduleOf(path, specifier) ?? '']
    if (!shared) continue

    if (names === 'all') {
      offenders.push(`* ur ${specifier}`)
      continue
    }
    for (const name of names) {
      if (shared.includes(name)) offenders.push(`${name} ur ${specifier}`)
    }
  }

  return offenders
}

function describeFile(path: string, source: string): SourceFile {
  return { path, directives: directivesOf(path, source), imports: importDeclarations(path, source) }
}

/**
 * Serverkoden bland filerna: allt utom kryptolagret och koden i webbläsaren.
 *
 * Webbläsarens kod är varje fil med 'use client' och allt den drar in, följt
 * import för import. En fil med 'use server' följs inte, eftersom den körs på
 * servern även när en klientfil importerar den.
 */
export function serverFiles(files: Array<{ path: string; source: string }>): string[] {
  const described = files.map((file) => describeFile(file.path, file.source))
  const byPath = new Map(described.map((file) => [file.path, file]))

  const resolveFile = (from: string, specifier: string): string | null => {
    const base = moduleOf(from, specifier)
    if (base === null) return null
    const candidates = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
    return candidates.find((candidate) => byPath.has(candidate)) ?? null
  }

  const client = new Set<string>()
  const queue = described
    .filter((file) => file.directives.includes('use client'))
    .map((file) => file.path)

  while (queue.length > 0) {
    const path = queue.shift()!
    const file = byPath.get(path)
    if (client.has(path) || !file || file.directives.includes('use server')) continue

    client.add(path)
    for (const { specifier } of file.imports) {
      const resolved = specifier === null ? null : resolveFile(path, specifier)
      if (resolved) queue.push(resolved)
    }
  }

  return described
    .map((file) => file.path)
    .filter((path) => !CRYPTO_LAYER.includes(path) && !client.has(path))
}

function sourceFiles(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      if (entry === 'generated' || entry === 'node_modules') continue
      found.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(entry)) {
      found.push(path)
    }
  }
  return found
}

describe('servern räknar i OpenSSL', () => {
  const files = SCANNED_ROOTS.flatMap((root) => sourceFiles(join(ROOT, root))).map((path) => ({
    path: relative(ROOT, path).split(sep).join('/'),
    source: readFileSync(path, 'utf8'),
  }))
  const server = serverFiles(files)

  it('prövar varje serverfil: moduler, orkestrering, rutter, src/lib, sidor och seed', () => {
    expect(server).toEqual(
      expect.arrayContaining([
        'src/modules/eligibility/pending-vote.service.ts',
        'src/orchestration/validate-before-close.usecase.ts',
        'src/orchestration/close-election.usecase.ts',
        'src/orchestration/create-election.usecase.ts',
        'src/app/api/vote/encrypted/route.ts',
        'src/lib/rate-limit.ts',
        'src/lib/crypto/share-storage.ts',
        'src/app/architecture/page.tsx',
        'src/middleware.ts',
        'prisma/seed.ts',
      ]),
    )
  })

  it('men inte kryptolagret eller koden i webbläsaren', () => {
    // Kontrasten åt andra hållet: röstsidan importerar krypteringen direkt,
    // och ska göra det.
    for (const path of [
      'src/lib/crypto/proofs.ts',
      'src/lib/encrypt-client.ts',
      'src/app/vote/page.tsx',
      'src/app/vote/BankIdSigning.tsx',
      'src/app/vote/device-vote.ts',
    ]) {
      expect(server, path).not.toContain(path)
    }
  })

  it('ingen serverfil hämtar en exponentierande funktion direkt ur de delade modulerna', () => {
    const offenders = Object.fromEntries(
      files
        .filter((file) => server.includes(file.path))
        .map((file) => [file.path, directExponentiation(file.path, file.source)] as const)
        .filter(([, found]) => found.length > 0),
    )
    expect(offenders).toEqual({})
  })

  it('verifieringen och nycklarna hämtas ur serverns ingång', () => {
    const importsServer = (path: string) =>
      /from\s*['"](?:@\/|\.\.\/src\/)lib\/crypto\/server['"]/.test(
        files.find((file) => file.path === path)!.source,
      )

    for (const path of [
      'src/modules/eligibility/pending-vote.service.ts',
      'src/orchestration/validate-before-close.usecase.ts',
      'src/orchestration/close-election.usecase.ts',
      'src/orchestration/create-election.usecase.ts',
      // Räkningen exponentierar med förtroendepersonens andel, som ska räknas
      // i OpenSSL och i konstant tid (uppgift 12).
      'src/orchestration/tally.usecase.ts',
      'prisma/seed.ts',
    ]) {
      expect(importsServer(path), path).toBe(true)
    }
  })
})

describe('regeln fångar varje form av import, och bara den', () => {
  // Kontrasten. Utan den kunde en regel som aldrig träffade ge grönt ovan. Ett
  // fall för varje form som granskaren av uppgift 14b fick igenom, och för
  // varje form som redan fångades.
  const ORCHESTRATION = 'src/orchestration/tally.usecase.ts'

  it('en statisk import, också på flera rader, med alias, förvalt namn och hela modulen', () => {
    expect(
      directExponentiation(
        ORCHESTRATION,
        "import { verifyEncryptedBallot } from '@/lib/crypto/verify-ballot'\n",
      ),
    ).toEqual(['verifyEncryptedBallot ur @/lib/crypto/verify-ballot'])
    expect(
      directExponentiation(
        'prisma/seed.ts',
        "import {\n  hashCiphertext,\n  partiallyDecrypt as decrypt,\n} from '../src/lib/crypto/threshold'\n",
      ),
    ).toEqual(['partiallyDecrypt ur ../src/lib/crypto/threshold'])
    expect(
      directExponentiation(ORCHESTRATION, "import group, { modPow } from '../lib/crypto/group'\n"),
    ).toEqual(['modPow ur ../lib/crypto/group'])
    expect(
      directExponentiation('src/app/api/x/route.ts', "import * as group from '../../../lib/crypto/group'\n"),
    ).toEqual(['* ur ../../../lib/crypto/group'])
  })

  it('import(), också med en mall utan insättningar', () => {
    expect(
      directExponentiation(
        ORCHESTRATION,
        "const { partiallyDecrypt } = await import('@/lib/crypto/threshold')\n",
      ),
    ).toEqual(['* ur @/lib/crypto/threshold'])
    expect(directExponentiation(ORCHESTRATION, 'const g = await import(`@/lib/crypto/group`)\n')).toEqual(
      ['* ur @/lib/crypto/group'],
    )
    // Kontrasten: serverns ingång får laddas hur som helst.
    expect(
      directExponentiation(ORCHESTRATION, "const server = await import('@/lib/crypto/server')\n"),
    ).toEqual([])
  })

  it('require()', () => {
    expect(
      directExponentiation(ORCHESTRATION, "const { encrypt } = require('../lib/crypto/elgamal')\n"),
    ).toEqual(['* ur ../lib/crypto/elgamal'])
    expect(directExponentiation(ORCHESTRATION, "const fs = require('node:fs')\n")).toEqual([])
  })

  it('export * from, export * as och export { } from', () => {
    const LIB = 'src/lib/tally.ts'
    expect(directExponentiation(LIB, "export * from './crypto/proofs'\n")).toEqual([
      '* ur ./crypto/proofs',
    ])
    expect(directExponentiation(LIB, "export * as proofs from './crypto/proofs'\n")).toEqual([
      '* ur ./crypto/proofs',
    ])
    expect(directExponentiation(LIB, "export { combine } from './crypto/threshold'\n")).toEqual([
      'combine ur ./crypto/threshold',
    ])
    // Kontrasten: en modul som inte exponentierar får återexporteras hel.
    expect(directExponentiation(LIB, "export * from './crypto/ballot-encoding'\n")).toEqual([])
  })

  it('en specifierare som slutar på .js eller .ts', () => {
    expect(
      directExponentiation(ORCHESTRATION, "import { modPow } from '@/lib/crypto/group.js'\n"),
    ).toEqual(['modPow ur @/lib/crypto/group.js'])
    expect(
      directExponentiation(ORCHESTRATION, "import { encryptBallot } from '../lib/encrypt-client.ts'\n"),
    ).toEqual(['encryptBallot ur ../lib/encrypt-client.ts'])
    // Kontrasten: namn som inte exponentierar.
    expect(directExponentiation(ORCHESTRATION, "import { P, Q } from '@/lib/crypto/group.js'\n")).toEqual(
      [],
    )
  })

  it('en import som inte går att läsa ut fälls', () => {
    expect(directExponentiation(ORCHESTRATION, 'const m = await import(name)\n')).toEqual([UNRESOLVED])
    expect(directExponentiation(ORCHESTRATION, 'const m = require(`./crypto/${name}`)\n')).toEqual([
      UNRESOLVED,
    ])
  })

  it('en ny fil i src/lib och i src/lib/crypto prövas, men inte kryptolagret', () => {
    const files = [
      { path: 'src/lib/tally.ts', source: "import { partiallyDecrypt } from './crypto/threshold'\n" },
      { path: 'src/lib/crypto/tally.ts', source: "import { modPow } from './group'\n" },
      { path: 'src/lib/crypto/proofs.ts', source: "import { modPow } from './group'\n" },
    ]

    expect(serverFiles(files)).toEqual(['src/lib/tally.ts', 'src/lib/crypto/tally.ts'])
    expect(directExponentiation(files[0]!.path, files[0]!.source)).toEqual([
      'partiallyDecrypt ur ./crypto/threshold',
    ])
    expect(directExponentiation(files[1]!.path, files[1]!.source)).toEqual(['modPow ur ./group'])
  })

  it('en serveråtgärd i src/app utanför api prövas, men inte koden i webbläsaren', () => {
    const files = [
      {
        path: 'src/app/admin/actions.ts',
        source: "'use server'\nimport { verifyEncryptedBallot } from '@/lib/crypto/verify-ballot'\n",
      },
      // En serverkomponent, utan direktiv.
      { path: 'src/app/admin/page.tsx', source: "import { tally } from './actions'\n" },
      {
        path: 'src/app/vote/page.tsx',
        source:
          "'use client'\n" +
          "import { encryptBallotInSteps } from '@/lib/encrypt-client'\n" +
          "import { helper } from './helper'\n" +
          "import { cast } from './cast-action'\n",
      },
      // Bara röstsidan drar in den, så den körs i webbläsaren.
      { path: 'src/app/vote/helper.ts', source: "import { encryptBallot } from '@/lib/encrypt-client'\n" },
      // Importerad av en klientfil, men körs på servern.
      {
        path: 'src/app/vote/cast-action.ts',
        source: "'use server'\nimport { verifyEncryptedBallot } from '@/lib/crypto/verify-ballot'\n",
      },
    ]

    expect(serverFiles(files)).toEqual([
      'src/app/admin/actions.ts',
      'src/app/admin/page.tsx',
      'src/app/vote/cast-action.ts',
    ])
    expect(directExponentiation(files[0]!.path, files[0]!.source)).toEqual([
      'verifyEncryptedBallot ur @/lib/crypto/verify-ballot',
    ])
  })

  it('räknar inte typer, kommentarer, strängar eller andra namn', () => {
    expect(
      directExponentiation(
        ORCHESTRATION,
        "import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'\n" +
          "import { type Share, splitSecret } from '@/lib/crypto/threshold'\n" +
          "export type { ZeroOrOneProof } from '@/lib/crypto/proofs'\n" +
          "import { canonicalOptions } from '@/lib/crypto/ballot-encoding'\n" +
          "// import { modPow } from '@/lib/crypto/group'\n" +
          "/* export * from '@/lib/crypto/proofs' */\n" +
          'const text = "import { modPow } from \'@/lib/crypto/group\'"\n' +
          "import { verifyEncryptedBallotOnServer } from '@/lib/crypto/server'\n",
      ),
    ).toEqual([])
  })
})
