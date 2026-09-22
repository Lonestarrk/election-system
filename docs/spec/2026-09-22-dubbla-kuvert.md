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

Varje förtroendeman bidrar med en partiell dekryptering `c1^{x_i}` plus ett
Chaum–Pedersen-bevis att samma `x_i` användes som i hens publika andel. Bidragen
kombineras med Lagrange-koefficienter.

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
  updatedAt         timestamptz     dygnsupplöst, som övrig tidsdata
  @@unique([voterStatusId, ballotId])
```

Raden **ersätts** vid omröstning och **raderas** vid stängning.

`Election` får `linkClearedAt timestamptz?`.

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
   krypterar, bevisar, och skickar in tillsammans med sessionen.
4. **Servern** verifierar varje bevis och gör upsert på `(voterStatusId, ballotId)`.
   Ett ogiltigt bevis avvisas — det är enda stället där det kan fångas billigt.
5. **Klienten visar chifferhashen** som verifikationskod och **kastar slumptalet**.
6. **Vid `closesAt`** kör administratören stängningen:
   verifiera alla bevis → infoga i `votes_db` sorterat på chifferhash (idempotent på
   `ciphertextHash`) → jämför antal → radera `PendingVote` → sätt `linkClearedAt`.
7. **k av n förtroendemän** lämnar partiella dekrypteringar av den homomorfa summan.
8. **Kombinera, räkna, publicera.** Chiffer, bevis, partiella dekrypteringar och resultat
   blir alla offentliga.
9. **Slutkontrollen** vägrar fastställa så länge en enda `PendingVote` finns kvar.

Steg 6 kan inte vara en transaktion över två databaser — det är fysiskt omöjligt, vilket
är själva poängen med separationen. Idempotensen bär i stället: infogningen är
nyckelfri på `ciphertextHash`, så en avbruten körning kan köras om utan dubbletter.
Samma resonemang som röstintygens inlösen använde.

## 7. Vad som raderas

| Fil | Skäl |
|---|---|
| `src/lib/blind-signature.ts` | Obundenheten kommer nu från att inga enskilda röster öppnas |
| `src/lib/blind-client.ts` | — |
| `src/modules/eligibility/credential.service.ts` | Inga röstintyg |
| `src/app/api/vote/credential/route.ts` | — |
| `src/modules/ballot-box/token.service.ts` | Chifferhashen ersätter kvittokoden |
| `signingPrivateKeyPem`, `signingPublicKeyPem` | Inga signeringsnycklar finns kvar |
| `credentialId`, `credentialSignature` på rösten | — |

## 8. Kända begränsningar som försvinner

- **`signing-keys-in-database`** — det finns inga signeringsnycklar längre.
- **`receipt-proves-choice`** — klienten kastar slumptalet; hashen bevisar inklusion, inte innehåll.
- **`single-administrator`** — fastställandet kräver k av n förtroendemän.
- **`no-guaranteed-anonymity-set`** — alla röster skalas och infogas i en enda sats,
  sorterade på innehåll. Anonymitetsmängden är hela valet.

## 9. Kända begränsningar som tillkommer

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
