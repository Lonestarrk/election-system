/**
 * DEMOLÄGE ELLER SKARPT LÄGE, AVGJORT PÅ ETT ENDA STÄLLE (uppgift 17).
 *
 * Det här är den enda filen som läser DEMO_MODE, och tests/security/
 * demo-mode-cannot-reach-production.test.ts kräver det. Alla andra går genom
 * `runtimeMode()` eller, i koden som frågar om demon, `isDemoMode()` i
 * src/lib/demo-mode.ts.
 *
 * I demoläget kringgår demoidentiteterna BankID helt, så vem som helst kan
 * rösta som vem som helst. Det är hela poängen med en demo, och det är därför
 * den här filen är en av de farligaste i projektet.
 *
 * TRE REGLER
 *
 *   1. Skarpt läge är förvalt. En glömd, felstavad eller tom variabel ger det
 *      säkra utfallet. Bara exakt "true" ger demoläge: "TRUE", "1" och "yes"
 *      gör det inte, eftersom ett värde som nästan är rätt ska läsas som att
 *      ingen bett om demoläge.
 *   2. Läget följer bara DEMO_MODE, inte NODE_ENV. Den publika demon i Azure är
 *      ett produktionsbygge som kör i demoläge (ruling 121). Ett villkor på
 *      NODE_ENV hade gjort att den demon inte kunde starta.
 *   3. Läget sätts vid driftsättning. Ingen väg i appen byter det: ingen knapp,
 *      ingen rutt och ingen skrivning till variabeln. Den som kommer åt en
 *      adminsession kan därför inte slå på attrapp-BankID åt alla.
 *
 * Det som skyddar ett riktigt val mot en demoprocess är att skarpt läge är
 * förvalt, banderollen på varje sida i demoläget, omröstningens eget läge (en
 * demoomröstning kan aldrig fastställas i skarpt läge) och uppstartsvakten i
 * skarpt läge. Se src/lib/runtime-mode.ts.
 *
 * Filen har inga importer, så att seed-skriptet och uppstartskoden kan läsa den
 * utan att dra in resten av appen.
 */

export type RuntimeMode = 'DEMO' | 'SHARP'

/** Läses vid varje anrop. Processen byter aldrig läge, men testerna måste kunna visa båda. */
export function runtimeMode(): RuntimeMode {
  return process.env.DEMO_MODE === 'true' ? 'DEMO' : 'SHARP'
}

/**
 * Hör omröstningen till det läge servern kör i? En omröstning bär det läge den
 * skapades i, och läggning, stängning och fastställande vägrar en omröstning
 * vars läge är ett annat: en demoomröstning kan aldrig fastställas i skarpt
 * läge, och demoröster hamnar aldrig i en skarp omröstning. Ett okänt värde i
 * kolumnen är ingen av delarna, och vägras i båda lägena.
 */
export function electionBelongsToThisMode(electionMode: string): boolean {
  return electionMode === runtimeMode()
}
