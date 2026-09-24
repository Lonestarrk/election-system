-- ---------------------------------------------------------------------------
-- En roll per databas, körd som Postgres-administratören av db-init-jobbet.
--
-- Lokalt ansluter appen till båda databaserna som samma användare. Här får
-- varje databas en egen roll som bara kan ansluta till sin egen: den som har
-- VOTERS_DATABASE_URL kan inte ens öppna en anslutning till votes_db, och
-- tvärtom. Separationen mellan identitet och röst gäller då också
-- inloggningsuppgifterna, inte bara schemat.
--
-- Idempotent: körs om vid varje distribution. Lösenorden kommer som
-- psql-variabler (-v voters_pw=... -v votes_pw=...) från Key Vault.
-- ---------------------------------------------------------------------------

SELECT 'CREATE ROLE voters_app LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'voters_app') \gexec

SELECT 'CREATE ROLE votes_app LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'votes_app') \gexec

-- Bara LOGIN och lösenord. Rollerna är redan NOSUPERUSER, NOCREATEDB och
-- NOCREATEROLE, som CREATE ROLE ger utan annat angivet. Att skriva ut det går
-- inte: Azures administratör är ingen superuser, och Postgres låter bara en
-- superuser nämna SUPERUSER-attributet alls, också för att säga nej till det.
ALTER ROLE voters_app WITH LOGIN PASSWORD :'voters_pw';
ALTER ROLE votes_app WITH LOGIN PASSWORD :'votes_pw';

-- Ingen får ansluta till en databas som inte uttryckligen släppts in.
REVOKE CONNECT, TEMPORARY ON DATABASE voters_db FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE votes_db FROM PUBLIC;

-- CREATE på databasen behövs för att den första migreringen börjar med
-- CREATE SCHEMA IF NOT EXISTS "public", och Postgres prövar rätten innan det
-- ser att schemat redan finns. Rättigheten gäller bara rollens egen databas.
GRANT CONNECT, TEMPORARY, CREATE ON DATABASE voters_db TO voters_app;
GRANT CONNECT, TEMPORARY, CREATE ON DATABASE votes_db TO votes_app;

-- Prisma migrate skapar tabellerna, så rollen behöver CREATE i schemat.
\connect voters_db
GRANT USAGE, CREATE ON SCHEMA public TO voters_app;

\connect votes_db
GRANT USAGE, CREATE ON SCHEMA public TO votes_app;
