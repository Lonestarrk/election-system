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
   * De nio första posterna gäller modellen med dubbla kuvert och är sanna i
   * koden redan i dag. Övriga poster beskriver antingen det gamla röstflödet
   * med röstintyg och blinda signaturer, som ingen sida lägger röster i sedan
   * uppgift 14 men vars rutter och tabeller finns kvar, eller gäller oavsett
   * modell. Det gamla flödets poster står kvar tills flödet tas bort, och testet
   * tvingar bort var och en när dess markör försvinner.
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
  /**
   * UPPGIFT 14f ERSATTE POSTEN "BankID-certifikatkedjan valideras inte".
   *
   * Valideringen prövar nu varje kedja mot BankID:s rot och varje löv mot
   * väljarens identitet, och sedan fixrunda 1 flyttar stängningen exakt de
   * kuvert som validerats. Med riktig BankID kan den som bara kan skriva i
   * databasen därför inte längre lägga in en röst för någon som inte skrivit
   * under. De fyra första posterna nedan är det som kedjan inte ger, och den
   * femte är priset för att den lagras.
   */
  {
    id: 'operator-can-remove-or-restore-envelope',
    title: 'Den som driver systemet kan ta bort ett kuvert eller lägga tillbaka en tidigare röst',
    why:
      'Med riktig BankID prövas varje underskrift mot BankID:s rot och mot väljarens identitet, och ' +
      'stängningen flyttar bara de kuvert som prövats, så den som kan skriva i databasen kan inte ' +
      'längre förfalska en ny. I demon kan den som driver systemet fortfarande det, eftersom ' +
      'attrappen utfärdar certifikaten själv. Men en äkta underskrift går att ta bort, och ' +
      'en väljares tidigare äkta kuvert går att lägga tillbaka i stället för hennes senaste. ' +
      'Räknaren som visar vilket kuvert som är det senaste lagras i samma databas, och den som ' +
      'lägger tillbaka det gamla kuvertet lägger tillbaka dess räknare, så valideringen före ' +
      'stängningen ser ingenting fel. Väljaren kan upptäcka båda före stängningen på enheten hon ' +
      'röstade från, där jämförelsen svarar att rösten ändrats eller att ingen röst finns. Efter ' +
      'stängningen ska markeringen "har röstat" visa att hon röstat, men den är inte byggd än ' +
      '(uppgift 11d).',
    stillTrueIf: [
      // Räknaren som valideringen jämför med är radens egen. Kom den från
      // något som den som driver systemet inte kan skriva om, till exempel en
      // publicerad logg, ändrades raden.
      {
        file: 'src/orchestration/validate-before-close.usecase.ts',
        contains: 'castSequence: vote.castSequence,',
      },
      { file: 'prisma/voters/schema.prisma', contains: 'castSequence Int @map("cast_sequence")' },
    ],
  },
  {
    id: 'no-revocation-check',
    title: 'Ingen spärrkontroll av BankID-certifikaten',
    why:
      'Kedjan prövas mot BankID:s rot och mot certifikatens giltighetstid, men ingen frågar om ' +
      'certifikatet har spärrats. Ett BankID som spärrats, till exempel för att telefonen stulits, ' +
      'godkänns alltså så länge certifikatet gäller i tid. Riktig BankID skickar med ett OCSP-svar ' +
      'som visar certifikatets status vid underskriften, och det är det som ska prövas, både när ' +
      'rösten läggs och i valideringen före stängningen. Attrappen har inget sådant svar, och ' +
      'kedjeprövningen tar inte emot något. Dessutom kommer tiden för underskriften i valideringen ' +
      'ur kuvertets updatedAt, som den som kan skriva i databasen kan ändra. Ett certifikat som ' +
      'gått ut godkänns därför om raden bakdateras till en dag då det gällde. Det kräver ett äkta ' +
      'certifikat och dess privata nyckel, och tidpunkten i OCSP-svaret hade stängt också det.',
    // Prövningen tar emot rötterna och tidpunkten för underskriften, och
    // ingenting annat. En spärrkontroll behöver ett OCSP-svar in, och då
    // ändras just den här raden.
    stillTrueIf: {
      file: 'src/modules/eligibility/bankid/certificate-chain.ts',
      contains: 'options: { roots: readonly X509Certificate[]; signedDuring: SigningWindow },',
    },
  },
  {
    id: 'mock-issues-certificates-in-demo',
    title: 'I demoläget utfärdar attrappen certifikaten själv',
    why:
      'Attrappen är sin egen certifikatutfärdare, och mellannivåns privata nyckel är incheckad i ' +
      'koden som testfixtur. Den som driver en demo kan därför utfärda ett giltigt certifikat för ' +
      'vilket personnummer som helst och förfalska en underskrift som valideringen godkänner. ' +
      'Skyddet gäller med riktig BankID, där nyckeln finns hos BankID och inte hos den som driver ' +
      'systemet. Testerna visar egenskapen mot attrappens inbyggda rot, vars privata nyckel ' +
      'kastades när den skapats: en kedja till en annan rot, ett certifikat för fel väljare, ett ' +
      'utgånget certifikat och ett löv med CA-rätt underkänns, var och ett av sin egen kontroll. ' +
      'En mellannivå utan CA-rätt prövas under en egen rot som testet litar på, eftersom ingen ' +
      'längre kan utfärda en mellannivå under attrappens.',
    stillTrueIf: [
      // Attrappen utfärdar med den incheckade nyckeln ...
      {
        file: 'src/modules/eligibility/bankid/MockBankIdService.ts',
        contains: "from './mock-ca/issuing-ca-test-key'",
      },
      // ... och i demoläget är attrappens rot den som kedjan prövas mot.
      {
        file: 'src/modules/eligibility/bankid/trusted-roots.ts',
        contains: 'if (isDemoMode()) return [mockBankIdRoot()]',
      },
    ],
  },
  {
    id: 'bankid-xmldsig-adapter-missing',
    title: 'Riktig BankID kräver en adapter för XML-signaturen',
    why:
      'BankID v6 returnerar underskriften som en XML-signatur, XMLDSig, med certifikatkedjan ' +
      'inbäddad. Kedjeprövningen är oberoende av formatet: den tar certifikaten och det signerade ' +
      'innehållet som de är. Men att läsa ut kedjan, signaturvärdet och den signerade texten ur ' +
      'XML-signaturen, och att pröva XML-signaturen själv, är inte byggt och kan inte provas utan ' +
      'BankID:s testmiljö. Tills adaptern finns är attrappen den enda implementationen, och ingen ' +
      'del av systemet har prövats mot ett riktigt BankID-svar.',
    // Attrappen är den enda implementationen av gränssnittet.
    stillTrueIf: {
      file: 'src/modules/eligibility/bankid/index.ts',
      contains: 'export const bankIdService: IBankIdService = new MockBankIdService()',
    },
  },
  {
    id: 'pepper-holder-reads-voter-names',
    title: 'Den som har pepparn kan läsa namn och personnummer för varje liggande kuvert',
    why:
      'Varje liggande kuvert bär väljarens BankID-certifikat, med personnummer och namn i klartext, ' +
      'krypterat med en nyckel som härleds ur IDENTITY_PEPPER och utfyllt till en fast längd, så ' +
      'att inte heller längden säger något om namnet eller banken. Nyckeln måste finnas hos ' +
      'servern, eftersom valideringen före stängningen öppnar varje kedja. En databasdump utan ' +
      'pepparn avslöjar därför ingenting nytt, men den som har både databasen och pepparn öppnar ' +
      'varje kedja och får namn och personnummer för alla som har röstat och ännu inte fått sitt ' +
      'kuvert skalat, utan en enda hashning. Det är mer än röstlängden ger i dag: identitetshashen ' +
      'låter den som har pepparn pröva ett personnummer i taget, och namnen finns ingen annanstans ' +
      'i databasen. Det gäller också den som ska granska underskrifterna: för att pröva kedjorna ' +
      'mot BankID:s rot behöver granskaren pepparn, och får då också veta vem som röstat. Pepparn ' +
      'ligger i samma miljö som applikationen, så den som tagit sig in i servern har ofta båda. ' +
      'Kedjan raderas med raden vid skalningen.',
    // Kedjans nyckel härleds ur pepparn. Kom den i stället från något som
    // servern inte bär, till exempel förtroendemännens andelar, ändrades raden.
    stillTrueIf: {
      file: 'src/modules/eligibility/sealed-chain.ts',
      contains: "hkdfSync('sha256', env.identityPepper,",
    },
  },
  {
    id: 'client-code-from-server',
    title: 'Klientkoden levereras av servern',
    why:
      'Rösten krypteras i din webbläsare, men koden kommer från den som ska granskas. En riktad, ' +
      'manipulerad version kan kryptera något annat än du valde, eller behålla slumptalet och ' +
      'göra det enheten visar till ett bevis som en köpare kan kräva — tyst, och utan att synas ' +
      'i databasen. Motmedlet, att väljaren kan låta granska en krypterad valsedel innan hon ' +
      'lägger den (cast-or-audit), ligger utanför specen, och problemet går inte att lösa fullt ' +
      'ut i en webbapp.',
    /**
     * Så länge valsedeln krypteras i klientkod som servern levererar står
     * problemet kvar. Fram till uppgift 14 gällde posten blindningen i det
     * gamla flödet och pekade på src/lib/blind-client.ts. Röstsidan blindar
     * inte längre något, så posten beskriver nu kuvertmodellens klient, som
     * spec 10 anger, och markören följer med dit.
     */
    stillTrueIf: {
      file: 'src/app/vote/page.tsx',
      contains: "import { encryptBallotInSteps } from '@/lib/encrypt-client'",
    },
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
      'Ingen sida delar längre ut en token, men rutten som svarar på dem finns kvar, och en token ' +
      'från förr visar fortfarande sitt parti. Kuvertmodellen är utformad utan kvitto (spec 3.1). ' +
      'Före stängningen ser väljaren sin nuvarande röst på enheten hon röstade från, men enheten ' +
      'sparar aldrig slumptalet, så det den visar bevisar ingenting för någon annan. Ingen kod ' +
      'visas, och efter stängningen ska bara summorna publiceras, så att det inte finns något per ' +
      'röst att visa upp eller matcha mot. Posten gäller det gamla flödet och försvinner med det.',
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
