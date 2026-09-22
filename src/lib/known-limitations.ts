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

export type KnownLimitation = {
  id: string
  title: string
  /** Varför det är allvarligt, i klartext för den som läser arkitektursidan. */
  why: string
  /**
   * Markör i källkoden som bevisar att begränsningen finns kvar.
   *
   * `file` läses relativt projektroten. `contains` måste förekomma i den.
   * Försvinner strängen har problemet antagligen lösts, och testet kräver att
   * posten tas bort härifrån.
   */
  stillTrueIf?: { file: string; contains: string }
}

export const KNOWN_LIMITATIONS: KnownLimitation[] = [
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
      'Verifieringen visar vilket alternativ token gäller. Det gör att en väljare kan bevisa sin ' +
      'röst för någon annan, vilket öppnar för röstköp. Det gäller varje val på valsedeln, inte ' +
      'bara personröster — kvittot är problemet, inte hur finfördelat valet är. ' +
      'LÖSNINGEN ÄR INTE ATT TA BORT KVITTOT. Att kvittot visar valet är också det som låter ' +
      'väljaren kontrollera att rösten räknats rätt, och den kontrollen är hela skälet att ett ' +
      'digitalt val alls går att lita på. Vägen framåt är kvittofrihet genom FÖRNEKBARHET: ' +
      'väljaren ska kunna framställa ett kvitto som ser äkta ut men visar ett annat val, och som ' +
      'en köpare inte kan skilja från ett riktigt. Då är ett kvitto inget bevis längre, och den ' +
      'som betalar för röster köper luft. Kravet är att äkta och falskt kvitto ska vara ' +
      'omöjliga att skilja på för alla utom väljaren själv.',
    // `choice` i verifieringssvaret är precis det som bevisar valet.
    stillTrueIf: { file: 'src/modules/ballot-box/vote.service.ts', contains: 'choice: string' },
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
