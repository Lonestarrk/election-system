import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
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
 * `@/lib/crypto/server`, som registrerar OpenSSL. Uppgift 12:s partiella
 * dekryptering omfattas redan, eftersom regeln gäller varje fil i de här
 * katalogerna och inte en lista över dagens anropare.
 */

const ROOT = process.cwd()

/** Kod som bara körs på servern. Röstsidans kod ligger utanför och prövas av browser-bundle.test.ts. */
const SERVER_DIRECTORIES = ['src/modules', 'src/orchestration', 'src/app/api', 'prisma']

/** De delade modulerna, och de namn ur dem som exponentierar i gruppen. */
const EXPONENTIATING: Record<string, string[]> = {
  'lib/crypto/group': ['modPow', 'bigintModPow', 'isInSubgroup'],
  'lib/crypto/elgamal': ['generateKeyPair', 'encrypt', 'decryptWithSecret', 'discreteLog'],
  'lib/crypto/proofs': ['proveZeroOrOne', 'verifyZeroOrOne', 'proveSumIsOne', 'verifySumIsOne'],
  'lib/crypto/threshold': ['publicShare', 'partiallyDecrypt', 'verifyPartialDecryption', 'combine'],
  'lib/crypto/verify-ballot': ['verifyEncryptedBallot', 'verifyEncryptedBallotInSteps'],
  'lib/encrypt-client': ['encryptBallot', 'encryptBallotInSteps'],
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

/** Källtexten utan kommentarer, som i browser-bundle.test.ts. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
}

/**
 * Exponentierande namn som en fil importerar direkt ur en delad modul.
 *
 * Typimporter räknas inte, eftersom de försvinner vid kompileringen. En import
 * av hela modulen, `import * as`, räknas som en import av varje namn i den.
 */
export function directExponentiation(source: string): string[] {
  const code = withoutComments(source)
  const offenders: string[] = []

  const moduleOf = (specifier: string) =>
    Object.keys(EXPONENTIATING).find((suffix) =>
      new RegExp(`(^|/)${suffix.replace('/', '\\/')}$`).test(specifier),
    )

  for (const match of code.matchAll(
    /\b(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
  )) {
    if (match[1]) continue
    const shared = moduleOf(match[3]!)
    if (!shared) continue

    for (const part of match[2]!.split(',')) {
      const name = part.trim()
      if (!name || name.startsWith('type ')) continue
      const imported = name.split(/\s+as\s+/)[0]!.trim()
      if (EXPONENTIATING[shared]!.includes(imported)) offenders.push(`${imported} ur ${match[3]}`)
    }
  }

  for (const match of code.matchAll(/\bimport\s+\*\s+as\s+\w+\s+from\s*['"]([^'"]+)['"]/g)) {
    const shared = moduleOf(match[1]!)
    if (shared) offenders.push(`* ur ${match[1]}`)
  }

  return offenders
}

describe('servern räknar i OpenSSL', () => {
  const files = SERVER_DIRECTORIES.flatMap((directory) => sourceFiles(join(ROOT, directory))).map(
    (path) => ({
      path: relative(ROOT, path).split(sep).join('/'),
      source: readFileSync(path, 'utf8'),
    }),
  )

  it('hittar serverfilerna, också de som verifierar och skapar nycklar', () => {
    const paths = files.map((file) => file.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        'src/modules/eligibility/pending-vote.service.ts',
        'src/orchestration/validate-before-close.usecase.ts',
        'src/orchestration/close-election.usecase.ts',
        'src/orchestration/create-election.usecase.ts',
        'prisma/seed.ts',
      ]),
    )
  })

  it('ingen serverfil hämtar en exponentierande funktion direkt ur de delade modulerna', () => {
    const offenders = Object.fromEntries(
      files
        .map((file) => [file.path, directExponentiation(file.source)] as const)
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
      'prisma/seed.ts',
    ]) {
      expect(importsServer(path), path).toBe(true)
    }
  })

  it('upptäcker en direkt import, men inte typer, kommentarer eller andra namn', () => {
    // Kontrasten. Utan den kunde en regel som aldrig träffade ge grönt ovan.
    expect(
      directExponentiation("import { verifyEncryptedBallot } from '@/lib/crypto/verify-ballot'\n"),
    ).toEqual(['verifyEncryptedBallot ur @/lib/crypto/verify-ballot'])
    expect(
      directExponentiation(
        "import {\n  hashCiphertext,\n  partiallyDecrypt as decrypt,\n} from '../src/lib/crypto/threshold'\n",
      ),
    ).toEqual(['partiallyDecrypt ur ../src/lib/crypto/threshold'])
    expect(directExponentiation("import * as group from '../../lib/crypto/group'\n")).toEqual([
      '* ur ../../lib/crypto/group',
    ])
    expect(
      directExponentiation(
        "import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'\n" +
          "import { type Share, splitSecret } from '@/lib/crypto/threshold'\n" +
          "import { canonicalOptions } from '@/lib/crypto/ballot-encoding'\n" +
          "// import { modPow } from '@/lib/crypto/group'\n" +
          "import { verifyEncryptedBallotOnServer } from '@/lib/crypto/server'\n",
      ),
    ).toEqual([])
  })
})
