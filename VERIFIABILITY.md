# Verifierbarhet

Det här dokumentet beskriver hur systemet kan **visa varför resultatet kan anses vara
korrekt**, inte bara producera ett resultat, och var den möjligheten tar slut. Det
kompletterar [SECURITY.md](SECURITY.md), som beskriver anonymitetsmodellen. Specen,
[docs/spec/2026-09-22-dubbla-kuvert.md](docs/spec/2026-09-22-dubbla-kuvert.md), är
bindande, och avsnitt 3.1 i den sätter gränsen för allt nedan.

Den bärande principen: **det ska inte räcka att lita på att administratören säger att
databasen är korrekt.** Principen når inte hela vägen, och det här dokumentet försöker säga
var.

## Beslutet som styr allt: kontroll före stängningen, bara summor efter

Spec 3.1 är ett beslut med ett pris:

- **Före stängningen** kan väljaren se, kontrollera och ändra sin röst, på enheten hon röstade
  från.
- **Efter stängningen** publiceras bara summorna, med bevis. Enskilda chiffer och deras
  hashar publiceras aldrig, eftersom allt som publiceras per röst är ett handtag en köpare
  kan matcha mot. Väljaren ser att hon röstat, inte vad.
- **Ingen verifikationskod visas.** En kod på skärmen är just det handtag en köpare antecknar.

Priset är den universella verifierbarheten röst för röst. Allmänheten kan kontrollera att
resultatet är en korrekt dekryptering av den publicerade summan. Att summan består av exakt
de giltiga rösterna kan allmänheten inte räkna om.

---

## 1. Den signerade kuvertläggningen: varför databasflaggor inte räcker

Kravet på oberoende granskning går inte att uppfylla med en flagga i databasen. En
observatör som inte litar på databasen kan inte verifiera en flagga i samma databas, och
"rösten är godkänd" blir då bara ett påstående från den som kontrollerar servern.

Systemet använder därför **väljarens egen BankID-signatur** över sitt kuvert. Det är inte
ett röstintyg: ingenting delas ut i förväg, och inget intyg bärs över någon gräns. Det är
en signerad kuvertläggning.

### Flödet

1. Väljarens webbläsare krypterar valsedeln (ElGamal, en etta och resten nollor) och bevisar
   att den har rätt form. Slumptalet kastas.
2. Servern kontrollerar formen och räknar fram räknaren `castSequence` själv. Den skapar ett
   salt och bygger åtagandet över chifferhashen och saltet.
3. Väljaren skriver under i BankID. Appen visar valets namn och valsedelns slag. Det
   signerade bär `valsystem/kuvert/v2 | electionId | ballotId | åtagande | castSequence`.
4. Servern hämtar signaturen och certifikatkedjan ur BankID:s eget svar, aldrig ur
   begäran, och kontrollerar bevisen, kedjan mot BankID:s rot, signaturen, att personnumret
   i certifikatet är väljarens och att räknaren är högre än den lagrade.
5. Kuvertet läggs i `pending_vote`, och ersätter väljarens tidigare kuvert för valsedeln.

### Vad signaturen uppfyller

| Krav | Hur |
|---|---|
| En röst kan inte förfalskas av en klient | Den bär väljarens BankID-signatur, med en kedja till BankID:s rot |
| Ett äkta kuverts innehåll kan inte manipuleras obemärkt | Åtagandet över chifferhashen ligger i det signerade |
| Ett äldre kuvert kan inte spelas upp igen av den som fångat det | `castSequence` ligger inuti det signerade, och servern kräver en högre räknare |
| En väljare har högst ett kuvert per valsedel | Unikt index på `(voter_status_id, ballot_id)` |
| En annan väljares äkta underskrift kan inte läggas i fel rad | Personnumret i certifikatet hashas och ska vara radens |

### Vad den inte uppfyller

- **Den som driver systemet kan ta bort ett äkta kuvert, eller lägga tillbaka en väljares
  tidigare äkta kuvert med dess räknare.** Räknaren lagras i samma databas som kuvertet.
  Väljaren kan upptäcka det före stängningen på enheten hon röstade från, där jämförelsen
  svarar *olika* eller *ingen röst*. Efter stängningen syns bara ett borttaget kuvert, genom
  att markeringen "har röstat" saknas. Ett återlagt äldre kuvert syns inte, och den som kan
  skriva i röstlängden kan skriva eller radera en markering.
- **Ett spärrat BankID-certifikat godkänns**, eftersom ingen spärrkontroll görs.
- **I demon utfärdar attrappen certifikaten själv**, så den som driver demon kan förfalska
  en underskrift. Skyddet gäller med riktig BankID.
- **Läsaren av BankID:s XML-signatur är inte prövad mot en riktig underskrift från BankID.**
  Ett antagande som inte håller får varje riktig röst att avvisas, men aldrig en falsk röst
  att godtas.

De exakta avgränsningarna står i spec 4.6 och 10 och i `src/lib/known-limitations.ts`.

### Kuvertroten är ett åtagande, inte ett inklusionsbevis

Innan kuverten skalas räknas en **kuvertrot**, en Merklerot över alla yttre kuvert, och
den skrivs i röstlängden och i revisionskedjan innan signaturerna raderas. Bladet är
`hashLeaf("<chifferhash>|<salt>|<signatur>")`. Saltet står i bladet, eftersom BankID har
varje signatur och urnans hashar annars hade räckt för att pröva sig fram till roten på en
valsedel med få röster.

**Roten är inte ett inklusionsbevis.** Ingen inklusionsväg lagras, inga syskonhashar
sparas, och efter skalningen är signaturerna borta, så ingen utomstående kan räkna om
roten. Den är ett åtagande över mängden kuvert, publicerat före raderingen: vi kan inte
senare påstå att andra kuvert fanns. Ett bevis som väljaren kan visa upp efter stängningen
vore samma handtag som spec 3.1 tar bort, så det ska inte finnas.

### Validering medan kopplingen finns

Det finns ett enda ögonblick då varje kuvert går att knyta till en väljare: strax före
skalningen. Valideringen (`src/orchestration/validate-before-close.usecase.ts`) använder det,
och prövar för varje kuvert:

- BankID-signaturen, kedjan mot roten och personnumret, och att den synliga texten är den
  appen visade
- att räknaren i signaturen är den lagrade
- att valsedeln gäller väljaren: rätt kommun och region
- att varje valsedels bevis håller
- att högst ett kuvert finns per väljare och valsedel

Avvikelser får en kod, som `BAD_SIGNATURE`, `STALE_SEQUENCE`, `WRONG_BALLOT`, `BAD_PROOF`
eller `OLD_PROOF_FORMAT`, och vilken väljare det gäller går att utreda. Valideringen
kontrollerar inte väljarens nuvarande röstberättigande, eftersom rösten var legitim när den
lades (spec 7.4). Den är en **spärr**: hittar den något allvarligt avbryts stängningen och
ingenting raderas. Det som publiceras är antal, kategorier och utfall, aldrig vilka väljare
det gällde.

Valideringen och slutkontrollen körs av den som driver systemet. Det är därför "summan består
av exakt de giltiga rösterna" vilar på dem och inte kan räknas om av allmänheten.

---

## 2. Manipulationsskydd: hashträd, inte hashkedja

### Konflikten

Den självklara lösningen på "röster får inte ändras utan att det upptäcks" är en hashkedja
där varje rad pekar på den föregående. **Den går inte att använda här.** En kedja kräver ett
löpnummer, och ett löpnummer *är* en ordning. Hela skälet till att tidsstämplarna är grova är
att kuverten inte ska gå att sortera i samma följd som väljarna röstade. En kedja i
insättningsordning hade rivit ned tidsskyddet för att bygga upp manipulationsskyddet.

### Lösningen

Ett hashträd vars löv sorteras på **sitt eget hashvärde** och inte på när de skrevs. Trädet
ser likadant ut oavsett i vilken ordning kuverten kom in, och avslöjar därför ingenting om
tid, samtidigt som roten ändras om ett enda kuvert ändras, läggs till eller tas bort.

Tre detaljer stänger varsin känd attack:

- **Skilda prefix för löv och interna noder.** Utan dem kan en intern nod presenteras som ett
  löv.
- **Domänseparerad rot som binder in antalet löv.** Utan det blir roten för ett träd med ett
  enda löv identisk med lövet självt. *Den svagheten hittades av ett test under utvecklingen.*
- **Udda noder lyfts upp, dubbleras inte.** Att hasha en nod med sig själv låter två olika
  mängder ge samma rot.

### Två rötter

- **Kuvertroten** binder de yttre kuverten (avsnitt 1).
- **Urnroten** binder de inre. Stängningen räknar den över exakt de rader den infogar i
  `votes_db`, och skriver den i röstlängden i samma sats som `STRIPPED`, och i posten
  `LINK_CLEARED` i revisionskedjan. Bladet är SHA-256 över `valsystem/urnrot/v1|<valsedelns
  id>|<H>`, där H är chifferhashen räknad ur chiffret, och valsedelns id står i bladet, så
  att en rad inte kan flyttas mellan två valsedlar. Räkningen räknar om den ur urnan före
  frasen, före varje bidrag och före kombinationen, och slutkontrollen gör det igen.

Urnroten finns för att kuvertroten inte går att räkna om efter skalningen. Den som kan skriva
i `votes_db` kan inte längre byta ut, lägga till, ta bort eller flytta en rad obemärkt, men
kan stoppa räkningen.

**Vad rötterna inte skyddar mot:**

- Den som kan skriva i **båda** databaserna kan skriva om roten i omröstningens rad. Då
  öppnar dekrypteringen den urna som lagts dit, och slutkontrollen märker det först efteråt,
  och bara om inte revisionskedjan också räknas om.
- Båda rötterna publiceras av systemet självt. Att en granskare sparar dem under röstningen
  och jämför är en rutin systemet inte kan genomdriva, och en rot som skrevs om före den
  första hämtningen syns inte.
- Urnroten binder chiffret men inte bevisen. Bevisen prövar slutkontrollen, rad för rad.

### Revisionsloggen

Revisionsloggen har en egen hashkedja med löpnummer. **Där är en ordning ofarlig**, till
skillnad från bland kuverten: att para ihop de två sidorna kräver ordning på *båda*, och
urnans rader har ingen. Loggen innehåller händelsetyp, timavrundad tidpunkt och kedjans
hashar, och i posten `LINK_CLEARED` urnroten. Ingen identitet och inget val.

Kedjan upptäcker borttagna rader (hål i löpnumren), ändrade rader (hashen stämmer inte) och
omskriven historik (pekaren bakåt stämmer inte). Den upptäcker **inte** att någon med
skrivrättigheter räknar om hela kedjan. Systemet publicerar inte kedjans spets, så mot det
hjälper bara att en granskare sparar den själv.

---

## 3. Den automatiska slutkontrollen

Nio kontroller, i `src/orchestration/final-check.usecase.ts`:

| Kontroll | Frågar |
|---|---|
| `election_tallied` | Står omröstningen i fasen `TALLIED`, så att resultatet får fastställas? |
| `link_cleared` | Är kopplingen raderad ur röstlängden och kuvertroten skriven? |
| `urn_matches_markers` | Har urnan lika många rader som markeringar "har röstat", på varje valsedel? |
| `urn_root_matches` | Är urnan exakt de rader skalningen flyttade, enligt urnroten? |
| `every_vote_verifies` | Är varje rad i urnan en valsedel med exakt ett val, med bevis som håller? |
| `partial_decryptions_verify` | Håller varje förtroendepersons bidrag mot hennes publika andel och valsedelns summa? |
| `tally_matches` | Stämmer de sparade räkneverken med urnan och bidragen? |
| `audit_chain_intact` | Är revisionsloggen obruten? |
| `not_under_review` | Saknas en markering om avvikelse från en tidigare slutkontroll? |

Alla körs alltid. En som avbryter vid första felet skulle dölja att det finns fler, och den
som granskar behöver se hela bilden innan hen bedömer om det är ett fel eller ett angrepp.
En kontroll är **kritisk** när underlaget inte stämmer, och en **förutsättning** när något bara
inte är klart än, till exempel att skalningen inte har körts.

**Kontrollerna jämför siffror och bevis i databaser som den med skrivrättigheter kan ändra.**
De som verifierar kryptografi, `every_vote_verifies` och `partial_decryptions_verify`, kan
köras om av vem som helst som har underlaget, men underlaget är urnan, och den publiceras
inte (spec 3.1). Utanför systemet går därför bara bidragens bevis att kontrollera, med
verktyget i avsnitt 5.

I den gamla modellen fanns kontroller för röstintyg, åtagandekedjan och utfärdade intyg som
aldrig lösts in. De är borttagna eller omskrivna, och `WHAT_BECAME_OF_THE_OLD_CHECKS` i filen
säger vad som hände med var och en. Skälet var att de passerade på noll mot noll för ett val i
den nya modellen.

---

## 4. Administratörens slutverifiering

Administratören ska **inte** bara kunna klicka fram ett resultat och godkänna det.

`POST /api/admin/elections/check` kör slutkontrollen och returnerar hela rapporten: varje
kontroll med sin fråga i klartext, sitt utfall och sin förklaring.

### Spärren kan inte kringgås

`POST /api/admin/elections/certify` tar emot **ett** fält: vilken omröstning det gäller.

- Ingen force-parameter.
- Ingen lista över kontroller att hoppa över.
- Ingen väg att skicka med en egen rapport. Kontrollen körs om på servern.

Fallerar något kritiskt sätts omröstningen i `UNDER_REVIEW`. Det tillståndet går **inte** att
lämna via applikationen, eftersom en knapp som markerar ett avvikande val som utrett vore
samma spärr med ett extra klick. Att omröstningen inte är räknad än är däremot inte en
avvikelse, bara för tidigt, och sätter inte `UNDER_REVIEW`. Annars hade ett klick en dag för
tidigt gjort valet omöjligt att fastställa.

Vid godkänt går fasen till `CERTIFIED`, och en revisionshändelse skrivs. Händelsetypen
bär BankID-miljön (`ELECTION_CERTIFIED` i demoläget, och `_BANKID_TEST` eller
`_BANKID_PRODUCTION` i skarpt läge), så ett val som fastställts mot testmiljön går att
skilja från ett mot produktionen.

**Fastställandet gör en administratör ensam.** Att öppna resultatet kräver två av tre
förtroendepersoner, men att skapa och fastställa omröstningen gör det inte. Se `single-
administrator` i `src/lib/known-limitations.ts`.

---

## 5. Vad en utomstående kan kontrollera

### Medan röstningen pågår

`POST /api/observer/election` är öppen utan inloggning. Utan omröstning ger den listan. Med
en omröstning ger den:

- **fasen**, och **valdeltagandet** per valsedel: hur många som röstat. Det är det enda som
  publiceras medan röstningen pågår, och det räknas ur röstlängden, utan dekryptering
- **kuvertroten, urnroten och summan av markeringarna**, från skalningen. De visas före
  räkningen, så att den som vill kan spara dem och jämföra med publiceringen efteråt

**Inga löpande resultat publiceras, i någon fas.** Delsiffror påverkar dem som ännu inte röstat,
och differensen mellan två publiceringar är rösterna däremellan. Systemet vet dessutom vem som
röstade när, så en differens på en röst är den personens röst (spec 6.2).

### Efter räkningen

`GET /api/observer/results?electionId=<id>` är öppen, och svarar först när omröstningen
står i `TALLIED` eller `CERTIFIED`. Före det svarar den 409 med fasen och ingenting annat.
Stämmer de sparade räkneverken inte med en omräkning ur urnan och bidragen svarar den också
409 och lämnar inget tal. Svaret innehåller per valsedel den krypterade summan,
förtroendepersonernas partiella dekrypteringar med bevis, och resultatet. Per omröstning
innehåller det valets publika nyckel, de publika andelarna, kuvertroten, urnroten och
summan av markeringarna. Ingenting per röst.

### Verktyget

```bash
node tools/verify-election.mjs https://<värd>/api/observer/results?electionId=<id>
node tools/verify-election.mjs resultat.json <id>
```

Verktyget är fristående. Det importerar bara Nodes inbyggda moduler och ingenting ur appen,
och transkriptet och kombinationen är skrivna på nytt ur specen (4.4 och 4.5). Ett verktyg som
delade kod med appen hade bara visat att appen är konsekvent med sig själv. Utfallet är 0 när
allt som går att kontrollera stämmer, 1 när något inte gör det, och 2 när underlaget inte gick
att läsa.

**Verktyget kontrollerar:**

1. varje förtroendepersons partiella dekryptering, mot hennes publika andel och summans `c1`,
   med beviset räknat ur spec 4.5
2. att de publika andelarna hör till valets publika nyckel
3. att Lagrange-kombinationen av bidragen ger rätt antal för varje alternativ
4. att räkneverken summerar till antalet rader i urnan, och att antalet rader och
   markeringarna "har röstat" stämmer med varandra
5. att kuvertroten och urnroten finns och har formen av en rot
6. att varje valsedel står en gång, och att publiceringen gäller den omröstning som efterfrågades

**Verktyget kan inte kontrollera**, och säger det längst ned i varje utskrift:

- **Att summan består av exakt de giltiga rösterna.** De enskilda chiffren publiceras inte, så
  summan kan inte räknas om. Det vilar på valideringen och slutkontrollen, som båda körs av den
  som driver systemet.
- **Att rötterna är riktiga.** De kan inte räknas om, eftersom de enskilda kuverten och chiffren
  inte publiceras. De är åtaganden: den som sparade dem vid stängningen kan jämföra. Ändras
  urnan och rötterna tillsammans syns det inte.
- **Att antalet rader och markeringarna är riktiga.** Verktyget prövar bara att de stämmer med
  varandra och med räkneverken.
- **Vilka valsedlar omröstningen har.** En valsedel som saknas i publiceringen syns inte.
- **Att valets publika nyckel och andelarna är de som fanns när rösterna krypterades.** Den som
  sparade nyckeln medan röstningen pågick kan jämföra.

Det verktyget visar är alltså att dekrypteringen av den publicerade summan är korrekt och
att k av n förtroendepersoner bidrog. Det är inte ett bevis för att valet var korrekt.

### Varför det inte hotar valhemligheten

- Ingenting per röst publiceras, och inga chiffer eller hashar. Det finns inget en köpare eller
  väljare håller som går att matcha mot.
- Ingen tidsstämpel ingår i det publicerade, och markeringarna har ingen tid.
- **Undantaget är en valsedel med mycket få röster.** Då visar summan hur de få röstade, och
  med en enda röst är den publicerade summan exakt den röstens chiffer, så den som sett just
  det chiffret kan se att det räknades. Det gäller varje system som publicerar summor per
  valsedel. Riktiga val döljer eller slår ihop små tal, men det ligger utanför specen.

---

## 6. Väljarens egen kontroll

**Före stängningen** ser väljaren sin nuvarande röst på röstsidan, på enheten hon röstade
från. Enheten sparar valet och chifferhashen för den senaste läggningen per valsedel, men
aldrig slumptalet, och skickar hashen till servern, som svarar *lika*, *olika* eller *ingen
röst*. Svaret innehåller aldrig serverns hash, eftersom en enhet då skulle få veta hashen
för en röst som lagts från en annan enhet, alltså den som räknas. Är svaret *olika* har rösten
ändrats från en annan enhet, och innehållet visas inte.

**Visningen är inget kvitto.** Utan slumptalet går det inte att bevisa att chiffret innehåller
det enheten visar, och väljaren kan själv skriva om det enheten visar. En köpare kan inte lita
på skärmen, bara på att själv se läggningen, och den som ser läggningen kl 19 vet ingenting om
vad som gäller kl 20. Ingen kod visas.

**Vid stängningen** raderar enheten sina uppgifter när sidan ser att fasen lämnat `OPEN`.
Sidan frågar var trettionde sekund medan den är öppen.

**Efter stängningen** ser väljaren på `/verify` per valsedel *"Du har röstat"* eller *"Du har
inte röstat"*, utan tid och utan något chiffer. Beskedet kommer ur markeringen "har röstat",
som skalningen skriver ur de kuvert den raderar. Den kräver ingen koppling till rösten.
Markeringen är skriven av systemet, så den som kan skriva i röstlängden kan skriva eller
radera den, och sidan visar då det den skrev.

**Vad väljaren inte kan göra:** kontrollera att hennes röst räknades som hon lade den.
Efter stängningen finns ingenting hon kan jämföra mot, och det är med avsikt (spec 3.1).

---

## 7. Avvägningar som följer med

### Omröstnings-id är en delad identifierare

Omröstningen och dess valsedlar finns i **båda** databaserna med samma UUID. En foreign key
mellan två PostgreSQL-databaser är fysiskt omöjlig, och alternativet skulle kräva att den ena
sidan kan läsa den andra. Med flera omröstningar partitioneras kuverten, och anonymitetsmängden
krymper per omröstning och valsedel. För en valsedel med få röstande är det en verklig
försämring som måste vägas in när omröstningar utformas.

### Sessionen lever över flera valsedlar

I ett riksdagsval fyller väljaren tre valsedlar under samma session, och varje läggning kräver
en egen BankID-signering. Sessionen, tio minuter, innehåller väljarens id och omröstningens id,
aldrig ett val.

### Push-notiser utan identitet

Prenumerationer lagras utan koppling till någon väljare: ingen foreign key, ingen
identitetshash, ingen inloggning för att prenumerera. En push-endpoint är en
enhetsidentifierare, och låg den bredvid en identitetshash skulle en databasdump avslöja vilken
telefon som hör till vilken person. Priset är att notiser går till alla prenumeranter, även
icke röstberättigade. Meddelandet säger bara att en omröstning öppnat, vilket är offentligt.

---

## 8. Vad som fortfarande kräver tillit

Ärlighet om gränserna hör till konstruktionen. Listan numreras inte här, eftersom den fanns på
fyra ställen och blev olika. Den enda källan är `src/lib/known-limitations.ts`, grundad i spec
10, och visas på `/architecture/technical`. Läs den där.

Det som går att säga i korthet är vilka frågor som kräver tillit till den som driver systemet:

- att valideringen och slutkontrollen faktiskt kördes, och att inget äkta kuvert togs bort före
  stängningen
- att inte en kopia av databasen från före stängningen, med kuverten bredvid namnen, finns
  hos någon som också har två andelar av nyckeln
- att webbläsarkoden som levererades var den granskade
- att rötterna inte skrevs om, för den som inte sparade dem själv

Se [SECURITY.md](SECURITY.md) för hotmodellen och [ARCHITECTURE.md](ARCHITECTURE.md)
avsnitt 10 för hur listan hänger ihop med koden.
