/**
 * SKRIVER UT IDENTITETSHASHEN FÖR ETT PERSONNUMMER (uppgift 17d).
 *
 *   IDENTITY_PEPPER=... npx tsx scripts/voter-identity-hash.ts <personnummer, 12 siffror>
 *
 * Skarpt läge seedar inte, så den som ska pröva skarpt läge mot BankID:s testmiljö
 * behöver lägga in sitt test-BankID:s personnummer i röstlängden för hand, se README,
 * "Uppgift 17d steg för steg". Hashen räknas med samma funktion som legitimeringen
 * (`hashPersonalNumber` i src/modules/eligibility/identity.ts), så att den matchar.
 * Skriptet läser och skriver ingen databas.
 */

import { hashPersonalNumber } from '../src/modules/eligibility/identity'

const personalNumber = process.argv[2] ?? ''
if (!/^\d{12}$/.test(personalNumber)) {
  console.error('Användning: IDENTITY_PEPPER=... npx tsx scripts/voter-identity-hash.ts <personnummer, 12 siffror>')
  process.exit(2)
}

hashPersonalNumber(personalNumber).then(
  (hash) => console.log(hash),
  (error: Error) => {
    console.error(error.message)
    process.exit(1)
  },
)
