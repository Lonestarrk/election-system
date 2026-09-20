-- Den anonyma röstdatabasen. Inga kolumner som kan kopplas till en väljare.

CREATE TABLE "party" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL,

    CONSTRAINT "party_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "party_name_key" ON "party"("name");
CREATE UNIQUE INDEX "party_abbreviation_key" ON "party"("abbreviation");

CREATE TABLE "anonymous_vote" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "anonymous_vote_pkey" PRIMARY KEY ("id")
);

-- Unikt index: en tokenkollision blir ett hårt databasfel i stället för att
-- tyst skriva över någon annans röst.
CREATE UNIQUE INDEX "anonymous_vote_token_hash_key" ON "anonymous_vote"("token_hash");

CREATE INDEX "anonymous_vote_party_id_idx" ON "anonymous_vote"("party_id");

ALTER TABLE "anonymous_vote"
    ADD CONSTRAINT "anonymous_vote_party_id_fkey"
    FOREIGN KEY ("party_id") REFERENCES "party"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
