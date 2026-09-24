import { PrismaClient as VotersClient } from '.prisma/voters'
import { PrismaClient as VotesClient } from '.prisma/votes'

/**
 * Nollställer röstdata inför en E2E-körning.
 *
 * VARFÖR DET BEHÖVS
 *
 * E2E-testerna röstar på riktigt: de utfärdar röstintyg, löser in dem och
 * förbrukar väljarnas rösträtt. En andra körning mot samma databas blockeras
 * därför av dubbelröstningsspärren — vilket är korrekt beteende och ett
 * värdelöst testresultat.
 *
 * VAD SOM RADERAS OCH VAD SOM BEHÅLLS
 *
 * Rösterna, "har röstat"-markeringarna och sessionerna raderas. Omröstningen,
 * valsedlarna, signeringsnycklarna, partiregistret och röstlängden behålls —
 * att generera nya RSA-nyckelpar vid varje körning tar sekunder i onödan, och
 * väljarna sätts ändå i rätt skick av seed-skriptet.
 *
 * Revisionsloggen raderas också, eftersom hashkedjan annars fortsätter från
 * gamla händelser och kedjekontrollen i slutkontrollen blir svårare att läsa.
 *
 * KUVERTMODELLENS TABELLER TÖMS OCKSÅ. Sedan röstsidan lägger kuvert gör
 * e2e-testerna det, och utan tömningen samlas de mellan körningarna: en väljare
 * som redan har ett liggande kuvert visar "Du har en röst registrerad" i
 * stället för en orörd valsedel, och ett test som räknar med det senare går
 * rött av förra körningens skull. Det gäller de yttre kuverten i röstlängden
 * och de inre i röstdatabasen, liksom förtroendemännens bidrag och summorna,
 * som bara finns efter en stängning. Förtroendemännens andelar av nyckeln
 * behålls, eftersom omröstningen behålls.
 *
 * SKRIPTET ÄR AVSIKTLIGT SKILT FRÅN APPLIKATIONEN.
 *
 * Det finns ingen motsvarande funktion i src/ — inget API, ingen adminknapp,
 * ingen tjänst som kan radera röster. Det här är ett utvecklingsverktyg som
 * kräver direkt databasåtkomst, och det ska det fortsätta vara.
 */

const votersDb = new VotersClient()
const votesDb = new VotesClient()

async function main() {
  // Ordningen följer beroendena: rösterna först, eftersom de refererar
  // valsedlarna som behålls.
  const votes = await votesDb.vote.deleteMany()
  const commitments = await votesDb.electionCommitment.deleteMany()
  const innerEnvelopes = await votesDb.encryptedVote.deleteMany()
  await votesDb.partialDecryption.deleteMany()
  await votesDb.ballotTally.deleteMany()

  const ballotStatuses = await votersDb.voterBallotStatus.deleteMany()
  // Kuvertmodellens markering "har röstat", som skalningen skriver (uppgift 11d).
  const votedMarkers = await votersDb.votedMarker.deleteMany()
  // Före omröstningarna nedan: kuvertet har ingen främmande nyckel mot
  // valsedeln, så ett kuvert i en borttagen testomröstning skulle annars bli
  // kvar utan något att höra till.
  const outerEnvelopes = await votersDb.pendingVote.deleteMany()
  await votersDb.adminSession.deleteMany()
  await votersDb.votingSession.deleteMany()
  await votersDb.auditEvent.deleteMany()

  // Omröstningar som testerna själva skapat städas bort. Valet 2026 kommer
  // från seed-skriptet och behålls.
  await votesDb.election.deleteMany({ where: { name: { not: 'Valet 2026' } } })
  await votersDb.election.deleteMany({ where: { name: { not: 'Valet 2026' } } })

  // Status återställs: en tidigare körning kan ha fastställt eller flaggat
  // omröstningen, och då vägrar slutkontrollen i nästa körning.
  await votesDb.election.updateMany({ data: { status: 'OPEN', certifiedAt: null } })

  process.stdout.write(
    `Nollställt: ${votes.count} röster, ${commitments.count} åtaganden, ` +
      `${ballotStatuses.count} markeringar i det gamla flödet, ${votedMarkers.count} i ` +
      `kuvertmodellen, ${outerEnvelopes.count} yttre och ${innerEnvelopes.count} inre kuvert.\n`,
  )
}

main()
  .then(async () => {
    await votersDb.$disconnect()
    await votesDb.$disconnect()
  })
  .catch(async (error) => {
    process.stderr.write(`Nollställning misslyckades: ${String(error)}\n`)
    await votersDb.$disconnect()
    await votesDb.$disconnect()
    process.exit(1)
  })
