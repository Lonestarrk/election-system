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
      'röst för någon annan, vilket öppnar för röstköp. Att kvittot i stället bara bekräftar att ' +
      'rösten är registrerad gör lögnen gratis — men då behövs ett annat sätt att upptäcka en ' +
      'fuskande klient.',
    // `choice` i verifieringssvaret är precis det som bevisar valet.
    stillTrueIf: { file: 'src/modules/anonymous-vote/vote.service.ts', contains: 'choice: string' },
  },
  {
    id: 'municipality-beside-identity-hash',
    title: 'Folkbokföringskoden ligger bredvid identitetshashen',
    why:
      'Vänds identitetshashen får man inte bara vem som står i röstlängden, utan också var ' +
      'personen är folkbokförd — de ligger i samma rad. För någon med skyddad identitet är det ' +
      'precis den uppgift som inte får finnas. Hashningen är numera minneshård med scrypt, vilket ' +
      'gör massreversering dyr, men en riktad kontroll av EN person kostar fortfarande ett anrop.',
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
      file: 'src/modules/anonymous-vote/vote.service.ts',
      contains: 'votesDb.anonymousVote.create',
    },
  },
]

/** Begränsningar som går att kontrollera automatiskt. */
export const CHECKABLE_LIMITATIONS = KNOWN_LIMITATIONS.filter(
  (limitation) => limitation.stillTrueIf !== undefined,
)
