-- Fixrunda 3 av uppgift 11d, ruling 130: urnan tål två kuvert med samma
-- chiffer.
--
-- Den som lägger en kopia av någon annans valsedel lägger en giltig röst, och
-- läggningen skiljer inte en kopia från en ny valsedel. Ett svar som gjorde
-- det vore ett orakel för en köpare. Med chifferhashen unik här gick bara ett
-- av två likadana kuvert att flytta, och varje stängning stoppades. Urnans
-- rader nycklas i stället per kuvert: id:t härleds ur chifferhashen,
-- valsedeln och ett löpnummer bland likadana kuvert, och primärnyckeln bär
-- idempotensen. Hashen får ett vanligt index för återläsningen och
-- städningen.

-- DropIndex
DROP INDEX "encrypted_vote_ciphertext_hash_key";

-- CreateIndex
CREATE INDEX "encrypted_vote_ciphertext_hash_idx" ON "encrypted_vote"("ciphertext_hash");
