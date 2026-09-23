-- ---------------------------------------------------------------------------
-- Skapar TVÅ separata databaser i samma PostgreSQL-instans.
--
-- Detta är kärnan i hela säkerhetsmodellen. PostgreSQL tillåter inte foreign
-- keys mellan databaser. Genom att lägga röstlängden i en databas och de
-- anonyma rösterna i en annan blir det fysiskt omöjligt att skapa en relation
-- mellan en väljare och en röst — även av misstag, även av en utvecklare som
-- inte läst dokumentationen, även av en framtida migration.
--
-- Jämför med alternativet "två tabeller i samma databas utan foreign key":
-- där är separationen bara en konvention, och en enda `JOIN` räcker för att
-- bryta den.
-- ---------------------------------------------------------------------------

CREATE DATABASE votes_db;

-- voters_db skapas av POSTGRES_DB i docker-compose.yml.

GRANT ALL PRIVILEGES ON DATABASE votes_db TO election;
GRANT ALL PRIVILEGES ON DATABASE voters_db TO election;

-- ---------------------------------------------------------------------------
-- Testdatabaser för integrationstesterna.
--
-- Testerna tömmer databaserna före varje test. Mot voters_db/votes_db skulle
-- det radera det som utvecklingsservern visar i webbläsaren, så testerna har
-- ett eget par med samma uppdelning — två databaser, av samma skäl som ovan.
-- tests/setup.ts pekar om klienterna hit, och testhjälparen vägrar tömma en
-- databas vars namn inte slutar på _test.
--
-- Skriptet körs bara när volymen är tom. En befintlig installation får
-- databaserna ändå: tests/global-setup.ts kör `prisma migrate deploy` mot dem
-- före varje testkörning, och det skapar en databas som saknas.
-- ---------------------------------------------------------------------------

CREATE DATABASE voters_test;
CREATE DATABASE votes_test;

GRANT ALL PRIVILEGES ON DATABASE voters_test TO election;
GRANT ALL PRIVILEGES ON DATABASE votes_test TO election;
