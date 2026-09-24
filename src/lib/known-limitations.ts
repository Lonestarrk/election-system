/**
 * KÄNDA BEGRÄNSNINGAR — EN ENDA KÄLLA
 *
 * Listan fanns tidigare som prosa på tre ställen: arkitektursidan, SECURITY.md
 * och VERIFIABILITY.md. Följden blev förutsägbar. Ordningsproblemet mellan de
 * två databasskrivningarna löstes av röstintygen, men stod kvar som ett
 * kvarvarande problem på sidan långt efteråt — och en sida som påstår att
 * systemet är sämre än det är underminerar tilliten lika säkert som en som
 * påstår motsatsen.
 *
 * VARJE BEGRÄNSNING BÄR SITT EGET TEST
 *
 * Fältet `stillTrueIf` pekar ut något i källkoden som är sant SÅ LÄNGE
 * begränsningen finns kvar. Ett säkerhetstest kontrollerar varje sådan
 * markör och misslyckas när den försvinner.
 *
 * Det betyder att den som faktiskt löser ett problem inte kan glömma att
 * uppdatera listan: bygget går sönder tills posten är borttagen. Det är
 * omvänd logik jämfört med ett vanligt test — det failar när något blir
 * BÄTTRE, och det är hela poängen.
 *
 * Begränsningar utan `stillTrueIf` är sådana som inte går att läsa ur koden:
 * driftsrutiner, organisation, hur nycklar förvaras. De måste underhållas för
 * hand, och de är markerade så.
 */

/**
 * Markör i källkoden som bevisar att begränsningen finns kvar.
 *
 * `file` läses relativt projektroten. `contains` måste förekomma i den.
 * Försvinner strängen har problemet antagligen lösts, och testet kräver att
 * posten tas bort härifrån.
 */
export type LimitationMarker = { file: string; contains: string }

export type KnownLimitation = {
  id: string
  title: string
  /** Varför det är allvarligt, i klartext för den som läser arkitektursidan. */
  why: string
  /**
   * En markör, eller flera när posten påstår flera saker om koden. Med flera
   * måste alla hålla: posten står kvar så länge vart och ett av påståendena i
   * den är sant, och den som löser en del av problemet får skriva om texten.
   */
  stillTrueIf?: LimitationMarker | LimitationMarker[]
}

export const KNOWN_LIMITATIONS: KnownLimitation[] = [
  /**
   * KUVERTMODELLENS BEGRÄNSNINGAR.
   *
   * De fyra första posterna gäller modellen med dubbla kuvert och är sanna i
   * koden redan i dag. Övriga poster beskriver antingen det gamla röstflödet
   * med röstintyg och blinda signaturer, som röstsidan fortfarande kör, eller
   * gäller oavsett modell. Det gamla flödets poster står kvar tills flödet tas
   * bort, och testet tvingar bort var och en när dess markör försvinner.
   */
  {
    id: 'link-exists-during-voting',
    title: 'Kopplingen väljare↔röst finns medan röstningen pågår',
    why:
      'Modellen med dubbla kuvert kräver kopplingen — det är den som gör rösten utbytbar, så ' +
      'att en köpt röst kan ersättas ända fram till stängningen. Priset är att "kan inte ' +
      'existera" blivit "raderas enligt schema". Backuper, läsreplikor och WAL-loggen omfattas ' +
      'inte av raderingen, och rösten är bara skyddad av att chiffret inte går att läsa utan k ' +
      'av n andelar. Det är den huvudsakliga akademiska invändningen mot Estlands system.',
    // PendingVote är det yttre kuvertet: väljarens id i samma rad som chiffret.
    // Så länge modellen finns, finns kopplingen medan röstningen pågår.
    stillTrueIf: { file: 'prisma/voters/schema.prisma', contains: 'model PendingVote' },
  },
  {
    id: 'bankid-order-carries-link',
    title: 'BankID-ordern bär kopplingen ut ur systemet',
    why:
      'Det väljaren signerar innehåller chifferhashen, och samma BankID-order bär hennes ' +
      'identitet. BankID sparar signaturer, bland annat för tvister, så med skarp BankID finns ' +
      'kopplingen mellan väljaren och chiffret kvar hos BankID efter att den raderats här, och ' +
      'hashen står kvar i encrypted_vote och pekar ut chiffret. Raderingen vid stängningen når ' +
      'inte dit. I demoläget håller attrappen dessutom övergivna signeringsordrar i ' +
      'processminnet tills servern startas om, med det signerade och, om ordern hunnit skannas, ' +
      'personnumret.',
    // sign-start lägger chifferhashen oförändrad i det signerade. När det
    // signerade i stället bär en saltad hash av den, med ett salt som bara
    // finns i PendingVote och raderas med raden, ändras just den här raden, och
    // BankID:s kopia slutar gå att matcha mot något efter stängningen.
    stillTrueIf: {
      file: 'src/app/api/vote/sign-start/route.ts',
      contains: 'ciphertextHash: body.data.ciphertextHash',
    },
  },
  {
    id: 'trusted-dealer',
    title: 'Tröskelnyckeln delas av en betrodd utdelare',
    why:
      'Vid valets skapande existerar hela den privata nyckeln på ett ställe under ett ögonblick ' +
      'innan den delas och raderas. Riktig distribuerad nyckelgenerering låter förtroendemännen ' +
      'bygga nyckeln utan att den någonsin sätts ihop.',
    // Att dela en färdig nyckel ÄR den betrodda utdelaren. Vid distribuerad
    // nyckelgenerering finns ingen hel nyckel att dela, och anropet försvinner.
    // Markören är anropet med den hela nyckeln, inte bara namnet: namnet står
    // också i importraden och hade överlevt att anropet togs bort.
    stillTrueIf: {
      file: 'src/orchestration/create-election.usecase.ts',
      contains: 'splitSecret(keys.privateKey',
    },
  },
  {
    id: 'bankid-chain-not-validated',
    title: 'BankID-certifikatkedjan valideras inte',
    why:
      'Signaturen på det yttre kuvertet prövas mot den publika nyckel som står i certifikatet, ' +
      'men certifikatet prövas aldrig mot BankID:s CA. Den som har skrivrättighet i databasen ' +
      'kan därför skapa ett eget nyckelpar, signera ett välformat kuvert och lägga nyckel, ' +
      'signatur och en verklig väljare i en helt självkonsekvent rad, som valideringen före ' +
      'stängningen godkänner. Signaturen skyddar alltså mot en klient som skickar in ett eget ' +
      'kuvert, men inte mot den som driver systemet. Att pröva kedjan när rösten läggs räcker ' +
      'inte, eftersom den som skriver direkt i databasen aldrig passerar läggningen; det är ' +
      'valideringen före stängningen som måste pröva ett certifikat mot BankID:s CA. ' +
      'Förfalskningen finns som körbart test i tests/integration/validate-before-close.test.ts.',
    // Valideringen före stängningen prövar signaturen mot nyckeln som raden
    // själv bär. Så länge den gör det kan den som skriver i databasen lägga in
    // ett eget nyckelpar tillsammans med en signatur som håller, och det är
    // hela luckan. När raden i stället bär något som BankID:s CA står för, och
    // valideringen prövar det, ändras just det här anropet. En kontroll som
    // bara läggs till vid läggningen lämnar anropet orört, och då är det rätt
    // att posten står kvar: förfalskningen går ändå igenom.
    stillTrueIf: {
      file: 'src/orchestration/validate-before-close.usecase.ts',
      contains: 'verifySignedPayload(vote.bankIdSignature, vote.bankIdPublicKey',
    },
  },
  {
    id: 'client-code-from-server',
    title: 'Klientkoden levereras av servern',
    why:
      'Blindningen sker i din webbläsare, men koden kommer från den som ska granskas. En riktad, ' +
      'manipulerad version kan läcka blindningsfaktorn och lägga tillbaka kopplingen mellan ' +
      'väljare och röst — tyst, och utan att synas i databasen. Det här är det enda som faktiskt ' +
      'kan bryta obundenheten, och det går inte att lösa fullt ut i en webbapp.',
    // Så länge blindningen sker i klientkod som servern levererar står problemet kvar.
    stillTrueIf: { file: 'src/lib/blind-client.ts', contains: 'createBlindedCredential' },
  },
  {
    id: 'signing-keys-in-database',
    title: 'Signeringsnycklarna ligger i databasen',
    why:
      'Valsedlarnas privata nycklar lagras i röstlängden. En databasdump — en backup i fel händer ' +
      'räcker — låter vem som helst prägla giltiga röstintyg och lägga röster som passerar varje ' +
      'kontroll. Nycklarna hör hemma i en HSM, aldrig i en tabell.',
    // Fältet försvinner ur schemat den dag signeringen flyttar till Key Vault.
    stillTrueIf: { file: 'prisma/voters/schema.prisma', contains: 'signingPrivateKeyPem' },
  },
  {
    id: 'receipt-proves-choice',
    title: 'Kvittot bevisar hur du röstat',
    why:
      'Det gamla flödets verifiering visar vilket alternativ token gäller. Det gör att en väljare ' +
      'kan bevisa sin röst för någon annan, vilket öppnar för röstköp. Det gäller varje val på ' +
      'valsedeln, inte bara personröster — kvittot är problemet, inte hur finfördelat valet är. ' +
      'Kuvertmodellen är därför utformad utan kvitto (spec 3.1). Före stängningen ska väljaren se ' +
      'sin nuvarande röst på enheten hon röstade från, men enheten ska aldrig spara slumptalet, så ' +
      'det den visar bevisar ingenting för någon annan. Ingen kod ska visas, och efter ' +
      'stängningen ska bara summorna publiceras, så att det inte finns något per röst att visa ' +
      'upp eller matcha mot. Posten gäller det gamla flödet och försvinner med det.',
    // `choice` i verifieringssvaret är precis det som bevisar valet.
    stillTrueIf: { file: 'src/modules/ballot-box/vote.service.ts', contains: 'choice: string' },
  },
  {
    id: 'live-results-in-old-flow',
    title: 'Det gamla flödets resultat och röster är öppna medan röstningen pågår',
    why:
      'Observatörsgränssnittet, som är öppet utan inloggning, lämnar ut antalet röster per parti ' +
      'ur det gamla flödets tabell vote medan röstningen pågår. Rutten /api/observer/votes går ' +
      'längre och lämnar ut varje röst en och en, med sitt innehåll: parti, kandidat eller ' +
      'svarsalternativ. Det är ett löpande resultat, och det får inte finnas: delsiffror påverkar ' +
      'dem som ännu inte röstat, och differensen mellan två hämtningar är rösterna som lades ' +
      'däremellan. Har bara en person röstat under tiden är differensen den personens röst. I ' +
      'kuvertmodellens design räknas ingenting förrän kopplingen raderats, men det gamla flödet ' +
      'räknar i klartext, när som helst.',
    stillTrueIf: [
      // Rutten räknar ur tabellen vote vid varje anrop, utan att fråga om
      // röstningen stängt. När den under röstningen bara visar valdeltagandet,
      // och resultat först när en valsedel räknats, försvinner anropet.
      { file: 'src/app/api/observer/election/route.ts', contains: 'getElectionResults(election.id)' },
      // Varje röst lämnas ut med sitt val: parti, kandidat och svarsalternativ,
      // en markör för vart och ett, eftersom texten nämner alla tre. Tas något
      // av dem bort ur svaret, eller rutten helt, faller posten.
      { file: 'src/app/api/observer/votes/route.ts', contains: 'ballotPartyId: true,' },
      { file: 'src/app/api/observer/votes/route.ts', contains: 'candidateId: true,' },
      { file: 'src/app/api/observer/votes/route.ts', contains: 'optionId: true,' },
    ],
  },
  {
    id: 'municipality-beside-identity-hash',
    title: 'Folkbokföringskoden ligger bredvid identitetshashen',
    why:
      'Folkbokföringsorten står i samma rad som identitetshashen. Ett personnummer är sällan ' +
      'hemligt, så den som har pepparn bekräftar en utpekad person med ett anrop och läser av ' +
      'orten — och för någon med skyddad folkbokföring är numret ofta redan känt av just den hen ' +
      'skyddas från, medan orten är det som ska vara hemlig. Ingen hashparameter hjälper mot en ' +
      'riktad kontroll. Lösningen är att inte lagra uppgiften: orten behövs bara för att välja ' +
      'kommunvalsedel och ska slås upp mot folkbokföringen vid inloggning, så att värdet lever i ' +
      'den ena begäran. Tre vägar är redan uteslutna — en egen tabell byter bara kolumnnamn ' +
      'eftersom joinet ger tillbaka kopplingen, lagrade valsedelsrättigheter avslöjar samma sak ' +
      '(rätten till Faluns kommunvalsedel ÄR kommunen), och BankID kan inte leverera den: ' +
      'completionData innehåller personnummer och namn, ingen adress.',
    stillTrueIf: { file: 'prisma/voters/schema.prisma', contains: 'municipalityCode' },
  },
  {
    id: 'commitments-internal-only',
    title: 'Åtaganden publiceras bara internt',
    why:
      'En Merklerot som bara finns i samma databas som den skyddar kan skrivas om tillsammans med ' +
      'rösterna. Rötterna måste publiceras utanför systemet för att ha fullt bevisvärde.',
    // Ingen kodmarkör: att rötterna publiceras externt är en driftsrutin, inte en kodegenskap.
  },
  {
    id: 'single-administrator',
    title: 'En ensam administratör',
    why:
      'Att skapa eller fastställa en omröstning borde kräva att flera behöriga personer agerar ' +
      'tillsammans. I dag räcker en.',
    // Försvinner när fastställandet kräver flera godkännanden.
    stillTrueIf: {
      file: 'src/orchestration/final-check.usecase.ts',
      contains: 'export async function certifyElection',
    },
  },
  {
    id: 'no-guaranteed-anonymity-set',
    title: 'Ingen garanterad anonymitetsmängd',
    why:
      'Vid låg röstfrekvens räcker inte grova tidsstämplar. Rösterna behöver köas och skrivas i ' +
      'blandade satser med en garanterad mängd.',
    // Rösten skrivs direkt vid inlösen. En kö skulle ersätta det anropet.
    stillTrueIf: {
      file: 'src/modules/ballot-box/vote.service.ts',
      contains: 'votesDb.vote.create',
    },
  },
  {
    id: 'admission-queue-per-process',
    title: 'Nummerlappen gäller bara en serverinstans',
    why:
      'Antagningskön som skyddar den minneshårda identitetshashningen håller sitt tillstånd i ' +
      'processminnet. Två följder: med flera instanser bakom en lastbalanserare blir det faktiska ' +
      'taket åtta gånger antalet instanser, alltså inte det tak minnesberäkningen utgår från. Och ' +
      'köplatsen är inte en riktig nummerlapp — den lever bara så länge begäran lever, så en ' +
      'väljare som tappar nätet eller vars begäran tar timeout hamnar sist igen. En valdag behöver ' +
      'delad kö med bestående platser, så att den som väntat längst behåller sin plats i kön.',
    stillTrueIf: {
      file: 'src/lib/admission-queue.ts',
      contains: 'const waiting: Waiter[] = []',
    },
  },
]

/** Begränsningar som går att kontrollera automatiskt. */
export const CHECKABLE_LIMITATIONS = KNOWN_LIMITATIONS.filter(
  (limitation) => limitation.stillTrueIf !== undefined,
)
