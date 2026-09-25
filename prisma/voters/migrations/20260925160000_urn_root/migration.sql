-- Uppgift 12b: urnroten (ruling 134).
--
-- Kuvertroten binder chifferhash och signatur och går inte att räkna om efter
-- stängningen, eftersom signaturerna raderas. Stängningen räknar därför också
-- en urnrot, en Merklerot över valsedel och chifferhash för varje rad som
-- flyttas till urnan, kopior inräknade, och skriver den här, i samma sats som
-- STRIPPED och kuvertroten. Räkningen och slutkontrollen räknar om den ur
-- votes_db. Roten ligger i röstlängden, och inte bredvid urnan, så att den som
-- bara kan skriva i röstdatabasen inte kan skriva om den.
--
-- Samma rot står i posten LINK_CLEARED i revisionskedjan, och ingår i postens
-- hash. Kolumnen är tom för alla andra poster, och för poster från före
-- uppgiften, vars hash därför är oförändrad.
--
-- Båda kolumnerna får vara tomma: en omröstning som skalades före uppgiften
-- har ingen urnrot, och räkningen vägrar den med ett besked.

-- AlterTable
ALTER TABLE "election" ADD COLUMN     "urn_root" TEXT;

-- AlterTable
ALTER TABLE "audit_event" ADD COLUMN     "urn_root" TEXT;
