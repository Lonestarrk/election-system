import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { READER_TESTED_AGAINST_REAL_SIGNATURE } from '@/modules/eligibility/bankid/kind'
import {
  acceptedRealFixtures,
  parseRealFixture,
  verifyRealSignature,
} from '@/modules/eligibility/bankid/real-signature'

/**
 * RIKTIGA UNDERSKRIFTER FRÅN BANKID:S TESTMILJÖ (uppgift 17c, beslut 4, och 17d).
 *
 * Mappen fixtures/real är tom tills en människa med test-BankID har skrivit under
 * en röst mot testmiljön med BANKID_CAPTURE_SIGNATURES_DIR satt och lagt in filen
 * med scripts/add-real-bankid-signature.ts. Se README, "Uppgift 17d steg för steg".
 *
 * Varje fixtur prövas med läsaren, som läggningen gör, mot BankID:s kundrot för
 * testmiljön så som den är förankrad i koden (bankid-environment.ts), och aldrig
 * mot en rotfil bredvid fixturen: en sådan fil hade kunnat vara vilken rot som
 * helst, också attrappens.
 *
 * KRAVET bankid-reader-tested FÖLJER FIXTURERNA. Konstanten
 * READER_TESTED_AGAINST_REAL_SIGNATURE i kind.ts ska vara sann exakt när minst en
 * fixtur från testmiljön godtas här. Testet nedan går rött åt båda hållen: en
 * konstant som sätts utan fixtur, och en fixtur som godtas medan konstanten står
 * kvar. Konstanten läses inte ur filerna när appen kör, eftersom den som kan lägga
 * en fil i en driftsatt app då hade kunnat slå på kravet utan granskning.
 */

const DIRECTORY = join(process.cwd(), 'tests', 'unit', 'bankid', 'fixtures', 'real')
const fixtures = existsSync(DIRECTORY) ? readdirSync(DIRECTORY).filter((name) => name.endsWith('.json')) : []

describe('riktiga underskrifter från BankID:s testmiljö', () => {
  ;(fixtures.length === 0 ? it.skip : it)(
    'hoppas över: tests/unit/bankid/fixtures/real är tom. En riktig underskrift läggs in med ' +
      'scripts/add-real-bankid-signature.ts, se README, "Uppgift 17d steg för steg"',
    () => {},
  )

  for (const name of fixtures) {
    it(`${name} har metadata och godtas av läsaren mot testmiljöns förankrade kundrot`, () => {
      const parsed = parseRealFixture(JSON.parse(readFileSync(join(DIRECTORY, name), 'utf8')))
      if (!parsed.ok) throw new Error(`${name}: ${parsed.problem}`)
      expect(parsed.fixture.environment).toBe('test')

      const result = verifyRealSignature(parsed.fixture)
      if (!result.ok) {
        throw new Error(
          `${name} avvisades: ${result.reason}\n` + result.findings.map((finding) => `  ${finding.text}`).join('\n'),
        )
      }
    })
  }

  it('READER_TESTED_AGAINST_REAL_SIGNATURE är sann exakt när en riktig fixtur från testmiljön godtas', () => {
    const accepted = acceptedRealFixtures(DIRECTORY)
    expect(
      READER_TESTED_AGAINST_REAL_SIGNATURE,
      accepted.length > 0
        ? `${accepted.join(', ')} godtas. Byt READER_TESTED_AGAINST_REAL_SIGNATURE mot true i kind.ts.`
        : 'Ingen riktig fixtur godtas, och då får kravet bankid-reader-tested inte vara uppfyllt.',
    ).toBe(accepted.length > 0)
  })
})
