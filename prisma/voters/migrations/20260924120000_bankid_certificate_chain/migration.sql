-- Uppgift 14f: kuvertet bär BankID-kedjan, krypterad, i stället för bara nyckeln.
--
-- Nyckeln i raden var just det som gjorde en förfalskning möjlig: den som kunde
-- skriva i tabellen lade in ett eget nyckelpar, och valideringen före
-- stängningen godkände det. Kedjan prövas mot BankID:s rot och kan inte bytas ut
-- på samma sätt.
--
-- Ett kuvert som redan ligger får en tom kedja. Den går inte att pröva mot någon
-- rot, och valideringen underkänner raden och stoppar skalningen, som den ska
-- för en rad utan bevis. Väljaren rättar det genom att rösta igen. Tom och inte
-- påhittad, så att raden inte ser äkta ut. Förvalet tas bort direkt, så att
-- varje ny rad måste bära en kedja.

-- AlterTable
ALTER TABLE "pending_vote" DROP COLUMN "bankid_public_key",
ADD COLUMN     "bankid_certificate_chain" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "pending_vote" ALTER COLUMN "bankid_certificate_chain" DROP DEFAULT;
