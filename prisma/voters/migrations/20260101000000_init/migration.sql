-- Röstlängdsdatabasen. Inga kolumner som kan kopplas till en röst.

CREATE TABLE "voter_status" (
    "id" TEXT NOT NULL,
    "external_identity_hash" TEXT NOT NULL,
    "is_eligible" BOOLEAN NOT NULL DEFAULT true,
    "has_voted" BOOLEAN NOT NULL DEFAULT false,
    "voted_at" TIMESTAMP(3),

    CONSTRAINT "voter_status_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "voter_status_external_identity_hash_key"
    ON "voter_status"("external_identity_hash");

CREATE TABLE "voting_session" (
    "id" TEXT NOT NULL,
    "voter_status_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "csrf_secret" TEXT NOT NULL,

    CONSTRAINT "voting_session_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "voting_session_voter_status_id_idx" ON "voting_session"("voter_status_id");

ALTER TABLE "voting_session"
    ADD CONSTRAINT "voting_session_voter_status_id_fkey"
    FOREIGN KEY ("voter_status_id") REFERENCES "voter_status"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_event_event_type_idx" ON "audit_event"("event_type");
