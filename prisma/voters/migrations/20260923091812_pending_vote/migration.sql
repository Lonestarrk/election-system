-- AlterTable
ALTER TABLE "election" ADD COLUMN     "envelope_root" TEXT,
ADD COLUMN     "link_cleared_at" TIMESTAMP(3),
ADD COLUMN     "phase" TEXT NOT NULL DEFAULT 'OPEN';

-- CreateTable
CREATE TABLE "pending_vote" (
    "id" TEXT NOT NULL,
    "voter_status_id" TEXT NOT NULL,
    "ballot_id" TEXT NOT NULL,
    "ciphertext" JSONB NOT NULL,
    "proofs" JSONB NOT NULL,
    "ciphertext_hash" TEXT NOT NULL,
    "cast_sequence" INTEGER NOT NULL,
    "bankid_signature" TEXT NOT NULL,
    "bankid_certificate" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_vote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_vote_ballot_id_idx" ON "pending_vote"("ballot_id");

-- CreateIndex
CREATE UNIQUE INDEX "pending_vote_voter_status_id_ballot_id_key" ON "pending_vote"("voter_status_id", "ballot_id");

-- AddForeignKey
ALTER TABLE "pending_vote" ADD CONSTRAINT "pending_vote_voter_status_id_fkey" FOREIGN KEY ("voter_status_id") REFERENCES "voter_status"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
