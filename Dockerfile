FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# ---------------------------------------------------------------------------
# OM VALET AV BASE IMAGE
#
# node:22-alpine är ungefär 150 MB och innehåller node, npm och en shell.
# Mindre alternativ finns men passar inte den här appen:
#
#   – gcr.io/distroless/nodejs22 är ~110 MB men har VARKEN shell eller npm.
#     Entrypoint kör `npx prisma migrate deploy` och `npx tsx prisma/seed.ts`
#     vid uppstart, så containern skulle inte starta alls. Vinsten vore 40 MB.
#
#   – Att bygga från rena alpine och installera node manuellt ger ingen
#     mätbar vinst mot node:22-alpine.
#
# Base image var aldrig det som gjorde imagen stor. Det var att hela
# utvecklingsberoendekedjan kopierades in — se runner-steget nedan.
# ---------------------------------------------------------------------------

# --- Beroenden -------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json* ./
# --ignore-scripts: postinstall kör `prisma generate`, och schemafilerna finns
# inte i det här steget. Genereringen sker explicit i builder-steget i stället.
RUN npm ci --ignore-scripts

# --- Produktionsberoenden --------------------------------------------------
#
# Ett eget steg med BARA det som behövs vid körning. Det är hela skillnaden
# mellan en image på 1,5 GB och en på en bråkdel: builder-steget drar in
# TypeScript, Playwright, esbuild och SWC-binärer för varje plattform, och
# ingenting av det körs i drift.
#
# `prisma` och `tsx` ligger i dependencies, inte devDependencies, och det är
# avsiktligt: i den här driftmodellen kör entrypoint migreringar och seedning
# vid uppstart, så de ÄR körningsberoenden.
FROM base AS prod-deps
COPY package.json package-lock.json* ./
# Beskärningen sker i SAMMA lager som installationen, och det är inte en
# stilfråga. Docker-lager är additiva: filer som tas bort i ett senare lager
# ligger kvar i det tidigare och följer med imagen ändå. Ett `rm` i ett eget
# RUN-steg hade sett ut att fungera utan att minska imagen en byte.
#
# @next/swc-* är 273 MB kompilatorbinärer. Att de inte behövs vid körning är
# inte en gissning: Next.js egna standalone-utdata utesluter dem, och den
# servern startar med `node server.js` och kompilerar ingenting.
#
# typescript stannar, trots att den ser ut som ett utvecklingsberoende.
# @prisma/client och prisma CLI beror båda på den.
RUN npm ci --omit=dev --ignore-scripts  && rm -rf node_modules/@next/swc-*  && npm cache clean --force 2>/dev/null || true

# --- Bygg ------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Två Prisma-scheman ⇒ två genererade klienter.
RUN npx prisma generate --schema=prisma/voters/schema.prisma \
 && npx prisma generate --schema=prisma/votes/schema.prisma

# Placeholders: next build behöver att variablerna finns, men ansluter aldrig.
ENV VOTERS_DATABASE_URL="postgresql://build:build@localhost:5432/voters_db"
ENV VOTES_DATABASE_URL="postgresql://build:build@localhost:5432/votes_db"
ENV IDENTITY_PEPPER="build-time-placeholder-aldrig-anvand-i-runtime-000"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- Generering mot produktionsträdet --------------------------------------
#
# Klienterna genereras OM, mot produktionsberoendena. Att kopiera dem från
# builder-steget vore frestande men fel: de ligger i node_modules/.prisma, och
# att blanda filer från två olika beroendeträd ger subtila versionskrockar
# mellan klienten och @prisma/client.
FROM base AS client-gen
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY prisma ./prisma
RUN npx prisma generate --schema=prisma/voters/schema.prisma \
 && npx prisma generate --schema=prisma/votes/schema.prisma

# --- Körning ---------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Produktionsträdet med de genererade Prisma-klienterna i.
#
# Klienterna genereras in i node_modules/.prisma och inte under src/. Prisma
# kopierar sin runtime till utdatakatalogen, och den filen anropar
# os.homedir(). Ligger den utanför node_modules försöker Next.js filspårning
# expandera anropet statiskt och skanna hela användarkatalogen, vilket kraschar
# bygget på Windows. Next hoppar alltid över node_modules vid spårning.
COPY --from=client-gen /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma

# Seed-skriptet importerar krypto- och nyckelfunktionerna relativt från
# src/lib. Att det är SAMMA implementation som applikationen är avgörande: en
# identitetshash räknad på annat sätt matchar inte när väljaren sedan
# legitimerar sig (se prisma/seed.ts).
#
# Standalone-utdatan innehåller bara de spårade serverfilerna, inte den råa
# källkoden — utan de här raderna faller entrypoint på `Cannot find module
# '../src/lib/crypto'`, och eftersom den kör med `set -e` startar
# applikationen aldrig.
COPY --from=builder /app/src/lib ./src/lib
COPY --from=builder /app/tsconfig.json ./tsconfig.json

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Kör som icke-root. node-användaren finns redan i basimagen.
#
# En container som kör som root och blir komprometterad ger angriparen root i
# containern, vilket är första steget mot att bryta ut ur den. Här finns inget
# behov: servern binder port 3000, inte en privilegierad port.
RUN chown -R node:node /app
USER node

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
