-- Uppgift 15: blindsigneringen och det gamla röstflödet tas bort.
--
-- vote bar det gamla flödets röster i klartext, med röstintyg och token, och
-- election_commitment var åtagandena över den tabellen. Kuvertmodellens urna är
-- encrypted_vote, och urnroten ligger i röstlängden och i revisionskedjan. De
-- rörs inte här.
--
-- Raderna försvinner med tabellerna. Det är avsett: ingen kod läser dem längre,
-- och en databas med röster i det gamla flödet fanns bara som demo.

-- DropTable
DROP TABLE "vote";

-- DropTable
DROP TABLE "election_commitment";

-- AlterTable
ALTER TABLE "election_ballot" DROP COLUMN "signing_public_key_pem";
