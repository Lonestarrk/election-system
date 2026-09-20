# Säkerhets- och anonymitetsmodell

Det här dokumentet beskriver vad systemet skyddar, hur det gör det, och — viktigast —
var skyddet tar slut.

> **Detta är en proof of concept. Den är inte lämplig för ett verkligt val.**
> Skälen står i [sista avsnittet](#varför-detta-inte-duger-för-ett-riktigt-val), och de
> är inte en formalitet.

---

## 1. Vad systemet skyddar

En enda egenskap bär hela konstruktionen:

> Den komponent som vet **"person X har röstat"** kan inte ta reda på
> **"person X röstade på parti Y"**.

Allt annat i dokumentet är antingen ett medel för att uppnå den egenskapen eller en
beskrivning av hur den kan brytas.

### Vad systemet kan svara på

| Fråga | Svar | Var svaret finns |
|---|---|---|
| Är den här personen röstberättigad? | ja/nej | `voters_db` |
| Har den här personen röstat? | ja/nej | `voters_db` |
| Finns det en röst med den här token? | ja/nej + parti | `votes_db` |
| Hur många röster fick varje parti? | antal | `votes_db` |

### Vad systemet inte kan svara på

| Fråga | Varför inte |
|---|---|
| Vilken token hör till person X? | Uppgiften lagras inte, och kan inte härledas |
| Vem äger token T? | Uppgiften lagras inte, och kan inte härledas |
| Vad röstade person X på? | Kräver båda svaren ovan |
| I vilken ordning lades rösterna? | Tidsstämplarna är för grovkorniga, id är slumpade |

Det andra kolumnen säger är inte "vi har stängt av den funktionen". Det är "underlaget
finns inte". Skillnaden är avgörande: en avstängd funktion kan slås på igen.

---

## 2. Hotmodell

### 2.1 Nyfiken administratör

**Angriparen:** har giltiga inloggningsuppgifter till adminvyn och full läsbehörighet
till båda databaserna.

**Vad angriparen vill:** ta reda på hur en namngiven person röstat.

**Vad som stoppar det:** kopplingen finns inte lagrad. Administratören kan se att
person X röstat (via `voter_status`) och se att någon röstat på parti Y (via
`anonymous_vote`), men det finns ingen kolumn, ingen foreign key och ingen gemensam
nyckel som binder de två raderna samman.

Adminvyn har heller ingen sökfunktion — men det är inte det som skyddar. Även med direkt
SQL-åtkomst går frågan inte att formulera.

**Var det brister:** se [4.1 tidskorrelation](#41-tidskorrelation) och
[4.6 databasens egna loggar](#46-databasens-egna-loggar). En administratör med tillgång
till PostgreSQL:s WAL eller serverloggar har ett betydligt starkare läge än en som bara
kan läsa tabellerna.

### 2.2 Databaskompromiss

**Angriparen:** har en fullständig dump av båda databaserna, men inte av
applikationsservern.

**Vad angriparen får:**
- en lista över identitetshashar och vilka som röstat
- en lista över röster med token-hashar och partier

**Vad angriparen inte får:**
- vilka personer hasharna motsvarar (kräver `IDENTITY_PEPPER`, som ligger i
  applikationens konfiguration, inte i databasen)
- vilken röst som hör till vilken person
- några klartext-tokens

**Varför peppret är avgörande:** ett svenskt personnummer har omkring 10<sup>10</sup>
möjliga värden. En ren SHA-256 av röstlängden går att vända på med uttömmande sökning på
en modern GPU inom minuter — den hashade röstlängden vore i praktiken en röstlängd i
klartext. HMAC med ett hemligt pepper gör att angriparen behöver både databasen och
applikationens konfiguration.

**Konsekvens:** databasen och konfigurationen måste ha skilda åtkomstvägar. Ligger de i
samma hemlighetsförråd med samma behörigheter är peppret ingen extra barriär.

### 2.3 Serverkompromiss under pågående val

**Angriparen:** har kodexekvering på applikationsservern medan valet pågår.

**Vad som händer:** anonymiteten bryts för varje röst som läggs därefter.

Detta är POC:ens allvarligaste strukturella svaghet och går inte att åtgärda inom den
här arkitekturen. Under de sekunder en röstning pågår finns både den legitimerade
identiteten och partivalet i samma process minne. En angripare med kodexekvering kan
läsa båda och skriva ned kopplingen.

**Vad som skyddar de redan lagda rösterna:** ingenting i systemet gör det möjligt att i
efterhand rekonstruera kopplingen för röster som redan lagts — den informationen finns
inte längre någonstans.

**Vad ett riktigt system gör i stället:** kör de två delarna som separata tjänster på
separata värdar, under separata driftorganisationer, så att en kompromiss av den ena
inte ger tillgång till den andra. Och använder kryptografiska protokoll (se
[5. blinda signaturer](#5-den-riktiga-lösningen-blinda-signaturer)) som gör att inte ens
den som kontrollerar båda tjänsterna kan återskapa kopplingen.

### 2.4 Nätverksobservatör

**Angriparen:** ser trafiken mellan väljaren och servern, men inte innehållet (TLS).

**Vad angriparen får:** tidpunkten då en viss IP-adress legitimerade sig och lade sin
röst. Kombinerat med tillgång till databasen är det ofta nog för att peka ut vilken röst
som är vems, särskilt vid låg trafik.

**Vad som skyddar:** ingenting i den här POC:en. Det är ett hot mot ett verkligt system
som kräver åtgärder på nätverksnivå (mixnät, konstant trafikprofil, tidsförskjuten
publicering).

### 2.5 Väljaren själv, och röstköp

**Angriparen:** någon som vill köpa röster eller tvinga fram ett visst röstande.

Verifieringstoken är ett **kvitto på hur man röstat**. Det är hela dess syfte — och
samtidigt dess farligaste egenskap. En väljare som kan visa upp sin token kan bevisa hur
hen röstat, vilket gör röstköp och påtryckning möjliga på ett sätt som inte fungerar i
en vallokal.

Detta är en känd och grundläggande konflikt i valforskning: **verifierbarhet och
kvittofrihet drar åt olika håll.** Riktiga verifierbara valsystem löser den med
konstruktioner där väljaren kan övertyga sig själv men inte någon annan — till exempel
genom att kunna skapa ett falskt men trovärdigt kvitto.

Den här POC:en löser det inte. Den demonstrerar den enkla varianten av verifierbarhet,
med den svagheten inbakad.

---

## 3. Tokendesign

### Konstruktion

| Egenskap | Värde |
|---|---|
| Entropikälla | `crypto.randomBytes` (operativsystemets CSPRNG) |
| Storlek | 30 byte = 240 bitar |
| Kodning | Crockford base32, utan I, L, O, U |
| Visningsformat | 6 grupper om 8 tecken |
| Lagring | SHA-256 av normaliserad token, unikt index |
| Klartext lagras | aldrig |
| Klartext visas | exakt en gång, i svaret på röstläggningen |

### Vad token inte innehåller

Token härleds inte från personnummer, väljar-id, sessions-id, tidpunkt, parti, IP-adress
eller löpnummer. Den är 240 slumpbitar och ingenting annat.

Det är inte en detalj. En token som kodade in en tidsstämpel eller ett löpnummer skulle
gå att sortera, och sorteringen skulle motsvara den ordning väljarna legitimerade sig i.
Det ensamt skulle räcka för att återskapa kopplingen mellan väljare och röst — oavsett
hur väl databaserna är separerade.

### Varför SHA-256 och inte Argon2

Långsam lösenordshashning skyddar hemligheter med låg entropi, som lösenord människor
hittat på. En token med 240 slumpbitar har ingen sådan svaghet: uttömmande sökning är
utesluten oavsett hashfunktionens hastighet. Argon2 här skulle bara göra verifieringen
dyrare utan att höja säkerheten.

### Replayskydd

Token är en bärarhemlighet och kan verifieras hur många gånger som helst. Det är
avsiktligt — väljaren ska kunna kontrollera sin röst när som helst.

Token kan däremot inte användas för att *lägga* en röst, ändra en röst eller legitimera
sig. Den är enbart en uppslagsnyckel i verifieringen. Ett "replay" av en token ger därför
ingenting utöver samma svar en gång till.

Röstsessionen har separat replayskydd: den raderas vid röstläggning, och
dubbelröstningsspärren bygger på ett villkorat databasskrivande (se nedan) snarare än på
att sessionen ska vara borta.

---

## 4. Metadatarisker — där anonymiteten faktiskt hotas

Databasseparationen är den lätta delen. Det som i praktiken avanonymiserar väljare är
spåren runtomkring.

### 4.1 Tidskorrelation

**Den allvarligaste risken i hela systemet.**

Om `voter_status.voted_at` och `anonymous_vote.created_at` båda hade
millisekundsupplösning skulle en angripare med båda databaserna kunna para ihop raderna
på tid, rad för rad, med hög träffsäkerhet. Databasseparationen vore då meningslös:
kopplingen skulle ligga i datan, inte i schemat.

**Åtgärder:**
- `anonymous_vote.created_at` avrundas till hel timme
- `voter_status.voted_at` avrundas till dygn
- `audit_event.occurred_at` avrundas till hel timme
- slumpad fördröjning (0–400 ms) mellan de två databasskrivningarna

**Kvarstående brist:** avrundning hjälper bara om det finns många röster per tidsfönster.
Vid ett val med tre röster per timme är timbucketen fortfarande unik nog att peka ut
individen. Skyddet är alltså starkast när det behövs minst.

Ett riktigt system behöver **garanterad anonymitetsmängd**: rösterna köas och skrivs i
blandade satser först när tillräckligt många samlats, eller skickas genom ett mixnät.

### 4.2 Skrivordning

Databasens naturliga radordning speglar i vilken ordning saker hände. Två tabeller
lästa i insättningsordning går att para ihop rad för rad.

**Åtgärder:** primärnycklarna är slumpade UUID:er, inte sekvenser. Demosidan sorterar på
id, inte på insättningsordning. Den slumpade fördröjningen bryter upp den konsekventa
tidsdifferensen mellan de två skrivningarna.

**Kvarstående brist:** den fysiska radordningen i PostgreSQL-heapen speglar fortfarande
insättningsordningen och syns för den som läser filerna direkt eller kör `SELECT` utan
`ORDER BY`.

### 4.3 IP-adresser

En IP-adress plus en tidpunkt är i praktiken en identitet.

**Åtgärder:** IP-adressen används enbart till hastighetsbegränsning. Den hashas innan den
läggs i hastighetsbegränsarens minnesstruktur, lagras aldrig i databasen, loggas aldrig
och skickas aldrig in i den anonyma röstmodulen.

**Kvarstående brist:** webbservern eller lastbalanseraren framför applikationen loggar
med största sannolikhet IP och tidpunkt ändå. Det ligger utanför applikationens kontroll
och måste hanteras i driftmiljön.

### 4.4 Request-id och spårning

Ett gemensamt request-id i loggarna på båda sidor skulle koppla ihop dem lika effektivt
som en foreign key.

**Åtgärder:** inget request-id propageras in i röstmodulen. Modulens publika kontrakt är
`castAnonymousVote({ partyId })` och har ingen parameter som kan bära det.

### 4.5 Applikationsloggar

En enda `console.log(request.body)` under felsökning räcker för att skriva en väljares
token eller personnummer till disk — och därifrån vidare till loggaggregering, backuper
och supportärenden.

**Åtgärder:**
- all loggning går genom `src/lib/logger.ts`, som maskerar token-, personnummer- och
  hashmönster på väg ut
- ett arkitekturtest misslyckas om någon källfil anropar `console.*` direkt
- ett integrationstest kör en fullständig röstning och granskar allt som skrevs till
  konsolen efter spår av token
- den anonyma röstmodulen loggar ingenting alls vid en lyckad röstning — inte ens ett
  "röst registrerad", eftersom en loggrad med millisekundsprecision vore samma
  tidskorrelationsproblem som exakta tidsstämplar i databasen

### 4.6 Databasens egna loggar

Detta är den allvarligaste kvarstående bristen efter tidskorrelationen.

Prismas frågeloggning är avstängd i båda klienterna, men PostgreSQL för sin egen
write-ahead-logg. WAL innehåller varje skrivning med exakt tidpunkt, i exakt ordning.
Den som kommer åt WAL från **båda** databaserna kan korrelera skrivningarna på
millisekundnivå — och då hjälper varken avrundade tidsstämplar i tabellerna eller den
slumpade fördröjningen särskilt mycket.

**Vad som skulle krävas:** de två databaserna måste köras på skilda servrar, under skilda
driftorganisationer, med separat behörighet till loggar och backuper. Att de i POC:en
kör i samma PostgreSQL-instans är en bekvämlighet för demonstrationen och samtidigt den
största avvikelsen från vad modellen egentligen kräver.

### 4.7 Analys, telemetri och felrapportering

En felrapporteringstjänst som får en stacktrace med request-kroppen bifogad kan få både
identitet och röst i samma nyttolast.

**Åtgärder:** systemet har ingen analytics, ingen telemetri och ingen extern
felrapportering. CSP:n sätter `connect-src 'self'`, vilket gör att sidan inte kan skicka
något till en tredje part ens om kod för det smugit sig in.

### 4.8 Sammanställning

| Risk | Hur den skulle avslöja | Vad systemet gör | Räcker det? |
|---|---|---|---|
| Exakta tidsstämplar | Rad matchas mot rad | Dygn / timme | Bara vid hög röstfrekvens |
| Skrivordning | Kronologisk parning | Slumpade UUID, jitter | Delvis |
| IP-adress | IP + tid = identitet | Hashas, lagras aldrig | Ja, i applikationen |
| Request-id | Samma id i båda loggarna | Propageras aldrig | Ja |
| Applikationsloggar | Token i klartext | Maskering + tester | Ja |
| Analys/telemetri | Tredje part får allt | Finns inte, CSP blockerar | Ja |
| Databasens WAL | Millisekundsexakt ordning | Inget | **Nej** |
| Lågt röstantal | Unik tidsbucket | Inget | **Nej** |
| Nätverkstrafik | Tidpunkt per IP | Inget | **Nej** |

---

## 5. Dubbelröstningsspärr och ordningsproblemet

### Spärren

Väljaren markeras som röstande med ett villkorat skrivande:

```sql
UPDATE voter_status SET has_voted = true
WHERE id = $1 AND has_voted = false AND is_eligible = true
```

Uppdateringen körs i en transaktion tillsammans med raderingen av röstsessionen. Om noll
rader påverkades har någon annan redan hunnit före, och röstningen avbryts.

En kontroll av typen "läs `has_voted`, testa i JavaScript, skriv sedan" hade haft ett
kapplöpningsfönster mellan läsning och skrivning där två samtidiga begäranden båda ser
`false`. Det villkorade skrivandet stänger fönstret, eftersom PostgreSQL serialiserar
uppdateringar av samma rad. Det finns ett integrationstest som kör två röstningar
parallellt och verifierar att exakt en går igenom.

### Ordningsproblemet

De två skrivningarna går till **olika databaser** och kan därför inte ingå i samma
transaktion. Något måste ske först, och ingen ordning är utan nackdel:

| Ordning | Vid krasch emellan | Konsekvens |
|---|---|---|
| Rösta först, markera sedan | Röst lagd, väljare omarkerad | **Dubbelröstning** |
| Markera först, rösta sedan | Väljare markerad, ingen röst | **Förlorad röst** |

**Valet: markera först.** En förlorad röst drabbar en enskild väljare och går att
upptäcka. Dubbelröstning angriper valets integritet och är svårare att upptäcka i
efterhand.

Adminvyn visar avvikelsen mellan antal markerade väljare och antal registrerade röster,
just för att en förlorad röst ska bli synlig. Att den siffran är ett aggregat och inte en
lista är avsiktligt: en lista över "vilka röster gick förlorade" skulle vara ett steg
tillbaka mot kopplingen.

### Den riktiga lösningen: blinda signaturer

Problemet är löst i forskningslitteraturen, och lösningen heter blinda signaturer.

Väljaren skapar sin röst lokalt och blindar den kryptografiskt. Röstberättigandetjänsten
signerar den blindade rösten — utan att kunna se innehållet — och markerar väljaren som
röstande. Väljaren avblindar signaturen och lämnar in den signerade rösten till den
anonyma tjänsten, som verifierar signaturen utan att veta vem den tillhör.

Det löser båda problemen på en gång:

- **Ordningen slutar spela roll.** Inlämningen är idempotent och kan göras om, eftersom
  det signerade röstintyget är beviset — inte en databasrad.
- **Kopplingen blir matematiskt omöjlig**, inte bara olagrad. Inte ens den som
  kontrollerar båda tjänsterna kan koppla en avblindad signatur till signeringstillfället.

Detta ligger utanför POC:ens omfattning och är den enskilt största skillnaden mellan
den här demonstrationen och ett system som skulle kunna användas på riktigt.

---

## 6. Vad som lagras och vad som medvetet inte lagras

### `voters_db.voter_status`

| Lagras | Kommentar |
|---|---|
| `id` | Slumpad UUID |
| `external_identity_hash` | HMAC-SHA256(personnummer, pepper) |
| `is_eligible` | |
| `has_voted` | |
| `voted_at` | Dygnsupplösning |

**Lagras inte:** personnummer i klartext, namn, adress, token, token-hash, parti,
röst-id, IP-adress, sessions-id efter röstning.

### `voters_db.voting_session`

Kortlivad (10 min). Innehåller väljar-id och CSRF-hemlighet, aldrig något partival.
**Raderas** vid röstläggning — markeras inte som förbrukad, eftersom en kvarlämnad rad
med sessions-id vore exakt den koppling systemet är byggt för att inte lämna efter sig.

### `voters_db.audit_event`

Endast händelsetyp och timavrundad tidpunkt.

**Lagras inte:** identitet, parti, token, IP, request-id, sessions-id, exakt tidpunkt.

Att händelsetypen inte får innehålla parti är särskilt viktigt: en rad
`VOTE_RECORDED_SD` i röstlängdsdatabasen skulle på egen hand riva hela separationen.

Detta är en medveten avvägning. En revisionslogg detaljerad nog att utreda ett enskilt
fall vore också detaljerad nog att avanonymisera en väljare. Valhemligheten går före
utredningsbarheten.

### `votes_db.anonymous_vote`

| Lagras | Kommentar |
|---|---|
| `id` | Slumpad UUID |
| `token_hash` | SHA-256, unikt index |
| `party_id` | |
| `created_at` | Timupplösning |

**Lagras inte:** identitet, identitetshash, personnummer, väljar-id, sessions-id,
request-id, IP-adress, user agent, klartext-token.

---

## 7. Tekniska skyddsåtgärder

| Område | Åtgärd |
|---|---|
| CSRF | Double-submit mot sessionshemlighet i databasen + Origin-kontroll + `SameSite=Strict` |
| Sessionscookie | `HttpOnly`, `SameSite=Strict`, `Secure` (bakom HTTPS), 10 min TTL |
| Säkerhetsheaders | CSP utan `unsafe-inline` för skript, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` |
| CORS | Endast egen origin, ingen wildcard, preflight från främmande origin avvisas |
| Hastighetsbegränsning | Token bucket per hashad IP, olika gränser per endpoint |
| Indatavalidering | Zod vid varje systemgräns; okända fält plockas bort |
| SQL-injektion | Prisma parametriserar; ingen rå SQL i röstvägen |
| Tidssäker jämförelse | `timingSafeEqual` för CSRF-token och adminlösenord |

**Om CSRF-skyddet:** double-submit kontrolleras mot sessionens hemlighet i databasen, inte
bara mot cookien. En ren double-submit-kontroll kan kringgås av en angripare som kan
sätta cookies på domänen — hen sätter då både cookie och header till samma påhittade
värde. Genom att jämföra mot det databaslagrade värdet stängs den luckan.

**Om `Referrer-Policy: no-referrer`:** utan den skulle en utgående länk kunna läcka att
besökaren kom från kvittosidan.

---

## 8. Varför detta inte duger för ett riktigt val

De tre strukturella bristerna, i ordning:

1. **Serverkompromiss bryter anonymiteten.** Båda delarna kör i samma process. Under de
   sekunder en röstning pågår finns identitet och partival i samma minne.

2. **Databasernas WAL kan korreleras.** Båda databaserna kör i samma PostgreSQL-instans.
   Den som kommer åt transaktionsloggarna kan para ihop skrivningarna på millisekundnivå.

3. **Token är ett kvitto, och kvitton möjliggör röstköp.** Verifierbarhet och
   kvittofrihet drar åt olika håll, och POC:en väljer verifierbarhet utan att lösa
   konflikten.

Utöver det saknas allt det som gör skillnaden mellan en fungerande demonstration och ett
system man kan lita på med ett val:

- oberoende säkerhetsgranskning och penetrationstestning
- formell hotmodellering och kryptografisk verifiering av protokollet
- juridisk analys mot vallagen och dataskyddsregelverk
- tillgänglighetskrav enligt WCAG och praktisk testning med hjälpmedel
- reproducerbara byggen, så att den granskade koden bevisligen är den som kör
- oberoende valmyndigheter med flerpartskontroll, där ingen ensam aktör kan avgöra något
- driftsäkerhet: nyckelhantering, hårdvarusäkerhetsmoduler, separation av driftmiljöer
- offentlig insyn och möjlighet för vem som helst att granska och räkna om
- riktig BankID-integration med certifikathantering och avtal
- beredskap för överbelastningsangrepp och för att valet ska kunna genomföras ändå

Syftet med projektet är att visa **en princip**:

> Legitimera väljaren separat. Registrera rösten anonymt. Ge väljaren en engångstoken som
> låter hen kontrollera sin egen röst.

Principen är sund. Implementationen är en demonstration av principen, inte av ett
valsystem.
