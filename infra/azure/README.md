# Distribution till Azure

Systemet körs som en container i **Azure Container Apps** mot **Azure Database for
PostgreSQL Flexible Server**, i ett eget VNet. Allt beskrivs i Bicep här och körs med
`deploy.sh`.

```
Internet ──HTTPS──▶ Container Apps ingress ──▶ election-app (1 replika)
                                                   │  identitet: election-app-id
                                  ┌────────────────┼─────────────────┐
                                  ▼                ▼                 ▼
                         Container Registry    Key Vault      PostgreSQL (privat, snet-pg)
                           (AcrPull)        (Secrets User)    voters_db ← voters_app
                                                              votes_db  ← votes_app
```

## Köra

```bash
export AZURE_CLIENT_ID=... AZURE_CLIENT_SECRET=... AZURE_TENANT_ID=... AZURE_SUBSCRIPTION_ID=...
infra/azure/deploy.sh                 # bygger och distribuerar HEAD
GIT_REF=v1.2 infra/azure/deploy.sh    # en annan commit eller tagg
```

Skriptet är idempotent. Imagen byggs alltid ur `git archive` av den valda committen,
aldrig ur arbetskatalogen, och taggas med commit-hashen.

Tjänsteprincipalen behöver **Owner** (eller Contributor + User Access Administrator) på
resursgruppen, eftersom `infra.bicep` skapar två rolltilldelningar. Båda gäller bara en
enskild resurs:

| Identitet | Roll | Omfång |
|---|---|---|
| `election-app-id` | AcrPull | registret |
| `election-app-id` | Key Vault Secrets User | valvet |

## Steg

1. `keyvault.bicep`: valvet (RBAC-läge).
2. Hemligheter som saknas genereras och skrivs via `secret.bicep`. Befintliga rörs aldrig.
3. `infra.bicep`: VNet, privat DNS, Log Analytics, register, identitet och roller,
   Postgres (`postgres.bicep`) och Container Apps-miljön.
4. Imagen byggs och pushas; `postgres:17-alpine` importeras för db-init-jobbet.
5. `db-init-job.bicep` + körning: `db-init.sql` skapar `voters_app` och `votes_app`,
   var och en med anslutningsrätt till bara sin egen databas.
6. `app.bicep`: appen. Entrypoint migrerar och seedar vid start, som lokalt.

## Hemligheter i Key Vault

| Namn | Används som |
|---|---|
| `identity-pepper` | `IDENTITY_PEPPER`. **Byt aldrig**: röstlängdens hashar slutar matcha. |
| `voters-database-url` / `votes-database-url` | `VOTERS_DATABASE_URL` / `VOTES_DATABASE_URL` |
| `pg-voters-password` / `pg-votes-password` | lösenorden i URL:erna, för db-init |
| `pg-admin-password` | Postgres-administratören, bara för db-init |
| `vapid-public-key` / `vapid-private-key` | Web Push |

## Varför en replika

MockBankID:s ordrar, hastighetsbegränsningen och antagningskön ligger i processens minne.
`app.bicep` låser därför `minReplicas = maxReplicas = 1`. Fler repliker kräver att det
tillståndet flyttas till en delad lagring först.

## Demoläge

Med MockBankID är appen i demoläge (`src/lib/demo-mode.ts`): vem som helst som når
adressen kan legitimera sig som demopersonerna, också administratören, och
`/api/demo/*` svarar. Vill man begränsa vem som når den:

```bash
az containerapp ingress access-restriction set -n election-app -g rg-election-system \
  --rule-name office --ip-address 203.0.113.0/24 --action Allow
```

## Egen domän

```bash
EXTRA_APP_ORIGINS=https://val.example.se infra/azure/deploy.sh
az containerapp hostname add  -n election-app -g rg-election-system --hostname val.example.se
az containerapp hostname bind -n election-app -g rg-election-system --hostname val.example.se \
  --environment election-env --validation-method CNAME
```

## Loggar

```bash
az containerapp logs show -n election-app -g rg-election-system --follow
```
