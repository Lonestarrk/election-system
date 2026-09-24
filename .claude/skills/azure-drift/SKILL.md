---
name: azure-drift
description: Underhåll av election-system i Azure (Container Apps + PostgreSQL i prenumerationen "Election System"). Använd den här skillen så fort användaren vill distribuera om, uppdatera eller rulla tillbaka appen i Azure, läsa loggar, felsöka en krasch eller 500:or i drift, titta i produktionsdatabasen, hantera hemligheter i Key Vault, ändra storlek eller kostnad, koppla en egen domän, begränsa åtkomst med IP, eller riva miljön — även när de bara säger "deploya", "pusha ut", "är sajten nere?", "vad kostar det" eller "logga in i Azure".
---

# election-system i Azure

All infrastruktur finns som kod i `infra/azure/` (Bicep + `deploy.sh`). Läs `infra/azure/README.md` för arkitekturen. Den här skillen är det operativa: hur man loggar in, distribuerar, felsöker och vad man inte får göra.

## Miljön

| Sak | Värde |
|---|---|
| Katalog (tenant) | Standardkatalog, `159aeb7f-d905-4fda-9ac1-e623e8594f3d` |
| Prenumeration | **Election System**, `c6f20877-408e-407d-b6b7-86c6410f4f8f` (INTE "ICare Development" — det är ett annat åtagande) |
| Resursgrupp / region | `rg-election-system`, `swedencentral` |
| App / miljö / db-init-jobb | `election-app`, `election-env`, `election-db-init` |
| Register / valv / Postgres | `acrelectiondb125f`, `kv-election-db125f`, `election-pg-db125f` |
| Identitet | `election-app-id` (AcrPull på registret, Key Vault Secrets User på valvet) |
| URL | https://election-app.politesmoke-5b452a89.swedencentral.azurecontainerapps.io |
| Fakturering | fakturaavsnitt "Election System" på profilen "Jimmy Revtorp"; budget `election-monthly` 400 kr/mån med mejl |

Namnens suffix (`db125f`) är deterministiskt ur prenumeration + resursgrupp, så `deploy.sh` hittar samma resurser varje gång.

## Förutsättningar på den här datorn

Det här bet oss första gången; kolla dem innan du drar slutsatser om att något är trasigt.

- **Git Bash skriver om argument som ser ut som sökvägar.** `/subscriptions/...` blir `C:/Program Files/Git/subscriptions/...` när det skickas till az. Sätt `export MSYS_NO_PATHCONV=1` i varje skal som kör az med resurs-id:n, och översätt riktiga filsökvägar med `cygpath -w`. `deploy.sh` gör båda. Det här fick en gång skriptet att tro att hemligheterna saknades, så att de skrevs över.
- **az ligger inte i PATH.** Använd `export PATH="/c/Program Files/Microsoft SDKs/Azure/CLI2/wbin:$PATH"` i Git Bash. `deploy.sh` gör det själv.
- **git klagar på "dubious ownership"** eftersom repot ägs av en annan Windows-användare. Använd `git -c safe.directory=H:/Projects/election-system ...` per kommando; ändra inte global konfiguration utan att fråga.
- **Inloggning:** användaren vill inte hantera hemligheter själv. Kör device code i bakgrunden och ge användaren URL och kod:
  ```bash
  az login --tenant 159aeb7f-d905-4fda-9ac1-e623e8594f3d --use-device-code
  az account set --subscription c6f20877-408e-407d-b6b7-86c6410f4f8f
  ```
  Kontot är `revtorparen@gmail.com` och kräver MFA. Webbläsarinloggning (`az login` utan flagga) öppnade inget fönster, så börja med device code. En isolerad `AZURE_CONFIG_DIR` håller sessionens inloggning skild från användarens egen.
- **Flera Claude-sessioner delar arbetskatalogen.** Applikationskoden skrivs av sessionen "Blind signing röstningssystem". Behöver en rättning i `src/` göras, delegera den dit med SendMessage (utan `notify_when_idle`, den går över Remote Control) i stället för att ändra filen själv, och distribuera när rättningen finns på `main`. Den sessionens tester pekar på rader i `app.bicep`, `keyvault.bicep`, `infra.bicep` och `db-init.sql`; ändras de filerna kan ett test där bli rött, och det är avsiktligt.
- Andra sessioner committar och har ocommittade ändringar samtidigt, och git-indexet är också delat: det som stagas av en session kan följa med i en annan sessions commit. Committa därför alltid med uttryckliga sökvägar, `git commit -- <sökvägar>`, i stället för `git add` följt av `git commit`. Den andra sessionen stagar aldrig något under `infra/` eller `.claude/`; stagea på samma sätt aldrig något utanför dem. Distribuera alltid från en commit — aldrig från arbetskatalogen.

## Distribuera om

```bash
export PATH="/c/Program Files/Microsoft SDKs/Azure/CLI2/wbin:$PATH"
SKIP_LOGIN=1 AZURE_SUBSCRIPTION_ID=c6f20877-408e-407d-b6b7-86c6410f4f8f bash infra/azure/deploy.sh
# en viss commit eller tillbakarullning:
GIT_REF=<sha> SKIP_LOGIN=1 AZURE_SUBSCRIPTION_ID=c6f20877-408e-407d-b6b7-86c6410f4f8f bash infra/azure/deploy.sh
```

Kör den i bakgrunden med utdata till en loggfil; en omdistribution tar ~5 min, första gången ~25. Skriptet är idempotent: det bygger imagen ur `git archive` av committen (taggad med kort sha, hoppar över bygget om taggen redan finns), kör db-init-jobbet, uppdaterar appen och väntar tills `/api/elections` svarar 200. Rapportera alltid vilken commit som hamnade i drift — HEAD läses av först vid byggsteget, så en annan sessions commit kan hinna emellan.

Ändra inte `deploy.sh` medan den kör: bash läser skriptfilen under körningen.

Innan du distribuerar kod som ändrat Prisma-scheman: migreringarna körs automatiskt av containerns entrypoint mot produktionsdatabasen. De går inte att ångra genom att rulla tillbaka imagen. Säg det till användaren och få ett ja först.

## Felsökning

```bash
az containerapp logs show -n election-app -g rg-election-system --tail 100           # appens stdout
az containerapp logs show -n election-app -g rg-election-system --type system        # pull, probes, secrets
az containerapp revision list -n election-app -g rg-election-system -o table
az containerapp job execution list -n election-db-init -g rg-election-system -o table
```

Kända fel och orsaker:

| Symptom | Orsak |
|---|---|
| `exec /usr/local/bin/entrypoint.sh: no such file or directory` | CRLF i entrypoint.sh. `git archive` på Windows följer `core.autocrlf=true`; deploy.sh använder `-c core.autocrlf=false`. |
| `next build`: `Cannot find module '../tests/test-databases'` | `scripts/` kom med i byggkontexten utan `tests/`. `.dockerignore` utesluter båda. |
| Secret/KV-fel direkt efter första distributionen | Rolltilldelningen har inte slagit igenom; deploy.sh försöker om i upp till 5 min. |
| `next build`: `Invalid regular expression ... Unterminated group` | SWC-minifieringen förstör två template-strängar som förenas med `+` inuti `new RegExp(...)`. Skriv uttrycket som en enda template-sträng; `tests/security/regexp-construction.test.ts` vaktar mönstret. |
| db-init: `permission denied to alter role ... SUPERUSER attribute` | Azures administratör är ingen superuser och får inte ens skriva `NOSUPERUSER`. Ange bara `LOGIN PASSWORD`. |
| Appen: `permission denied for database voters_db` vid första migreringen | `CREATE SCHEMA IF NOT EXISTS` kräver CREATE på databasen; db-init.sql ger det, bara på rollens egen databas. |
| Appen: `P3009 migrate found failed migrations` | En migrering har misslyckats och ligger kvar som misslyckad. Rätta orsaken, kör sedan ett engångsjobb med appens image: `npx prisma migrate resolve --rolled-back <migrering> --schema=prisma/<db>/schema.prisma` (argumenten i en Bicep-mall — `az containerapp job create --args` tolkar `--rolled-back` som sin egen flagga), starta om revisionen och ta bort jobbet. Bara säkert när migreringen inte hann göra något; fråga annars. |
| 403 på varje POST | `APP_ORIGIN` saknar adressen som används. Egen domän → `EXTRA_APP_ORIGINS`. |
| Alla delar samma hastighetsgräns | `TRUSTED_PROXY_HOPS` ska vara `1` bakom Container Apps ingress. |

## Databasen

Postgres har ingen publik ändpunkt; den nås bara inifrån VNet:et. Två databaser, två roller: `voters_app` kan bara ansluta till `voters_db`, `votes_app` bara till `votes_db`. Det är en del av säkerhetsmodellen (identitet och röst får aldrig kunna kopplas) — slå aldrig ihop dem eller ge en roll åtkomst till båda.

För en fråga mot databasen: kör psql i appens container (`az containerapp exec -n election-app -g rg-election-system --command sh`, sedan `npx prisma` eller node) eller gör en tillfällig kopia av db-init-jobbet med en annan SQL. Läs bara om inte användaren uttryckligen ber om ändringar; demodata återskapas av seed vid varje start.

## Hemligheter

Ligger i `kv-election-db125f`, skapas av deploy.sh bara om de saknas och läses av appen via identiteten. Deploy-flödet behöver ingen dataplansroll — skriv inte ut värden i terminalen.

- **`identity-pepper` får aldrig bytas eller raderas.** Den kan inte roteras utan att röstlängden importeras om; utan den matchar ingen identitetshash. Valvet har 90 dagars soft delete.
- Databaslösenord byts genom att skriva ny hemlighet för både `pg-*-password` och motsvarande `*-database-url`, köra om db-init-jobbet och starta om en revision.

## Skalning och kostnad

Appen måste köra **exakt en replika** (`min = max = 1` i `app.bicep`): MockBankID-ordrar, hastighetsgräns och antagningskö ligger i processens minne. Höj inte `maxReplicas` och slå inte på scale-to-zero.

Ungefärlig kostnad: Postgres B1ms ~16 USD, appen 1 vCPU/2 GiB ~10–40 USD, register ~5 USD, logg ~2 USD, valv <1 USD — totalt ~350–600 kr/mån, alltså över budgetlarmet på 400 kr. Billigare: `cpu: 0.5`, `memory: '1Gi'` i `app.bicep` (scrypt-kön behöver ~128 MiB). Kolla faktisk kostnad med `az consumption usage list` eller Cost Management i portalen.

## Domän och åtkomst

Appen använder Azures egen adress (`*.azurecontainerapps.io`). is-a.dev förkastades: de förbjuder AI-genererade ansökningar och politiska projekt. Egen domän och IP-begränsning: se `infra/azure/README.md`.

## Kräver användarens uttryckliga ja

- Radera resurser eller hela resursgruppen (`az group delete` raderar också databasen och valvet).
- Nya kostsamma resurser eller större SKU:er.
- Nya rolltilldelningar, eller något på prenumerationsnivå.
- Något i prenumerationen "ICare Development".
