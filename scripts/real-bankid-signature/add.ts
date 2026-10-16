import type { X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { customerRootFor } from '../../src/modules/eligibility/bankid/bankid-environment'
import {
  fixtureFileName,
  parseCapture,
  PUBLIC_TEST_RP_SERVICE_NAME,
  type RealFixture,
  verifyRealSignature,
} from '../../src/modules/eligibility/bankid/real-signature'

/**
 * FRÅN FÅNGST TILL FIXTUR (uppgift 17d, punkt 2). Logiken bakom
 * scripts/add-real-bankid-signature.ts, som en funktion så att testerna kan köra den.
 *
 * `roots` finns bara för testerna, som saknar en riktig underskrift och därför
 * prövar med attrappens rot. Kommandoraden ger aldrig något annat än BankID:s
 * förankrade kundrot för testmiljön.
 */

export type AddResult = { exitCode: number; lines: string[]; written: string | null }

const USAGE =
  'Användning: npx tsx scripts/add-real-bankid-signature.ts <fångad fil> --app "<BankID-app och version>" ' +
  '[--service "<srvInfo/name>"] [--confirm-test-identity]'

type Arguments = { capture: string | null; app: string | null; service: string | null; confirmed: boolean; problem: string | null }

function parseArguments(args: readonly string[]): Arguments {
  const parsed: Arguments = { capture: null, app: null, service: null, confirmed: false, problem: null }
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (argument === '--confirm-test-identity') parsed.confirmed = true
    else if (argument === '--app' || argument === '--service') {
      const value = args[++index]
      if (value === undefined || value.startsWith('--')) parsed.problem = `${argument} saknar ett värde.`
      else if (argument === '--app') parsed.app = value
      else parsed.service = value
    } else if (argument.startsWith('--')) parsed.problem = `Okänd flagga: ${argument}.`
    else if (parsed.capture === null) parsed.capture = argument
    else parsed.problem = `Bara en fil i taget: ${argument}.`
  }
  return parsed
}

export function addRealBankIdSignature(
  args: readonly string[],
  options: { fixturesDirectory: string; roots?: readonly X509Certificate[]; bankIdEnv?: string },
): AddResult {
  const lines: string[] = []
  const stop = (exitCode: number, ...text: string[]): AddResult => ({ exitCode, lines: [...lines, ...text], written: null })

  const parsed = parseArguments(args)
  if (parsed.problem) return stop(2, parsed.problem, USAGE)
  if (parsed.capture === null) return stop(2, USAGE)

  /**
   * BARA TESTMILJÖN. I produktion bär underskriften en riktig persons personnummer
   * och namn, och den hör aldrig hemma i repot. Fångsten skriver bara i testmiljön,
   * men verktyget prövar ändå både filen och BANKID_ENV. Ett osatt BANKID_ENV godtas,
   * eftersom verktyget alltid prövar mot testmiljöns förankrade kundrot och vägrar en
   * fångst vars fil säger något annat än test.
   */
  const bankIdEnv = options.bankIdEnv?.trim() ?? ''
  if (bankIdEnv !== '' && bankIdEnv !== 'test') {
    return stop(2, `BANKID_ENV är ${bankIdEnv}. Verktyget körs bara för BankID:s testmiljö.`)
  }

  let content: unknown
  try {
    content = JSON.parse(readFileSync(parsed.capture, 'utf8'))
  } catch (error) {
    return stop(2, `Filen går inte att läsa som JSON: ${(error as Error).message}`)
  }
  const capture = parseCapture(content)
  if (!capture.ok) return stop(2, `Filen är ingen fångst: ${capture.problem}`)
  if (capture.value.environment !== 'test') {
    return stop(
      2,
      `Fångsten är från miljön "${capture.value.environment}". Bara underskrifter från BankID:s testmiljö läggs som fixtur.`,
    )
  }

  const service = parsed.service ?? PUBLIC_TEST_RP_SERVICE_NAME
  const result = verifyRealSignature({ ...capture.value, service }, options.roots ?? [customerRootFor('test')])

  if (!result.ok) {
    return stop(
      1,
      `Läsaren avvisade underskriften med skälet ${result.reason}.`,
      ...result.findings.map((finding) => `  - ${finding.text}`),
      '',
      'Ingen fixtur skrevs. Rätta läsaren med underskriften som testfall, utan att göra den mindre strikt än ' +
        'underskriften kräver (beslut 4 i 17c), och kör verktyget igen.',
    )
  }

  lines.push(
    `Läsaren godtog underskriften mot BankID:s kundrot för testmiljön (fångad ${capture.value.capturedOn}).`,
    `Den bär personnumret ${result.personalNumber} och namnet ${result.name ?? '(okänt)'}.`,
  )

  /**
   * PERSONNUMMER OCH NAMN GÅR INTE ATT BYTA. De står i lövets subject, som BankID
   * har signerat, och i det signerade dokumentet. Ett test-BankID bär uppgifter som
   * den som skaffade det valde själv, men verktyget kan inte veta att de är påhittade.
   */
  if (!parsed.confirmed) {
    return stop(
      1,
      '',
      'Varning: personnummer och namn går inte att byta ut utan att bryta underskriften, så de följer med in i repot.',
      'Ett test-BankID bär uppgifter som den som skaffade det valde själv. Kontrollera att de ovan är påhittade',
      '(till exempel ett av Skatteverkets testpersonnummer) och inte en verklig persons, och kör igen med',
      '--confirm-test-identity.',
    )
  }
  if (parsed.app === null || parsed.app.trim() === '') {
    return stop(2, 'Ange vilken BankID-app och version som skrev under med --app, till exempel --app "BankID för Android 10.4.1".')
  }

  const fixture: RealFixture = {
    environment: 'test',
    capturedOn: capture.value.capturedOn,
    bankIdApp: parsed.app.trim(),
    service,
    signature: capture.value.signature,
    ocspResponse: capture.value.ocspResponse,
  }

  mkdirSync(options.fixturesDirectory, { recursive: true })
  const path = join(options.fixturesDirectory, fixtureFileName(capture.value))
  try {
    writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, { flag: 'wx' })
  } catch {
    return stop(1, `Fixturen finns redan: ${path}`)
  }

  const shown = relative(process.cwd(), path).replace(/\\/g, '/')
  return {
    exitCode: 0,
    written: path,
    lines: [
      ...lines,
      `Fixturen är skriven: ${shown}`,
      '',
      'Vad som syntes, per antagande från 17b:',
      ...result.observations.map((observation) => `  ${observation}`),
      '',
      'Kvar att göra:',
      '  1. Kör npx vitest run tests/unit/bankid/real-signature.test.ts. Fixturen ska gå grönt, och testet',
      '     av kravet går rött tills konstanten nedan byts.',
      '  2. Byt READER_TESTED_AGAINST_REAL_SIGNATURE mot true i src/modules/eligibility/bankid/kind.ts.',
      '  3. Ta bort posten bankid-reader-untested-against-bankid i src/lib/known-limitations.ts och punkten om',
      '     läsaren i REMAINING i src/app/architecture/code-facts.ts. Deras markörer går rött när konstanten byts.',
      '     Skriv om påståendena, och lös aldrig upp en markör.',
      '  4. Kör tsc, hela vitest och hela Playwright.',
      `  5. Committa fixturen med uttrycklig sökväg. Granskaren ska veta att filen bär test-BankID:ts`,
      '     personnummer och namn, och dagen.',
      '  6. Lägg in observationerna ovan i rapporten för 17d, och pröva för hand det som README räknar upp',
      '     (avbryt, låt ordern gå ut, samma enhet, ändra rösten).',
    ],
  }
}
