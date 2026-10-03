import { runtimeMode } from './mode-flag'

/**
 * Demovalet, det som prisma/seed.ts skapar (uppgift 12c).
 *
 * Demoåterställningen på adminsidan återställer bara en omröstning med det här
 * namnet och vägrar alla andra. Namnet står i seedningen och i
 * prisma/reset-votes.ts också, och tests/integration/admin-closing.test.ts kräver
 * att de stämmer med den här konstanten.
 */
export const DEMO_ELECTION_NAME = 'Valet 2026'

/**
 * Förtroendepersonernas fraser i demovalet, i ordning efter förtroendeperson 1
 * till 3. Seedningen krypterar andelarna med dem, och adminsidan fyller i dem
 * med en knapp i demoläget (rutten /api/demo/trustee-passphrases).
 *
 * Seedningen har kvar sin egen lista, eftersom de kända begränsningarnas
 * markörer pekar på den i prisma/seed.ts. tests/integration/admin-closing.test.ts
 * kräver att de två listorna är lika.
 *
 * De är kända för alla som läser repot. Det är en känd begränsning, se
 * `demo-trustee-passphrases-known` i src/lib/known-limitations.ts.
 */
export const DEMO_TRUSTEE_PASSPHRASES: readonly [string, string, string] = [
  'demo-fortroendeman-ett',
  'demo-fortroendeman-tva',
  'demo-fortroendeman-tre',
]

/**
 * Demovalets tider, räknade från idag (ruling 136).
 *
 * Valet öppnar vid dygnets början i UTC och stänger trettio dygn senare. Med
 * fasta datum stängde demovalet för läggning en dag, och ingen kunde rösta i
 * det längre. Seedningen använder tiderna när den skapar valet, och
 * demoåterställningen och prisma/reset-votes.ts flyttar fram dem. Skarpt läge
 * rörs inte: det har inget demoval.
 */
export function demoElectionWindow(now: Date = new Date()): { opensAt: Date; closesAt: Date } {
  const opensAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const closesAt = new Date(opensAt.getTime() + 30 * 86_400_000)
  return { opensAt, closesAt }
}

/**
 * Är frasen en av demofraserna? Jämförelsen ser förbi skiftläge och blanksteg
 * runt frasen: "Demo-Fortroendeman-Ett " är lika känd som originalet, och en
 * spärr som en versal kringgår vore ingen spärr.
 */
export function isKnownDemoPassphrase(phrase: string): boolean {
  const normalised = phrase.trim().toLowerCase()
  return DEMO_TRUSTEE_PASSPHRASES.some((known) => known.toLowerCase() === normalised)
}

/**
 * Seedningen vägrar köra utanför demoläget (uppgift 17).
 *
 * Den skapar demovalet med förtroendemännens kända fraser och en administratör
 * med ett känt personnummer, och skriver ut dem. Det är rätt för en demo och
 * fel för allt annat. Anropas först i prisma/seed.ts, före varje databasåtkomst.
 *
 * Läser läget ur src/lib/mode-flag.ts, som är en fil utan importer och därför
 * går att köra ur tsx utan appens sökvägsalias.
 */
export function assertSeedAllowed(): void {
  if (runtimeMode() === 'DEMO') return

  throw new Error(
    'Seedningen körs bara i demoläget. Den här processen kör i skarpt läge, som är förvalt: ' +
      'DEMO_MODE är inte exakt "true". Seedningen skapar demovalet med förtroendemännens kända fraser ' +
      'och en administratör med ett känt personnummer, och gör inget utanför demoläget.',
  )
}
