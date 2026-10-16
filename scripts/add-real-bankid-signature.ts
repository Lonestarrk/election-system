/**
 * LÄGGER IN EN RIKTIG BANKID-UNDERSKRIFT SOM TESTFALL (uppgift 17d).
 *
 *   npx tsx scripts/add-real-bankid-signature.ts <fångad fil> --app "<BankID-app och version>" \
 *     [--service "<srvInfo/name>"] [--confirm-test-identity]
 *
 * Filen är en som appen skrev med BANKID_CAPTURE_SIGNATURES_DIR satt, i skarpt läge
 * mot BankID:s testmiljö. Skriptet prövar den med läsaren mot BankID:s kundrot för
 * testmiljön, förankrad i src/modules/eligibility/bankid/bankid-environment.ts, och
 * säger vilket antagande från 17b som inte höll om läsaren avvisar den. Godtas den
 * läggs den i tests/unit/bankid/fixtures/real med dagen, miljön och BankID-appen,
 * och skriptet skriver ut vad som återstår.
 *
 * `--service` är srvInfo/name för RP-certifikatet appen körde med. Förvalet är
 * BankID:s publika testcertifikat FP Testcert 5, som README använder.
 *
 * Skriptet vägrar en fångst från en annan miljö än test, och kör inte när
 * BANKID_ENV är något annat än test. Personnummer och namn i underskriften går inte
 * att byta, och skriptet kräver --confirm-test-identity innan de skrivs till repot.
 * Se README, "Uppgift 17d steg för steg".
 */

import { join } from 'node:path'
import { addRealBankIdSignature } from './real-bankid-signature/add'

const result = addRealBankIdSignature(process.argv.slice(2), {
  fixturesDirectory: join(process.cwd(), 'tests', 'unit', 'bankid', 'fixtures', 'real'),
  bankIdEnv: process.env.BANKID_ENV,
})
for (const line of result.lines) console.log(line)
process.exit(result.exitCode)
