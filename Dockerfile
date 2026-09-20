FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# --- Beroenden -------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json* ./
# --ignore-scripts: postinstall kör `prisma generate`, och schemafilerna finns
# inte i det här steget. Genereringen sker explicit i builder-steget i stället.
RUN npm install --ignore-scripts

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

# --- Körning ---------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# node_modules hämtas från builder, inte från deps: det är där de genererade
# Prisma-klienterna ligger (node_modules/.prisma/voters och /votes).
#
# Klienterna genereras medvetet in i node_modules i stället för under src/.
# Prisma kopierar sin runtime till utdatakatalogen, och den runtime-filen
# innehåller ett anrop till os.homedir(). Ligger den utanför node_modules
# försöker Next.js filspårning expandera anropet och skanna hela
# användarkatalogen, vilket får bygget att krascha på Windows. Next hoppar
# alltid över node_modules vid spårning.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
