# Digitalt valsystem — proof of concept

Teknisk demonstration av ett valsystem där väljarens identitet och röst aldrig kan
kopplas ihop.

> **Detta är inte ett valsystem redo för användning.** Det är en demonstration av en
> arkitekturprincip. Se [SECURITY.md](SECURITY.md) för vad som fattas och varför.

---

## Idén

Systemet är byggt kring en enda egenskap:

> Den del som vet **"person X har röstat"** kan inte ta reda på
> **"person X röstade på parti Y"**.

Det uppnås genom två åtskilda delar med varsin databas:

| | Röstlängdssystemet | Anonyma röstsystemet |
|---|---|---|
| Vet | vem du är, om du fått rösta | vad som röstats, hur många röster |
| Vet inte | vad du röstat på | vem som röstat |
| Databas | `voters_db` | `votes_db` |

De ligger i **olika PostgreSQL-databaser**. En foreign key mellan dem är inte bara
oskriven — den är omöjlig att skapa. Det enda som passerar gränsen när en röst läggs är
ett parti-id.

---

## Kom igång

```bash
docker compose up
```

Öppna <http://localhost:3000>.

Uppstarten migrerar båda databaserna, seedar demodata och startar applikationen. Första
bygget tar några minuter.

### Sidor

| Sida | Vad den gör |
|---|---|
| `/` | Start |
| `/legitimera` | BankID-legitimering (attrapp) |
| `/rosta` | Partival, bekräftelse och kvitto med token |
| `/verifiera` | Kontrollera en röst med sin token (`/verify` omdirigerar hit) |
| `/admin` | Aggregerad statistik (lösenord: `admin`) |
| `/demo` | Arkitektur, båda databasernas innehåll, metadatarisker |

---

## Prova systemet

### 1. Rösta

Gå till `/legitimera` och ange ett demopersonnummer:

| Personnummer | Utfall |
|---|---|
| `19900101-1234` | Röstberättigad — kan rösta |
| `19850515-2345` | Röstberättigad — kan rösta |
| `19701212-3456` | Röstberättigad — kan rösta |
| `20100101-4567` | Ej röstberättigad — avvisas |
| `19420404-8901` | Har redan röstat — avvisas |
| valfritt annat | Finns inte i röstlängden — avvisas |

BankID-attrappen blir klar efter ett par sekunders polling. Välj parti, bekräfta, och
**spara token** — den visas en enda gång.

### 2. Verifiera

Gå till `/verifiera` och klistra in din token. Svaret blir *"Din röst är registrerad"*
plus partiet. Bindestreck och versaler spelar ingen roll.

### 3. Försök rösta igen

Legitimera dig med samma personnummer. Du avvisas med *"Du har redan röstat i det här
valet."*

### 4. Se att kopplingen saknas

Gå till `/demo`. Där visas båda databasernas innehåll sida vid sida, samtliga foreign
keys hämtade direkt ur `information_schema`, och en knapp som demonstrerar varför frågan
"vem röstade på vad?" inte går att formulera som SQL.

### 5. Kontrollera själv, i databasen

```bash
# Röstlängden: vem som röstat. Ingen token, inget parti.
docker exec -it election-postgres psql -U election -d voters_db -c "SELECT * FROM voter_status;"

# Rösterna: vad som röstats. Ingen identitet.
docker exec -it election-postgres psql -U election -d votes_db -c "SELECT * FROM anonymous_vote;"

# Samtliga foreign keys — alla pekar inom sin egen databas.
docker exec -it election-postgres psql -U election -d votes_db -c "
  SELECT tc.table_name, ccu.table_name AS refererar
  FROM information_schema.table_constraints tc
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
  WHERE tc.constraint_type = 'FOREIGN KEY';"
```

Det finns ingen kolumn i den ena tabellen som förekommer i den andra. Tidsstämplarna är
avrundade (dygn respektive timme) just för att de annars skulle gå att para ihop.

---

## Utveckling utan Docker

Kräver Node 22+ och en PostgreSQL med databaserna `voters_db` och `votes_db`.

```bash
docker compose up -d postgres   # enklaste sättet att få båda databaserna
cp .env.example .env
npm install                     # genererar Prisma-klienterna via postinstall
npm run migrate                 # migrerar båda databaserna
npm run seed
npm run dev
```

### Skript

| Kommando | Gör |
|---|---|
| `npm run dev` | Utvecklingsserver |
| `npm run build` | Produktionsbygge |
| `npm run generate` | Genererar båda Prisma-klienterna |
| `npm run migrate` | Migrerar båda databaserna |
| `npm run seed` | Lägger in demodata |
| `npm test` | Hela testsviten |
| `npm run test:unit` | Endast enhetstester (kräver ingen databas) |
| `npm run test:security` | Arkitektur- och API-ytegranskning |
| `npm run test:integration` | Integrationstester mot riktig databas |

---

## Tester

```bash
docker compose up -d postgres
npm test
```

119 tester i tre nivåer:

- **Enhetstester** — tokenentropi och format, identitetshashning, tidsavrundning,
  loggmaskering, BankID-attrappen, validering
- **Integrationstester** — fullständiga röstningsflöden mot riktig PostgreSQL, med
  inspektion av det faktiska databastillståndet efteråt
- **Säkerhetstester** — modulgränser, schemaseparation, API-yta, token i loggar

De statiska testerna läser källkoden i stället för att köra den. De svarar på en annan
fråga än integrationstesterna: inte "saknas kopplingen just nu?" utan "kan den införas av
misstag?". Ett test misslyckas till exempel om en ny fil börjar importera från båda
modulerna, eller om någon lägger in ett `console.log` som kringgår loggmaskeringen.

> **Integrationstesterna tömmer röstlängd, röster, sessioner och revisionslogg.** Kör
> `npm run seed` efteråt för att få tillbaka demodatan.

Enhets- och säkerhetstesterna kräver ingen databas — de hoppar över databasberoende
tester automatiskt om ingen är tillgänglig.

### De sexton testpunkterna

| # | Krav | Var |
|---|---|---|
| 1 | Väljare kan legitimera sig | `unit/bankid.test.ts` |
| 2 | Röstberättigad kan rösta | `integration/voting-flow.test.ts` |
| 3 | Kan inte rösta två gånger | `integration/voting-flow.test.ts` |
| 4 | Icke röstberättigad kan inte rösta | `integration/voting-flow.test.ts` |
| 5 | Token genereras säkert | `unit/token.test.ts` |
| 6 | Token verifierar rätt röst | `integration/voting-flow.test.ts` |
| 7 | Token avslöjar inte väljaren | `integration/voting-flow.test.ts` |
| 8 | Identitet ger inte token | `integration/voting-flow.test.ts`, `security/api-surface.test.ts` |
| 9 | Ingen relation identitet↔röst | `integration/voting-flow.test.ts`, `security/schema-separation.test.ts` |
| 10 | Token hamnar aldrig i loggen | `security/no-token-in-logs.test.ts` |
| 11 | Token visas bara en gång | `security/no-token-in-logs.test.ts` |
| 12 | Verifiering avslöjar inte identitet | `integration/voting-flow.test.ts` |
| 13 | Inga tokenkollisioner | `unit/token.test.ts`, `integration/voting-flow.test.ts` |
| 14 | Partival påverkar inte röstlängden | `integration/voting-flow.test.ts` |
| 15 | Röstlängdstabellen avslöjar ingen röst | `integration/voting-flow.test.ts` |
| 16 | Rösttabellen avslöjar ingen väljare | `integration/voting-flow.test.ts` |

---

## Teknik

Next.js 15 (App Router) · TypeScript · PostgreSQL 17 · Prisma 6 · React 19 · Vitest ·
Docker Compose

Två Prisma-scheman genererar två klienter mot två databaser. Den anonyma röstmodulens
publika kontrakt är:

```ts
castAnonymousVote(input: { partyId: string }): Promise<{ token: string }>
```

Ingen parameter kan bära en identitet, så en utvecklare kan inte skicka med sådant ens av
misstag — kompilatorn stoppar det.

### BankID

`MockBankIdService` implementerar `IBankIdService` och simulerar det riktiga API:ets
flöde (order startas, klienten pollar `collect`). Implementationen väljs på ett enda
ställe, `src/modules/eligibility/bankid/index.ts`. Ett byte till skarp BankID kräver en ny
klass och certifikathantering — ingen annan fil behöver ändras.

### Avvikelse från specifikationen

Specifikationen beskriver `GET /api/verify/{token}` men kräver samtidigt att token aldrig
hamnar i en URL. Kraven är oförenliga: en token i sökvägen skrivs till accessloggar,
proxyloggar och webbläsarhistorik, och följer med i Referer-headern. Verifieringen sker
därför med **POST** och token i begärans kropp. Svarsformatet följer specen exakt:

```json
{ "registered": true, "party": "Exempelpartiet" }
```

---

## Dokumentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — komponenter, dataflöde, modulkontrakt,
  datamodell, testarkitektur
- **[VERIFIABILITY.md](VERIFIABILITY.md)** — oberoende verifierbarhet: blinda
  röstintyg, Merkleåtaganden, automatisk slutkontroll, observatörsgränssnitt och
  vad som fortfarande kräver tillit
- **[SECURITY.md](SECURITY.md)** — hotmodell, anonymitetsmodell, tokendesign,
  metadatarisker, och varför detta inte duger för ett riktigt val

---

## Begränsningar

De tre som betyder mest:

1. **Serverkompromiss bryter anonymiteten.** Båda delarna kör i samma process. Under de
   sekunder en röstning pågår finns identitet och partival i samma minne.
2. **Databasernas transaktionsloggar kan korreleras.** Båda databaserna kör i samma
   PostgreSQL-instans. Den som kommer åt WAL kan para ihop skrivningarna på
   millisekundnivå — trots de avrundade tidsstämplarna i tabellerna.
3. **Token är ett kvitto, och kvitton möjliggör röstköp.** En väljare som kan visa upp
   sin token kan bevisa hur hen röstat. Verifierbarhet och kvittofrihet drar åt olika
   håll, och den här POC:en väljer verifierbarhet utan att lösa konflikten.

Alla tre är beskrivna i [SECURITY.md](SECURITY.md), tillsammans med vad ett riktigt
system skulle göra i stället — bland annat blinda signaturer, som löser både
ordningsproblemet mellan de två databasskrivningarna och kopplingsproblemet på en gång.

Syftet är att visa **en princip**: legitimera väljaren separat, registrera rösten
anonymt, och ge väljaren en engångstoken som låter hen kontrollera sin egen röst.
