-- Uppgift 11d: markeringen "har röstat" i kuvertmodellen (spec 3.1 punkt 6).
--
-- Skalningen skriver en rad per väljare och valsedel, i samma transaktion som
-- raderar kuverten, ur de kuvert som raderas. Tabellen har ingen kolumn för
-- tid, så markeringen säger att väljaren röstade men inte när.
--
-- En egen tabell och inte voter_ballot_status. Den tabellen hör till det gamla
-- flödet, har en obligatorisk tidpunkt och läses av röstsidan som en röst i det
-- gamla flödet. Väljaren har RESTRICT, som pending_vote, så att en radering av
-- väljaren inte tyst tar markeringen med sig.

-- CreateTable
CREATE TABLE "voted_marker" (
    "id" TEXT NOT NULL,
    "voter_status_id" TEXT NOT NULL,
    "ballot_id" TEXT NOT NULL,

    CONSTRAINT "voted_marker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voted_marker_ballot_id_idx" ON "voted_marker"("ballot_id");

-- CreateIndex
CREATE UNIQUE INDEX "voted_marker_voter_status_id_ballot_id_key" ON "voted_marker"("voter_status_id", "ballot_id");

-- AddForeignKey
ALTER TABLE "voted_marker" ADD CONSTRAINT "voted_marker_voter_status_id_fkey" FOREIGN KEY ("voter_status_id") REFERENCES "voter_status"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voted_marker" ADD CONSTRAINT "voted_marker_ballot_id_fkey" FOREIGN KEY ("ballot_id") REFERENCES "election_ballot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

