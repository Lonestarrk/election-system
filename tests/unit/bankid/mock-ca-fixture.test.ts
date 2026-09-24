import { createPrivateKey, X509Certificate } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MOCK_BANKID_INTERMEDIATE_CERTIFICATE,
  MOCK_BANKID_INTERMEDIATE_PRIVATE_KEY,
} from '@/modules/eligibility/bankid/mock-ca/issuing-ca-test-key'
import { MOCK_BANKID_ROOT_CERTIFICATE } from '@/modules/eligibility/bankid/mock-ca/root-certificate'

/**
 * ATTRAPPENS ROT OCH MELLANNIVÅ, SOM SKRIPTET SKAPADE DEM.
 *
 * scripts/generate-mock-bankid-ca.ts skapar båda med openssl och kastar rotens
 * privata nyckel. Här prövas att det som checkats in hänger ihop, och att
 * rotens nyckel verkligen är borta ur repot: finns den kvar kan vem som helst
 * utfärda en ny mellannivå, och då är det inte längre sant att bara
 * attrappens egen mellannivå kan utfärda certifikat som roten godtar.
 */

const ROOT = new X509Certificate(MOCK_BANKID_ROOT_CERTIFICATE)
const INTERMEDIATE = new X509Certificate(MOCK_BANKID_INTERMEDIATE_CERTIFICATE)

/** Katalogerna som checkas in och kan bära en nyckel. */
const SEARCHED = ['src', 'scripts', 'tests', 'prisma', 'docs', 'tools', 'docker', 'public']
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g

function filesUnder(directory: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

describe('attrappens rot och mellannivå', () => {
  it('roten är en självsignerad CA', () => {
    expect(ROOT.checkIssued(ROOT)).toBe(true)
    expect(ROOT.verify(ROOT.publicKey)).toBe(true)
    expect(ROOT.ca).toBe(true)
  })

  it('mellannivån är utfärdad av roten och är en CA', () => {
    expect(INTERMEDIATE.checkIssued(ROOT)).toBe(true)
    expect(INTERMEDIATE.verify(ROOT.publicKey)).toBe(true)
    expect(INTERMEDIATE.ca).toBe(true)
  })

  it('mellannivåns privata nyckel hör till mellannivåns certifikat', () => {
    expect(INTERMEDIATE.checkPrivateKey(createPrivateKey(MOCK_BANKID_INTERMEDIATE_PRIVATE_KEY))).toBe(
      true,
    )
  })

  it('ingen incheckad privat nyckel hör till roten', () => {
    const root = process.cwd()
    const keys = SEARCHED.flatMap((directory) => filesUnder(join(root, directory))).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(PRIVATE_KEY)].map((match) => ({
        file: relative(root, file).split(sep).join('/'),
        key: match[0],
      })),
    )

    // Mellannivåns nyckel ska hittas, annars letar testet på fel ställe.
    expect(keys.map((found) => found.file)).toContain(
      'src/modules/eligibility/bankid/mock-ca/issuing-ca-test-key.ts',
    )

    for (const { file, key } of keys) {
      let belongsToRoot = false
      try {
        belongsToRoot = ROOT.checkPrivateKey(createPrivateKey(key))
      } catch {
        // En nyckel som inte går att läsa kan inte heller vara rotens.
      }
      expect(belongsToRoot, `${file} bär rotens privata nyckel`).toBe(false)
    }
  })
})
