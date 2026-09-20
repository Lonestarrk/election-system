# Oberoende verifierbarhet

Det här dokumentet beskriver hur systemet kan **visa varför resultatet kan anses
vara korrekt** — inte bara producera ett resultat. Det kompletterar
[SECURITY.md](SECURITY.md), som beskriver anonymitetsmodellen.

Den bärande principen: **det ska inte räcka att lita på att administratören säger
att databasen är korrekt.**

---

## 1. Röstintyg: varför databasflaggor inte räcker

Kravet på oberoende valobservation går inte att uppfylla med en flagga i
databasen. En observatör som inte litar på databasen kan inte verifiera en flagga
i samma databas — "rösten är godkänd" blir då bara ett påstående från den som
kontrollerar servern.

Systemet använder därför **blinda RSA-signaturer**.

### Flödet

1. Väljarens webbläsare skapar ett hemligt röstintyg: 32 slumpbytes.
2. Webbläsaren **blindar** intyget genom att multiplicera in en slumpfaktor som
   aldrig lämnar enheten.
3. Väljaren legitimerar sig. Valmyndigheten markerar att rösträtten är använd på
   valsedeln och signerar det blindade värdet — **utan att se vad den signerar**.
4. Webbläsaren avblindar signaturen. Resultatet är en giltig signatur över
   intyget, utan spår av blindningsfaktorn.
5. Rösten lämnas in anonymt med intyg och signatur. Ingen session, ingen cookie,
   ingen koppling till legitimeringen.

### Obundenheten är starkare än "svår att knäcka"

Blindningsfaktorn *r* är likformigt slumpad, alltså är `r^e mod n` likformigt
fördelad. Det myndigheten ser vid signeringen är därmed **statistiskt oberoende**
av det underliggande intyget.

Det är inte beräkningsmässigt svårt att koppla ihop utfärdande och inlösen — det
är informationsteoretiskt omöjligt.

### Vad intyget uppfyller

| Krav | Hur |
|---|---|
| En röst kan bara skapas genom den auktoriserade processen | Signaturen kan bara skapas med valsedelns privata nyckel |
| Inga röster tillagda utanför processen | En tillagd rad saknar giltig signatur och fångas av slutkontrollen |
| Antalet godkända röstningar motsvarar antalet röster | Utfärdade intyg räknas i röstlängden, inlösta i röstdatabasen |
| En väljare kan rösta en gång | Unikt index på `credential_id` gör inlösen till en engångshändelse |

### Det löser också ordningsproblemet

Tidigare fanns ett fönster mellan de två databasskrivningarna: markera först och
krascha gav en **förlorad röst**, rösta först och krascha gav **dubbelröstning**.
Ingen ordning var utan nackdel, och en transaktion över två separata
PostgreSQL-databaser är fysiskt omöjlig.

Med röstintyg försvinner fönstret:

- **Utfärdandet** — markering plus signering — sker i *en* transaktion, eftersom
  båda rör samma databas.
- **Inlösen** är idempotent. Samma intyg kan bara lösas in en gång, oavsett när
  eller hur många gånger det försöks.

En avbruten röstning kan därför göras om utan risk. Ett utfärdat men aldrig
inlöst intyg är inte en tyst förlust: det syns som en avvikelse i slutkontrollen.

### Nyckelpar per valsedel

Myndigheten signerar blint och ser inte vilken valsedel intyget gäller.
Bindningen måste därför komma från **vilken nyckel som signerade**: ett intyg för
kommunvalsedeln verifierar inte mot riksdagsvalsedelns publika nyckel.

Utan det skulle en väljare kunna begära tre intyg och lösa in alla tre på samma
valsedel.

### Kända begränsningar

**Blindningen körs i webbläsaren, men koden kommer från servern.** En server som
levererar en manipulerad `blind-client.ts` till en utvald väljare skulle kunna
lägga tillbaka kopplingen. Det är ett välkänt problem för all webbaserad
kryptografi. Motmedlen — signerade klientpaket, reproducerbara byggen, oberoende
granskning av det levererade — ligger utanför den här POC:en.

**Rå RSA med full-domain hashing via MGF1.** Korrekt och välkänt, men ett
produktionssystem ska använda [RFC 9474 (RSA-BSSA)](https://www.rfc-editor.org/rfc/rfc9474.html),
som är standardiserad och granskad.

**Den privata nyckeln ligger i röstlängdsdatabasen.** Läcker den kan vem som
helst skapa intyg som ser auktoriserade ut. Den angriper valets *riktighet*, till
skillnad från `IDENTITY_PEPPER` som bär *valhemligheten*. Ett riktigt system
skulle förvara den i en HSM och kräva flerpartskontroll.

---

## 2. Manipulationsskydd: Merkleträd, inte hashkedja

### Konflikten

Den självklara lösningen på "röster får inte ändras utan att det upptäcks" är en
hashkedja där varje röst pekar på den föregående. **Den går inte att använda
här.**

En kedja kräver ett löpnummer, och ett löpnummer *är* en ordning. Hela skälet
till att rösternas tidsstämpel avrundas till timme är att de inte ska gå att
sortera i samma följd som väljarna legitimerade sig — kan man det räcker båda
databaserna för att para ihop väljare med röst.

En kedja i insättningsordning skulle alltså **riva ned tidsskyddet för att bygga
upp manipulationsskyddet**.

### Lösningen

Ett Merkleträd vars löv sorteras på **sitt eget hashvärde**, inte på när de
skrevs. Trädet ser likadant ut oavsett i vilken ordning rösterna kom in och
avslöjar därför ingenting om tid — samtidigt som roten ändras om en enda röst
ändras, läggs till eller tas bort.

Tre detaljer stänger varsin känd attack:

- **Skilda prefix för löv och interna noder.** Utan dem kan en intern nod
  presenteras som ett löv och ett falskt bevis konstrueras.
- **Domänseparerad rot som binder in antalet löv.** Utan det blir roten för ett
  träd med ett enda löv identisk med lövet självt. *Den här svagheten hittades av
  ett test under utvecklingen.*
- **Udda noder lyfts upp, dubbleras inte.** Att hasha en nod med sig själv öppnar
  för att två olika mängder röster ger samma rot.

### Åtaganden

Ett **åtagande** är Merkleroten plus antalet röster, publicerat vid en tidpunkt.
Den som publicerat en rot har bundit sig vid exakt den mängden röster.

Åtagandena bildar en kedja där varje åtagande hashar in det föregående, så att
historiken inte går att skriva om i efterhand.

Här är ordningen oproblematisk: åtagandena är få, publicerade och innehåller inga
röster. Det är rösterna som inte får gå att ordna, inte åtagandena om dem.

> **Åtaganden måste publiceras externt för att ha fullt bevisvärde.** En rot som
> bara finns i samma databas som den skyddar kan skrivas om tillsammans med
> rösterna. Var de publiceras ligger utanför POC:en, men observatörs-API:t är
> byggt så att vem som helst kan hämta och spara dem löpande.

### Revisionsloggen

Revisionsloggen har en egen hashkedja med löpnummer. **Där är en ordning ofarlig**,
till skillnad från bland rösterna: att para ihop de två sidorna kräver ordning på
*båda*, och rösterna har ingen.

Kedjan upptäcker borttagna rader (hål i löpnumren), ändrade rader (hashen stämmer
inte) och omskriven historik (pekaren bakåt stämmer inte). Den upptäcker **inte**
att någon med skrivrättigheter räknar om hela kedjan — mot det hjälper bara att
kedjans spets publiceras löpande.

---

## 3. Den automatiska slutkontrollen

Nio kontroller, åtta kritiska:

| # | Kontroll | Allvar |
|---|---|---|
| 1 | Motsvarar varje godkänd röstning exakt en registrerad röst? | Kritisk |
| 2 | Har varje röst skapats genom den auktoriserade processen? | Kritisk |
| 3 | Har något röstintyg lösts in mer än en gång? | Kritisk |
| 4 | Har någon röst ändrats sedan det senaste åtagandet? | Kritisk |
| 5 | Är åtagandekedjan obruten? | Kritisk |
| 6 | Är revisionsloggen obruten? | Kritisk |
| 7 | Stämmer sammanräkningen med röstunderlaget? | Kritisk |
| 8 | Är omröstningen stängd? | Kritisk |
| 9 | Finns utfärdade intyg som aldrig lösts in? | Varning |

Alla kontroller körs alltid. En som avbryter vid första felet skulle dölja att
det finns fler, och den som granskar behöver se hela bilden innan hen bedömer om
det rör sig om ett fel eller ett angrepp.

**Kontroll 2 är den enda som inte kan förfalskas inifrån.** De övriga jämför
siffror i databaser, som den med skrivrättigheter kan ändra. Kontroll 2
verifierar en kryptografisk signatur — och samma kontroll kan köras av vem som
helst med den publika nyckeln.

**Kontroll 7 räknar om resultatet från rådata** i stället för att lita på den
aggregering som adminvyn visar.

### Varför kontroll 9 bara är en varning

Ett utfärdat men aldrig inlöst intyg betyder oftast att någon avbröt mitt i. Det
är normalt och ska inte hindra ett val från att fastställas.

Men det är också vad en förlorad röst ser ut som, och skillnaden går inte att
avgöra maskinellt — systemet kan inte veta om väljaren ändrade sig eller om något
gick sönder. Antalet redovisas därför tydligt i stället för att döljas, så att den
som granskar kan bedöma om det är rimligt.

Kontroll 1 är ändå kritisk och fångar varje differens. Kontroll 9 skiljer ut
vilken *sorts* differens det rör sig om.

---

## 4. Administratörens slutverifiering

Administratören ska **inte** bara kunna klicka fram ett resultat och godkänna det.

`POST /api/admin/elections/check` kör slutkontrollen och returnerar hela
rapporten: varje kontroll med sin fråga i klartext, sitt utfall och sin
förklaring. Administratören ser alltså före fastställandet om allt är godkänt, vad
som fallerat, vilka avvikelser som finns och om resultatet får fastställas alls.

### Spärren kan inte kringgås

`POST /api/admin/elections/certify` tar emot **ett** fält: vilken omröstning det
gäller.

- Ingen force-parameter.
- Ingen lista över kontroller att hoppa över.
- Ingen väg att skicka med en egen rapport — kontrollen körs om på servern.

Fallerar något kritiskt sätts omröstningen i `UNDER_REVIEW`. Det tillståndet går
**inte** att lämna via applikationen; en knapp som markerar ett avvikande val som
utrett vore samma spärr med ett extra klick.

Vid godkänt publiceras ett sista åtagande **före** fastställandet, så att det
fastställda resultatet knyts till exakt det röstunderlag som granskades.

---

## 5. Vad observatören kan kontrollera

`POST /api/observer/election` och `POST /api/observer/votes` är öppna utan
inloggning.

### Vad som lämnas ut

- **Valsedlarnas publika nycklar** — för att verifiera varje rösts intyg.
- **Antalet godkända röstningar per valsedel** — ur röstlängden, som rena antal.
- **Åtagandekedjan** — för att avgöra om något ändrats sedan ett tidigare
  åtagande.
- **Hela röstunderlaget** — varje röst med intyg, signatur och val.
- **Det sammanräknade resultatet** — att jämföra mot en egen omräkning.

### Verifieringskedjan

> en legitim röstning genomfördes → exakt en anonym röst skapades →
> rösten finns kvar → rösten räknades korrekt

1. Verifiera varje `credentialSignature` mot valsedelns `signingPublicKeyPem`.
2. Kontrollera att varje `credentialId` förekommer exakt en gång.
3. Räkna om Merkleroten och jämför med sparade åtaganden.
4. Räkna rösterna per alternativ och jämför med det redovisade resultatet, samt
   antalet röster per valsedel med antalet godkända röstningar.

### Varför det inte hotar valhemligheten

- `credentialId` valdes av väljaren själv och blindades innan det signerades.
  Myndigheten har aldrig sett värdet och kan inte känna igen det. **Kopplingen
  finns inte lagrad någonstans — den existerar inte.**
- `tokenHash` är en hash av väljarens kvitto. Bara den som har kvittot kan matcha
  det, och kvittot finns bara hos väljaren.
- Ingen tidsstämpel ingår, och listan sorteras på innehåll. Rösterna går alltså
  inte att ordna i tid och kan inte korreleras mot legitimeringstidpunkter.

Att publicera underlaget är därför inte en eftergift åt granskningen på
valhemlighetens bekostnad. Det är **möjligt just därför** att underlaget inte bär
någon identitet.

**Vad observatören aldrig får:** någon uppgift om vem som röstat.

---

## 6. Väljarens egen verifiering

Den token-baserade verifieringen är oförändrad. Efter röstningen kan väljaren
använda sin token för att kontrollera att rösten är registrerad.

- Verifieringen avslöjar ingenting om väljarens identitet.
- Token skapar ingen koppling mellan väljaren och röstregistret: bara hashen
  lagras, och klartexten finns enbart hos väljaren.
- Svaret innehåller ingen tidsstämpel och inget löpnummer, så den som samlat in
  flera kvitton kan inte ordna rösterna i tid.

**En token per valsedel.** Väljaren i ett riksdagsval får tre kvittokoder. En
gemensam token skulle binda ihop kommun-, landstings- och riksdagsrösten till en
profil, och en kombination av tre partival är betydligt mer identifierande än
något enskilt av dem.

---

## 7. Nya avvägningar som infördes

### Omröstnings-id är en delad identifierare

Omröstningen och dess valsedlar finns i **båda** databaserna med samma UUID. En
foreign key mellan två PostgreSQL-databaser är fysiskt omöjlig, och alternativet
skulle kräva att den ena sidan kan läsa den andra.

Med en enda omröstning ändrar det ingenting. Med flera partitioneras rösterna och
anonymitetsmängden krymper per omröstning. För en valsedel med få röstande är det
en verklig försämring som måste vägas in när omröstningar utformas.

### Sessionen lever över flera valsedlar

I ett riksdagsval fyller väljaren tre valsedlar under samma session. Fönstret där
identitet och pågående röstning finns samtidigt är därför längre än tidigare.

Alternativet — en ny BankID-legitimering per valsedel — skulle korta fönstret men
kräva tre signeringar per väljare. Livslängden på tio minuter är oförändrad.

Notera att **själva röstläggningen ligger utanför sessionen** sedan röstintygen
infördes. Sessionen behövs bara för att hämta intyg.

### Push-notiser utan identitet

Prenumerationer lagras utan koppling till någon väljare: ingen foreign key, inget
identitetshash, ingen inloggning för att prenumerera.

En push-endpoint är i praktiken en enhetsidentifierare. Låg den bredvid ett
identitetshash skulle en databasdump avslöja vilken telefon som hör till vilken
person.

Priset är att notiser går till alla prenumeranter, även icke röstberättigade. Det
är accepterat: meddelandet säger bara att en omröstning öppnat, vilket är
offentlig information ändå.

---

## 8. Vad som fortfarande kräver tillit

Ärlighet om gränserna hör till konstruktionen. Följande är **inte** löst:

| Problem | Varför det kvarstår |
|---|---|
| Klientkoden levereras av servern | En riktad, manipulerad version kan lägga tillbaka kopplingen väljare–röst |
| Åtaganden publiceras bara internt | En rot i samma databas som den skyddar kan skrivas om med rösterna |
| Signeringsnyckeln ligger i databasen | Ingen HSM, ingen flerpartskontroll |
| En ensam administratör | Att skapa eller fastställa en omröstning borde kräva flera personer |
| Serverkompromiss under röstning | Identitet och intygsutfärdande passerar samma process |
| Ingen garanterad anonymitetsmängd | Vid låg röstfrekvens räcker inte slumpfördröjningen |

Se [SECURITY.md](SECURITY.md) för den fullständiga hotmodellen.
