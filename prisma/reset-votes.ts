import { PrismaClient as VotersClient } from '.prisma/voters'
import { PrismaClient as VotesClient } from '.prisma/votes'
import { demoElectionWindow } from '../src/lib/demo-election'

/**
 * Nollställer röstdata inför en E2E-körning.
 *
 * VARFÖR DET BEHÖVS
 *
 * E2E-testerna röstar på riktigt: de lägger kuvert och stänger omröstningar. En andra
 * körning mot samma databas utgår annars från det förra körningen lämnade.
 *
 * VAD SOM RADERAS OCH VAD SOM BEHÅLLS
 *
 * Kuverten, "har röstat"-markeringarna och sessionerna raderas. Omröstningen,
 * valsedlarna, partiregistret och röstlängden behålls — att skapa dem på nytt vid varje
 * körning vore sekunder i onödan, och väljarna sätts ändå i rätt skick av seed-skriptet.
 *
 * Revisionsloggen raderas också, eftersom hashkedjan annars fortsätter från
 * gamla händelser och kedjekontrollen i slutkontrollen blir svårare att läsa.
 *
 * Utan tömningen av kuverten samlas de mellan körningarna: en väljare
 * som redan har ett liggande kuvert visar "Du har en röst registrerad" i
 * stället för en orörd valsedel, och ett test som räknar med det senare går
 * rött av förra körningens skull. Det gäller de yttre kuverten i röstlängden
 * och de inre i röstdatabasen, liksom förtroendemännens bidrag och summorna,
 * som bara finns efter en stängning. Förtroendemännens andelar av nyckeln
 * behålls, eftersom omröstningen behålls.
 *
 * SKRIPTET ÄR AVSIKTLIGT SKILT FRÅN APPLIKATIONEN.
 *
 * I skarpt läge finns ingen motsvarande funktion i src/ — inget API, ingen
 * adminknapp, ingen tjänst som kan radera röster. Det här är ett
 * utvecklingsverktyg som kräver direkt databasåtkomst, och det ska det
 * fortsätta vara. Det enda undantaget är demoläget (uppgift 12c): rutten
 * /api/demo/reset-election återställer demovalet, och bara det, bakom
 * `isDemoMode()`, adminsessionen och CSRF. Den skriver en revisionspost,
 * medan det här skriptet tömmer hela kedjan.
 */

const votersDb = new VotersClient()
const votesDb = new VotesClient()

async function main() {
  const innerEnvelopes = await votesDb.encryptedVote.deleteMany()
  await votesDb.partialDecryption.deleteMany()
  await votesDb.ballotTally.deleteMany()

  // Markeringen "har röstat", som skalningen skriver (uppgift 11d).
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
  // omröstningen, och då vägrar slutkontrollen i nästa körning. Räkningens
  // tidpunkt nollställs också: räkningen skriver den bara när den saknas, så
  // en gammal timme hade annars stått kvar efter nästa räkning.
  await votesDb.election.updateMany({ data: { status: 'OPEN', certifiedAt: null, tallyCompletedAt: null } })

  // Fasen och rötterna i röstlängden återställs också (uppgift 12c). Utan det
  // står en omröstning som en tidigare körning stängde kvar i STRIPPED eller
  // CERTIFIED, med en tom urna, och ingen läggning tas emot. Rötterna och
  // tidpunkten för raderingen hör till fasen och nollställs med den.
  await votersDb.election.updateMany({
    data: { phase: 'OPEN', envelopeRoot: null, urnRoot: null, linkClearedAt: null },
  })

  // Demovalets tider flyttas fram från idag (ruling 136). Annars har valet
  // stängt för läggning när dagarna gått, och ingen kan rösta i det. Bara
  // demovalet, vid namn: en testomröstning har sina egna tider.
  const window = demoElectionWindow()
  await votersDb.election.updateMany({ where: { name: 'Valet 2026' }, data: window })
  await votesDb.election.updateMany({ where: { name: 'Valet 2026' }, data: window })

  process.stdout.write(
    `Nollställt: ${votedMarkers.count} markeringar, ` +
      `${outerEnvelopes.count} yttre och ${innerEnvelopes.count} inre kuvert.
`,
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
