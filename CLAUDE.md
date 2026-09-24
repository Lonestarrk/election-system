# election-system: anvisningar för Claude

Ett bevisprojekt för digital röstning i Sverige, byggt enligt modellen med **dubbla kuvert**
(som i Estland). Det inre kuvertet är en valsedel krypterad med ElGamal. Det yttre är
väljarens BankID-underskrift över det inre. Vid stängningen valideras de yttre kuverten,
kopplingen mellan namn och röst raderas, och bara summorna dekrypteras, av två av tre
förtroendepersoner.

## Dokumenten som styr

- **Specen är bindande:** `docs/spec/2026-09-22-dubbla-kuvert.md`. Hotmodellen står i
  avsnitt 10.
- **Planen:** `docs/superpowers/plans/2026-09-22-dubbla-kuvert.md`. Vad som återstår och i
  vilken ordning står i raden "Exekveringsordning efter uppgift 11".
- **Användarens beslut (spec 3.1):**
  - Alla röster är förtidsröster.
  - Fram till stängningen kan väljaren se, kontrollera och ändra sin röst på enheten den
    lades från.
  - Ingen verifieringskod visas.
  - Efter stängningen publiceras bara summorna med bevis. Väljaren ser att den röstat,
    men inte på vad.
  - Markeringen "har röstat" har ingen tidsstämpel.
- **Demoläge och skarpt läge** sätts vid driftsättning (uppgift 17). Ingen knapp i appen
  byter läge.
- **README, ARCHITECTURE.md, VERIFIABILITY.md, SECURITY.md och PLAN.md** beskriver till
  stor del den gamla modellen med blindsignering och röstintyg. De skrivs om i uppgift 16,
  och till dess gäller specen där de säger emot den. Arkitektursidan i appen följer den nya
  modellen.

## Kommandon

- **Databaserna** körs i Docker: `docker compose up -d postgres`. Containern heter
  `election-postgres` och användaren `election`. Där finns `voters_db` och `votes_db` för
  utveckling, och `voters_test` och `votes_test` för testerna.
- **Dev-servern:** `npx next dev -H 0.0.0.0 -p 3000`. Den bygger till `.next-dev`.
- **Typkontroll:** `npx tsc --noEmit` ska ge noll fel.
- **Tester:** `npx vitest run`. Testerna styrs själva om till testdatabaserna, och
  `tests/test-databases.ts` kontrollerar det med `current_database()`. `SKIP_DB_TESTS=1`
  hoppar över databastesterna.
- **E2E:** `npx playwright test` kör mot <http://localhost:3000> och använder en dev-server
  som redan kör. `E2E_BASE_URL` pekar om den.
- **Bygget:** `npx next build` bygger till `.next` och kan köra medan dev-servern kör.
  Det skriver om `next-env.d.ts`, så återställ filen efteråt med
  `git checkout -- next-env.d.ts`. Bygget kör inte `prisma generate`.
- **Schemana är två.** Kör `npm run generate` efter en schemaändring och `npm run migrate`
  för att migrera båda.

## Regler i koden

- Kommentarer och användartext skrivs på svenska. Kommentarer förklarar varför, inte vad.
  URL:er är på engelska.
- **Inga nya npm-beroenden.** Undantaget står i planens uppgift 18 (OpenAPI). Kryptot i
  `src/lib/crypto` bygger på `BigInt` och `node:crypto`.
- **Gruppen** är RFC 3526 MODP Group 14 med `g = 4`.
  - Varje mottaget gruppelement valideras: `1 < y < p` och `y^q ≡ 1 (mod p)`.
  - Tal från klienten tolkas bara med `parseScalar` och `parseElement` i
    `src/lib/crypto/group.ts`.
- **`votes_db` får aldrig innehålla identitet.** Det vaktas av
  `tests/security/schema-separation.test.ts`.
- **Tidsstämplar grovkornas** med `src/lib/time.ts`.
- **Demoläget avgörs bara av `isDemoMode()`** i `src/lib/demo-mode.ts`. Varje rutt under
  `/api/demo` frågar den först. Det vaktas av `tests/security/api-surface.test.ts`.
- **`new RegExp(...)` byggs av en enda template-sträng.** SWC:s minifiering förstörde en
  sammanfogad sträng i produktionsbygget, och bara bygget visade felet. Det vaktas av
  `tests/security/regexp-construction.test.ts`.

## Arkitektursidan och de kända begränsningarna

- **Sidorna:**
  - `/architecture` för alla, utan fackord
  - `/architecture/technical`
  - `/architecture/status`
- **Markörerna.** Varje påstående om koden läses ur `src/app/architecture/code-facts.ts`
  och bär markörer, alltså en fil och en sträng som ska finnas i den. Posterna i
  `src/lib/known-limitations.ts` har `stillTrueIf`. Testerna går rött när koden ändras så
  att ett påstående slutar stämma. Skriv då om påståendet. Lös aldrig upp en markör för att
  få testet grönt.
- **Lova aldrig för mycket.** Avgränsa varje "ingen", "aldrig", "bara" och "inte", och pröva
  det mot spec 10 och hela flödet. Pröva det också mot den som driver systemet, den som
  läser Key Vault och den som kan skriva i en av databaserna. Granskningarna har hittat
  ett tiotal sådana överlöften.

## Git och den andra sessionen

- **Arbetskopian och git-indexet delas** med en annan Claude-session, Azure-sessionen
  (voting-azure). Den äger `infra/` och `.claude/`.
  - Committa med uttryckliga sökvägar: `git commit -m "..." -- <sökvägar>`.
  - Stagea och committa aldrig något under `infra/` eller `.claude/`.
  - Rör inte den andra sessionens ocommittade filer.
- **Commitmeddelanden skrivs på svenska.**
- **Pusha** med `git push origin main` när en funktion är klar. Tvinga aldrig en push.
- **Gör inte åt en annan session det som dess egna behörigheter nekade.** Fråga användaren.

## Azure

- **Demon:**
  <https://election-app.politesmoke-5b452a89.swedencentral.azurecontainerapps.io>
  - Den kör Container Apps, PostgreSQL och Key Vault i prenumerationen "Election System".
  - Den är ett produktionsbygge i demoläge.
- **Drift** sköts med skillen `azure-drift`, och filerna under `infra/azure/` är
  Azure-sessionens.

## Arbetssättet

- **Planen körs med superpowers:subagent-driven-development.** Liggaren är
  `.superpowers/sdd/2026-09-22-dubbla-kuvert/progress.md`. Den är git-ignorerad och har
  rulings, status och historik. En uppgift med raden "Task N: complete" är klar.
- **Efter en kompaktering** gäller liggaren och `git log` före minnet.

## Fällor i Windows

- **Bash-verktyget är Git Bash.** Heredocs med `!` eller vissa citattecken kan fela. Skriv
  längre text med en citerad heredoc (`<<'EOF'`) eller till en fil.
- **Ange `MSYS_NO_PATHCONV=1`** när en sökväg som börjar med `/` ska till ett
  Windows-verktyg, till exempel az.
- **En dev-server som stoppas med TaskStop** lämnar node-processer som håller port 3000
  och Prismas DLL. Stoppa dem med `Stop-Process` och kontrollera att porten är fri.
- **C: är liten.** Dockers diskavbild
  (`%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx`) och npm-cachen växer där. När C: är
  full felar verktygen med "No space left on device", och Docker hänger sig.
