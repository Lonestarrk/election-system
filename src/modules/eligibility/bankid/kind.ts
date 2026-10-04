import type { RuntimeMode } from '@/lib/mode-flag'

/**
 * Vilken BankID bygget använder i det läge det kör i (uppgift 17).
 *
 *   mock         attrappen, i demoläget
 *   test         BankID:s testmiljö, med test-BankID som vem som helst kan skaffa för vilket personnummer som helst
 *   production   BankID:s produktionsmiljö
 *   none         ingen klient: skarpt läge utan en riktig BankID-klient
 *
 * Filen har inga importer utöver en typ, så att både `index.ts` (som väljer
 * tjänsten) och `src/lib/runtime-mode.ts` (som redovisar valet och kräver en
 * riktig klient) kan läsa den utan att dra in varandra.
 */
export type BankIdKind = 'mock' | 'test' | 'production' | 'none'

/**
 * FINNS DET EN RIKTIG BANKID-KLIENT I DET HÄR BYGGET?
 *
 * Ja, sedan uppgift 17c: ./BankIdRpClient.ts, mot BankID:s RP API v6.0, och
 * `index.ts` bygger den i skarpt läge. Vilken miljö den går mot väljer
 * BANKID_ENV, och utan den är svaret fortfarande ingen klient. Konstanten och
 * valet i `index.ts` ändrades i samma commit, så att det ena inte finns utan det
 * andra.
 */
export const REAL_BANKID_CLIENT_BUILT = true

/**
 * ÄR LÄSAREN PRÖVAD MOT EN RIKTIG UNDERSKRIFT FRÅN BANKID?
 *
 * Nej. Läsaren (./xmldsig.ts) är byggd efter BankID:s signaturprofil, och
 * klienten är prövad mot testmiljön för auth, collect och cancel, men ingen
 * underskrift från BankID finns bland testfallen. En sådan kräver en människa med
 * test-BankID, och hur den fångas står i ./signature-capture.ts och i rapporten
 * för uppgift 17c. Spec 10 säger att skarpt läge inte ska släppas på utan den, så
 * kravet `bankid-reader-tested` stoppar BANKID_ENV=production och varnar i
 * testmiljön. Konstanten byts mot true i samma commit som underskriften läggs in
 * som testfall.
 */
export const READER_TESTED_AGAINST_REAL_SIGNATURE = false

/** BANKID_ENV, bara om värdet är ett av de två som finns. */
export function configuredBankIdEnvironment(): 'test' | 'production' | null {
  const value = process.env.BANKID_ENV
  return value === 'test' || value === 'production' ? value : null
}

export function bankIdKind(mode: RuntimeMode): BankIdKind {
  if (mode === 'DEMO') return 'mock'
  if (!REAL_BANKID_CLIENT_BUILT) return 'none'
  return configuredBankIdEnvironment() ?? 'none'
}
