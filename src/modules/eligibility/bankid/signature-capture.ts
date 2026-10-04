import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { logger } from '@/lib/logger'
import { runtimeMode } from '@/lib/mode-flag'
import { truncateToDay } from '@/lib/time'
import { configuredBankIdEnvironment } from './kind'

/**
 * EN RIKTIG UNDERSKRIFT FÅNGAS SOM TESTFALL (uppgift 17c, beslut 4 i granskningen av 17b).
 *
 * Läsaren av BankID:s underskrift (./xmldsig.ts) är byggd efter BankID:s
 * beskrivning och ska prövas mot en riktig underskrift, och en sådan kräver en
 * människa med test-BankID. Med BANKID_CAPTURE_SIGNATURES_DIR satt skriver
 * klienten varje underskrift den hämtar till en egen fil i katalogen, och hur den
 * blir ett testfall står i rapporten för uppgift 17c och i README.
 *
 * BARA I BANKID:S TESTMILJÖ. Fångsten gäller när appen kör i skarpt läge med
 * BANKID_ENV=test, och aldrig annars: i produktion bär underskriften en riktig
 * persons personnummer och namn, och i demoläget är den attrappens.
 *
 * ALDRIG I EN LOGG. Underskriften skrivs bara till filen, och loggen får inget av
 * den, inte heller filens namn. Filen bär test-BankID:ts personnummer och namn,
 * och dagen, men ingen tid på dygnet.
 */

export function signatureCaptureDirectory(): string | null {
  const directory = process.env.BANKID_CAPTURE_SIGNATURES_DIR?.trim()
  if (!directory) return null
  if (runtimeMode() !== 'SHARP') return null
  if (configuredBankIdEnvironment() !== 'test') return null

  /**
   * KATALOGEN LIGGER UTANFÖR APPEN (fixrunda 1 av 17c, Mindre 1). En relativ sökväg,
   * eller en inne i arbetskatalogen, hade kunnat lägga underskrifterna i repot, där
   * de committas av misstag, eller i en katalog som appen serverar. Då slås fångsten
   * inte på, och felet loggas utan sökvägen.
   */
  const fromCwd = relative(process.cwd(), resolve(directory))
  const insideCwd = fromCwd === '' || (!fromCwd.startsWith('..') && !isAbsolute(fromCwd))
  if (!isAbsolute(directory) || insideCwd) {
    logger.error(
      'BANKID_CAPTURE_SIGNATURES_DIR måste vara en absolut sökväg utanför appens arbetskatalog. Fångsten är avstängd.',
    )
    return null
  }
  return directory
}

/** Skriver underskriften till en ny fil i katalogen. Skriver aldrig över en tidigare. */
export function captureSignature(
  directory: string,
  completion: { signature: string; ocspResponse: string },
  now: Date = new Date(),
): string {
  const path = join(directory, `bankid-signature-${randomBytes(8).toString('hex')}.json`)
  const content = {
    environment: 'test',
    capturedOn: truncateToDay(now).toISOString().slice(0, 10),
    signature: completion.signature,
    ocspResponse: completion.ocspResponse,
  }
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return path
}
