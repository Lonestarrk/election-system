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
| Motstånd mot röstköp | Rösten kan ändras fram till stängning. Köparen måste bevaka dig till kl 20. |
| Kvittofrihet | Klienten kastar krypteringens slumptal. Väljaren håller bara ett chifferhash. |
| Individuell verifierbarhet | Väljaren kontrollerar att hennes chifferhash finns i den publicerade mängden. |
| Universell verifierbarhet | Vem som helst räknar om den homomorfa summan och kontrollerar dekrypteringsbevisen. |
| Ingen ensam administratör | k-av-n tröskeldekryptering. |

Det avgörande greppet för kvittofrihet: **klienten behåller inte slumptalet.** Väljaren
kan därför bevisa att hennes chiffer ingår i räkningen, men inte vad det innehåller.
Inklusionen räcker för hennes egen kontroll, och saknar värde för en köpare.

## 4. Kryptografi

### 4.1 Grupp

RFC 3526 MODP Group 14 (2048 bitar), `p` som där angiven, `q = (p-1)/2`.

Generatorn är `g = 4`. Skälet: RFC:ns `g = 2` genererar hela gruppen av ordning `2q`,
vilket öppnar för angrepp i undergruppen av ordning 2. `4 = 2²` har ordning `q`, som är
primtal. **Alla exponenter räknas mod `q`, och varje mottaget gruppelement kontrolleras
med `y^q ≡ 1 (mod p)` innan det används.**

Mätt kostnad: **2,0 ms per modexp**. En riksdagsvalsedel kostar ~134 modexp ≈ 0,3 s, och
en väljares tre valsedlar ~0,7 s. Ren BigInt räcker — **inget kryptobibliotek läggs
till**, och projektets nollberoendelinje för krypto står kvar.

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
signaturen och certifikatet, och valideringen vid stängning kontrollerar varje signatur
mot chifferhashen och mot personnumret i röstlängden.

Därmed kan en röst inte förfalskas av **en klient**. Systemet slutar vara betrott att
säga att en viss webbläsare talar för en viss väljare.

**MEN DEN SKYDDAR INTE MOT DEN SOM DRIVER SYSTEMET, OCH DET ÄR VIKTIGT ATT SÄGA RAKT UT.**

En signatur är bara värd vad certifikatet bakom den är värt. Kontrollen jämför signaturen
mot en nyckel, och att nyckeln tillhör en verklig väljare vilar helt på att certifikatet
är utfärdat av BankID:s CA. Utan **kedjevalidering mot den CA:n** kan vem som helst med
skrivrättighet till röstlängden generera ett eget nyckelpar, signera ett välformat kuvert,
och skriva signatur, nyckel och väljarrad tillsammans i en fullt självkonsekvent post.
Varje kontroll säger ja.

Kedjevalideringen finns inte i den här prototypen, eftersom BankID är en attrapp. Vad
signaturen ger i dag är alltså:

| Skyddar mot | Skyddar inte mot |
|---|---|
| En klient som skickar med ett eget kuvert | Den som kan skriva direkt i databasen |
| Manipulation av en annars äkta rads innehåll | En självkonsekvent förfalskning med eget nyckelpar |

Skillnaden mellan de två kolumnerna är precis kedjevalideringen. Den står som känd
begränsning, och konstruktionen är byggd för att den ska gå att lägga till utan att något
annat ändras.

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
  bankIdCertificate text            väljarens certifikat, ur signaturen
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
5. **Servern** verifierar bevisen, kontrollerar signaturen mot väljarens personnummer och
   att räknaren är högre än den lagrade, och gör upsert på `(voterStatusId, ballotId)`.
6. **Klienten visar chifferhashen** som verifikationskod och **kastar slumptalet**.
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
| Varje röst bär väljarens egen BankID-signatur över sitt chiffer | Förfalskad röst från en klient; manipulation av en äkta rad | Nej |
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

Hur mycket det beviset är värt avgörs dock av avsnitt 4.6. Utan kedjevalidering mot
BankID:s CA kan den som skriver direkt i databasen framställa beviset själv, och då är
kontrollen tillbaka på relationell nivå mot just den angriparen. Valideringen stänger
alltså **klientsidan** helt, och serversidan först när kedjevalideringen finns.

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
  avvikelser" är den sortens uppgift som gör ett resultat trovärdigt.
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

Två saker följer. En väljare som sparat sitt eget kuvert kan i efterhand bevisa att det
räknades, genom en inklusionsväg upp till den publicerade roten. Och vi kan inte senare
påstå att andra kuvert fanns, eftersom roten redan är ute. Valhemligheten blir samtidigt
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
- **Tvång före stängning är fortfarande möjligt** om tvingaren kan bevaka väljaren fram
  till kl 20. Estland lägger till att en pappersröst upphäver den digitala; det ligger
  utanför denna spec.
