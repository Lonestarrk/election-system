/**
 * Demovalet, det som prisma/seed.ts skapar (uppgift 12c).
 *
 * Demoåterställningen på adminsidan återställer bara en omröstning med det här
 * namnet och vägrar alla andra. Namnet står i seedningen och i
 * prisma/reset-votes.ts också, och tests/integration/demo-reset.test.ts kräver
 * att de stämmer med den här konstanten.
 */
export const DEMO_ELECTION_NAME = 'Valet 2026'

/**
 * Förtroendepersonernas fraser i demovalet, i ordning efter förtroendeperson 1
 * till 3. Seedningen krypterar andelarna med dem, och adminsidan fyller i dem
 * med en knapp i demoläget (rutten /api/demo/trustee-passphrases).
 *
 * Seedningen har kvar sin egen lista, eftersom de kända begränsningarnas
 * markörer pekar på den i prisma/seed.ts. tests/integration/demo-reset.test.ts
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
