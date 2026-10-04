-- Uppgift 15: blindsigneringen och det gamla röstflödet tas bort.
--
-- voter_ballot_status var det gamla flödets markering "har röstat", och
-- signeringsnycklarna på election_ballot var valsedlarnas nyckelpar för
-- röstintygen. Kuvertmodellens markering är voted_marker, och den rörs inte här.
--
-- Raderna i voter_ballot_status och nycklarna försvinner med kolumnerna. Det är
-- avsett: ingen kod läser dem längre, och en databas med röster i det gamla
-- flödet fanns bara som demo.

-- DropTable
DROP TABLE "voter_ballot_status";

-- AlterTable
ALTER TABLE "election_ballot" DROP COLUMN "signing_private_key_pem",
DROP COLUMN "signing_public_key_pem";
