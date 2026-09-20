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
