/**
 * VAD ARKITEKTURSIDAN FÅR SÄGA OM VALVET, SOM REGLER FÖR TESTERNA.
 *
 * Uppgift 11g lade in valvet i Azure, Key Vault, på huvudsidan och i
 * tidslinjen. Två fel ligger nära till hands i en liknelse med ett valv, och
 * båda vore allvarliga för en läsare som inte själv kan kontrollera
 * förklaringen:
 *
 *   1. Att valvet ser ut att hålla förtroendepersonernas nycklar. Det gör det
 *      inte, och med avsikt. Andelarna ligger i röstdatabasen, krypterade med
 *      var sin lösenfras, eftersom tre andelar i samma valv inte vore tre
 *      innehavare (spec 4.5).
 *   2. Att valvet ser ut att göra kopplingen omöjlig. Det är raderingen vid
 *      stängningen som tar bort kopplingen ur urnan. Valvet har kvar pepparn
 *      efteråt, och i en kopia från före stängningen öppnar den fortfarande
 *      namnen.
 *
 * Reglerna prövas mening för mening. En mening som nämner valvet tillsammans
 * med förtroendepersonernas nycklar måste säga att de inte finns i valvet. En
 * mening som nämner valvet tillsammans med kopplingen måste säga att det inte
 * är valvet som tar bort den. Samma regler används av enhetstestet för
 * momenten, av säkerhetstestet för huvudsidans filer och av e2e-testet för
 * sidan som den renderas.
 */

/** Meningar räknas som i tests/unit/timeline-moments.test.ts: på punkt, frågetecken och utropstecken. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

const VAULT = /valv/i

/** Förtroendepersonernas nycklar, med de ord sidan använder för dem. */
const TRUSTEE_KEYS =
  /förtroendeperson|nyckelns (?:tre )?delar|delarna av nyckeln|nyckeln till summan|låsets nyck/i

/** Att de inte finns i valvet, sagt så att negationen gäller valvet och inget annat. */
const NOT_IN_THE_VAULT =
  /inte (?:heller )?i valvet|valvet har (?:ingen|inga|inte)|(?:finns|ligger|förvaras) inte (?:heller )?(?:där|i valvet)/i

const LINK = /koppling|omöjlig|anonym/i

/** Att det inte är valvet som tar bort kopplingen, med just de orden. */
const NOT_THE_VAULT = /inte valvet/i

export type VaultClaimProblem = { sentence: string; problem: string }

export function vaultClaimProblems(text: string): VaultClaimProblem[] {
  return sentencesOf(text.replace(/\s+/g, ' ')).flatMap((sentence) => {
    if (!VAULT.test(sentence)) return []

    const problems: VaultClaimProblem[] = []
    if (TRUSTEE_KEYS.test(sentence) && !NOT_IN_THE_VAULT.test(sentence)) {
      problems.push({
        sentence,
        problem: 'nämner valvet och förtroendepersonernas nycklar utan att säga att nycklarna inte finns där',
      })
    }
    if (LINK.test(sentence) && !NOT_THE_VAULT.test(sentence)) {
      problems.push({
        sentence,
        problem: 'nämner valvet och kopplingen utan att säga att det inte är valvet som tar bort den',
      })
    }
    return problems
  })
}
