-- Härdningen, punkt 3: omröstningen bär sin BankID-miljö.
--
-- none, test eller production: den BankID-miljö omröstningen skapades mot. En
-- server vägrar läggning, stängning, räkning, publicering och fastställande i en
-- omröstning från en annan miljö, som för läget, och publiceringen bär miljön.
--
-- RADER SOM FINNS. En demoomröstning går med attrappen och får none. En skarp
-- omröstning som redan finns kan bara ha skapats mot testmiljön: skarpt läge
-- startar inte utan BANKID_ENV (kravet bankid-env), och mot produktionen stoppas
-- det av kravet bankid-reader-tested, som ingen server har uppfyllt. Den får
-- därför test. Ett annat värde i mode än DEMO och SHARP vägras av varje server
-- och får none.
--
-- Migreringen går att köra på en databas med data, som Azure-demon: kolumnen
-- läggs till med ett förval, så att varje befintlig rad får ett värde, raderna i
-- skarpt läge skrivs om, och förvalet tas bort, eftersom skapandet alltid skriver
-- miljön uttryckligen.

-- AlterTable
ALTER TABLE "election" ADD COLUMN "bank_id_environment" TEXT NOT NULL DEFAULT 'none';

UPDATE "election" SET "bank_id_environment" = 'test' WHERE "mode" = 'SHARP';

ALTER TABLE "election" ALTER COLUMN "bank_id_environment" DROP DEFAULT;
