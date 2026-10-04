# Säkerhets- och anonymitetsmodell

Det här dokumentet beskriver vad systemet skyddar, hur det gör det, och viktigast, var
skyddet tar slut. Specen, [docs/spec/2026-09-22-dubbla-kuvert.md](docs/spec/2026-09-22-dubbla-kuvert.md),
är bindande, och hotmodellen i dess avsnitt 10 är den som gäller. Säger det här dokumentet
emot den är det dokumentet som har fel.

> **Detta är en proof of concept. Den är inte lämplig för ett verkligt val.**
> Skälen står i [sista avsnittet](#8-varför-detta-inte-duger-för-ett-riktigt-val), och de är
> inte en formalitet.

> **Se även [VERIFIABILITY.md](VERIFIABILITY.md)** för vad som går att kontrollera utifrån och
> vad som inte gör det, och [ARCHITECTURE.md](ARCHITECTURE.md) för konstruktionen.

---

## 1. Vad systemet skyddar

Systemet bygger på dubbla kuvert. Det inre kuvertet är en valsedel krypterad med ElGamal under
valets tröskelnyckel. Det yttre är väljarens BankID-underskrift över det inre. Vid stängningen
valideras de yttre kuverten, kopplingen mellan namn och röst raderas, och bara summorna
dekrypteras, av två av tre förtroendepersoner.

Egenskapen som bär konstruktionen **ändras med fasen**, och det är det viktigaste att förstå:

| När | Vad systemet vet | Vad som skyddar valhemligheten |
|---|---|---|
| **Medan röstningen pågår** | Att väljare X har röstat, och vilket chiffer som är hennes. Kopplingen finns i `voters_db`, med avsikt: det är den som låter väljaren ändra sig och gör att en köpt röst kan ersättas. | Att chiffret inte går att läsa utan två av tre andelar av valets nyckel. Ingenting annat. |
| **Vid stängningen** | Chiffren flyttas till `votes_db`, kopplingen raderas och kuvertroten och urnroten skrivs. | Raderingen, som sker i en transaktion i röstlängden. |
| **Efter stängningen** | Att väljare X har röstat (markeringen), men inte vilket chiffer som var hennes. | Att kopplingen är raderad ur den levande databasen, och att chiffren bara öppnas som en summa. |

Raderingen omfattar inte backuper, läsreplikor och WAL-loggen. En kopia från före
stängningen har kvar kuverten bredvid namnen, och två andelar öppnar dem då, kuvert för
kuvert. Det är den huvudsakliga akademiska invändningen mot Estlands system (spec 10), och
den är verklig.

### Vad systemet kan svara på

| Fråga | Svar | Var svaret finns |
|---|---|---|
| Är den här personen röstberättigad? | ja/nej | `voters_db` |
| Har den här personen röstat? | ja/nej, medan röstningen pågår ur kuvertet och efter stängningen ur markeringen | `voters_db` |
| Vilket chiffer är den här personens röst? | Medan röstningen pågår: ja, men det går inte att läsa. Efter stängningen: nej, i den levande databasen. | `voters_db`, `pending_vote` |
| Hur många röster fick varje alternativ? | antal, efter stängningen och räkningen | `votes_db` |
| Har den här enheten fortfarande rösten den lade? | lika, olika eller ingen röst | `/api/vote/compare` |

### Vad systemet inte kan svara på

| Fråga | Varför inte |
|---|---|
| Vad röstade person X på, efter stängningen? | Kopplingen är raderad ur den levande databasen, och enskilda röster dekrypteras aldrig. |
| Vilken rad i urnan är väljare X:s? | Raden bär ingen identitet, och en markering har ingen koppling till en rad. |
| I vilken ordning lades kuverten? | Urnans rader har ett id räknat ur innehållet och ett löpnummer bland likadana, ingen tidsstämpel, och infogas sorterade på innehåll. |
| Visa en utomstående vad jag röstade. | Slumptalet kastas, och ingenting publiceras per röst. |

Det andra kolumnen säger är inte "vi har stängt av funktionen" utan "underlaget finns inte".
Skillnaden är avgörande: en avstängd funktion kan slås på igen. Underlaget finns dock inte
**i den levande databasen efter stängningen**, och kolumnen gäller inte den som har en kopia
från före stängningen eller som har BankID:s order (avsnitt 2.2 och 2.7).

---

## 2. Hotmodell

### 2.1 Nyfiken administratör eller databasläsare

**Angriparen:** har giltiga inloggningsuppgifter till adminvyn och full läsbehörighet till
båda databaserna.

**Vad angriparen vill:** ta reda på hur en namngiven person röstat.

**Medan röstningen pågår:** kopplingen finns i `pending_vote`, så angriparen ser att person X
röstat, vilket chiffer som är hennes och hur många gånger hon ändrat sig. Chiffret går inte att
läsa utan två andelar. Andelarna ligger krypterade i `votes_db`, och varje andel är låst med en
lösenfras som förtroendepersonen sätter och som aldrig lagras. Den som bara läser databaserna
ser därför ingenting om valet. **I demon skyddar fraserna ingenting**, eftersom de står i repot
(spec 4.5).

**Efter stängningen:** angriparen ser att person X har röstat (markeringen), och vad som röstats
(summorna). Det finns ingen kolumn, ingen foreign key och ingen gemensam nyckel som binder en
rad i urnan till en väljare.

**Var det brister:** se [4.1 tidskorrelation](#41-tidskorrelation) och
[4.6 databasens egna loggar](#46-databasens-egna-loggar). En administratör med tillgång till
PostgreSQL:s WAL eller en backup från före stängningen har ett betydligt starkare läge än en som
bara kan läsa tabellerna.

### 2.2 Databaskompromiss

**Angriparen:** har en fullständig dump av båda databaserna, men inte av applikationsservern.

**Vad angriparen får:**

- en dump från **före stängningen**: identitetshashar, kuvert bredvid väljare, certifikatkedjor
  (förseglade, se nedan), krypterade andelar
- en dump från **efter stängningen**: identitetshashar, markeringar, urnan och räkneverken

**Vad angriparen inte får:**

- vilka personer hashen motsvarar, utan `IDENTITY_PEPPER`, som ligger i applikationens
  konfiguration och inte i databasen
- namn och personnummer ur certifikatkedjorna, utan pepparn, eftersom kedjan är förseglad med
  AES-256-GCM under en nyckel härledd ur den
- vilket val ett chiffer innehåller, utan två andelar och deras fraser

**Det angriparen får om hen dessutom har två andelar och deras fraser:** varje kuvert i dumpen
öppnas. Från före stängningen står kuverten bredvid namnen. Det är begränsningen
`link-exists-during-voting` (spec 10), och den raderas inte av att kopplingen raderas i den
levande databasen. I Azure sparas databasernas automatiska säkerhetskopior i sju dagar.

**Varför pepparn är avgörande:** ett svenskt personnummer har omkring 4·10<sup>7</sup>
realistiska värden. En ren SHA-256 av röstlängden vore en röstlängd i klartext. Identitetshashen
är scrypt (16 MiB per försök, uppmätt 37 ms) med pepparn som salt. Med pepparn kostar en
uttömmande sökning omkring 17 processordygn, och arbetet går att dela upp. Pepparn är alltså
det faktiska skyddet och inte hashfunktionens parametrar. En riktad kontroll av en enda person
kostar ett anrop.

**Konsekvens:** databasen och konfigurationen måste ha skilda åtkomstvägar. Ligger de i samma
hemlighetsförråd med samma behörigheter är pepparn ingen extra barriär. Se avsnitt 9.

### 2.3 Serverkompromiss

**Angriparen:** har kodexekvering på applikationsservern.

Det här är den hotbild där modellen är svagast, och den går inte att åtgärda inom den här
arkitekturen:

- **Under röstningen** ser angriparen varje legitimering: personnumret och namnet i BankID:s
  svar, och väljarens session. BankID:s svar, med certifikatkedjan i klartext, hålls i
  processminnet i upp till tre minuter när verifieringskön är full (`order-state-per-process`).
- Angriparen har pepparn i minnet, och kan öppna kedjorna och räkna om identitetshashar.
- Appen har uppgifter till båda databaserna. En komprometterad app når båda.
- Vid räkningsceremonin låser servern upp en förtroendepersons andel med hennes fras i minnet.
  En angripare som tagit sig in vid ceremonin kan fånga både andel och fras. Med två andelar
  går varje chiffer i urnan att öppna, inte bara summan, och en säkerhetskopia från före
  stängningen har då namnen bredvid (`server-sees-trustee-share`). I ett riktigt val räknar
  förtroendepersonen på sin egen enhet.
- Angriparen kan leverera manipulerad klientkod till en utvald väljare (`client-code-from-server`).

**Vad som skyddar de redan räknade rösterna efter stängningen i den levande databasen:** kopplingen
är raderad, och enskilda röster dekrypteras aldrig. Det skyddar inte mot en kopia från före
stängningen.

**Vad ett riktigt system gör i stället:** kör delarna på separata värdar under separata
driftorganisationer, och låter förtroendepersonerna räkna på egna enheter.

### 2.4 Nätverksobservatör

**Angriparen:** ser trafiken mellan väljaren och servern, men inte innehållet (TLS).

**Vad angriparen får:** tidpunkten då en viss IP-adress legitimerade sig och lade sin röst.
Kombinerat med tillgång till databasen är det ofta nog för att peka ut vilken röst som är vems
medan kopplingen finns, och efter stängningen särskilt vid låg trafik.

**Vad som skyddar:** ingenting i den här POC:en. Det är ett hot mot ett verkligt system som kräver
åtgärder på nätverksnivå.

### 2.5 Väljaren själv, och röstköp

**Angriparen:** någon som vill köpa röster eller tvinga fram ett visst röstande.

Konstruktionen finns för det här hotet, och dess försvar är avgränsade:

- Väljaren kan **ändra sin röst ända fram till stängningen**, så en köpare som betalar i förväg
  kan inte veta att rösten gäller.
- Det enheten visar är **inget kvitto**. Klienten kastar slumptalet, så väljaren kan inte bevisa
  vad chiffret innehåller, och hon kan skriva om det enheten visar. Ingen verifikationskod
  visas.
- **Efter stängningen publiceras bara summorna.** Enskilda chiffer och deras hashar publiceras
  aldrig, så ingenting en väljare eller köpare håller går att matcha mot.

Det som kvarstår, ur spec 10:

- **Tvång vid själva slutet.** En tvingare som ser väljaren lägga rösten strax före stängningen
  vet att den gäller. Estland lägger till att en pappersröst upphäver den digitala, vilket ligger
  utanför specen.
- **En manipulerad klient** kan behålla slumptalet och göra det enheten visar till ett bevis. Se
  `client-code-from-server`.
- **En valsedel med mycket få röster** avslöjar dem genom summan. Med en enda röst är den
  publicerade summan exakt den röstens chiffer.
- **En kopia av någon annans valsedel räknas.** Att avvisa kopior vore ett orakel som en köpare
  kunde fråga, så de räknas. Den som har en annans chiffer och får många att lägga kopior kan
  förskjuta summan.

### 2.6 Den som driver systemet

**Angriparen:** driftar appen och databaserna, med skrivrättighet i röstlängden.

BankID-signaturen och kedjan mot BankID:s rot stoppar en förfalskad ny röst. De stoppar inte att
den som driver systemet **tar bort ett äkta kuvert, eller lägger tillbaka en väljares tidigare
äkta kuvert** med dess räknare, som ligger i samma databas (`operator-can-remove-or-restore-envelope`).
Väljaren kan upptäcka det före stängningen på enheten hon röstade från. Efter stängningen syns
ett borttaget kuvert men inte ett återlagt äldre. Den som kan skriva i röstdatabasen kan stoppa
räkningen, och den som kan skriva i båda kan få en annan urna räknad
(`votes-db-writer-can-swap-ciphertext`). **I demon utfärdar attrappen certifikaten själv,** så
där stoppar signaturen ingenting mot den som driver demon.

### 2.7 BankID och identitetens källa

BankID vet vem som röstade, på vilken valsedel, när och hur många gånger. Åtagandet i
underskriften har ett salt som raderas med kuvertet, så BankID:s kopia går inte att matcha mot en
rad i urnan efter stängningen. Men på en valsedel med så få röster att summan visar dem ger
BankID:s kopia tillsammans med den publicerade summan väljarens röst (`bankid-knows-who-voted`).

**Skarpt läge mot BankID:s testmiljö säkrar inte identiteten.** Vem som helst kan skaffa ett
test-BankID med vilket personnummer och namn som helst. Läget finns för att pröva den riktiga
klienten och är inte ett riktigt val. Det visas med en banderoll på varje sida.

---

## 3. Kryptografin och vad den kräver

### Valsedeln

Valsedelns alternativ numreras kanoniskt: index 0 är blankt, sedan partierna, sedan
kandidaterna. På en fråga i en allmän omröstning följer svarsalternativen på blankt. Väljarens
val är en vektor med en etta och resten nollor, och varje komponent krypteras för sig (ElGamal,
spec 4.2 och 4.3). Servern kräver ett bevis att varje komponent är 0 eller 1 och att alla
tillsammans summerar till 1, med stark Fiat–Shamir som binder valets id, valsedelns id, valets
publika nyckel och hela chifferlistan (spec 4.4).

### Strikt tolkning

**Varje mottaget tal tolkas strikt**, med `parseScalar` och `parseElement` i
`src/lib/crypto/group.ts`: bara siffror, kanoniskt, högst 617 siffror, svar och utmaningar under
`q`, gruppelement under `p` och i undergruppen. Skälet är konkret. Uppgift 14b:s granskning fann
att en negativ exponent räknades som 1 och att en förfalskad valsedel med +1000 och −999 då
godkändes, och att fyra tal förlängda med `k·q` låste händelseslingan i över fem sekunder.

### Tröskelnyckeln

Nyckeln delas med Shamirs delning, `n = 3` och `k = 2`. Den genereras av en **betrodd utdelare**
vid valets skapande, och den hela nyckeln raderas efter delningen, men den finns på ett ställe
under ett ögonblick (`trusted-dealer`). Alla tre fraser skickas dessutom i samma begäran från
administratören vid skapandet. Varje andel krypteras med scrypt av förtroendepersonens fras, som
aldrig lagras. Skarpt läge vägrar de kända demofraserna.

### Chifferhashen

Hashen över valsedelns kanoniska chifferlista används för att enheten ska kunna fråga om rösten
fortfarande ligger kvar, och för urnans id och urnroten. Hon ser den aldrig, och den publiceras
aldrig. Jämförelsen går bara åt ett håll: enheten skickar sin hash och får *lika*, *olika* eller
*ingen röst*, aldrig serverns hash. Annars skulle en enhet få veta hashen för en röst som lagts
från en annan enhet, alltså den som räknas, och den pekar tillsammans med läsrätt i `votes_db`
ut rätt rad efter stängningen. Jämförelsen är ändå ett orakel för den som har chiffret, och har
därför en egen rutt, en egen hastighetsgräns och en fråga per valsedel.

---

## 4. Metadatarisker, där anonymiteten faktiskt hotas

Databasseparationen är den lätta delen. Det som i praktiken avanonymiserar väljare är spåren
runtomkring.

### 4.1 Tidskorrelation

**Den allvarligaste metadatarisken.**

Om kuvertets och urnans tidsstämplar hade millisekundsupplösning skulle en angripare med båda
databaserna kunna para ihop rader på tid. Därför:

- `pending_vote.updated_at` avrundas till dygn
- `audit_event.occurred_at` avrundas till hel timme
- markeringen "har röstat" har ingen tidskolumn
- urnans rader har ingen tidsstämpel, ett id räknat ur innehållet och en insättning sorterad på
  innehåll

**Kvarstående brist:** avrundning hjälper bara om det finns många kuvert per tidsfönster. Med få
röster per dygn är dygnet unikt nog. Och under röstningen finns kopplingen ändå i `pending_vote`.
Skyddet är starkast när det behövs minst. Någon slumpad fördröjning mellan skrivningarna, som den gamla
modellen hade, finns inte längre och behövs inte: stängningen infogar alla chiffer i en sats, sorterade på innehåll, och
anonymitetsmängden är hela valet.

### 4.2 Skrivordning

Databasens naturliga radordning speglar i vilken ordning saker hände. Primärnycklarna är slumpade
UUID:er, och urnans id räknas ur innehållet. Stängningen infogar raderna sorterade på innehåll.

**Kvarstående brist:** den fysiska radordningen i PostgreSQL-heapen och WAL-loggen speglar
insättningsordningen, och den syns för den som läser filerna direkt. Se 4.6.

### 4.3 IP-adresser och `TRUSTED_PROXY_HOPS`

En IP-adress plus en tidpunkt är i praktiken en identitet.

**Åtgärder:** IP-adressen används till hastighetsbegränsning. Den hashas innan den läggs i
hastighetsbegränsarens minnesstruktur, lagras aldrig i databasen, loggas aldrig och skickas
aldrig in i urnans modul. Till BankID skickas den som `endUserIp`, eftersom BankID kräver den.

**`TRUSTED_PROXY_HOPS` bestämmer om `X-Forwarded-For` tros.** Rubriken kan klienten sätta själv,
så den läses bara när en proxy vi litar på har skrivit den.

| Värde | Följd |
|---|---|
| osatt eller `0` | Ingen proxy. Appen nås direkt. Middleware tar bort rubriken klienten skickat, och anslutningens egen adress används. |
| `n` ≥ 1 | `n` betrodda proxyer, som var och en lägger till adressen den ser. Adressen som används är den `n`:te från slutet. |

Två fel går att göra, och de felar åt olika håll:

- **Bakom en proxy utan variabeln** delar alla besökare proxyns adress, och därmed en gräns. Det
  felar åt det stränga hållet och syns genast. Med BankID i skarpt läge blir dessutom `endUserIp`
  proxyns adress eller `okand`, och ett värde som inte är en IP-adress avvisas lokalt.
- **Med variabeln satt för högt** tros poster som klienten själv skrivit, och en klient kan välja
  sin egen adress, en ny för varje begäran, och ta sig förbi varje hastighetsgräns. Det felar åt
  det farliga hållet och syns inte. Proxyn måste dessutom lägga till adressen den ser, som nginx
  `$proxy_add_x_forwarded_for`, och appen får inte gå att nå förbi den.

Se `src/lib/client-address.ts` och `.env.example`.

**Kvarstående brist:** webbservern eller lastbalanseraren framför appen loggar med största
sannolikhet IP och tidpunkt ändå. Det ligger utanför applikationens kontroll.

### 4.4 Request-id och spårning

Ett gemensamt request-id i loggarna på båda sidor skulle koppla ihop dem lika effektivt som en
foreign key. Inget request-id propageras in i urnans modul, och urnans modul har inget kontrakt
som tar emot en röst utifrån. Rader i urnan skrivs av skalningen, som läser chiffret och inte
väljaren.

### 4.5 Applikationsloggar

En enda `console.log(request.body)` under felsökning räcker för att skriva en väljares
personnummer till disk, och därifrån vidare till loggaggregering och backuper.

**Åtgärder:**

- all loggning går genom `src/lib/logger.ts`, som maskerar personnummer- och hashmönster
- ett arkitekturtest misslyckas om någon källfil anropar `console.*` direkt
- ett test kör ett kuvertflöde och granskar vad som skrevs till konsolen
- urnans modul loggar ingenting alls vid en lyckad läggning, eftersom en loggrad med
  millisekundsprecision vore samma tidskorrelationsproblem som en exakt tidsstämpel

Seedningen skriver i demoläget ut de tre demofraserna vid varje start. I Azure hamnar de i Log Analytics.

### 4.6 Databasens egna loggar

Detta är den allvarligaste kvarstående bristen efter tidskorrelationen.

Prismas frågeloggning är avstängd i båda klienterna, men PostgreSQL för sin egen
write-ahead-logg. WAL innehåller varje skrivning med exakt tidpunkt, i exakt ordning, **och
kuverten bredvid namnen så länge `pending_vote` fanns.** Raderingen vid stängningen tar inte bort
det som redan skrivits i WAL, i backuper eller på en läsreplika. Den som kommer åt dem har
kopplingen, och kan öppna kuverten med två andelar.

**Vad som skulle krävas:** de två databaserna på skilda servrar, under skilda driftorganisationer,
med separat behörighet till loggar och backuper. Att de i POC:en kör i samma PostgreSQL-instans är
en bekvämlighet för demonstrationen, och den största avvikelsen från vad modellen egentligen kräver.

### 4.7 Analys, telemetri och felrapportering

En felrapporteringstjänst som får en stacktrace med request-kroppen bifogad kan få både identitet
och chiffer i samma nyttolast.

**Åtgärder:** systemet har ingen analytics, ingen telemetri och ingen extern felrapportering.
CSP:n sätter `connect-src 'self'`, vilket gör att sidan inte kan skicka något till en tredje part
ens om kod för det smugit sig in.

### 4.8 Sammanställning

| Risk | Hur den skulle avslöja | Vad systemet gör | Räcker det? |
|---|---|---|---|
| Exakta tidsstämplar | Rad matchas mot rad | Dygn, timme, ingen tid på markeringen | Bara vid hög röstfrekvens |
| Skrivordning | Kronologisk parning | Slumpade id, innehållssorterad infogning | I tabellerna, inte i WAL |
| IP-adress | IP + tid = identitet | Hashas, lagras aldrig | Ja, i applikationen |
| Request-id | Samma id i båda loggarna | Propageras aldrig | Ja |
| Applikationsloggar | Personnummer i klartext | Maskering + tester | Ja |
| Analys/telemetri | Tredje part får allt | Finns inte, CSP blockerar | Ja |
| Databasens WAL och backuper | Kuverten bredvid namnen, med exakt ordning | Inget | **Nej** |
| Lågt röstantal | Unik tidsbucket, och en summa som visar rösten | Inget | **Nej** |
| Nätverkstrafik | Tidpunkt per IP | Inget | **Nej** |

---

## 5. Stängningen och ordningsproblemet

Den gamla konstruktionen hade ett ordningsproblem mellan två databasskrivningar: markera väljaren
först och förlora en röst vid en krasch, eller rösta först och riskera en dubbelröst. Det problemet
finns inte längre, eftersom kuvertet och väljaren ligger i samma databas, i samma rad.

Det som i stället skriver över gränsen är **stängningen**, som flyttar chiffren från röstlängden till
röstdatabasen. En transaktion över två databaser är fysiskt omöjlig, så idempotensen och faserna bär:

- **Urnans rader nycklas per kuvert**, med ett id räknat ur chifferhashen, valsedeln och ett
  löpnummer bland likadana. En avbruten stängning kan köras om utan dubbletter.
- **Faserna är enkelriktade tillstånd** (`OPEN`, `CLOSED`, `VALIDATED`, `STRIPPED`, `TALLIED`,
  `CERTIFIED`), med övergångar som jämför och sätter. Bara en stängning kör åt gången, med ett
  advisory lock.
- **Valideringen är en spärr.** Hittar den en allvarlig avvikelse avbryts stängningen och ingenting
  raderas.
- **Varje flyttat chiffer läses tillbaka** och jämförs byte för byte, och antalet prövas före COMMIT.
- **Skalningen är en transaktion** i röstlängden: `STRIPPED`, kuvertroten, urnroten, markeringarna
  och raderingen av `pending_vote`.
- **Slutkontrollen vägrar fastställa** så länge ett enda kuvert ligger kvar.

**Dubbelröstning** förhindras av det unika indexet på `(voter_status_id, ballot_id)`, och av att
läggningen prövar fasen och räknaren i en egen transaktion mot en rad som stängningen måste vänta
på. En röst som tas emot räknas alltså alltid, och annars får väljaren ett fel.

---

## 6. Vad som lagras och vad som medvetet inte lagras

### `voters_db.voter_status`

| Lagras | Kommentar |
|---|---|
| `id` | Slumpad UUID |
| `external_identity_hash` | scrypt(personnummer, pepper) |
| `is_eligible`, `is_admin` | |
| `municipality_code`, `region_code` | Bredvid identitetshashen, se `municipality-beside-identity-hash` |

**Lagras inte:** personnummer i klartext, namn, adress.

### `voters_db.pending_vote`, det yttre kuvertet

Chiffer, bevis, chifferhash, räknaren, BankID-signaturen och certifikatkedjan, båda förseglade med
AES-256-GCM, saltet i åtagandet och `updated_at` med dygnsupplösning. Raden ersätts när väljaren
ändrar sig och raderas vid stängningen. Kedjan innehåller namn och personnummer i klartext inuti
förseglingen, och den som har pepparn kan öppna den (`pepper-holder-reads-voter-names`).

**Lagras inte:** klartext till något chiffer, slumptalet.

### `voters_db.voted_marker`

En rad per väljare och valsedel som röstat, skriven vid skalningen ur de kuvert som raderas. **Ingen
tidskolumn** och inget id som går att ordna efter läggningen.

### `voters_db.voting_session`

Kortlivad (10 minuter). Innehåller väljar-id, omröstnings-id och CSRF-hemlighet, aldrig ett val.
Sessionen har en exakt utgångstid, och den raderas när den går ut eller när väljaren legitimerar sig på
nytt. Den bär identitet och finns i röstlängden, inte i urnan.

### `voters_db.audit_event`

Händelsetyp, timavrundad tidpunkt, löpnummer och kedjans hashar, och i posten `LINK_CLEARED`
urnroten. **Lagras inte:** identitet, val, IP, request-id, sessions-id. En revisionslogg detaljerad nog
att utreda ett enskilt fall vore också detaljerad nog att avanonymisera en väljare, så valhemligheten
går före utredningsbarheten.

### `votes_db.encrypted_vote`, det inre kuvertet

| Lagras | Kommentar |
|---|---|
| `id` | 128 bitar ur SHA-256 över chifferhashen, valsedeln och ett löpnummer |
| `ballot_id` | |
| `ciphertext`, `proofs` | |
| `ciphertext_hash` | Inte unik, eftersom en kopia räknas |

**Lagras inte:** identitet, identitetshash, väljar-id, sessions-id, request-id, IP-adress, tidsstämpel.

Dessutom finns förtroendepersonernas andelar, bidrag och räkneverk, och inget av det är per röst.

---

## 7. Tekniska skyddsåtgärder

| Område | Åtgärd |
|---|---|
| CSRF | Double-submit mot sessionshemlighet i databasen + Origin-kontroll + `SameSite=Strict` |
| Sessionscookie | `HttpOnly`, `SameSite=Strict`, `Secure` (när `COOKIE_SECURE=true`), tio minuter |
| Säkerhetsheaders | CSP med nonce per begäran och utan `unsafe-inline` för skript, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` |
| CORS | Endast egen origin, ingen wildcard |
| Hastighetsbegränsning | Token bucket per hashad IP, olika gränser per rutt, och `TRUSTED_PROXY_HOPS` (4.3) |
| Indatavalidering | Zod vid varje gräns, okända fält plockas bort. Tal i kryptot tolkas strikt (avsnitt 3). Kropparna begränsas till 2 MiB, och administratörens skapande till 8 MiB. |
| Underskriftens källa | Signatur och kedja läses ur BankID:s eget svar, aldrig ur klientens begäran |
| SQL-injektion | Prisma parametriserar |
| Tidssäker jämförelse | `timingSafeEqual` för CSRF-token |
| Identitetshashning | scrypt, minneshård, genom en antagningskö på åtta samtidiga |

**Om CSRF-skyddet:** double-submit kontrolleras mot sessionens hemlighet i databasen, inte bara mot
cookien. En ren double-submit-kontroll kan kringgås av en angripare som kan sätta cookies på domänen.

**Om `Referrer-Policy: no-referrer`:** utan den skulle en utgående länk kunna läcka att besökaren
kom från en viss sida.

---

## 8. Varför detta inte duger för ett riktigt val

### Kodnivån: se den enda källan

De strukturella bristerna i koden **listas inte här**, och det är ett medvetet val. Listan stod
tidigare i prosa på tre ställen, och de hann bli olika. Ett löst problem stod kvar som olöst, och ett
påstående som slutat vara sant stod kvar ändå. **En demonstration som påstår att systemet är sämre
än det är underminerar tilliten lika säkert som en som påstår motsatsen.**

Avvikelserna finns i `src/lib/known-limitations.ts`, grundade i spec 10, och de visas på
`/architecture/technical`. Varje post pekar ut en markör i källkoden som är sann så länge problemet
finns kvar. Löser någon problemet försvinner markören, testet failar, och bygget står still tills
posten tagits bort.

Se [ARCHITECTURE.md avsnitt 10](ARCHITECTURE.md) för hur listan hänger ihop med specen, och skillnaden
mellan en **bugg** (åtgärdbar) och en **teoretisk gräns** (klientkoden levereras av servern, vilket
bara går att flytta).

Avvägningar som följer med flera valsedlar och omröstningar, som omröstnings-id som delad
identifierare, sessionen över flera valsedlar och push-prenumerationer, står i
[VERIFIABILITY.md avsnitt 7](VERIFIABILITY.md).

### Två brister som inte syns i koden

**Databasernas WAL och backuper omfattar kuverten bredvid namnen.** Båda databaserna kör i samma
PostgreSQL-instans. Den som kommer åt transaktionsloggarna eller en säkerhetskopia från före
stängningen har kopplingen, och raderingen vid stängningen når den inte. Separata instanser med
separata driftansvariga är det enda som stänger det, och det är en driftsfråga och inte en kodfråga.

**Nyckelceremonin.** Utdelaren som genererade valets nyckel kunde ha behållit en kopia, och
administratören som skapade omröstningen har sett alla tre fraser. Svaret för ett riktigt val är
distribuerad nyckelgenerering, där ingen någonsin håller hela nyckeln, och fraser som varje
förtroendeperson sätter själv.

### Vad som saknas utöver kod

Det här är skillnaden mellan en fungerande demonstration och ett system man kan lita på med ett val.
Inget av det går att programmera sig till:

- oberoende säkerhetsgranskning och penetrationstestning
- formell hotmodellering och kryptografisk verifiering av protokollet
- juridisk analys mot vallagen och dataskyddsregelverk
- tillgänglighetskrav enligt WCAG och praktisk testning med hjälpmedel
- reproducerbara byggen, så att den granskade koden bevisligen är den som kör
- oberoende valmyndigheter med flerpartskontroll, där ingen ensam aktör kan avgöra något
- driftsäkerhet: nyckelhantering, hårdvarusäkerhetsmoduler, separation av driftmiljöer
- offentlig insyn och möjlighet för vem som helst att granska
- riktig BankID-integration med avtal, certifikathantering och bevakade utgångsdatum, och en riktig
  underskrift från BankID som testfall för läsaren (uppgift 17d)
- beredskap för överbelastningsangrepp och för att valet ska kunna genomföras ändå

### Vad projektet visar

> Låt väljaren lägga en krypterad röst som hon kan ändra. Skriv under den med BankID. Radera
> kopplingen vid stängningen och öppna bara summan, med två av tre förtroendepersoner. Publicera
> summan med bevis.

Principen är Estlands, och den är sund, men den är svagare på valhemlighet än den föregående, eftersom
kopplingen finns medan röstningen pågår. Implementationen är en demonstration av principen, inte av
ett valsystem.

---

## 9. Läge och drift

Läget sätts vid driftsättning med `DEMO_MODE`, och kan inte ändras inifrån appen. **Skarpt läge är
förvalt.** Se [ARCHITECTURE.md avsnitt 12](ARCHITECTURE.md) och README.

### Demon i Azure

Demon är ett produktionsbygge i **demoläge**. `DEMO_MODE=true` krävs. Utan den startar appen i skarpt
läge och dör på de ouppfyllda kraven, och entrypoint seedar inte. Efter en driftsättning med nya
format, till exempel av kuvertets signatur, ska demovalet **återställas med knappen på adminsidan**,
eftersom ett kuvert som lades före driftsättningen annars blir `OLD_SIGNATURE_FORMAT` och stoppar
stängningen. Filerna under `infra/azure/` och skillen `azure-drift` sköter driften.

### Hemligheter i Key Vault

I Azure ligger hemligheterna i Key Vault. För skarpt läge mot BankID:s testmiljö (uppgift 17c) ska
RP-certifikatet för testmiljön, `BANKID_CERT_PASSPHRASE` och rotfilen för `BANKID_ROOT_CERTIFICATES`
ligga där. Den publika frasen `qwerty123` hör till testcertifikatet, och ska ligga där
produktionens kommer att ligga.

Valvet håller hemligheterna utanför repot, imagen och databaserna. Det skyddar inte mot den som får
läsa det, och inte mot appen, som har dem i minnet. Appens identitet har läsrätt i hela valvet, vilket
omfattar Postgres-administratörens lösenord. Valvet är mjukvaruskyddat, och granskningslogg och
rensningsskydd är inte påslagna (spec 10). Förtroendepersonernas andelar ligger med avsikt inte i
valvet, utan låsta med fraserna i röstdatabasen.

Containern måste också nå BankID:s testmiljö på `appapi2.test.bankid.com:443`, och
`TRUSTED_PROXY_HOPS` måste vara rätt satt bakom Container Apps (4.3).
