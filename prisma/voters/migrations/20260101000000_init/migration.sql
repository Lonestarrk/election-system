-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "voter_status" (
    "id" TEXT NOT NULL,
    "external_identity_hash" TEXT NOT NULL,
    "is_eligible" BOOLEAN NOT NULL DEFAULT true,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "municipality_code" TEXT,
    "region_code" TEXT,

    CONSTRAINT "voter_status_pkey" PRIMARY KEY ("id")
);

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
    "signing_private_key_pem" TEXT NOT NULL,
    "signing_public_key_pem" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL,

    CONSTRAINT "election_ballot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voter_ballot_status" (
    "id" TEXT NOT NULL,
    "voter_status_id" TEXT NOT NULL,
    "ballot_id" TEXT NOT NULL,
    "voted_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voter_ballot_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voting_session" (
    "id" TEXT NOT NULL,
    "voter_status_id" TEXT NOT NULL,
    "election_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "csrf_secret" TEXT NOT NULL,

    CONSTRAINT "voting_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_session" (
    "id" TEXT NOT NULL,
    "voter_status_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "csrf_secret" TEXT NOT NULL,

    CONSTRAINT "admin_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscription" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voter_status_external_identity_hash_key" ON "voter_status"("external_identity_hash");

-- CreateIndex
CREATE INDEX "election_ballot_election_id_idx" ON "election_ballot"("election_id");

-- CreateIndex
CREATE INDEX "voter_ballot_status_ballot_id_idx" ON "voter_ballot_status"("ballot_id");

-- CreateIndex
CREATE UNIQUE INDEX "voter_ballot_status_voter_status_id_ballot_id_key" ON "voter_ballot_status"("voter_status_id", "ballot_id");

-- CreateIndex
CREATE INDEX "voting_session_voter_status_id_idx" ON "voting_session"("voter_status_id");

-- CreateIndex
CREATE INDEX "admin_session_voter_status_id_idx" ON "admin_session"("voter_status_id");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscription_endpoint_key" ON "push_subscription"("endpoint");

-- CreateIndex
CREATE INDEX "audit_event_event_type_idx" ON "audit_event"("event_type");

-- AddForeignKey
ALTER TABLE "election_ballot" ADD CONSTRAINT "election_ballot_election_id_fkey" FOREIGN KEY ("election_id") REFERENCES "election"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voter_ballot_status" ADD CONSTRAINT "voter_ballot_status_voter_status_id_fkey" FOREIGN KEY ("voter_status_id") REFERENCES "voter_status"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voter_ballot_status" ADD CONSTRAINT "voter_ballot_status_ballot_id_fkey" FOREIGN KEY ("ballot_id") REFERENCES "election_ballot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voting_session" ADD CONSTRAINT "voting_session_voter_status_id_fkey" FOREIGN KEY ("voter_status_id") REFERENCES "voter_status"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_session" ADD CONSTRAINT "admin_session_voter_status_id_fkey" FOREIGN KEY ("voter_status_id") REFERENCES "voter_status"("id") ON DELETE CASCADE ON UPDATE CASCADE;

