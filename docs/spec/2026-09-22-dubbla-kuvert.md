# Specifikation: dubbla kuvert med ändringsbar röst

**Status:** beslutad, ej byggd
**Ersätter:** blindsignaturmodellen i `ARCHITECTURE.md` avsnitt 4–7
**Datum:** 2026-09-22

---

## 1. Problemet som tvingar fram ombyggnaden

Dagens system gör kopplingen väljare↔röst **fysiskt omöjlig**: två databaser, ingen
foreign key kan existera, och blindsigneringen gör att ett utfärdat röstintyg inte går
att matcha mot ett inlöst ens för den som utfärdade det.

Det ger utmärkt valhemlighet och löser inte röstköp.

Kvittot som låter väljaren kontrollera att rösten räknats bevisar också **vad** hen
röstade på. Vi undersökte kvittofrihet genom förnekbarhet — att väljaren ska kunna
framställa falska kvitton — och den vägen är stängd i nuvarande konstruktion:

> Observatörsflödet publicerar `tokenHash` för varje röst, utan inloggning, och samma
> värde ligger i Merklebladet. En röstköpare hashar väljarens token och söker den i det
> öppna flödet. Finns den är kvittot äkta. Ett eget bord för falska kvitton gör den
> kontrollen lättare, inte svårare.

Den generella satsen:

> **Varje publicerad rad som parar ett handtag väljaren känner med ett val i klartext
> förstör kvittofriheten.** Antingen måste valet vara dolt i den publicerade datan,
> eller handtaget.

Vi undersökte också om nuvarande obundenhet kunde behållas och ändå tillåta att rösten
ändras. Den vägen är också stängd: det enda handtag som pekar ut väljarens röst är
token, och låter vi token auktorisera en ändring kan köparen som fått den också ändra
rösten. **Vilket handtag som än tillåter väljaren att ändra sig tillåter köparen det.**
Kopplingen till identitet är därför inte en genväg utan en nödvändighet.

## 2. Vald modell

Estlands konstruktion, i drift sedan 2005, modellerad på brevröstning.

```
   yttre kuvert                    inre kuvert
   ┌──────────────────┐            ┌────────────────────────┐
   │ väljarens rad    │  omsluter  │ krypterad röst         │
   │ i röstlängden    │  ───────►  │ under valets           │
   │ (vem)            │            │ tröskelnyckel (vad)    │
   └──────────────────┘            └────────────────────────┘
      voters_db                       flyttas till votes_db
      raderas vid stängning           vid stängning
```

Systemet vet under röstningen **att** en viss väljare har röstat, och kan byta ut hennes
inre kuvert när hon ändrar sig. Det kan inte läsa innehållet: dekrypteringsnyckeln är
delad mellan flera förtroendemän och används först efter att identitetslagret skalats
bort.

De dubbla kuverten faller ihop med de två databaserna som redan finns. Det yttre
kuvertet är en rad i `voters_db` som bär identitet plus ett ogenomträngligt chiffer. Det
inre kuvertet är chiffret som flyttas till `votes_db` vid stängning. Invarianten
"`votes_db` innehåller aldrig identitet" står kvar oförändrad för de räknade rösterna.

## 3. Egenskaper och vad som bär dem

| Egenskap | Mekanism |
|---|---|
| Valhemlighet | Enskilda röster dekrypteras **aldrig**. Bara summan öppnas. |
| Motstånd mot röstköp | Rösten kan ändras fram till stängning, och efter stängningen finns ingenting att matcha mot. En köpare måste se själva läggningen vid slutet. Se 3.1. |
| Kvittofrihet | Klienten kastar krypteringens slumptal. Det enheten visar före stängningen går inte att bevisa för någon annan. Se 3.1. |
| Individuell verifierbarhet | Före stängningen: väljaren ser sin nuvarande röst på enheten hon röstade från, kontrollerad mot det servern håller. Efter stängningen: att hon röstat, inte vad. Se 3.1. |
| Universell verifierbarhet | Vem som helst kontrollerar att resultatet är en korrekt dekryptering av den publicerade summan. Att summan består av exakt de giltiga rösterna vilar på valideringen före stängningen och på slutkontrollen. Se 3.1. |
| Ingen ensam administratör | k-av-n tröskeldekryptering. |

Det avgörande greppet för kvittofrihet: **klienten behåller inte slumptalet.** Väljaren
kan därför inte bevisa vad hennes chiffer innehåller.

### 3.1 Beslut 2026-09-23: kontroll före stängningen, bara summor efter

**Den första versionen av specen lovade två egenskaper som motsäger varandra.** Den sa
att köparen måste bevaka väljaren fram till kl 20, och att väljaren efter stängningen
kontrollerar att hennes chifferhash finns i den publicerade mängden. Men en köpare som
en gång sett rösten läggas har sett chifferhashen. Efter stängningen kontrollerar han om
den finns kvar. Finns den har väljaren inte ändrat sig; saknas den har hon det. Han
behöver alltså bevaka en gång, inte till kl 20, och möjligheten att ändra rösten
skyddar bara mot en köpare som betalar i förväg. Specen påstod att inklusionen *saknar
värde för en köpare*. Det gäller innehållet, men inte frågan om rösten **ändrats**.

Specen hade redan resonerat rätt om token: *vilket handtag som än tillåter väljaren att
ändra sig tillåter köparen det.* Den publicerade chifferhashen är också ett handtag, och
det missades. Felet hittades av implementeraren av arkitektursidan.

**Beslutet följer användarens modell:** alla röster är förtidsröster. Fram till
stängningen kan väljaren se, kontrollera och ändra sin röst. Efter stängningen kan
ingen se eller ändra något; väljaren kan se *att* hon röstat, inte på vad.

Konkret:

1. **Före stängningen ser väljaren sin nuvarande röst på den enhet hon röstade från.**
   Enheten sparar valet och chifferhashen för den senaste läggningen per valsedel, men
   **inte slumptalet**. Enheten skickar sin sparade hash till servern, som jämför med
   väljarens liggande röst och svarar bara *lika*, *olika* eller *ingen röst*.
   **Röstsidan får aldrig serverns hash.** Annars skulle en enhet få veta hashen för en röst som lagts
   från en annan enhet, alltså den röst som räknas, och den tillsammans med läsrätt i
   `votes_db` pekar ut rätt rad efter stängningen. Är svaret *lika* visas valet, med
   beskedet att servern håller exakt den röst som lades härifrån. Är det *olika* har
   rösten ändrats från en annan enhet, och innehållet visas inte. Livevyn på
   arkitektursidan visar i demoläget databasen som en insider ser den, med början av
   hashen. Det är avsiktligt och gäller bara demoläget.
2. **Visningen är inget kvitto.** Utan slumptalet går det inte att bevisa att chiffret
   innehåller det enheten visar. Det enheten visar kan dessutom ändras av väljaren
   själv. En köpare kan därför inte lita på skärmen, bara på att själv se läggningen, och
   den som ser läggningen kl 19 vet ingenting om vad som gäller kl 20.
3. **Ingen verifikationskod visas.** En kod på skärmen är just det handtag en köpare
   antecknar. Kontrollen i punkt 1 sker automatiskt och behöver ingen.
4. **Vid stängningen raderar enheten sina uppgifter** när sidan ser att fasen lämnat
   `OPEN`. Raderas de inte, därför att sidan aldrig öppnas igen, bevisar de ändå
   ingenting (punkt 2).
5. **Efter stängningen publiceras bara summorna** (se 7.2). Enskilda chiffer och deras
   hashar publiceras aldrig. Det finns alltså ingenting publicerat som något väljaren
   eller en köpare håller kan matchas mot.
6. **Efter stängningen ser väljaren att hon röstat.** Det står i röstlängden och kräver
   ingen koppling till rösten. Markeringen skrivs i skalningens transaktion, ur de
   kuvert som raderas, och har ingen tidsstämpel. Den säger att väljaren röstade,
   inte när.

**Priset är universell verifierbarhet röst för röst.** Allmänheten kan kontrollera att
resultatet är en korrekt dekryptering av den publicerade summan, att k av n
förtroendemän bidrog och att antalet röster stämmer med antalet som röstat. Att summan
består av exakt de giltiga rösterna kan allmänheten inte räkna om; det vilar på
valideringen medan kopplingen fanns (avsnitt 7) och på slutkontrollen. Estland har valt
samma väg: de enskilda rösterna publiceras inte, och granskningen sker genom
observatörer med åtkomst.

Två kvarvarande svagheter står i avsnitt 10: tvång vid själva slutet, och en insider med
läsrätt i `votes_db` som dessutom fått tag i en enhets sparade chifferhash.

## 4. Kryptografi

### 4.1 Grupp

RFC 3526 MODP Group 14 (2048 bitar), `p` som där angiven, `q = (p-1)/2`.

Generatorn är `g = 4`, som har ordning `q`, och `q` är ett primtal. **Den första
versionen motiverade valet fel.** Den sa att RFC:ns `g = 2` genererar hela gruppen av
ordning `2q` och därför öppnar för angrepp i undergruppen av ordning 2. Men `p ≡ 7
(mod 8)`, så 2 är en kvadratisk rest och har redan ordning `q`. Granskaren av uppgift 14b
kontrollerade det: `2^q ≡ 1 (mod p)`. Båda generatorerna hade alltså fungerat. `g = 4`
behålls, eftersom det är ett kvadrattal och därmed ligger i undergruppen oberoende av
vilken säker prim som används. **Alla exponenter räknas mod `q`, och varje mottaget gruppelement kontrolleras
med `y^q ≡ 1 (mod p)` innan det används.**

**Mätt kostnad, rättad 2026-09-24.** Den första versionen sa 2,0 ms per modexp och
cirka 134 modexp per riksdagsvalsedel. Båda var fel, och felet upptäcktes först när
röstsidan byggdes. Två oberoende mätningar är överens om kolumnen "före", och
uppgift 14b har mätt kolumnen "efter" (Node 22.19 med OpenSSL 3.0.17, Chromium 153,
i7-12700KF):

| Var | En modexp med full exponent (2048 bitar), före | Efter uppgift 14b |
|---|---|---|
| Ren BigInt i Node 22 | 39,7 ms | 39 ms, används inte längre på servern |
| OpenSSL, som servern nu räknar med | 1,6 ms | 1,4 ms, via Diffie–Hellman i `node:crypto` |
| Ren BigInt i Chromium 153, godtycklig bas | 4,4 ms | 4,4 ms |
| Chromium 153 med bas g eller h | 4,4 ms | 0,7 ms, med tabell för fast bas |

De 2 ms motsvarade alltså OpenSSL, inte BigInt i Node. En riksdagsvalsedel med
personval har 26 alternativ och kräver cirka 236 modexp för att krypteras och cirka
290 för att verifieras. Det gav 1,1 s i Chromium för krypteringen och 11,2 s i Node för
verifieringen, synkront, med händelseslingan stillastående.

Efter uppgift 14b, för samma valsedel:

| Vad | Före | Efter |
|---|---|---|
| Verifiering på servern | 11,2 s, 290 modexp | 0,38 s, 264 modexp |
| Längsta stopp i händelseslingan under en verifiering, för tal inom intervallen | 11 249 ms | 15 ms, 31 ms med tio samtidiga |
| Kryptering i Chromium | 1,1 s | 0,37 s för första valsedeln, 0,34 s för följande |
| Valideringen före stängningen, 100 väljare med tre valsedlar | cirka 33 min | 64 s |
| Stängningen, samma val | cirka 1 h | 131 s |

Verifieringen räknar varje exponentiering i OpenSSL och körs i steg, ett alternativ i
taget, med händelseslingan fri mellan stegen och högst två verifieringar samtidigt.
**Stoppen gäller bara tal inom sina intervall.** Granskaren av 14b visade att en giltig
valsedel, med fyra tal förlängda med k·q, låste slingan i 5,45 s i ett enda steg, eftersom
talens längd saknade gräns. Därför prövas nu varje tal strikt innan något räknas med det:
bara siffror, kanoniskt, högst 617 siffror, svar och utmaningar under `q` och gruppelement
under `p`. Samma prövning stoppar att en negativ exponent, som tidigare räknades som 1,
gör en förfalskad valsedel giltig.
Krypteringen i webbläsaren har tabeller med fyra bitar per fönster för `g` och `h`,
omkring 2 MB per bas och 11 ms att bygga. Baserna `c1` och `c2` beror på chiffret och
räknas som förut. Att verifieringen kräver 264 modexp och inte 290 beror på att
`g^(−1)` nu är en konstant. Undergruppskontrollen `y^q` räknas som `y^(q−1) · y`,
vilket är samma tal men låter OpenSSL svara på första anropet, eftersom OpenSSL aldrig
lämnar ut resultatet 1. Bevisen är oförändrade, tal för tal. Siffrorna tas fram med
`scripts/measure-crypto.ts`; "före" för valideringen och stängningen är räknat ur
antalet modexp, 499 per väljare, gånger 39,7 ms.

**Inget kryptobibliotek läggs till.** Nollberoendelinjen står kvar, eftersom det finns
snabba vägar utan beroenden, och uppgift 14b har tagit dem: OpenSSL:s modexp nås via
`node:crypto`, verifieringen släpper fram händelseslingan mellan alternativen, och de
fasta baserna är förberäknade i webbläsaren.

### 4.2 Exponentiell ElGamal

Nyckel: privat `x ∈ Z_q`, publik `h = g^x mod p`.

Kryptering av ett litet heltal `m` med slumptal `r ∈ Z_q`:

```
c1 = g^r mod p
c2 = h^r · g^m mod p
```

Homomorf egenskap: komponentvis produkt av två chiffer ger ett chiffer av summan.
Det är hela grunden för att kunna räkna utan att öppna någon enskild röst.

Dekryptering ger `g^m`, inte `m`. `m` återvinns med baby-step giant-step över
`[0, antal röstberättigade]` — billigt, eftersom räkneverket är litet.

### 4.3 Valsedeln som enhetsvektor

En valsedels alternativ ordnas kanoniskt och numreras `0 … M-1`:

- index `0` är alltid **blank röst**
- därefter varje parti i `displayOrder`
- därefter varje (parti, kandidat) i `displayOrder`, för valsedlar som tillåter personröst

Väljarens val kodas som en vektor där exakt en komponent är `1` och övriga `0`. Varje
komponent krypteras för sig.

Blankalternativet är inte artighet: utan det kan en väljare som inte vill rösta på något
inte producera en vektor som summerar till 1, och summabeviset nedan skulle falla.

### 4.4 Bevis

En krypterad valsedel utan bevis är värdelös — väljaren kunde lägga `1000` på sin
kandidat, och ingen skulle märka något förrän summan var orimlig.

**Per komponent:** ett disjunktivt Chaum–Pedersen-bevis att klartexten är `0` eller `1`.

**Per valsedel:** produkten av alla komponenters chiffer krypterar `g^1`, bevisat med ett
vanligt Chaum–Pedersen-bevis.

Utmaningarna beräknas med Fiat–Shamir: `SHA-256` över ett domänseparerat prefix plus
`electionId`, `ballotId`, komponentens index och **hela chifferlistan**. Bindningen till
listan hindrar att ett bevis klipps ut och återanvänds på en annan valsedel.

### 4.5 Tröskelnyckel

Shamir-delning över `Z_q`, `n = 3` förtroendemän, `k = 2` krävs.

Nyckeln genereras av en betrodd utdelare vid valets skapande och den ursprungliga privata
nyckeln raderas direkt efter delningen. Det är svagare än distribuerad nyckelgenerering
och står som känd begränsning.

**Varje andel krypteras med scrypt av en lösenfras som förtroendemannen sätter och som
aldrig lagras.** Skälet är att alternativet inte skyddar något: en andel krypterad med en
nyckel härledd ur appens miljö är läsbar för var och en som har databasen och miljön —
alltså precis vad en komprometterad appserver ger, eftersom appen behöver båda för att
fungera. Tre andelar i samma låda är inte tre innehavare.

Med lösenfraser ger en databasdump plus miljön ingenting. Kvarvarande svaghet: frasen
skrivs in på vår egen sida, så en komprometterad app kan fånga den i det ögonblicket. Det
kräver intrång vid ceremonin och inte mot data i vila — och ceremonin sker efter
skalningen, när det farliga fönstret redan är stängt.

**I demon skyddar fraserna ingenting.** Demovalets tre fraser står i repot och i imagen och
skrivs ut vid varje start, i Azure alltså i Log Analytics. Den som har databasen där kan
därför låsa upp två andelar, sätta ihop nyckeln och dekryptera varje kuvert. Under
röstningen ligger kuverten bredvid namnen. Demons väljare är påhittade, men egenskapen
ovan gäller alltså inte där. Skarpt läge ska vägra kända fraser (uppgift 17).

I demoläge seedas tre kända fraser som skrivs ut av `npm run seed`, så att en person kan
spela alla tre. I skarpt läge vägrar appen starta om fraserna är de seedade.

Varje förtroendeman bidrar med en partiell dekryptering `c1^{x_i}` plus ett
Chaum–Pedersen-bevis att samma `x_i` användes som i hens publika andel. Bidragen
kombineras med Lagrange-koefficienter.

### 4.6 Väljarens signatur på det yttre kuvertet

**Hålet som stängs.** Servern skriver raden, och därmed är det servern som påstår att
Anna lade just det här chiffret. Vem som helst med skrivrättighet till `voters_db` — eller
en komprometterad applikation — kan påstå samma sak om vilken väljare som helst som ännu
inte röstat. Den relationella kontrollen i avsnitt 7 fångar inte det, eftersom väljaren
är verklig.

**Mekanismen.** Röstläggningen använder BankID `/sign`, inte `/auth`:

| Fält | Innehåll |
|---|---|
| `userVisibleData` | "Rösta i Valet 2026 — Riksdagen". Det väljaren ser och godkänner i appen. |
| `userNonVisibleData` | `electionId \| ballotId \| ciphertextHash \| castSequence` |

BankID returnerar en XML-signatur ställd med väljarens eget certifikat. Raden lagrar
signaturen och certifikatkedjan, krypterad, och valideringen vid stängning kontrollerar
varje signatur mot chifferhashen, varje kedja mot BankID:s rot och varje certifikat mot
personnumret i röstlängden.

Därmed kan en röst inte förfalskas av **en klient**, och inte heller av den som bara kan
skriva i databasen. Systemet slutar vara betrott att säga att en viss webbläsare talar för
en viss väljare.

**Beslut 2026-09-24: certifikatkedjan valideras (uppgift 14f).**

En signatur är bara värd vad certifikatet bakom den är värt. Före uppgift 14f prövades
signaturen mot den nyckel raden själv bar, och att nyckeln tillhörde en verklig väljare
prövades aldrig. Vem som helst med skrivrättighet till röstlängden kunde generera ett eget
nyckelpar, signera ett välformat kuvert och skriva signatur, nyckel och väljarrad
tillsammans i en fullt självkonsekvent post, och varje kontroll sa ja. Signaturen skyddade
mot en klient men inte mot den som driver systemet. Nu gäller:

1. **Kedjan prövas mot en fast rot**, både när rösten läggs och i valideringen före
   stängningen, och därmed i skalningen, som kör valideringen som spärr. Kedjan är lövet
   och en till tre mellannivåer. Roten är konfigurerad, med en sökväg i
   `BANKID_ROOT_CERTIFICATES`, och följer aldrig med svaret: en rot som kom med kedjan vore
   vald av den som skrev kedjan. Varje mellannivå ska vara utfärdad och signerad av nivån
   ovanför, den översta av roten. Varje mellannivå ska ha CA-rätt och en `pathLen` som
   kedjan håller sig inom. Lövet ska vara utfärdat och signerat av den understa
   mellannivån, sakna CA-rätt och ha keyUsage digitalSignature, och alla certifikat ska ha
   gällt vid underskriften. Vid läggningen är det
   ögonblicket då BankID svarade, och i valideringen dagen då kuvertet lades, eftersom
   tidpunkten bara lagras på dygnet när. Ett certifikat som gått ut efter att rösten lades
   fäller inte rösten, av samma skäl som i 7.4.
2. **Certifikatet knyts till väljaren.** Personnumret i lövets `serialNumber` hashas med
   samma peppar som röstlängden, och hashen ska vara radens. En giltig kedja för en annan
   väljare underkänns. Valideringen hashar en gång per väljare och körning, inte per kuvert.
3. **Kedjan lagras krypterad** i `PendingVote`, med AES-256-GCM och en slumpad nonce per
   kuvert, under en nyckel som härleds ur `IDENTITY_PEPPER` med HKDF och en egen
   domänsträng, och med väljarens och valsedelns id som autentiserad data, så att en kedja
   inte kan flyttas till en annan rad. Lövet bär personnummer och namn i klartext, och en
   databasdump utan pepparn ska inte avslöja mer än i dag. Kedjan raderas med raden vid
   skalningen.
4. **Attrappen är en certifikatutfärdare.** Rot och mellannivå skapades en gång med openssl,
   av `scripts/generate-mock-bankid-ca.ts`, och rotens privata nyckel kastades. Mellannivån
   utfärdar ett certifikat vid varje underskrift, med personnumret som `serialNumber`. I
   demoläget är attrappens rot den betrodda, och skarpt läge ska vägra starta med den
   (uppgift 17).

Ett trasigt certifikat i en rad är en avvikelse och ingen krasch, med ett skäl som går att
utreda. En rotfil som inte går att läsa är däremot ett fel i driftsättningen, och då avbryts
stängningen med kopplingen orörd.

Vad signaturen ger nu:

| Skyddar mot | Skyddar inte mot |
|---|---|
| En klient som skickar med ett eget kuvert | Att den som driver systemet tar bort ett äkta kuvert |
| Manipulation av en annars äkta rads innehåll | Att den som driver systemet lägger tillbaka en väljares tidigare äkta kuvert, med dess räknare |
| En självkonsekvent förfalskning med eget nyckelpar, också från den som skriver direkt i databasen | Ett spärrat BankID-certifikat, eftersom ingen spärrkontroll görs |
| En annan väljares äkta underskrift, lagd i fel rad | Den som driver en demo, eftersom attrappen utfärdar certifikaten själv |

Den som bara kan skriva i **röstlängden** (`voters_db`) kan alltså inte längre få in en röst
för någon som inte skrivit under. Det gäller med fyra förbehåll:

1. **Med riktig BankID.** I demon utfärdar attrappen certifikaten själv.
2. **Stängningen flyttar exakt de kuvert den validerat**, i en enda läsning. Sedan 14f:s
   fixrunda prövades det mot 55 skrivningar i sex tidsfönster runt stängningen, och ingen
   förfalskning nådde urnan. Före fixrundan kunde en rad som togs bort mellan två
   läsningar flyttas utan att ha validerats.
3. **En granskare behöver pepparn** för att öppna kedjorna och kontrollera underskrifterna
   mot BankID:s rot under valideringen, och samma hemlighet öppnar namnen.
4. **Den som kan skriva i röstdatabasen** (`votes_db`) kan än så länge byta ut ett chiffer.
   Det kan ske före infogningen, genom en rad med ett äkta kuverts hash men ett annat
   chiffer, som infogningen hoppar över. Det kan också ske efter stängningen, eftersom
   ingenting kontrollerar urnan då, och kuvertroten går inte att räkna om när
   signaturerna är raderade. Uppgift 11d läser tillbaka varje flyttat chiffer, och
   uppgift 12b räknar om en urnrot som publiceras vid stängningen. Borttagning och återställning går inte att se i databasen,
eftersom räknaren för den senaste underskriften lagras där. Väljaren kan däremot upptäcka
båda själv: före stängningen svarar jämförelsen på hennes enhet "ändrad" eller "ingen röst",
och efter stängningen ska markeringen "har röstat" visa att hon röstat (uppgift 11d).

Riktig BankID kräver dessutom en adapter. BankID v6 returnerar en XMLDSig med kedjan
inbäddad. Prövningen ovan är oberoende av formatet, men att läsa ut kedjan och den
signerade texten ur XML-signaturen är inte byggt och kan inte provas utan BankID:s
testmiljö. Begränsningarna står i avsnitt 10.

**Återuppspelningen som också måste stoppas.** Utan räknaren i den signerade datan kan
den som fångat väljarens *första* signerade kuvert skicka in det igen efter att hon ändrat
sig, och rösten återgår till den köpta. Det vore ett röstköp som överlever hela
ändringsmöjligheten — alltså precis det modellen finns för att förhindra.

`castSequence` ökar för varje läggning, och servern avvisar en signatur vars räknare inte
är högre än den lagrade. Räknaren måste ligga **inuti** det signerade, annars kan den
bytas ut.

**Priset:** en BankID-signering per röstläggning, alltså en kodinmatning även för varje
ändring. Estland betalar samma pris för samma egenskap.

## 5. Datamodell

### voters_db — det yttre kuvertet

```
PendingVote
  id                uuid
  voterStatusId     -> VoterStatus (cascade)
  ballotId          uuid            (speglat id, ingen FK över databasgräns)
  ciphertext        jsonb           M par (c1, c2) som decimalsträngar
  proofs            jsonb           M 0/1-bevis + 1 summabevis
  ciphertextHash    text            SHA-256 över kanonisk serialisering
  castSequence      int             ökar vid varje läggning, ligger i det signerade
  bankIdSignature   text            XML-signatur från BankID /sign
  bankIdCertificateChain text       certifikatkedjan ur signaturen, löv och mellannivåer,
                                    krypterad med AES-256-GCM, se 4.6
  updatedAt         timestamptz     dygnsupplöst, som övrig tidsdata
  @@unique([voterStatusId, ballotId])
```

Raden **ersätts** vid omröstning och **raderas** vid stängning.

`Election` får `linkClearedAt timestamptz?` och `phase` enligt avsnitt 6.1.

### votes_db — det inre kuvertet

```
EncryptedVote
  id                uuid
  ballotId          -> ElectionBallot
  ciphertext        jsonb
  proofs            jsonb
  ciphertextHash    text  @unique      inklusionshandtaget
  @@index([ballotId])

TrusteeShare
  electionId        -> Election
  trusteeIndex      int
  publicShare       text              g^{x_i}
  encryptedShare    text              x_i, skyddad med administratörens nyckel
  @@unique([electionId, trusteeIndex])

PartialDecryption
  ballotId          -> ElectionBallot
  optionIndex       int
  trusteeIndex      int
  value             text              c1^{x_i}
  proof             jsonb
  @@unique([ballotId, optionIndex, trusteeIndex])

BallotTally
  ballotId          -> ElectionBallot
  optionIndex       int
  count             int
  @@unique([ballotId, optionIndex])
```

`Election` får `encryptionPublicKey text` och `tallyCompletedAt timestamptz?`.

## 6. Flöde

1. **Skapa omröstning.** Tröskelnyckel genereras, publik nyckel sparas i `votes_db`,
   tre andelar sparas krypterade, den ursprungliga privata nyckeln raderas.
2. **Väljaren legitimerar sig** och ser sina valsedlar samt om hon redan röstat.
3. **Klienten** hämtar valsedelns kanoniska alternativlista, bygger enhetsvektorn,
   krypterar och bevisar.
4. **Väljaren signerar** chifferhashen med BankID `/sign`. Appen visar vad hon godkänner;
   räknaren och valsedelns id ligger i det icke synliga fältet. Se avsnitt 4.6.
5. **Servern** verifierar bevisen, prövar kedjan mot BankID:s rot, signaturen mot lövets
   nyckel och personnumret i lövet mot väljarens, kontrollerar att räknaren är högre än den
   lagrade, och gör upsert på `(voterStatusId, ballotId)` med kedjan krypterad (4.6).
6. **Klienten kastar slumptalet** och sparar valet och chifferhashen lokalt, så att
   väljaren kan se sin nuvarande röst fram till stängningen. Ingen verifikationskod
   visas. Se 3.1.
7. **Vid `closesAt`** kör administratören stängningen:
   validera enligt avsnitt 7 → avbryt vid allvarlig avvikelse → annars infoga i
   `votes_db` sorterat på chifferhash (idempotent på `ciphertextHash`) → jämför antal →
   radera `PendingVote` → sätt `linkClearedAt`.
8. **k av n förtroendemän** lämnar partiella dekrypteringar av den homomorfa summan.
9. **Kombinera, räkna, publicera.** Chiffer, bevis, partiella dekrypteringar och resultat
   blir alla offentliga.
10. **Slutkontrollen** vägrar fastställa så länge en enda `PendingVote` finns kvar.

Steg 7 kan inte vara en transaktion över två databaser — det är fysiskt omöjligt, vilket
är själva poängen med separationen. Idempotensen bär i stället: infogningen är
nyckelfri på `ciphertextHash`, så en avbruten körning kan köras om utan dubbletter.
Samma resonemang som röstintygens inlösen använde.

### 6.1 Faserna är tillstånd, inte bara en ordning i koden

Ordningen måste vara omöjlig att kasta om, inte bara osannolik. `Election.phase` går
enkelriktat:

```
  OPEN ──closesAt──► CLOSED ──validering──► VALIDATED ──skalning──► STRIPPED
                                                                        │
                        CERTIFIED ◄──slutkontroll── TALLIED ◄──dekryptering
```

| Fas | Kopplingen finns | Röster tas emot | Vad som får hända härnäst |
|---|---|---|---|
| `OPEN` | ja | ja | tiden passerar `closesAt` |
| `CLOSED` | ja | **nej** | validering |
| `VALIDATED` | ja | nej | skalning |
| `STRIPPED` | **nej** | nej | partiella dekrypteringar |
| `TALLIED` | nej | nej | slutkontroll och fastställande |
| `CERTIFIED` | nej | nej | ingenting |

Två saker blir explicita av att `CLOSED` och `STRIPPED` är skilda tillstånd. Fönstret
där kopplingen finns men röstningen är stängd är **valideringsfönstret**, och det syns i
databasen att man befinner sig i det. Och en dekryptering kan inte beställas förrän
kopplingen bevisligen är borta, eftersom övergången till `STRIPPED` är villkoret.

Rösten avvisas i varje fas utom `OPEN`. Att den fasen är ett fält och inte en jämförelse
mot klockan spelar roll: en klocka som går fel eller en tidszon som tolkas om ändrar
beteendet tyst, medan en fasövergång är en händelse någon utfört.

### 6.2 Ingen preliminär räkning under pågående röstning

Det är frestande att räkna löpande och visa en valvaka. Det går inte, och skälen är tre —
i fallande ordning av hur avgörande de är.

**Det är inte tillåtet.** Resultat får inte offentliggöras innan röstningen stängt.
Partiella siffror påverkar dem som ännu inte röstat, och det är därför Sverige förbjuder
även vallokalsundersökningar före klockan 20. Ingen kryptografi gör det problemet mindre.

**Differensen mellan två publiceringar är rösterna däremellan.** Publiceras summan
klockan 14:00 och igen 14:01 är skillnaden exakt de röster som lades under minuten. Har
bara en person röstat *är differensen den personens röst*. Och i den här modellen vet
systemet vem som röstade när — kopplingen finns ju under röstningen. Uppslaget är en
enda fråga.

Att kopiera rösterna till en egen tabell för preliminär räkning hjälper inte, och det är
värt att vara tydlig med varför: **läckan ligger i publiceringstakten, inte i vilken
tabell siffrorna kommer ifrån.** Originalet förblir orört och krypterat i båda fallen.

Med en tröskel — publicera först när minst några tusen nya röster tillkommit — vore
differensangreppet hanterbart. Men det första skälet står kvar oavsett.

**Förtroendemännen måste vara online hela dagen.** Varje preliminär siffra kräver att k
av n utför en tröskeldekryptering. Nyckeln som ska vara svår att sammanföra skulle
sammanföras hundratals gånger under valdagen, och varje gång är ett tillfälle.

#### Vad som däremot går, och ger en riktig valvaka

**Valdeltagande live.** Antal som röstat, totalt och per kommun, uppdaterat kontinuerligt.
Kräver **ingen dekryptering alls** — det är en `count(*)` på liggande röster. Deltagande
är dessutom offentlig uppgift i ett riktigt val. Det är den siffra en valvaka faktiskt
följer under dagen.

**Resultat per område efterhand, efter stängning.** Det är vad en svensk valvaka är: inte
en löpande summa av ett öppet val, utan färdigräknade distrikt som rapporterar in ett
efter ett. Här motsvaras det av att varje valsedel och varje kommunområde dekrypteras och
publiceras så snart dess summa är klar. Spänningen finns kvar, och varje publicerad
siffra är en fullständig räkning med hela sin anonymitetsmängd bakom sig.

**Tröskelceremonin, och det är valvakans kärna.** Dekrypteringen kräver att k av n
förtroendemän var för sig lämnar sitt bidrag, och varje bidrag publiceras när det kommer
in. Det går alltså att följa *"2 av 3 förtroendemän har lämnat sitt bidrag"* i realtid.

Fördröjningen är äkta. Människor måste sammanträda, och var och en ska kontrollera
valideringsrapporten innan hen bidrar med sin andel — det är hela poängen med att dela
nyckeln. Den går inte att skynda på och inte att fejka.

Det är skillnaden mot en konstlad fördröjning, och skillnaden är inte estetisk:
**den som kan fördröja ett färdigt resultat kan också titta på det.** En siffra som finns
men hålls tillbaka är ett förtroendeproblem. En siffra som ännu inte går att räkna fram,
därför att tillräckligt många nycklar inte förts samman, är en garanti.

Att bidragen publiceras löpande krävs ändå för den universella verifierbarheten. Valvakan
faller alltså ut av en egenskap systemet behöver av andra skäl, vilket är den enda sortens
dramaturgi som är värd att bygga in.

**Räkningen har inget mellanliggande tillstånd.** Summan är produkten av alla chiffer som
ligger just nu, så varje körning är en omräkning från grunden. Att en väljare bytt sitt
val kräver ingen städning: raden ersattes, och nästa körning ser bara det som ligger där.
En separat hink för preliminära röster vore därför inte bara osäker utan överflödig —
den skulle vara en dubblett som måste hållas i synk med originalet vid varje ändring.

## 7. Validering medan kopplingen finns kvar

Det finns ett enda ögonblick där varje röst går att knyta till en väljare: strax före
skalningen. Den möjligheten ska användas, för efteråt finns ingen väljare att fråga och
före ombyggnaden fanns ingen koppling alls.

| Kontroll | Vad den upptäcker | Gick det i blindsigneringsmodellen? |
|---|---|---|
| Varje röst bär väljarens egen BankID-signatur över sitt chiffer, med en kedja till BankID:s rot | Förfalskad röst från en klient eller från den som skriver i databasen; manipulation av en äkta rad | Nej |
| Räknaren i signaturen är den högsta väljaren ställt ut | Återuppspelad äldre röst, alltså ett röstköp som överlever ändringen | Nej |
| Varje liggande röst tillhör en existerande, röstberättigad väljare | Rader som pekar på ingen | Nej |
| Valsedeln gäller väljaren, alltså rätt kommun och region | Fel valsedel, oavsett om det är bugg eller angrepp | Nej |
| Högst en liggande röst per väljare och valsedel | Dubbelröstning | Bara som ett antal, aldrig som en rad |
| Antalet som flyttas är exakt antalet som fanns | Förlust eller tillskott under skalningen | Nej |
| Varje valsedel verifierar sina bevis | Manipulerat chiffer | — |

Den första raden ändrar kontrollernas karaktär. Utan signaturen är de *relationella* —
de säger att raden hänger ihop med resten av databasen, vilket en angripare med
skrivrättighet lätt ordnar. Med signaturen blir de **kryptografiska**: raden måste bära
ett bevis.

Hur mycket det beviset är värt avgörs av avsnitt 4.6. Utan kedjevalidering mot BankID:s
rot kunde den som skriver direkt i databasen framställa beviset själv, och då var
kontrollen tillbaka på relationell nivå mot just den angriparen. Sedan uppgift 14f prövar
valideringen varje kedja mot roten och varje certifikat mot väljarens identitetshash, så
den stänger både **klientsidan** och **serversidan** mot förfalskade röster. Den stänger
inte att den som driver systemet tar bort ett äkta kuvert eller lägger tillbaka ett äldre,
och i demoläget, där attrappen utfärdar certifikaten själv, stänger den ingenting mot den
som driver demon.

**Skillnaden är också att avvikelser blir spårbara.** Tidigare gav en felräkning ett tal: fler
röster än markerade väljare. Ingen kunde säga vilka rösterna var. Nu ger samma kontroll
exakt vilka rader som avviker och vilken väljare varje hör till, så den går att utreda i
stället för att bara noteras.

En egenskap faller dessutom ut av datamodellen: **en stoppad röst måste hänga på en
verklig väljare.** Främmande nyckeln förbjuder en rad som tillhör ingen, och väljaren den
hängts på ser den nästa gång hen loggar in — och skriver över den genom att rösta.
Stoppning blir alltså både upptäckbar av systemet och rättningsbar av offret.

### 7.1 Valideringen är en spärr, inte en rapport

Skalningen körs inte om valideringen hittar något allvarligt. Ordningen är:

```
   validera (kopplingen finns)  ──►  allvarlig avvikelse?  ──► JA: avbryt, ingenting raderas
                                             │
                                             NEJ
                                             ▼
                                     skala och radera kopplingen
```

Att köra skalningen ändå vore att kasta bort bevismaterialet för det problem man just
hittat.

### 7.2 Vad som publiceras och vad som inte gör det

Valideringen kräver att kopplingen läses, alltså precis den förmåga som gör modellen
svagare på valhemlighet än den föregående. Därför:

- **Publiceras:** antal, kategorier och utfall. "12 483 röster, 12 483 väljare, noll
  avvikelser" är den sortens uppgift som gör ett resultat trovärdigt. Efter
  dekrypteringen dessutom, per valsedel: den krypterade summan, förtroendemännens
  partiella dekrypteringar med bevis, resultatet och kuvertroten.
- **Publiceras aldrig:** enskilda chiffer eller deras hashar. Se 3.1: vad som helst
  publicerat per röst är ett handtag en köpare kan matcha mot.
- **Publiceras inte:** vilka väljare som helst, i någon form. Detaljen finns för
  administratören att utreda, och inte längre än så.
- **Loggas:** att valideringen körts, av vem och när. Att läsa kopplingen ska synas.

### 7.3 Beslut: signaturerna förstörs, men en rot publiceras först

Signaturen bär väljarens certifikat, alltså personnummer och namn. Den får därför aldrig
följa med till `votes_db`. Men förstörs den vid skalningen försvinner också möjligheten
att i efterhand bevisa att rösterna var äkta — kvar finns bara valideringsrapportens ord.

| | Vad som krävs för att bryta valhemligheten | Vad som går att bevisa efteråt |
|---|---|---|
| **A: förstör vid skalning** | k av n andelar | ingenting utöver rapporten |
| **B: förseglat arkiv, skilt från rösterna** | arkivet **och** k av n andelar | varje rösts äkthet |

B kräver två oberoende intrång i stället för ett, och Estland har valt den vägen. A är
strikt starkare på valhemlighet och strikt svagare på granskning.

**Valt: A, med ett tillägg som återtar det mesta av granskbarheten.** Innan kuverten
skalas beräknas en Merklerot över alla par av `(ciphertextHash, signatur)` och
publiceras. Roten avslöjar ingenting — den är en hash — men binder oss vid exakt vilka
signerade kuvert som fanns.

Det som följer är att vi inte senare kan påstå att andra kuvert fanns, eftersom roten
redan är ute. **Roten är ett åtagande, inte ett inklusionsbevis.** Den första versionen
sa att en väljare med sparat kuvert kan bevisa att det räknades. Det stämmer inte, och
det ska inte heller stämma: ingen inklusionsväg lagras, signaturerna raderas, och ett
bevis som väljaren kan visa upp efter stängningen är samma handtag som 3.1 tar bort. Valhemligheten blir samtidigt
lika stark som vid full radering: efter skalningen krävs bara k av n andelar för att
bryta den, och roten hjälper ingen angripare.

### 7.4 Beslut: en struken väljares röst räknas ändå

Hon var röstberättigad när hon röstade, och det är den tidpunkten som gäller. Det
motsvarar svensk praxis för förtidsröster: en röst från någon som avlidit efter
röstningen räknas, eftersom valsedeln då redan är anonym.

Två konsekvenser för bygget, och båda är lätta att missa:

**Kaskaden från `VoterStatus` till `PendingVote` måste bort.** Annars tar en radering
tyst rösten med sig, vilket är precis det utfall beslutet avvisar.

**Valideringen får inte kontrollera nuvarande röstberättigande.** Att rösten var legitim
när den lades framgår av signaturen, inte av röstlängdens tillstånd i efterhand. En
kontroll mot nuläget skulle förkasta giltiga röster.

## 8. Vad som raderas

| Fil | Skäl |
|---|---|
| `src/lib/blind-signature.ts` | Obundenheten kommer nu från att inga enskilda röster öppnas |
| `src/lib/blind-client.ts` | — |
| `src/modules/eligibility/credential.service.ts` | Inga röstintyg |
| `src/app/api/vote/credential/route.ts` | — |
| `src/modules/ballot-box/token.service.ts` | Chifferhashen ersätter kvittokoden |
| `signingPrivateKeyPem`, `signingPublicKeyPem` | Inga signeringsnycklar finns kvar |
| `credentialId`, `credentialSignature` på rösten | — |

## 9. Kända begränsningar som försvinner

- **`signing-keys-in-database`** — det finns inga signeringsnycklar längre.
- **`receipt-proves-choice`** — klienten kastar slumptalet; hashen bevisar inklusion, inte innehåll.
- **`single-administrator`** — fastställandet kräver k av n förtroendemän.
- **`no-guaranteed-anonymity-set`** — alla röster skalas och infogas i en enda sats,
  sorterade på innehåll. Anonymitetsmängden är hela valet.

## 10. Kända begränsningar som tillkommer

- **Kopplingen existerar under röstningen.** "Kan inte existera" blir "raderas enligt
  schema". Backuper, läsreplikor och WAL-loggen omfattas inte av raderingen. Detta är
  den huvudsakliga akademiska invändningen mot Estlands system, och den är verklig.
- **Betrodd utdelare i stället för distribuerad nyckelgenerering.** Ett ögonblick
  existerar hela den privata nyckeln på ett ställe.
- **Klientintegriteten är fortfarande olöst.** En manipulerad klient kan kryptera något
  annat än väljaren valde. Motmedlet är cast-or-audit (Benaloh) och ligger utanför denna
  spec.
- **Tvång vid själva slutet är fortfarande möjligt.** En tvingare som ser väljaren lägga
  rösten strax före stängningen vet att den gäller. Skärmen hjälper inte tvingaren (3.1
  punkt 2), som måste se läggningen. Estland lägger till att en pappersröst upphäver den
  digitala; det ligger utanför denna spec.
- **En insider med läsrätt i `votes_db` och en enhets sparade chifferhash** kan se om
  den enhetens röst var den som räknades, men inte vad den innehöll. Det kräver både
  intrång i databasen och tillgång till väljarens enhet.
- **BankID-ordern bär chifferhashen ut ur systemet**, tillsammans med väljarens
  identitet. BankID sparar signaturer, bland annat för tvister, så kopplingen skulle
  finnas kvar hos BankID efter raderingen här. Åtgärdas genom att det signerade bär en
  hash av chifferhashen och ett salt som bara finns i `PendingVote` och raderas med
  raden. Efter stängningen går BankID:s kopia inte att matcha mot någonting.
- **Den som driver systemet kan ta bort ett kuvert eller återställa en väljares tidigare
  äkta röst.** Kedjevalideringen (4.6) hindrar att nya underskrifter förfalskas, men inte
  att äkta tas bort eller spelas upp igen, eftersom räknaren för den senaste underskriften
  lagras i samma databas: den som lägger tillbaka ett gammalt kuvert lägger tillbaka dess
  räknare. Väljaren kan upptäcka båda på sin enhet före stängningen, där jämförelsen
  svarar "ändrad" eller "ingen röst", och efter stängningen genom markeringen "har
  röstat" (uppgift 11d).
- **Ingen spärrkontroll (OCSP).** Ett spärrat BankID-certifikat godkänns så länge det
  gäller i tid. Åtgärdas genom att OCSP-svaret som BankID skickar med prövas, både när
  rösten läggs och i valideringen.
- **I demoläget utfärdar attrappen certifikaten själv.** Mellannivåns privata nyckel är
  incheckad, så den som driver en demo kan fortfarande förfalska en underskrift. Skyddet
  gäller med riktig BankID, där nyckeln finns hos BankID. Testerna visar egenskapen mot
  attrappens inbyggda rot, vars privata nyckel kastades.
- **Riktig BankID kräver en adapter för XML-signaturen.** BankID v6 returnerar en XMLDSig
  med kedjan inbäddad. Kedjevalideringen är oberoende av formatet, men att läsa ut kedjan
  och den signerade texten ur XML-signaturen är inte byggt, och kan inte testas utan
  BankID:s testmiljö.
- **Den som har pepparn kan läsa namn och personnummer för varje liggande kuvert.** Kedjan
  krypteras med en nyckel ur `IDENTITY_PEPPER`, eftersom valideringen måste kunna öppna
  den.
  - Den som har både en databasdump och pepparn får namnen direkt ur kedjorna.
  - Med pepparn går också identitetshasharna att vända. Personnumren är få nog för att
    pröva alla: cirka 4·10⁷ gånger 37 ms, ungefär 17 processordygn, och arbetet går att
    dela upp.
  - Utan pepparn avslöjar kedjan ingenting nytt. Signaturkolumnen gör det med riktig
    BankID. Dess längd följer lövets nyckeltyp och kan peka ut utfärdaren, och BankID:s
    XML-signatur bär dessutom kedjan i klartext. Den ska därför förseglas som kedjan
    (uppgift 17b).
  - Kedjan raderas med raden vid skalningen, men en säkerhetskopia från före stängningen
    har den kvar. I Azure sparas databasernas automatiska säkerhetskopior i sju dagar.
- **Pepparn ligger i Key Vault i Azure, och appen har den i minnet.**
  - Den som kan läsa valvet får pepparn, och därmed allt som föregående punkt beskriver.
  - Appens identitet har läsrätt i hela valvet. Den omfattar också Postgres-administratörens
    lösenord, som öppnar båda databaserna, så en komprometterad app når båda.
  - Valvet är mjukvaruskyddat (Standard). Granskningslogg och rensningsskydd är inte
    påslagna.
  - Förtroendepersonernas andelar ligger med avsikt inte i valvet, utan låsta med
    fraserna i röstdatabasen (4.5).
