-- Byter namn pa anonymous_vote till vote.
--
-- SKRIVEN FOR HAND, OCH DET AR AVSIKTLIGT.
--
-- `prisma migrate diff` kan inte upptacka ett namnbyte. Den ser en tabell som
-- forsvinner och en ny som tillkommer, och genererar DROP TABLE + CREATE
-- TABLE. Kord mot en databas med riktiga roster hade det tomt urnan.
--
-- ALTER TABLE ... RENAME bevarar raderna. Indexen och villkoren doper om sig
-- inte automatiskt, och Prisma forvantar sig namn som foljer tabellnamnet, sa
-- de raknas upp explicit nedan. Missas det fungerar databasen anda men nasta
-- `migrate diff` vill "rakna om" dem, vilket ger en meningslos diff for alltid.
--
-- VARFOR NAMNET BYTTES: "anonymous" sarskiljde ingenting — varje rost i den
-- har databasen ar anonym. Och ett namn som pastar en egenskap blir betrott i
-- stallet for kontrollerat. Det som faktiskt haller invarianten ar
-- tests/security/schema-separation.test.ts, som raknar upp forbjudna falt.

ALTER TABLE "anonymous_vote" RENAME TO "vote";

ALTER INDEX "anonymous_vote_pkey" RENAME TO "vote_pkey";
ALTER INDEX "anonymous_vote_token_hash_key" RENAME TO "vote_token_hash_key";
ALTER INDEX "anonymous_vote_credential_id_key" RENAME TO "vote_credential_id_key";
ALTER INDEX "anonymous_vote_ballot_id_idx" RENAME TO "vote_ballot_id_idx";
ALTER INDEX "anonymous_vote_ballot_party_id_idx" RENAME TO "vote_ballot_party_id_idx";
ALTER INDEX "anonymous_vote_candidate_id_idx" RENAME TO "vote_candidate_id_idx";
ALTER INDEX "anonymous_vote_option_id_idx" RENAME TO "vote_option_id_idx";

ALTER TABLE "vote" RENAME CONSTRAINT "anonymous_vote_ballot_id_fkey" TO "vote_ballot_id_fkey";
ALTER TABLE "vote" RENAME CONSTRAINT "anonymous_vote_ballot_party_id_fkey" TO "vote_ballot_party_id_fkey";
ALTER TABLE "vote" RENAME CONSTRAINT "anonymous_vote_candidate_id_fkey" TO "vote_candidate_id_fkey";
ALTER TABLE "vote" RENAME CONSTRAINT "anonymous_vote_option_id_fkey" TO "vote_option_id_fkey";
