import type { RuntimeMode } from '@/lib/mode-flag'

/**
 * Vilken BankID bygget använder i det läge det kör i (uppgift 17).
 *
 *   mock         attrappen, i demoläget
 *   test         BankID:s testmiljö, med test-BankID och inte med riktiga personer
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
 * Nej. Klienten mot BankID:s RP-API byggs i uppgift 17c. Tills dess kan skarpt
 * läge inte starta: kravet `bankid-real` är ouppfyllt och stoppar, och det är
 * sanningen om koden. Uppgift 17c byter den här konstanten mot true samtidigt
 * som den lägger in klienten i `index.ts`, så att det inte går att slå på det
 * ena utan det andra.
 */
export const REAL_BANKID_CLIENT_BUILT = false

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
