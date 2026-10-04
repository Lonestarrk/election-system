# Digitalt valsystem — proof of concept

Teknisk demonstration av digital röstning i Sverige, byggd enligt modellen med **dubbla
kuvert**, som Estland använder. Väljarens röst är en valsedel krypterad så att ingen enskild kan
öppna den (det inre kuvertet). Väljarens BankID-underskrift över den är det yttre kuvertet. Vid
stängningen kontrolleras de yttre kuverten, kopplingen mellan namn och röst raderas, och bara
summorna öppnas, av två av tre förtroendepersoner.

> **Detta är inte ett valsystem redo för användning.** Det är en demonstration av en
> arkitekturprincip. Se [SECURITY.md](SECURITY.md) för vad som fattas och varför.

**Prova demon:** <https://election-app.politesmoke-5b452a89.swedencentral.azurecontainerapps.io>

Demon körs i Azure i **demoläge**, med en BankID-attrapp, så vem som helst kan legitimera sig som
demopersonerna. Hur den distribueras står i [infra/azure/README.md](infra/azure/README.md).

---

## Idén, och när den gäller

Specen, [docs/spec/2026-09-22-dubbla-kuvert.md](docs/spec/2026-09-22-dubbla-kuvert.md), är
bindande. Den här sidan återger den, och säger emot den ingenstans.

Systemet kan inte hålla löftet att den som vet **"person X har röstat"** aldrig kan ta reda på
**"person X röstade på parti Y"** hela tiden. Vad som gäller beror på fasen:

| När | Vad som gäller |
|---|---|
| **Under röstningen** | Kopplingen finns, och rösten kan ändras. Det är avsikten. Kopplingen finns i `voters_db`, i tabellen `pending_vote`, och rösten i den är ett chiffer som ingen kan läsa utan två av tre andelar av valets nyckel. Det är det som gör att en köpt röst kan ersättas ända fram till stängningen. |
| **Vid stängningen** | Kuverten kontrolleras. Chiffren flyttas till `votes_db`, sorterade på innehåll. Kopplingen raderas i en transaktion, och kuvertroten och urnroten skrivs. |
| **Efter stängningen** | Ingen koppling finns kvar i den levande databasen, utom på en valsedel med så få röster att summan eller markeringarna pekar ut den (spec 10). Bara summorna öppnas, och de publiceras med bevis. Väljaren ser att hon röstat, men inte på vad. |

**Raderingen omfattar inte backuper, läsreplikor och WAL-loggen.** En kopia från före stängningen
har kvar kuverten bredvid namnen, och två andelar öppnar dem då. Det är den huvudsakliga
akademiska invändningen mot Estlands system, och den är verklig. Den står som
`link-exists-during-voting` i [src/lib/known-limitations.ts](src/lib/known-limitations.ts), och i
spec 10.

Valsedeln ligger i en databas (`voters_db`, röstlängden) medan den är ett yttre kuvert, och i en
annan (`votes_db`, urnan) när den är ett inre. De ligger i **olika PostgreSQL-databaser**, och en
foreign key mellan dem är fysiskt omöjlig. Det betyder att en räknad röst inte kan peka på en
väljare, utom på en valsedel med så få röster att summan eller markeringarna pekar ut den (spec 10). Det betyder inte att kopplingen aldrig funnits.

Vad systemet bygger på, från specens avsnitt 3.1:

- **Alla röster är förtidsröster.** Fram till stängningen kan väljaren se, kontrollera och ändra sin
  röst, på enheten hon röstade från.
- **Ingen verifikationskod visas.** En kod på skärmen är det handtag en köpare antecknar.
- **Efter stängningen publiceras bara summorna, med bevis.** Enskilda chiffer och deras hashar
  publiceras aldrig, utom i livevyn på arkitektursidan i demoläget, som med flit visar databasen som en
  insider ser den. Väljaren ser att hon röstat, inte på vad, och markeringen har ingen tidsstämpel.

Hur det hänger ihop beskrivs i [ARCHITECTURE.md](ARCHITECTURE.md), och på `/architecture` i appen för
den som aldrig hört ordet kryptering.

---

## Kom igång

```bash
docker compose up
```

Öppna <http://localhost:3000>.

Uppstarten migrerar båda databaserna, seedar demodata och startar applikationen. Första bygget tar
några minuter. `docker-compose.yml` sätter `DEMO_MODE=true`, och det är bara i demoläget som
uppstarten seedar.

### Sidor

| Sida | Vad den gör |
|---|---|
| `/` | Start |
| `/identify` | BankID-legitimering. I demoläget en panel med demopersoner. |
| `/vote` | Välj omröstning och valsedel, kryptera i webbläsaren, skriv under med BankID. Du ser din nuvarande röst på enheten du röstade från, och kan ändra den fram till stängningen. |
| `/verify` | Efter stängningen: *"Du har röstat"* eller *"Du har inte röstat"* per valsedel, utan tid. Länkar till det publicerade resultatet och säger hur du kontrollerar det. |
| `/admin` | Läget, stängningen, räkningen, slutkontrollen och fastställandet. Du legitimerar dig med BankID som administratör. |
| `/architecture` | Hur modellen fungerar, utan fackord. I demoläget visar den databasernas innehåll och "Följ en röst". |
| `/architecture/technical` | Faserna, kryptografin, databasgränsen, metadatarisker och hela listan över kända begränsningar |
| `/architecture/status` | Vad som är byggt och vad som återstår |

De gamla svenska sökvägarna `/legitimera`, `/rosta`, `/verifiera` och `/demo` omdirigeras till de
nya. Det finns inga tokens och inga kvitton i modellen.

---

## Prova systemet

### 1. Rösta

Gå till `/identify`, välj omröstningen och en demoperson:

| Personnummer | Utfall |
|---|---|
| `19900101-1234`, `19850515-2345`, `19701212-3456`, `19600301-5678`, `19550707-6789`, `19991231-7890` | Röstberättigade, folkbokförda i kommunen. Fyra valsedlar: kommun, region, riksdag och en fråga. |
| `19420404-8901` | Röstberättigad men folkbokförd i en annan kommun och region. Kommun- och regionvalsedlarna gäller inte, så hon får riksdagsvalet och frågan. |
| `20100101-4567` | Ej röstberättigad. Avvisas. |
| `19800101-9876` | Administratör, och röstberättigad. Används för `/admin`. |
| valfritt annat | Finns inte i röstlängden. Avvisas. |

Välj en valsedel, kryssa, och skriv under i BankID-attrappen. Skärmen visar vad du skriver under, och
ingen kod att spara. Det är ett `/sign`-anrop per läggning.

### 2. Ändra din röst

Rösta på samma valsedel igen. Kuvertet ersätts och räknaren i underskriften ökar. Röstsidan visar din
nuvarande röst bara om hashen enheten sparat fortfarande är den som servern håller. Röstar du från en
annan webbläsare ändras rösten, och den första enheten får svaret att rösten ändrats, utan att se
vilken.

### 3. Se kopplingen medan röstningen pågår

Det är modellens pris, och den visas rakt ut. Gå till `/architecture` (i demoläget) eller fråga
databasen, som nedan. Raderna i `pending_vote` bär väljarens id bredvid ett chiffer. Raderna i
`votes_db` är tomma tills omröstningen stängts.

### 4. Stäng omröstningen

Demovalet öppnar vid dygnets början och stänger trettio dygn senare, och stängningen vägrar före
stängningstiden. För att prova den lokalt, flytta stängningstiden i båda databaserna:

```bash
docker exec -it election-postgres psql -U election -d voters_db -c \
  "UPDATE election SET closes_at = now() - interval '1 minute' WHERE name = 'Valet 2026';"
docker exec -it election-postgres psql -U election -d votes_db -c \
  "UPDATE election SET closes_at = now() - interval '1 minute' WHERE name = 'Valet 2026';"
```

Gå sedan till `/admin`, legitimera dig som administratör och gå igenom stegen:

- **Stäng, validera och radera kopplingen.** Valideringen kontrollerar varje kuvert medan kopplingen
  finns, och avbryter utan att radera något om den hittar en allvarlig avvikelse.
- **Räkna.** Två av tre förtroendepersoner lämnar sin lösenfras, och bara summan öppnas. I demoläget
  fyller en knapp i demofraserna, som står i repot och därför inte skyddar något.
- **Slutkontroll och fastställande.**

Efteråt syns resultatet på adminsidan, och det publiceras, med bevis, på
`/api/observer/results?electionId=<id>`. **Återställ demovalet** med knappen på adminsidan för att
börja om.

### 5. Kontrollera resultatet utifrån

```bash
node tools/verify-election.mjs 'http://localhost:3000/api/observer/results?electionId=<omröstningens id>'
node tools/verify-election.mjs resultat.json <omröstningens id>
```

Omröstningens id ger `SELECT id FROM election;` i `votes_db`. Verktyget är fristående, importerar
ingenting ur appen och kräver ingen inloggning. Det kontrollerar förtroendepersonernas bevis, att
Lagrange-kombinationen ger rätt antal, att räkneverken summerar till antalet rader i urnan och att
rötterna har formen av en rot. Utfallet är 0 när allt stämmer, 1 när något inte gör det och 2 när
underlaget inte gick att läsa.

**Verktyget kan inte kontrollera att summan består av exakt de giltiga rösterna.** De enskilda
chiffren publiceras inte, så summan går inte att räkna om. Det vilar på valideringen och
slutkontrollen, som den som driver systemet kör. Det kan inte heller räkna om rötterna, och
varje utskrift säger vad mer det inte kan. Se [VERIFIABILITY.md](VERIFIABILITY.md) avsnitt 5.

### 6. Kontrollera själv, i databasen

```bash
# Röstlängden, medan röstningen pågår: vem som röstat, och vilket chiffer som är hennes.
# Kopplingen finns här med avsikt, men chiffret går inte att läsa.
docker exec -it election-postgres psql -U election -d voters_db -c \
  "SELECT voter_status_id, ballot_id, left(ciphertext_hash, 12) AS hash, cast_sequence, updated_at FROM pending_vote;"

# Efter stängningen: markeringarna "har röstat". Ingen tid, inget chiffer.
docker exec -it election-postgres psql -U election -d voters_db -c "SELECT * FROM voted_marker;"

# Urnan: chiffren. Ingen identitet, ingen tid. Tom tills omröstningen stängts.
docker exec -it election-postgres psql -U election -d votes_db -c \
  "SELECT id, ballot_id, left(ciphertext_hash, 12) AS hash FROM encrypted_vote;"

# Samtliga foreign keys i en databas. Alla pekar inom sin egen databas.
docker exec -it election-postgres psql -U election -d votes_db -c "
  SELECT tc.table_name, ccu.table_name AS refererar
  FROM information_schema.table_constraints tc
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
  WHERE tc.constraint_type = 'FOREIGN KEY';"
```

I `votes_db` finns ingen kolumn för identitet, och ett test (`tests/security/schema-separation.test.ts`)
går rött om någon läggs till. Tidsstämplarna är avrundade: `updated_at` på kuvertet till dygn, och
markeringen "har röstat" har ingen tid alls.

---

## Utveckling utan Docker

Kräver Node 22+ och en PostgreSQL med databaserna `voters_db` och `votes_db`.

```bash
docker compose up -d postgres   # enklaste sättet att få databaserna
cp .env.example .env
npm install                     # genererar Prisma-klienterna via postinstall
npm run migrate                 # migrerar båda databaserna
npm run seed
npm run dev
```

Dev-servern (`npx next dev -H 0.0.0.0 -p 3000`) bygger till `.next-dev`, så ett produktionsbygge
(`npx next build`, som bygger till `.next`) kan köra medan den kör. Bygget skriver om `next-env.d.ts`,
som återställs efteråt med `git checkout -- next-env.d.ts`.

### Skript

| Kommando | Gör |
|---|---|
| `npm run dev` | Utvecklingsserver |
| `npm run build` | Produktionsbygge |
| `npm run generate` | Genererar båda Prisma-klienterna |
| `npm run migrate` | Migrerar båda databaserna |
| `npm run seed` | Lägger in demodata. Vägrar i skarpt läge. |
| `npm run reset:votes` | Nollställer röstdata, sätter fasen till `OPEN` och flyttar fram demovalets tider |
| `npm test` | Hela vitest-sviten |
| `npm run test:unit` | Enhetstester (kräver ingen databas) |
| `npm run test:security` | Arkitektur- och API-ytegranskning |
| `npm run test:integration` | Integrationstester mot riktig databas |
| `npm run test:e2e` | Playwright mot en körande app |
| `npm run verify -- <url eller fil>` | `node tools/verify-election.mjs`, se ovan |
| `npx tsc --noEmit` | Typkontroll, ska ge noll fel |

---

## Tester

```bash
docker compose up -d postgres
npm test
```

Testerna är i tre nivåer:

- **Enhetstester**: kryptot (gruppen, ElGamal, bevisen, tröskeln), BankID-attrappen och klienten,
  XML-signaturens läsare, identitetshashning, urnroten, tidsavrundning, loggmaskering, valideringen
  av indata
- **Integrationstester** mot riktig PostgreSQL: hela kuvertflödet, stängningen och dess faser,
  valideringen, räkningen, slutkontrollen och den oberoende kontrollen, med inspektion av det faktiska
  databastillståndet efteråt
- **Säkerhetstester**: modulgränser, schemaseparation, API-yta, hur läget når rutterna, kända
  begränsningar och arkitektursidans påståenden

De statiska testerna läser källkoden i stället för att köra den. De svarar på en annan fråga än
integrationstesterna: inte "saknas kopplingen just nu?" utan "kan den införas av misstag?". Ett test
misslyckas till exempel om en ny fil börjar importera från båda modulerna, om identitet dyker upp i
`votes_db`, eller om någon lägger in ett `console.log` som kringgår loggmaskeringen.

> **Integrationstesterna kör mot egna databaser, `voters_test` och `votes_test`,** och
> tömmer dem före varje test. Adresserna härleds ur `VOTERS_DATABASE_URL` och
> `VOTES_DATABASE_URL` genom att bara databasnamnet byts ut; sätt
> `TEST_VOTERS_DATABASE_URL` och `TEST_VOTES_DATABASE_URL` för att peka någon annanstans.
> Testhjälparen frågar servern vilken databas den är ansluten till och vägrar tömma en
> vars namn inte slutar på `_test`, så utvecklingsdatabasen och demodatan rörs inte.
> Testdatabaserna skapas och migreras automatiskt före varje körning.

Enhetstesterna och de statiska säkerhetstesterna kräver ingen databas. De databasberoende
testerna hoppas bara över i två lägen: när ingen databasadress är satt alls (ingen `.env`),
eller när `SKIP_DB_TESTS=1` uttryckligen ber om det. Är en adress satt men servern svarar
inte — Docker är stoppat, värden eller porten är fel, en tjänstecontainer i CI har inte
startat — eller går testdatabaserna inte att migrera, fallerar de i stället. En trasig
uppsättning ska inte se ut som en grön körning.

### E2E-tester

Playwright kör mot appen i en riktig webbläsare på <http://localhost:3000>, och använder en
dev-server som redan kör (`E2E_BASE_URL` pekar om den). Det prövar det som ingen annan svit kan: att
krypteringen och bevisen fungerar med BigInt i en riktig webbläsare, mot serverns kontroll.

```bash
docker compose up -d postgres
npm run migrate && npm run seed
npx playwright install chromium
npm run test:e2e
```

> **E2E-sviten nollställer med flit röster och seedar om dev-databasen.** Den testar den körande
> appen, som läser dev-databasen, så testerna röstar på riktigt, och `prisma/reset-votes.ts` och
> `prisma/seed.ts` körs före sviten. Allt du röstat där försvinner. Det är inte testdatabaserna ovan
> som rörs.

---

## Teknik

Next.js 15 (App Router) · TypeScript · PostgreSQL 17 · Prisma 6 · React 19 · Vitest · Playwright ·
Docker Compose. Inga kryptobibliotek: kryptot i `src/lib/crypto` bygger på `BigInt` och `node:crypto`.

Två Prisma-scheman genererar två klienter mot två databaser.

- `prisma/voters/schema.prisma`: röstlängden, det yttre kuvertet (`pending_vote`), markeringen
  (`voted_marker`), sessioner och revisionsloggen
- `prisma/votes/schema.prisma`: urnan, det inre kuvertet (`encrypted_vote`), förtroendepersonernas
  andelar, bidrag och räkneverk

### Läget: demo eller skarpt

Läget sätts med `DEMO_MODE` vid driftsättning och kan inte ändras inifrån appen. **Skarpt läge är
förvalt**: allt utom exakt `DEMO_MODE=true` ger det. Det gäller oavsett `NODE_ENV`, så den publika
demon är ett produktionsbygge i demoläge. Läget skrivs i loggen vid varje start, och adminsidan visar
det.

- **Demoläget** använder BankID-attrappen, så vem som helst kan legitimera sig som en demoperson.
  Demogenvägarna under `/api/demo` finns, och varje sida bär en banderoll. Lokal utveckling och
  testerna körs i demoläget.
- **Skarpt läge** kräver en riktig BankID-klient och en komplett konfiguration, och appen vägrar
  starta med en lista på det som saknas: `COOKIE_SECURE=true`, https i `APP_ORIGIN`, en egen
  `IDENTITY_PEPPER`, `BANKID_ENV`, `BANKID_ROOT_CERTIFICATES`, `BANKID_CERT_PATH` och
  `BANKID_CERT_PASSPHRASE`. Skarpt läge vägrar också attrappens rot, demons kända lösenfraser och
  seedningen.

Varje omröstning bär det läge den skapades i, och läggning, stängning, räkning, publicering och
fastställande vägrar en omröstning i ett annat läge än serverns.

### BankID

Implementationen av `IBankIdService` väljs på ett enda ställe,
`src/modules/eligibility/bankid/index.ts`, efter läget:

- **Demoläget** (`DEMO_MODE=true`) använder `MockBankIdService`, som simulerar flödet och
  utfärdar certifikaten själv.
- **Skarpt läge** använder `BankIdRpClient` mot BankID:s RP API v6.0 (uppgift 17c), med
  ömsesidig TLS. `BANKID_ENV=test` går mot BankID:s testmiljö och `BANKID_ENV=production`
  mot produktionen. Serverroten för varje miljö är förankrad i koden med ett låst
  SHA-256-fingeravtryck, och systemets CA-lager används aldrig.

**Skarpt läge mot BankID:s testmiljö säkrar inte identiteten.** Vem som helst kan skaffa ett test-BankID
med vilket personnummer och namn som helst. Läget finns för att pröva den riktiga klienten, inte för ett
riktigt val, och varje sida bär en banderoll som säger det.

**Produktionen är inte klar.** Skarpt läge med `BANKID_ENV=production` vägrar starta tills läsaren av
BankID:s underskrift har prövats mot en riktig underskrift (kravet `bankid-reader-tested`). Det är
uppgift 17d, och den kräver en människa med test-BankID.

#### Skarpt läge mot BankID:s testmiljö

1. Hämta RP-certifikatet för test. Det committas inte. Skriptet hämtar det från BankID
   och prövar det mot en förankrad SHA-256:

   ```bash
   npx tsx scripts/fetch-bankid-test-cert.ts
   ```

   Filerna hamnar i `certs/bankid-test/`, som är git-ignorerad.
2. Skaffa ett test-BankID. Ett riktigt BankID fungerar inte i testmiljön. Källa:
   developers.bankid.com/test-portal/bankid-for-test, hämtad 2026-10-03.
   - **Android:** avinstallera och installera om BankID-appen, slå på flygplansläge, starta
     appen, gå till Inställningar → Support, håll inne på orden "Error information", skriv
     `kundtest` och tryck OK. Det ska stå CUST vid versionsnumret. Avsluta appen, slå av
     flygplansläget och tvångsavsluta appen.
   - **iOS:** avinstallera och installera om appen, och ange `cavainternal.test.bankid.com` i
     iOS Inställningar → BankID → Developer → Server. Det ska stå CUST vid versionsnumret
     under Inställningar → Support.
   - **Dator:** skapa filen `CavaServerSelector.txt` med ordet `kundtest` i BankID:s
     Config-katalog (`%appdata%\BankID\Config` i Windows).
   - Utfärda sedan ett test-BankID på developers.bankid.com/test-portal/testing, som har
     ersatt demo.bankid.com. Man väljer personnummer och namn. Ta personnummer från
     Skatteverkets testpersonnummer, eftersom andra kan använda samma nummer samtidigt.
   - Appen måste installeras om för att fungera mot produktionen igen.
   - Lägg in test-BankID:ts personnummer i röstlängden för omröstningen.
3. Rötterna för väljarnas certifikat. Kedjan i en underskrift går till BankID:s rot för
   kundcertifikat i testmiljön. BankID lämnar ut den på begäran. Den läggs i en PEM-fil som
   `BANKID_ROOT_CERTIFICATES` pekar ut.
4. Miljövariablerna:

   ```bash
   DEMO_MODE=                     # tom: skarpt läge
   BANKID_ENV=test
   BANKID_CERT_PATH=certs/bankid-test/FPTestcert5_20240610.p12
   BANKID_CERT_PASSPHRASE=qwerty123   # BankID:s publika fras för testcertifikatet
   BANKID_ROOT_CERTIFICATES=/sökväg/till/bankid-test-kundrot.pem
   COOKIE_SECURE=true
   APP_ORIGIN=https://...
   IDENTITY_PEPPER=...            # minst 32 tecken, inte exempelvärdet
   TRUSTED_PROXY_HOPS=1           # bakom en proxy, se SECURITY.md 4.3
   ```

   Appen vägrar starta med en lista på det som saknas. Adminsidan visar då
   "Skarpt läge, BankID testmiljö", och varje sida bär en banderoll som säger att vem som
   helst kan skaffa ett test-BankID för vilket personnummer som helst. Ett val i testmiljön
   är inte ett riktigt val.
5. Det frivilliga provet mot testmiljön startar en legitimering, frågar efter den och
   avbryter den. Det behöver ingen människa och ingår inte i den vanliga sviten:

   ```bash
   BANKID_LIVE_TEST=1 npx vitest run tests/live
   ```

**Läsaren av BankID:s underskrift är inte prövad mot en riktig underskrift.** En sådan kräver
en människa med test-BankID. Med `BANKID_CAPTURE_SIGNATURES_DIR=<absolut katalog utanför repot>` skriver appen varje
underskrift från testmiljön till en egen fil där, men bara i skarpt läge med
`BANKID_ENV=test`, aldrig i produktion, och aldrig till loggen. Skarpt läge med
`BANKID_ENV=production` vägrar starta tills en sådan underskrift har lagts in som testfall
(kravet `bankid-reader-tested`).

### Azure och drift

Demon körs som Container Apps, PostgreSQL och Key Vault i prenumerationen "Election System". Drift
sköts med skillen `azure-drift`, och filerna under `infra/azure/` är Azure-sessionens.

- **`DEMO_MODE=true` krävs** för demon. Utan den startar appen i skarpt läge och dör på de
  ouppfyllda kraven, och uppstarten seedar inte.
- **Efter en driftsättning med nya format** ska demovalet återställas med knappen på adminsidan. Ett
  kuvert som lades före driftsättningen har det gamla formatet, blir `OLD_SIGNATURE_FORMAT`, `OLD_BANKID_FORMAT` eller
  `BAD_SIGNATURE`, och stoppar stängningen. Återställningen raderar kuverten.
- **BankID-hemligheterna för skarpt läge mot testmiljön** (RP-certifikatet, frasen och rotfilen för
  kundcertifikat) ska ligga i Key Vault, och `TRUSTED_PROXY_HOPS` ska vara rätt satt bakom Container
  Apps. Annars får BankID proxyns adress som `endUserIp` i stället för väljarens, och `okand` om
  `X-Forwarded-For` helt saknas, vilket avvisas lokalt.
- **Key Vault skyddar inte mot den som får läsa det**, och inte mot appen, som har hemligheterna i
  minnet. Se `pepper-holder-reads-voter-names` och SECURITY.md avsnitt 9.

---

## Dokumentation

- **[docs/spec/2026-09-22-dubbla-kuvert.md](docs/spec/2026-09-22-dubbla-kuvert.md)** — specen.
  Bindande. Hotmodellen står i avsnitt 10.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — komponenter, dataflöde, faser, datamodell, modulkontrakt
- **[VERIFIABILITY.md](VERIFIABILITY.md)** — den signerade kuvertläggningen, rötterna, slutkontrollen,
  verktyget och vad det inte kan kontrollera
- **[SECURITY.md](SECURITY.md)** — hotmodell, metadatarisker, vad som lagras, läge och drift, och vad
  som saknas utöver kod för ett riktigt val
- **`/architecture`** i appen — samma sak utan fackord, med tekniska detaljer och status på
  undersidor
- **[PLAN.md](PLAN.md)** — den första planen. Den beskriver en tidigare modell och är historisk.

---

## Begränsningar

**Listan står inte här, och det är ett medvetet val.**

Den fanns tidigare i prosa på fyra ställen, och de hann bli olika. Ett löst problem stod kvar som olöst,
och ett påstående som slutat vara sant stod kvar ändå. En demonstration som påstår att systemet är
sämre än det är underminerar tilliten lika säkert som en som påstår motsatsen.

Kända avvikelser finns därför i **`src/lib/known-limitations.ts`**, grundade i spec 10, och de
visas på `/architecture/technical`. Varje post pekar ut en markör i källkoden som är sann så länge
problemet finns kvar. Löser någon problemet failar testet tills posten tagits bort.

| Läs om | I |
|---|---|
| Specen och hotmodellen | [docs/spec/2026-09-22-dubbla-kuvert.md](docs/spec/2026-09-22-dubbla-kuvert.md), avsnitt 10 |
| Var koden avviker från specen | [ARCHITECTURE.md](ARCHITECTURE.md), avsnitt 10 |
| Kopplingen under röstningen, WAL, backuper och nyckelceremoni | [SECURITY.md](SECURITY.md), avsnitt 2 och 4.6 |
| Vad som saknas utöver kod: granskning, juridik, WCAG | [SECURITY.md](SECURITY.md), avsnitt 8 |
| Vad som går att kontrollera utifrån, och vad som inte gör det | [VERIFIABILITY.md](VERIFIABILITY.md), avsnitt 5 och 8 |

---

Syftet är att visa **en princip**: låt väljaren lägga en krypterad röst som hon kan ändra fram till
stängningen, skriv under den med BankID, radera kopplingen vid stängningen och öppna bara summan, med två
av tre förtroendepersoner. Principen är Estlands. Den är svagare på valhemlighet än en konstruktion där
kopplingen aldrig finns, och det är priset för att en köpt röst ska gå att ersätta.
