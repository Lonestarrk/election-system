-- AlterTable
ALTER TABLE "election" ADD COLUMN     "encryption_public_key" TEXT,
ADD COLUMN     "tally_completed_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "encrypted_vote" (
    "id" TEXT NOT NULL,
    "ballot_id" TEXT NOT NULL,
    "ciphertext" JSONB NOT NULL,
    "proofs" JSONB NOT NULL,
    "ciphertext_hash" TEXT NOT NULL,

    CONSTRAINT "encrypted_vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trustee_share" (
    "id" TEXT NOT NULL,
    "election_id" TEXT NOT NULL,
    "trustee_index" INTEGER NOT NULL,
    "public_share" TEXT NOT NULL,
    "encrypted_share" TEXT NOT NULL,

    CONSTRAINT "trustee_share_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partial_decryption" (
    "id" TEXT NOT NULL,
    "ballot_id" TEXT NOT NULL,
    "option_index" INTEGER NOT NULL,
    "trustee_index" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    "proof" JSONB NOT NULL,

    CONSTRAINT "partial_decryption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ballot_tally" (
    "id" TEXT NOT NULL,
    "ballot_id" TEXT NOT NULL,
    "option_index" INTEGER NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "ballot_tally_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "encrypted_vote_ciphertext_hash_key" ON "encrypted_vote"("ciphertext_hash");

-- CreateIndex
CREATE INDEX "encrypted_vote_ballot_id_idx" ON "encrypted_vote"("ballot_id");

-- CreateIndex
CREATE UNIQUE INDEX "trustee_share_election_id_trustee_index_key" ON "trustee_share"("election_id", "trustee_index");

-- CreateIndex
CREATE UNIQUE INDEX "partial_decryption_ballot_id_option_index_trustee_index_key" ON "partial_decryption"("ballot_id", "option_index", "trustee_index");

-- CreateIndex
CREATE UNIQUE INDEX "ballot_tally_ballot_id_option_index_key" ON "ballot_tally"("ballot_id", "option_index");

-- CreateIndex
CREATE UNIQUE INDEX "ballot_party_ballot_id_display_order_key" ON "ballot_party"("ballot_id", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_ballot_party_id_display_order_key" ON "candidate"("ballot_party_id", "display_order");

-- AddForeignKey
ALTER TABLE "encrypted_vote" ADD CONSTRAINT "encrypted_vote_ballot_id_fkey" FOREIGN KEY ("ballot_id") REFERENCES "election_ballot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trustee_share" ADD CONSTRAINT "trustee_share_election_id_fkey" FOREIGN KEY ("election_id") REFERENCES "election"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partial_decryption" ADD CONSTRAINT "partial_decryption_ballot_id_fkey" FOREIGN KEY ("ballot_id") REFERENCES "election_ballot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ballot_tally" ADD CONSTRAINT "ballot_tally_ballot_id_fkey" FOREIGN KEY ("ballot_id") REFERENCES "election_ballot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

