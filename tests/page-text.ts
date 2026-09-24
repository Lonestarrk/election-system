/**
 * TEXTEN SOM EN LÄSARE UNGEFÄR SER, UR EN KÄLLFIL.
 *
 * Används av tests/security/known-limitations.test.ts, som letar efter rubriker
 * ur listan som står hårdkodade, och av tests/security/architecture-page.test.ts,
 * som prövar huvudsidans meningar om valvet och de citat ur huvudsidan som är
 * knutna till markörer. Funktionen fanns först som en kopia i vardera filen
 * (granskningen av 11g, M12), och en kopia som rättas på ett ställe men inte på
 * det andra är just den sortens fel testerna finns för att fånga.
 *
 * Taggarna tas bort, strängar som fogats ihop med `+` blir en sträng, och `{' '}`
 * och radbrytningar med indrag blir ett enda mellanslag. En mening som står
 * uppdelad på flera rader i källan blir då hel igen.
 */
export function visibleText(source: string): string {
  return source
    .replace(/(['"])\s*\+\s*\1/g, '')
    .replace(/\{\s*(['"])\s*\1\s*\}/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
}
