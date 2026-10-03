#!/bin/sh
set -e

echo "==> Migrerar röstlängdsdatabasen (voters_db)"
npx prisma migrate deploy --schema=prisma/voters/schema.prisma

echo "==> Migrerar den anonyma röstdatabasen (votes_db)"
npx prisma migrate deploy --schema=prisma/votes/schema.prisma

# Seedningen skapar demovalet med förtroendemännens kända fraser och en administratör med
# ett känt personnummer, och vägrar själv köra utanför demoläget (uppgift 17). Skarpt läge är
# förvalt, så här seedas bara när DEMO_MODE uttryckligen är true.
if [ "$DEMO_MODE" = "true" ]; then
  echo "==> Seedar demodata"
  npx tsx prisma/seed.ts
else
  echo "==> Seedar inte: DEMO_MODE är inte true, och skarpt läge är förvalt"
fi

echo "==> Startar applikationen på http://localhost:3000"
exec "$@"
