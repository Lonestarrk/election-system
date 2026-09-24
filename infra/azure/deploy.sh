#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Distribuerar election-system till Azure Container Apps + PostgreSQL.
#
# Idempotent: kör om för att uppdatera. Hemligheter skapas bara om de saknas,
# så en ny körning byter aldrig IDENTITY_PEPPER eller databaslösenorden.
#
# Kräver: az (Azure CLI), docker, git, node, openssl.
#
# Autentisering, med en tjänsteprincipal:
#   AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID
#
# Valfritt:
#   LOCATION        (swedencentral)
#   RESOURCE_GROUP  (rg-election-system)
#   PREFIX          (election)
#   GIT_REF         (HEAD)  vad som byggs; alltid från en ren git archive,
#                           aldrig från arbetskatalogen
#   EXTRA_APP_ORIGINS       t.ex. https://val.example.se för en egen domän
#   SKIP_LOGIN=1            använd den inloggning som redan finns i az
#
# Sekretessen: klienthemligheten skrivs aldrig ut, och inga genererade
# hemligheter hamnar på en kommandorad eller i distributionshistoriken; de
# går via parameterfiler i en temporär katalog som tas bort efteråt.
# ---------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

LOCATION="${LOCATION:-swedencentral}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-election-system}"
PREFIX="${PREFIX:-election}"
GIT_REF="${GIT_REF:-HEAD}"
EXTRA_APP_ORIGINS="${EXTRA_APP_ORIGINS:-}"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'FEL: %s\n' "$*" >&2; exit 1; }

# az på Windows under Git Bash: az.cmd ligger ofta utanför PATH.
if ! command -v az >/dev/null 2>&1; then
  for candidate in "/c/Program Files/Microsoft SDKs/Azure/CLI2/wbin" "/c/Program Files (x86)/Microsoft SDKs/Azure/CLI2/wbin"; do
    [ -x "$candidate/az.cmd" ] && PATH="$candidate:$PATH" && break
  done
fi
command -v az >/dev/null 2>&1 || die "Azure CLI (az) saknas."
command -v docker >/dev/null 2>&1 || die "docker saknas."

# Git Bash (MSYS) skriver om varje argument som ser ut som en Unix-sökväg när
# det skickas till ett Windows-program. Ett resurs-id som /subscriptions/...
# blir då C:/Program Files/Git/subscriptions/..., och az svarar med ett fel som
# såg ut som "hemligheten finns inte" — skriptet skrev över befintliga
# hemligheter. Omskrivningen stängs därför av helt, och de sökvägar som
# verkligen är filer översätts uttryckligen med native_path.
export MSYS_NO_PATHCONV=1
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
REPO_NATIVE="$(native_path "$REPO_ROOT")"
git_repo() { git -c safe.directory="$(printf '%s' "$REPO_NATIVE" | tr '\\' '/')" -C "$REPO_NATIVE" "$@"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- Inloggning ------------------------------------------------------------

: "${AZURE_SUBSCRIPTION_ID:?AZURE_SUBSCRIPTION_ID saknas}"
if [ "${SKIP_LOGIN:-}" != "1" ]; then
  : "${AZURE_CLIENT_ID:?AZURE_CLIENT_ID saknas}"
  : "${AZURE_CLIENT_SECRET:?AZURE_CLIENT_SECRET saknas}"
  : "${AZURE_TENANT_ID:?AZURE_TENANT_ID saknas}"
  log "Loggar in som tjänsteprincipal"
  az login --service-principal --username "$AZURE_CLIENT_ID" --password="$AZURE_CLIENT_SECRET" \
    --tenant "$AZURE_TENANT_ID" --output none
fi
az account set --subscription "$AZURE_SUBSCRIPTION_ID"
ACTIVE_SUB="$(az account show --query id -o tsv | tr -d '\r')"
[ "$ACTIVE_SUB" = "$AZURE_SUBSCRIPTION_ID" ] || die "Fel prenumeration vald: $ACTIVE_SUB"
log "Prenumeration: $(az account show --query '[name, id]' -o tsv | tr -d '\r' | paste -sd ' ')"

az bicep version >/dev/null 2>&1 || az bicep install
az config set extension.use_dynamic_install=yes_without_prompt --only-show-errors >/dev/null

# Deterministiska, globalt unika namn: samma prenumeration och grupp ger
# alltid samma namn, så en ny körning hittar de befintliga resurserna.
SUFFIX="$(printf '%s/%s' "$AZURE_SUBSCRIPTION_ID" "$RESOURCE_GROUP" | sha256sum | cut -c1-6)"
KV_NAME="kv-${PREFIX}-${SUFFIX}"
ACR_NAME="acr${PREFIX//-/}${SUFFIX}"
PG_SERVER="${PREFIX}-pg-${SUFFIX}"
PG_FQDN="${PG_SERVER}.postgres.database.azure.com"

deploy() { # deploy <namn> <mall> [param=värde ...]
  local name="$1" template="$2"; shift 2
  az deployment group create --resource-group "$RESOURCE_GROUP" --name "$name" \
    --template-file "$(native_path "$HERE/$template")" --parameters "$@" --output none
}
output() { # output <distribution> <utdata>
  az deployment group show --resource-group "$RESOURCE_GROUP" --name "$1" \
    --query "properties.outputs.$2.value" -o tsv | tr -d '\r'
}

# --- Resursgrupp och Key Vault --------------------------------------------

log "Resursgrupp $RESOURCE_GROUP i $LOCATION"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --tags app=election-system --output none

log "Key Vault $KV_NAME"
deploy keyvault keyvault.bicep location="$LOCATION" keyVaultName="$KV_NAME"
KV_ID="$(az keyvault show --name "$KV_NAME" --resource-group "$RESOURCE_GROUP" --query id -o tsv | tr -d '\r')"
KV_URI="$(output keyvault keyVaultUri)"

# --- Hemligheter, bara de som saknas --------------------------------------
#
# Existensen prövas via kontrollplanet (ARM), som inte lämnar ut värdet.
# Distributören behöver alltså ingen roll som kan LÄSA hemligheterna.

# Tre utfall, inte två: finns, finns inte, eller gick inte att avgöra. Det
# sista stoppar, eftersom "vet inte" tolkat som "finns inte" skriver över en
# befintlig hemlighet — för identity-pepper ett fel som inte går att ångra.
secret_exists() {
  local out
  if out="$(az resource show --ids "$KV_ID/secrets/$1" --query name -o tsv 2>&1)"; then
    return 0
  fi
  case "$out" in
    *ResourceNotFound*|*"was not found"*|*NotFound*) return 1 ;;
    *) die "Kunde inte avgöra om hemligheten $1 finns: $out" ;;
  esac
}

put_secret() { # put_secret <namn> <värde>
  local file="$WORK/secret-$1.json"
  # Värdet går via miljön till node, inte som argument.
  SECRET_VALUE="$2" node -e 'const [f, n, k] = process.argv.slice(1); require("fs").writeFileSync(f, JSON.stringify({
    "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
    contentVersion: "1.0.0.0",
    parameters: { keyVaultName: { value: k }, secretName: { value: n }, secretValue: { value: process.env.SECRET_VALUE } } }))' \
    "$(native_path "$file")" "$1" "$KV_NAME"
  deploy "secret-$1" secret.bicep "@$(native_path "$file")"
  rm -f "$file"
  echo "   skapade $1"
}

random_hex() { openssl rand -hex "$1"; }

ensure_pair() { # ensure_pair <a> <b> <generator som skriver "a b" på en rad>
  local a="$1" b="$2" gen="$3" ea eb
  secret_exists "$a" && ea=1 || ea=0
  secret_exists "$b" && eb=1 || eb=0
  if [ "$ea$eb" = "11" ]; then echo "   $a och $b finns redan"; return; fi
  [ "$ea$eb" = "00" ] || die "Bara en av $a och $b finns i $KV_NAME. Rätta för hand; de hör ihop."
  local pair; pair="$($gen)"
  put_secret "$a" "${pair%% *}"
  put_secret "$b" "${pair#* }"
}

gen_voters() { local pw; pw="$(random_hex 24)"; echo "$pw postgresql://voters_app:${pw}@${PG_FQDN}:5432/voters_db?schema=public&sslmode=require"; }
gen_votes()  { local pw; pw="$(random_hex 24)"; echo "$pw postgresql://votes_app:${pw}@${PG_FQDN}:5432/votes_db?schema=public&sslmode=require"; }
gen_vapid() {
  node -e 'const c = require("crypto"); const { privateKey } = c.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const j = privateKey.export({ format: "jwk" });
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, "base64url"), Buffer.from(j.y, "base64url")]).toString("base64url");
    process.stdout.write(pub + " " + j.d)'
}

log "Hemligheter i Key Vault"
if secret_exists pg-admin-password; then echo "   pg-admin-password finns redan"; else put_secret pg-admin-password "Pg-$(random_hex 24)-X"; fi  # Azure kräver tre av fyra teckenklasser
# IDENTITY_PEPPER skapas EN gång och byts aldrig: byts den matchar ingen hash i röstlängden.
if secret_exists identity-pepper; then echo "   identity-pepper finns redan"; else put_secret identity-pepper "$(random_hex 32)"; fi
ensure_pair pg-voters-password voters-database-url gen_voters
ensure_pair pg-votes-password votes-database-url gen_votes
ensure_pair vapid-public-key vapid-private-key gen_vapid

# --- Infrastruktur --------------------------------------------------------

log "Nätverk, loggar, register, identitet, PostgreSQL och Container Apps-miljö (tar 10–15 min första gången)"
deploy infra infra.bicep location="$LOCATION" prefix="$PREFIX" keyVaultName="$KV_NAME" \
  acrName="$ACR_NAME" postgresServerName="$PG_SERVER"
ENV_ID="$(output infra environmentId)"
ENV_DOMAIN="$(output infra environmentDefaultDomain)"
ACR_SERVER="$(output infra acrLoginServer)"
APP_IDENTITY_ID="$(output infra appIdentityId)"
PG_ADMIN="$(output infra postgresAdminLogin)"
[ "$(output infra postgresFqdn)" = "$PG_FQDN" ] || die "Postgres FQDN avviker från den i databas-URL:erna."

# --- Imagen ---------------------------------------------------------------

COMMIT="$(git_repo rev-parse --short=12 "$GIT_REF")"
IMAGE="$ACR_SERVER/election-app:$COMMIT"
az acr login --name "$ACR_NAME" --output none

if az acr manifest show-metadata --registry "$ACR_NAME" --name "election-app:$COMMIT" --output none >/dev/null 2>&1; then
  log "Imagen $IMAGE finns redan"
else
  log "Bygger $IMAGE från git archive $GIT_REF"
  mkdir -p "$WORK/src"
  # core.autocrlf=false: annars får entrypoint.sh CRLF på Windows och containern startar inte
  # ("exec /usr/local/bin/entrypoint.sh: no such file or directory").
  git_repo -c core.autocrlf=false archive "$COMMIT" | tar -x -C "$WORK/src"
  docker build --platform linux/amd64 -t "$IMAGE" "$(native_path "$WORK/src")"
  docker push "$IMAGE"
fi

PSQL_IMAGE="$ACR_SERVER/postgres:17-alpine"
if ! az acr manifest show-metadata --registry "$ACR_NAME" --name postgres:17-alpine --output none >/dev/null 2>&1; then
  log "Importerar postgres:17-alpine till registret"
  az acr import --name "$ACR_NAME" --source docker.io/library/postgres:17-alpine --image postgres:17-alpine --output none
fi

# Rolltilldelningarna i infra.bicep kan ta några minuter att slå igenom, och
# Container Apps prövar Key Vault-åtkomsten redan när resursen skapas.
deploy_retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if deploy "$@"; then return 0; fi
    echo "   försök $attempt misslyckades, väntar 60 s (rolltilldelningar kan vara på väg)"
    sleep 60
  done
  die "Distributionen $1 misslyckades."
}

# --- Databasroller --------------------------------------------------------

log "Databasroller (db-init-jobbet)"
deploy_retry db-init-job db-init-job.bicep location="$LOCATION" prefix="$PREFIX" environmentId="$ENV_ID" \
  acrLoginServer="$ACR_SERVER" appIdentityId="$APP_IDENTITY_ID" keyVaultUri="$KV_URI" \
  postgresFqdn="$PG_FQDN" postgresAdminLogin="$PG_ADMIN" psqlImage="$PSQL_IMAGE"
JOB_NAME="$(output db-init-job jobName)"
EXECUTION="$(az containerapp job start --name "$JOB_NAME" --resource-group "$RESOURCE_GROUP" --query name -o tsv | tr -d '\r')"
echo "   körning $EXECUTION"
for _ in $(seq 1 60); do
  STATUS="$(az containerapp job execution show --name "$JOB_NAME" --resource-group "$RESOURCE_GROUP" \
    --job-execution-name "$EXECUTION" --query properties.status -o tsv | tr -d '\r')"
  case "$STATUS" in
    Succeeded) echo "   klart"; break ;;
    Failed|Stopped|Degraded) die "db-init-jobbet slutade med $STATUS. Se loggarna i Log Analytics (ContainerAppConsoleLogs_CL)." ;;
    *) sleep 10 ;;
  esac
done
[ "$STATUS" = "Succeeded" ] || die "db-init-jobbet blev inte klart i tid (status $STATUS)."

# --- Applikationen --------------------------------------------------------

log "Container App med $IMAGE"
deploy_retry app app.bicep location="$LOCATION" prefix="$PREFIX" environmentId="$ENV_ID" \
  environmentDefaultDomain="$ENV_DOMAIN" acrLoginServer="$ACR_SERVER" appIdentityId="$APP_IDENTITY_ID" \
  keyVaultUri="$KV_URI" image="$IMAGE" extraAppOrigins="$EXTRA_APP_ORIGINS"
URL="$(output app url)"

log "Väntar på att $URL svarar"
for _ in $(seq 1 40); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL/api/elections" || true)"
  if [ "$CODE" = "200" ]; then
    echo "   $URL/api/elections svarar 200"
    printf '\nKlart.\n  URL:        %s\n  Image:      %s\n  Resursgrupp: %s (%s)\n' "$URL" "$IMAGE" "$RESOURCE_GROUP" "$LOCATION"
    exit 0
  fi
  sleep 15
done
die "Appen svarade inte 200 på $URL/api/elections (senast: $CODE). Se: az containerapp logs show -n ${PREFIX}-app -g $RESOURCE_GROUP"
