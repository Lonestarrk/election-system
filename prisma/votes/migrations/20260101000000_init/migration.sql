-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "election" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "opens_at" TIMESTAMP(3) NOT NULL,
    "closes_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "election_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "election_ballot" (
    "id" TEXT NOT NULL,
    "election_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "area_code" TEXT,
    "allows_candidate_vote" BOOLEAN NOT NULL DEFAULT false,
    "display_order" INTEGER NOT NULL,

    CONSTRAINT "election_ballot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "party" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL,

    CONSTRAINT "party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ballot_party" (
    "id" TEXT NOT NULL,
    "ballot_id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL,

    CONSTRAINT "ballot_party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate" (
    "id" TEXT NOT NULL,
    "ballot_party_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL,

    CONSTRAINT "candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ballot_option" (
    "id" TEXT NOT NULL,
    "ballot_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL,

    CONSTRAINT "ballot_option_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anonymous_vote" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "ballot_id" TEXT NOT NULL,
    "ballot_party_id" TEXT,
    "candidate_id" TEXT,
    "option_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "anonymous_vote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "election_ballot_election_id_idx" ON "election_ballot"("election_id");

-- CreateIndex
CREATE UNIQUE INDEX "party_name_key" ON "party"("name");

-- CreateIndex
CREATE UNIQUE INDEX "party_abbreviation_key" ON "party"("abbreviation");

-- CreateIndex
CREATE INDEX "ballot_party_party_id_idx" ON "ballot_party"("party_id");

-- CreateIndex
CREATE UNIQUE INDEX "ballot_party_ballot_id_party_id_key" ON "ballot_party"("ballot_id", "party_id");

-- CreateIndex
CREATE INDEX "candidate_ballot_party_id_idx" ON "candidate"("ballot_party_id");

-- CreateIndex
CREATE INDEX "ballot_option_ballot_id_idx" ON "ballot_option"("ballot_id");

-- CreateIndex
CREATE UNIQUE INDEX "anonymous_vote_token_hash_key" ON "anonymous_vote"("token_hash");

-- CreateIndex
CREATE INDEX "anonymous_vote_ballot_id_idx" ON "anonymous_vote"("ballot_id");

-- CreateIndex
CREATE INDEX "anonymous_vote_ballot_party_id_idx" ON "anonymous_vote"("ballot_party_id");

-- CreateIndex
CREATE INDEX "anonymous_vote_candidate_id_idx" ON "anonymous_vote"("candidate_id");

-- CreateIndex
CREATE INDEX "anonymous_vote_option_id_idx" ON "anonymous_vote"("option_id");

-- AddForeignKey
ALTER TABLE "election_ballot" ADD CONSTRAINT "election_ballot_election_id_fkey" FOREIGN KEY ("election_id") REFERENCES "election"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ballot_party" ADD CONSTRAINT "ballot_party_ballot_id_fkey" FOREIGN KEY ("ballot_id") REFERENCES "election_ballot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ballot_party" ADD CONSTRAINT "ballot_party_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate" ADD CONSTRAINT "candidate_ballot_party_id_fkey" FOREIGN KEY ("ballot_party_id") REFERENCES "ballot_party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ballot_option" ADD CONSTRAINT "ballot_option_ballot_id_fkey" FOREIGN KEY ("ballot_id") REFERENCES "election_ballot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anonymous_vote" ADD CONSTRAINT "anonymous_vote_ballot_id_fkey" FOREIGN KEY ("ballot_id") REFERENCES "election_ballot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anonymous_vote" ADD CONSTRAINT "anonymous_vote_ballot_party_id_fkey" FOREIGN KEY ("ballot_party_id") REFERENCES "ballot_party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anonymous_vote" ADD CONSTRAINT "anonymous_vote_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anonymous_vote" ADD CONSTRAINT "anonymous_vote_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "ballot_option"("id") ON DELETE SET NULL ON UPDATE CASCADE;

