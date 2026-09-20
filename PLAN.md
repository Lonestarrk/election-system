# Implementationsplan — Digitalt valsystem (POC)

Baserad på `digitalt_valsystem_prompt.txt`.

Bärande princip: **identitet och röst får aldrig lagras tillsammans eller kunna länkas
efter att rösten lagts.**

---

## 1. Arkitekturbeslut (de som faktiskt avgör om POC:en bevisar något)

### 1.1 Två fysiskt separerade databaser — inte bara två tabeller

Specen kräver "ingen foreign key". Att bara låta bli att skriva en FK i samma schema
bevisar ingenting — det är en konvention, inte en garanti.

**Beslut:** en PostgreSQL-instans, **två separata databaser** (`voters_db`, `votes_db`),
två Prisma-scheman, två genererade Prisma-klienter, två `DATABASE_URL`.

En FK över databasgränsen är *fysiskt omöjlig* i PostgreSQL. Det gör separationen
strukturellt bevisbar i stället för dokumenterad. Det ger också ett trovärdigt
kompromissscenario att beskriva i `SECURITY.md`: "angripare som dumpar `voters_db`
får noll röstinformation".

Docker Compose kör en init-SQL som skapar båda databaserna.

### 1.2 Modulgräns med avsiktligt smal kontrakt

```
modules/eligibility/          modules/anonymous-vote/
  – känner till identitet       – känner INTE till identitet
  – vet "X har röstat"          – vet "en röst finns på parti Y"
  – har ALDRIG partival         – får ALDRIG IP, headers, session, request-id
```

Röstmodulens publika API är exakt en funktion:

```ts
castAnonymousVote(input: { partyId: string }): Promise<{ token: string }>
```

Ingen ytterligare parameter existerar i typsignaturen. Det går alltså inte att
"råka" skicka med identitet — TypeScript stoppar det vid kompilering. Detta
verifieras även av ett test som läser typsignaturen/modulgränsen.

### 1.3 Ordningsproblemet: atomicitet vs anonymitet

Två databaser ⇒ ingen gemensam transaktion. Ordningen måste väljas medvetet:

| Ordning | Vid krasch mellan stegen | Konsekvens |
|---|---|---|
| Rösta först, markera sen | Röst lagd, väljare ej markerad | **Dubbelröstning** |
| Markera först, rösta sen | Väljare markerad, ingen röst | **Väljare förlorar sin röst** |

**Beslut:** markera först (fail-safe mot dubbelröstning), i en atomisk transaktion
som samtidigt konsumerar röstsessionen. Vid fel i steg 2 görs begränsad retry i
samma request; lyckas det inte räknas en anonym felräknare upp (ingen identitet,
ingen tidsstämpel per händelse).

Detta är en **medveten, dokumenterad begränsning**. En riktig valprocess löser det
med blinda signaturer / mix-nets, där väljaren får ett signerat röstintyg innan
identitetssteget avslutas. Skrivs ut i `SECURITY.md` som känd svaghet — inte
gömmas undan.

### 1.4 Konflikt i specen: `GET /api/verify/{token}` vs "lägg inte token i URL"

Specen kräver båda. De är oförenliga — en token i sökvägen hamnar i accessloggar,
webbläsarhistorik, referrer-headers och proxyloggar.

**Beslut:** `POST /api/verify` med token i request-body är den implementerade
endpointen. Responsformatet följer specen exakt:

```json
{ "registered": true, "party": "Exempelpartiet" }
```

Avvikelsen dokumenteras i `ARCHITECTURE.md` med motivering. (Alternativ om du hellre
vill följa specen bokstavligt: implementera även GET-varianten men med tydlig
varning — säg till så gör jag det.)

### 1.5 Tidskorrelation — den svåraste riktiga läckan

Om `VoterStatus.voted_at` och `AnonymousVote.created_at` båda har
millisekundsupplösning kan en angripare med båda databaserna matcha rad för rad på
tid. Då är hela separationen värdelös.

**Motmedel i POC:en:**
- `AnonymousVote.created_at` lagras **avrundad till hel timme** (grovkornig bucket)
- `VoterStatus.voted_at` lagras avrundat till hel dag
- Slumpmässig fördröjning (0–N ms) mellan de två skrivningarna

Detta är otillräckligt i lågtrafikscenarier (få röster per timme ⇒ fortfarande
unikt) och det ska stå rakt ut i `SECURITY.md`. Riktiga system använder
batchning/mixning med garanterad anonymitetsmängd.

### 1.6 Token-design

- 256 bitar från `crypto.randomBytes(32)` (CSPRNG, aldrig `Math.random`)
- Presentation: Crockford Base32, grupperad `XXXX-XXXX-XXXX-…` för avläsbarhet
- Lagring: **endast SHA-256-hash**, unikt index på `token_hash`
- Ingen härledning från identitet, tid, parti, IP, sekvensnummer — ren slump
- Klartexten existerar bara i responsen på röst-anropet, en enda gång

---

## 2. Projektstruktur

```
election-system/
├─ docker-compose.yml
├─ Dockerfile
├─ docker/postgres/init.sql          # skapar voters_db + votes_db
├─ .env.example
├─ prisma/
│  ├─ voters/schema.prisma           # VoterStatus, VotingSession, AuditEvent
│  └─ votes/schema.prisma            # Party, AnonymousVote
├─ src/
│  ├─ app/
│  │  ├─ (val)/page.tsx              # start
│  │  ├─ (val)/legitimera/page.tsx   # BankID-mock
│  │  ├─ (val)/rosta/page.tsx        # partival + bekräftelse
│  │  ├─ (val)/kvitto/page.tsx       # token, visas en gång
│  │  ├─ verifiera/page.tsx          # /verify-motsvarighet
│  │  ├─ admin/page.tsx
│  │  ├─ demo/page.tsx
│  │  └─ api/
│  │     ├─ auth/bankid/start|collect/route.ts
│  │     ├─ vote/parties|cast/route.ts
│  │     ├─ verify/route.ts
│  │     └─ admin/stats/route.ts
│  ├─ modules/
│  │  ├─ eligibility/                # identitetssidan
│  │  │  ├─ bankid/IBankIdService.ts
│  │  │  ├─ bankid/MockBankIdService.ts
│  │  │  ├─ voter-status.service.ts
│  │  │  ├─ voting-session.service.ts
│  │  │  └─ db.ts                    # Prisma-klient: voters_db
│  │  └─ anonymous-vote/             # röstsidan
│  │     ├─ index.ts                 # ENDA publika ytan: castAnonymousVote()
│  │     ├─ token.service.ts
│  │     ├─ vote.service.ts
│  │     └─ db.ts                    # Prisma-klient: votes_db
│  ├─ orchestration/cast-vote.usecase.ts   # enda stället som ser båda modulerna
│  └─ lib/  (logger, rate-limit, csrf, headers, validation, session-cookie)
├─ tests/  (unit/, integration/, security/)
├─ README.md · SECURITY.md · ARCHITECTURE.md
```

`orchestration/cast-vote.usecase.ts` är den *enda* filen som importerar båda
modulerna. Ett arkitekturtest failar om någon annan fil gör det.

---

## 3. Databasschema

**voters_db**
```
VoterStatus      id(uuid) · external_identity_hash(unik) · is_eligible ·
                 has_voted · voted_at(dagsupplösning)
VotingSession    id(uuid) · voter_status_id → VoterStatus · expires_at ·
                 consumed_at            ← raderas vid röstning
AuditEvent       id · event_type · occurred_at(timmesupplösning)
                 (aldrig identitet, aldrig parti, aldrig token)
```

**votes_db**
```
Party            id(uuid) · name · abbreviation · display_order
AnonymousVote    id(uuid) · token_hash(unik) · party_id → Party ·
                 created_at(timmesupplösning)
```

Ingen kolumn i `AnonymousVote` kan härledas till en väljare. Ingen kolumn i
`VoterStatus` kan härledas till en röst. Ingen FK korsar databasgränsen —
PostgreSQL tillåter det inte.

---

## 4. Flöden

**Röstning**
1. `/api/auth/bankid/start` → MockBankID returnerar `orderRef` + QR-placeholder
2. `/api/auth/bankid/collect` → polling → `pending` → `complete` (konfigurerbar fördröjning)
3. Personnummer hashas (HMAC-SHA256 med serverpeppar) → uppslag i `VoterStatus`
4. Ej röstberättigad → avslag · redan röstat → avslag (`403`, svenskt meddelande)
5. `VotingSession` skapas, id i HttpOnly/SameSite=Strict/Secure-cookie, TTL 10 min
6. `/api/vote/parties` → partilista
7. `/api/vote/cast` med `{ partyId }` + CSRF-token:
   - transaktion i voters_db: konsumera session **och** sätt `has_voted` (atomiskt)
   - anrop `castAnonymousVote({ partyId })` → token genereras, hash lagras
   - sessionscookie rensas
   - token returneras **en gång**, i responsbody
8. Kvittovyn visar token + varningen:
   *"Detta är enda gången din token visas. Spara den om du vill kunna kontrollera
   din röst senare."*
   Ingen autolagring i localStorage, ingen token i URL, ingen token i logg.

**Verifiering** — `POST /api/verify` med `{ token }` → hashas → uppslag → svar
`{ registered, party }`. Inget mer. Ingen endpoint tar personnummer som indata.

**Admin** — endast aggregat: antal röstberättigade, antal röstande, röster per
parti, totalt. Ingen sökning, inga listor, inga id:n. Skyddad med enkel
env-baserad inloggning (POC-nivå, tydligt märkt).

---

## 5. Säkerhetslager

| Kontroll | Implementation |
|---|---|
| CSRF | Double-submit cookie + `Origin`-validering på alla mutationer |
| Cookies | `HttpOnly`, `SameSite=Strict`, `Secure` (av bakom http i dev), kort TTL |
| Headers | CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` |
| CORS | Endast egen origin, ingen wildcard |
| Rate limiting | Token bucket per IP på auth/cast/verify (in-memory; Redis noteras som produktionskrav) |
| Validering | Zod på all indata, allowlist av `partyId` mot DB |
| SQL-injektion | Prisma parametriserar; ingen rå SQL i request-vägen |
| Loggning | Egen logger med **redaction-filter** som vägrar släppa igenom token-mönster och personnummer-mönster; röstmodulen loggar aldrig IP eller request-id |
| Telemetri | Ingen analytics, ingen error-tracking som skickar payloads vidare |

Request-id propageras **inte** in i röstmodulen — annars kan applikationsloggar
korrelera "auth för person X, request abc" med "röst lagd, request abc".

---

## 6. Tester (alla 16 punkter från specen + arkitekturtester)

**Enhet** — tokengenerering (entropi, format, unikhet över 100k dragningar),
hashning, MockBankID, validering, logg-redaction.

**Integration mot riktig Postgres** — de som faktiskt bevisar poängen:
- efter röstning: inspektera båda databaserna och visa att ingen kolumn matchar
- `information_schema` innehåller **noll** FK mellan databaserna
- token-hash finns i `votes_db`, finns inte någonstans i `voters_db`
- dubbelröstning avvisas
- icke röstberättigad avvisas
- byte av parti påverkar inte `VoterStatus`
- tömning av `VoterStatus` → verifiering fungerar fortfarande (röster överlever)
- tömning av `AnonymousVote` → "har röstat" består (ingen röst avslöjas)

**Säkerhet** — hela loggutdata scannas efter klartext-token efter en full
röstomgång (test 10); verifieringssvar scannas efter identitetsfält;
arkitekturtest som failar om röstmodulen importerar något från eligibility.

Stack: **Vitest** + Testcontainers-liknande uppsättning via compose-profil
`test`. Playwright endast om du vill ha E2E — säg till.

---

## 7. Demo-sidan `/demo`

- Arkitekturdiagrammet från specen, renderat
- Live-vy: `VoterStatus`-tabellen bredvid `AnonymousVote`-tabellen
- Explicit kolumnjämförelse som visar att inget fält är gemensamt
- Knapp: "Försök länka en väljare till en röst" → visar att frågan inte går att
  ställa, med den faktiska SQL som skulle behövas och varför den misslyckas
- Lista över metadata som *skulle* kunna underminera anonymitet (tid, IP, loggar,
  request-id, trafikvolym) och vad POC:en gör åt varje

---

## 8. Dokumentation

`ARCHITECTURE.md` — komponenter, dataflöde, modulgräns, varför två databaser,
sekvensdiagram, avvikelser från specen (verify via POST) med motivering.

`SECURITY.md` — hotmodell (väljare, admin, DB-dump, full serverkompromiss,
nätverksobservatör), anonymitetsmodell, tokendesign, replay- och
dubbelröstningsskydd, vad som lagras / vad som medvetet **inte** lagras,
metadatakorrelation, samt ett tydligt avsnitt: **varför detta inte duger för ett
riktigt val** (kräver oberoende granskning, formell hotmodellering, juridisk
analys, tillgänglighet, kryptografisk verifierbarhet, reproducerbara byggen,
oberoende valmyndighet, penetrationstester, offentlig insyn).

`README.md` — `docker compose up`, seed-data, testpersonnummer (röstberättigad /
ej röstberättigad / redan röstat), hur man kör testerna, hur man själv
inspekterar båda databaserna för att verifiera separationen.

---

## 9. Ordning för genomförande

1. Skelett: Next.js + TS + Docker Compose + två databaser + Prisma × 2 + seed
2. Eligibility-modulen + MockBankID + sessionshantering
3. Anonymous-vote-modulen + token + verifiering
4. Orchestration + API-rutter + hela säkerhetslagret
5. Frontend (svenskt UI): start → legitimering → röstning → kvitto → verifiering
6. Admin + demo-sidan
7. Tester (alla 16 + arkitektur- och loggtester)
8. README + SECURITY.md + ARCHITECTURE.md
9. Slutkontroll: `docker compose up` från rent tillstånd, full testsvit grön

---

## 10. Beslutade frågor

1. **Verify-endpoint** — endast POST med token i request-body. `GET` finns kvar men
   svarar `405` med en förklaring. Avvikelsen från specen är dokumenterad i
   README och ARCHITECTURE.
2. **Tester** — Vitest med enhets-, integrations- och arkitekturtester. Ingen
   Playwright.
3. **Partier** — riksdagens åtta partier med riktiga namn och färger.

## 11. Genomfört

Allt i planen är byggt. Två avvikelser från planen uppstod under arbetet:

- **Kvittot fick ingen egen sida.** Att navigera till `/kvitto` hade krävt att
  klartext-token transporterades genom en URL, sessionStorage eller ett tillstånd
  som överlever sidladdning — alla tre förbjudna av specen. Kvittot renderas
  därför direkt i `/rosta` från svaret, utan navigering.
- **Prisma-klienterna genereras till `node_modules/.prisma/`**, inte till `src/`.
  Prisma kopierar sin runtime till utdatakatalogen, och den filen anropar
  `os.homedir()`. Ligger den utanför `node_modules` försöker Next.js filspårning
  expandera anropet statiskt och skanna hela användarkatalogen, vilket kraschar
  bygget på Windows. Next hoppar alltid över `node_modules` vid spårning.
