import { electionBelongsToThisMode, runtimeMode } from '@/lib/mode-flag'
import { bankIdKind, type BankIdKind } from '@/modules/eligibility/bankid/kind'

/**
 * OMRÖSTNINGEN BÄR SIN BANKID-MILJÖ (härdningen, punkt 3).
 *
 * Läget från uppgift 17 sa DEMO eller SHARP men inte vilken BankID ett skarpt
 * val gick mot. En omröstning skapad mot BankID:s testmiljö, där vem som helst
 * kan skaffa ett test-BankID för vilket personnummer som helst, kunde då
 * stängas, räknas och publiceras av en server mot produktionen, och
 * publiceringen såg likadan ut som en från produktionen.
 *
 * Miljön skrivs när omröstningen skapas, i båda databaserna, ur serverns egen,
 * som läget. Den har tre värden:
 *
 *   none         ingen riktig BankID: attrappen i demoläget, eller skarpt läge
 *                utan en klient, som inte kan starta
 *   test         BankID:s testmiljö
 *   production   BankID:s produktionsmiljö
 *
 * Varje väg som vägrar en omröstning i fel läge vägrar också en omröstning från
 * en annan miljö, och publiceringen bär miljön ur omröstningens rad. En
 * omröstning mot testmiljön kan alltså inte läggas i, stängas, räknas,
 * publiceras eller fastställas av en server mot produktionen, och publiceras
 * aldrig som något annat än testmiljön. Den som kan skriva i båda databaserna
 * kan ändå skriva om miljön, som läget.
 */
export type ElectionBankIdEnvironment = 'none' | 'test' | 'production'

export function electionBankIdEnvironmentFor(kind: BankIdKind): ElectionBankIdEnvironment {
  return kind === 'test' || kind === 'production' ? kind : 'none'
}

/** Miljön en omröstning som skapas av den här servern får. Läses vid varje anrop, som läget. */
export function serverBankIdEnvironment(): ElectionBankIdEnvironment {
  return electionBankIdEnvironmentFor(bankIdKind(runtimeMode()))
}

/**
 * Hör omröstningen till serverns läge och BankID-miljö? Ett okänt värde i
 * någon av kolumnerna stämmer med ingen server.
 */
export function electionBelongsToThisServer(election: { mode: string; bankIdEnvironment: string }): boolean {
  return electionBelongsToThisMode(election.mode) && election.bankIdEnvironment === serverBankIdEnvironment()
}
