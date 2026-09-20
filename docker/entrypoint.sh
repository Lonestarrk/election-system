#!/bin/sh
set -e

echo "==> Migrerar röstlängdsdatabasen (voters_db)"
npx prisma migrate deploy --schema=prisma/voters/schema.prisma

echo "==> Migrerar den anonyma röstdatabasen (votes_db)"
npx prisma migrate deploy --schema=prisma/votes/schema.prisma

echo "==> Seedar demodata"
npx tsx prisma/seed.ts

echo "==> Startar applikationen på http://localhost:3000"
exec "$@"
