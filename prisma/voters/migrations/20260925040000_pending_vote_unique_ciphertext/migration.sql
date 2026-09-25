-- Fixrunda 2 av uppgift 11d, ruling 129: två kuvert får aldrig ha samma
-- chifferhash.
--
-- Chifferhashen är unik i urnan, encrypted_vote, så två kuvert med samma
-- chiffer kan aldrig båda flyttas vid stängningen. Utan indexet här tog
-- läggningen emot samma chiffer två gånger, på två valsedlar eller från två
-- väljare, och stängningens återläsning avbröt sedan varje körning. En enda
-- väljare kunde alltså hindra valet från att stängas.
--
-- Migreringen stoppar om två kuvert redan har samma hash. De ska då utredas
-- innan indexet läggs, eftersom bara ett av dem kan räknas.

-- CreateIndex
CREATE UNIQUE INDEX "pending_vote_ciphertext_hash_key" ON "pending_vote"("ciphertext_hash");
