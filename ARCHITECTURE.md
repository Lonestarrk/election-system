# Arkitektur

Teknisk beskrivning av systemets uppbyggnad och dataflöde.

Säkerhetsresonemangen finns i [SECURITY.md](SECURITY.md); här beskrivs konstruktionen.

---

## 1. Grundidé

Systemet består av två delar som avsiktligt inte kan nå varandras data:

```
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│  VÄLJARSYSTEM                   │   │  ANONYMT RÖSTSYSTEM             │
│  src/modules/eligibility/       │   │  src/modules/anonymous-vote/    │
│                                 │   │                                 │
│  Vet:  vem du är                │   │  Vet:  vad som röstats          │
│        om du får rösta          │   │        hur många röster         │
│        om du har röstat         │   │                                 │
│                                 │   │  Vet inte: vem som röstat       │
│  Vet inte: vad du röstat på     │   │                                 │
│                                 │   │                                 │
│  Databas: voters_db             │   │  Databas: votes_db              │
└─────────────────────────────────┘   └─────────────────────────────────┘
              │                                       │
              └───────────────┬───────────────────────┘
                              │
                  src/orchestration/cast-vote.usecase.ts
                  Enda stället där båda finns i samma anropsstack.
                  Skickar vidare exakt ett värde: partyId.
```

Separationen upprätthålls i tre lager, oberoende av varandra:

1. **Topologiskt** — två PostgreSQL-databaser. En foreign key mellan dem är omöjlig.
2. **Typmässigt** — röstmodulens publika kontrakt har ingen parameter som kan bära
   identitet. Kompilatorn stoppar försöket.
3. **Genom test** — arkitekturtester läser källkoden och misslyckas om modulerna börjar
   importera varandra, eller om en ny fil börjar se båda sidorna.

Ett lager kan gå sönder utan att de andra gör det. Det är poängen med att ha tre.

---

## 2. Projektstruktur

```
election-system/
├── docker/
│   ├── postgres/init.sql          Skapar votes_db vid första uppstart
│   └── entrypoint.sh              Migrerar båda databaserna, seedar, startar
├── prisma/
│   ├── voters/                    Schema + migrationer för voters_db
│   ├── votes/                     Schema + migrationer för votes_db
│   └── seed.ts                    Demodata
├── src/
│   ├── app/
│   │   ├── page.tsx               Start
│   │   ├── legitimera/            BankID-flöde
│   │   ├── rosta/                 Partival, bekräftelse, kvitto
│   │   ├── verifiera/             Tokenverifiering
│   │   ├── admin/                 Aggregerad statistik
│   │   ├── demo/                  Arkitekturdemonstration
│   │   └── api/
│   │       ├── auth/bankid/       start, collect
│   │       ├── vote/              parties, cast
│   │       ├── verify/            POST
│   │       ├── admin/             login, stats
│   │       └── demo/              database-state
│   ├── modules/
│   │   ├── eligibility/           Identitetssidan
│   │   │   ├── bankid/            IBankIdService + MockBankIdService
│   │   │   ├── identity.ts        Personnummer → HMAC
│   │   │   ├── voter-status.service.ts
│   │   │   ├── voting-session.service.ts
│   │   │   ├── audit.service.ts
│   │   │   └── db.ts              Prisma-klient mot voters_db
│   │   └── anonymous-vote/        Röstsidan
│   │       ├── index.ts           Publikt kontrakt — hela modulens yta
│   │       ├── token.service.ts
│   │       ├── vote.service.ts
│   │       └── db.ts              Prisma-klient mot votes_db
│   ├── orchestration/
│   │   └── cast-vote.usecase.ts   Den enda kopplingspunkten
│   ├── lib/                       Krypto, logg, validering, CSRF, cookies, tid
│   └── middleware.ts              Säkerhetsheaders och CORS
└── tests/
    ├── unit/                      Token, krypto, logg, BankID, validering
    ├── integration/               Mot riktig databas
    └── security/                  Arkitektur- och API-ytegranskning
```

---

## 3. Datamodell

### voters_db

```
voter_status
├── id                      uuid, slumpad
├── external_identity_hash  HMAC-SHA256(personnummer, pepper), unik
├── is_eligible             boolean
├── has_voted               boolean
└── voted_at                timestamp, avrundad till DYGN

voting_session                       ← raderas vid röstläggning
├── id                      uuid
├── voter_status_id         FK → voter_status
├── expires_at              timestamp
└── csrf_secret             text

audit_event
├── id                      uuid
├── event_type              text
└── occurred_at             timestamp, avrundad till TIMME
```

### votes_db

```
party
├── id                      uuid
├── name, abbreviation      text, unika
├── color                   text
└── display_order           int

anonymous_vote
├── id                      uuid, slumpad
├── token_hash              SHA-256, UNIKT INDEX
├── party_id                FK → party
└── created_at              timestamp, avrundad till TIMME
```

### Vad som inte finns

Det viktiga i modellen är frånvaron:

- ingen foreign key mellan `voter_status` och `anonymous_vote` — de ligger i olika
  databaser, så relationen är inte bara oskriven utan omöjlig
- ingen token eller token-hash i `voter_status`
- ingen identitet, session eller IP i `anonymous_vote`
- inget sessions-id som överlever röstningen
- inga sekvensnummer som exponeras — alla id är slumpade UUID:er

Tidsstämplarnas grovkornighet är en del av datamodellen, inte en presentationsdetalj. Se
[SECURITY.md, 4.1](SECURITY.md#41-tidskorrelation).

---

## 4. Dataflöde vid röstning

```
Väljare                Väljarsystem              Orkestrering         Röstsystem
   │                        │                         │                    │
   │──personnummer─────────▶│                         │                    │
   │                   MockBankID auth                │                    │
   │◀─────orderRef──────────│                         │                    │
   │                        │                         │                    │
   │──collect (polling)────▶│                         │                    │
   │                   evaluateEligibility()          │                    │
   │                   personnummer → HMAC            │                    │
   │                   uppslag i voters_db            │                    │
   │                        │                         │                    │
   │                   ┌────┴─────┐                   │                    │
   │                   │ i röstlängden?               │                    │
   │                   │ röstberättigad?              │                    │
   │                   │ har inte röstat?             │                    │
   │                   └────┬─────┘                   │                    │
   │                   createVotingSession()          │                    │
   │◀──HttpOnly-cookie──────│                         │                    │
   │                        │                         │                    │
   │──välj parti───────────▶│                         │                    │
   │  + CSRF-header         │──────castVote(session, partyId)──▶│          │
   │                        │                         │                    │
   │                        │                    ┌────┴────┐               │
   │                        │                    │ 1. finns partiet?       │
   │                        │                    │ 2. markera som röstad   │
   │                        │                    │    + radera session     │
   │                        │                    │    ATOMISKT             │
   │                        │                    │ 3. slumpad fördröjning  │
   │                        │                    └────┬────┘               │
   │                        │                         │                    │
   │                        │                         │──{ partyId }──────▶│
   │                        │                         │                    │
   │                        │                         │   ╔════════════════╧═══╗
   │                        │                         │   ║ HÄR SLUTAR IDENTITETEN
   │                        │                         │   ║ Endast partyId passerar
   │                        │                         │   ╚════════════════╤═══╝
   │                        │                         │                    │
   │                        │                         │         generateVoteToken()
   │                        │                         │         240 slumpbitar
   │                        │                         │         lagra SHA-256(token)
   │                        │                         │                    │
   │                        │                         │◀──────token────────│
   │◀──token (en gång)──────│◀────────────────────────│                    │
   │  cookies raderas       │                         │                    │
```

Det streckade partiet är hela systemets kärna. Funktionen som anropas där har signaturen:

```ts
castAnonymousVote(input: { partyId: string }): Promise<{ token: string }>
```

Det finns ingen parameter för väljar-id, personnummer, sessions-id, IP-adress eller
request-id. En utvecklare som ville skicka med sådant skulle behöva ändra kontraktet
först — och då misslyckas arkitekturtestet.

### Ordningen mellan de två skrivningarna

Steg 2 (markera väljaren) sker **före** steg 3 (registrera rösten), och de kan inte ingå i
samma transaktion eftersom de går till olika databaser. Valet och dess konsekvenser är
utförligt beskrivet i [SECURITY.md, avsnitt 5](SECURITY.md#5-dubbelröstningsspärr-och-ordningsproblemet).

---

## 5. Dataflöde vid verifiering

```
Väljare ──POST /api/verify { token } ──▶ Röstsystem
                                            │
                                     normalisera token
                                     SHA-256
                                     uppslag på token_hash i votes_db
                                            │
        ◀── { registered: true, party } ────┘
```

Verifieringsvägen rör aldrig `voters_db`. Rutten importerar inte ens väljarmodulen,
vilket ett test kontrollerar.

**Avvikelse från specifikationen:** specen beskriver `GET /api/verify/{token}` men kräver
samtidigt att token aldrig hamnar i en URL. Kraven är oförenliga — en token i sökvägen
skrivs till accessloggar, proxyloggar, webbläsarhistorik och följer med i Referer-headern.
Kravet som skyddar väljaren fick styra, så verifieringen sker med POST och token i
begärans kropp. `GET` finns kvar men svarar `405` med en förklaring.

---

## 6. Modulkontrakt

### `src/modules/anonymous-vote/index.ts`

Hela modulens publika yta:

```ts
castAnonymousVote({ partyId }): Promise<{ token }>   // registrera röst
isKnownParty(partyId): Promise<boolean>              // validera före markering
listParties(): Promise<Party[]>                      // partilistan
verifyToken(token): Promise<VerificationResult>      // verifiering
getVoteStatistics(): Promise<{ totalVotes, perParty }>  // aggregat
```

Ingen av dem tar emot eller returnerar något som identifierar en person.

### `src/modules/eligibility/`

```ts
evaluateEligibility(personalNumber): Promise<EligibilityDecision>
markAsVotedAndConsumeSession(voterStatusId, sessionId): Promise<boolean>
createVotingSession(voterStatusId): Promise<VotingSession>
getValidVotingSession(sessionId): Promise<VotingSession | null>
getVoterStatistics(): Promise<{ totalEligible, totalVoted }>
```

Ingen av dem tar emot eller returnerar något om partier eller röster.

### Varför `isKnownParty` finns

Orkestreringen måste kunna avvisa ett ogiltigt parti **innan** väljaren markeras som
röstande. Utan den kontrollen skulle en felformad begäran kunna bränna någons rösträtt
utan att en röst registrerades. Funktionen frågar bara "finns det här partiet?" och
skickar ingenting om väljaren vidare.

---

## 7. BankID-abstraktionen

```ts
interface IBankIdService {
  auth(request: { personalNumber?: string }): Promise<BankIdAuthOrder>
  collect(orderRef: string): Promise<BankIdCollectResult>
  cancel(orderRef: string): Promise<void>
}
```

Signaturerna följer det riktiga BankID-API:ets form: en order startas, klienten pollar
`collect` tills status blir `complete` eller `failed`. `MockBankIdService` håller
ordertillståndet i processminne och blir klar efter ett konfigurerbart antal pollningar.

Implementationen väljs på ett enda ställe, `src/modules/eligibility/bankid/index.ts`. Ett
byte till skarp BankID kräver en ny klass som implementerar gränssnittet plus
certifikathantering — ingen annan fil behöver ändras.

**Det mockade tillståndet ligger i processminne.** Rätt för en POC, fel för drift: en
omstart tappar pågående legitimeringar, och med flera instanser hamnar polling-anropen på
fel process.

---

## 8. Applikationslager

### Middleware (`src/middleware.ts`)

Sätter CSP, HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy` och
`Permissions-Policy` på alla svar. Hanterar CORS-preflight och avvisar främmande origin.
API-svar får `no-store`.

CSP:n sätter `connect-src 'self'`, vilket gör att sidan inte kan skicka data till en
tredje part ens om kod för det smugit sig in.

### Logg (`src/lib/logger.ts`)

All utskrift går genom loggern, som maskerar token-, personnummer- och hashmönster på väg
ut. Maskeringen är ett skyddsnät för det som råkar slinka igenom — inte en ursäkt för att
logga slarvigt vid anropsstället.

Ett arkitekturtest misslyckas om någon källfil anropar `console.*` direkt. Prismas
frågeloggning är avstängd i båda klienterna; påslagen skulle den skriva ut
identitetshashar respektive token-hashar.

### Hastighetsbegränsning (`src/lib/rate-limit.ts`)

Token bucket i processminne, med hashade nycklar. Tillräckligt för en POC, fel för drift:
tillståndet är per process och nollställs vid omstart. Produktionsmiljö behöver Redis
eller en WAF framför applikationen.

---

## 9. Frontend

Next.js App Router. Serverkomponenter där inget tillstånd behövs, klientkomponenter för
BankID-polling, partival, verifiering, admin och demo.

**Kvittot renderas på samma sida som röstningen, utan navigering.** Alternativet — att
skicka token vidare till en separat kvittosida — skulle kräva att klartexten
transporteras genom en URL, sessionStorage eller ett tillstånd som överlever en
sidladdning. Alla tre är precis vad specifikationen förbjuder. Genom att rendera kvittot
direkt från svaret lämnar token aldrig komponentens minne, och en omladdning gör den
oåterkalleligt borta — vilket är avsikten.

Kopiering till urklipp sker bara på väljarens eget klick. Sidan varnar vid navigering
medan token fortfarande visas.

---

## 10. Demonstrationssidan

`/demo` visar dataflödet, båda databasernas innehåll sida vid sida, en kolumnjämförelse
som visar att inget fält är gemensamt, samtliga foreign keys hämtade ur
`information_schema`, och en genomgång av metadatariskerna.

`/api/demo/database-state` **ska inte finnas i ett skarpt system.** Den är med för att
POC:ens hela poäng är att gå att granska. Tre saker görs ändå rätt, eftersom ett dåligt
exempel är sämre än inget exempel: hashvärden kortas av, raderna sorteras på id i stället
för insättningsordning (som skulle röja kronologin), och foreign keys hämtas ur
databasen så att påståendet går att kontrollera i stället för att behöva tros på.

---

## 11. Testarkitektur

| Nivå | Vad som granskas |
|---|---|
| `tests/unit/` | Tokenentropi och format, hashning, identitets-HMAC, tidsavrundning, logg-maskering, BankID-mock, validering |
| `tests/integration/` | Fullständiga röstningsflöden mot riktig PostgreSQL, med inspektion av faktiskt databastillstånd |
| `tests/security/` | Modulgränser, schemaseparation, API-yta, token i loggar |

Integrationstesterna kontrollerar inte bara att flödet fungerar utan att **kopplingen
saknas**: de läser ut raderna ur båda databaserna och verifierar att inget värde från den
ena förekommer i den andra, att foreign keys aldrig pekar över gränsen, och att en tömd
röstlängd inte påverkar de anonyma rösterna.

De statiska testerna i `tests/security/` granskar källkoden i stället för att köra den. De
svarar på en annan fråga: inte "saknas kopplingen just nu?" utan "kan den införas av
misstag?".

Testerna hoppas över automatiskt om ingen databas är tillgänglig, så att enhets- och
arkitekturtesterna kan köras utan Docker.
