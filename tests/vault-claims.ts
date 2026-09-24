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
 * Reglerna prövas mening för mening, och samma regler används av enhetstestet
 * för momenten, av säkerhetstestet för huvudsidans filer och av e2e-testet för
 * sidan som den renderas.
 *
 * VAD REGLERNA INTE KAN FÅNGA. De är ordlistor och mönster, inget bevis för att
 * en text är rätt. De fångar de formuleringar som finns i testfallen i
 * tests/unit/timeline-moments.test.ts och sådana som liknar dem: valvet som
 * håller andelar, delar, nycklar till låset eller kuverten, och valvet som den
 * som skyddar, döljer eller tar bort kopplingen. En mening som säger samma sak
 * med andra ord, som "hemligheterna i valvet räcker för att öppna summan",
 * passerar. Det gör också en omskrivning över två meningar, där den ena säger
 * vad valvet har och den andra vad det räcker till, och ett påstående i en bild
 * och inte i en text. Den som skriver om valvet får därför fortfarande läsa sin
 * mening mot spec 4.5 och 10, och reglerna är till för att samma fel inte ska
 * komma tillbaka, inte för att intyga att texten stämmer.
 *
 * Granskningen av 11g fann att reglerna först var för lösa: 12 av 14 naturliga
 * felformuleringar passerade, liksom tre meningar som innehöll "inte i valvet"
 * eller "inte valvet" men ändå påstod motsatsen. Därför räknas en negation bara
 * när den gäller valvet självt, inte när den följs av "bara", "ensamt" eller en
 * mening som med "men", "utan" eller "fast" säger något nytt om valvet.
 */

/** Meningar räknas som i tests/unit/timeline-moments.test.ts: på punkt, frågetecken och utropstecken. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

const VAULT = /valv/i

/**
 * Förtroendepersonernas nycklar, med de ord en text om dem använder: personerna
 * själva, andelar och delar, deras lösenfraser, låsets nyckel och nyckeln till
 * summan eller kuverten. Inte "nyckel" ensamt, eftersom valvet faktiskt har
 * nycklar: till urnorna, och huvudnyckeln till båda.
 */
const TRUSTEE_KEYS = new RegExp(
  [
    'förtroendeperson',
    'förtroendem(?:an|än)',
    '\\bandel(?:ar|arna|en)?\\b',
    '\\bdel(?:ar|arna)\\b',
    'nyckelns (?:tre )?delar',
    'låsets (?:nyckel|nycklar|tre delar|delar)',
    'nyckel(?:n|ns)? till (?:summan|låset|de inre kuverten|kuverten|de enskilda kuverten|rösterna|rösten)',
    'lösenfras',
  ].join('|'),
  'i',
)

/** Att de inte finns i valvet, sagt så att negationen gäller valvet och inget annat. */
const NOT_IN_THE_VAULT =
  /inte (?:heller )?i valvet|valvet har (?:ingen|inga|inte)\b(?! bara| enbart| endast)|(?:finns|ligger|förvaras|sparas) inte (?:heller )?(?:där|i valvet)|varken i valvet|aldrig i valvet|utanför valvet/i

/** Kopplingen mellan väljare och röst, med de ord en text om den använder. */
const LINK =
  /koppl|omöjlig|anonym|valhemlig|samband|vem som röstade|vilket kuvert som är ditt|röst(?:en)? hemlig/i

/** Att det inte är valvet, med just de orden och utan "ensamt" eller "bara" efter. */
const NOT_THE_VAULT = /inte valvet\b(?! ensamt| bara| enbart| endast| själv)/i

/** Valvet som den som gör något åt kopplingen, namnen eller rösterna. */
const VAULT_AS_AGENT = new RegExp(
  [
    '\\bvalvet\\s+(?:som\\s+)?(?:gör|ser till|skyddar|garanterar|döljer|säkrar|raderar|tar bort|slänger|skalar|hindrar)\\b(?!\\s+inte)',
    '\\b(?:gör|ser till|skyddar|garanterar|döljer|säkrar|raderar|tar bort|slänger|skalar|hindrar)\\s+valvet\\b(?!\\s+inte)',
    '\\b(?:tack vare|med hjälp av|genom)\\s+valvet\\b',
  ].join('|'),
  'i',
)
/** Det valvet i så fall gör något åt. Hela ord, så att "röstlängden" inte räknas som en röst. */
const AGENT_OBJECT = new RegExp(
  `${LINK.source}|\\bnamn(?:et|en)?\\b|\\bröst(?:en|er|erna)?\\b|\\bkuvert(?:et|en)?\\b|\\bidentitet(?:en)?\\b`,
  'i',
)

/** "inte bara", som ser ut som en negation men lägger till. */
const ONLY_SEEMS_NEGATED = /inte (?:bara|enbart|endast|främst)\b/i

/** En ny mening om valvet efter "men", "utan" eller "fast", som tar tillbaka negationen. */
const REASSERTION = /\b(?:men|utan|fast)\b[^.]*?\bvalv/i

export type VaultClaimProblem = { sentence: string; problem: string }

export function vaultClaimProblems(text: string): VaultClaimProblem[] {
  return sentencesOf(text.replace(/\s+/g, ' ')).flatMap((sentence) => {
    if (!VAULT.test(sentence)) return []

    const problems: VaultClaimProblem[] = []

    const saysNotInTheVault =
      NOT_IN_THE_VAULT.test(sentence) && !ONLY_SEEMS_NEGATED.test(sentence) && !REASSERTION.test(sentence)
    if (TRUSTEE_KEYS.test(sentence) && !saysNotInTheVault) {
      problems.push({
        sentence,
        problem: 'nämner valvet och förtroendepersonernas nycklar utan att säga att nycklarna inte finns där',
      })
    }

    const attributesElsewhere =
      NOT_THE_VAULT.test(sentence) && !ONLY_SEEMS_NEGATED.test(sentence) && !REASSERTION.test(sentence)
    if (LINK.test(sentence) && !attributesElsewhere) {
      problems.push({
        sentence,
        problem: 'nämner valvet och kopplingen utan att säga att det inte är valvet som tar bort den',
      })
    } else if (VAULT_AS_AGENT.test(sentence) && AGENT_OBJECT.test(sentence)) {
      problems.push({
        sentence,
        problem: 'låter valvet vara den som skyddar eller tar bort kopplingen, namnen eller rösterna',
      })
    }

    return problems
  })
}
