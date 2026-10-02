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
