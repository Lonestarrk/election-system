import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { votesDb } from '@/modules/ballot-box/db'
import { listOpenElections } from '@/modules/ballot-box/election.service'
import { createElection } from '@/orchestration/create-election.usecase'
import { disconnect, firstPartyId, isDatabaseAvailable, resetElectionData } from './helpers'

/**
 * VILKA OMRÖSTNINGAR SOM RÄKNAS SOM ÖPPNA.
 *
 * Regeln var korrekt men otestad, och det räckte för att kosta en
 * felsökningsrunda. Integrationstesterna lämnade kvar en omröstning med ett
 * kort tidsfönster; nästa dag hade det gått ut, listan var tom, och
 * gränssnittet svarade "välj vilken omröstning du vill rösta i" — en
 * uppmaning som inte går att följa när det inte finns något att välja.
 *
 * Felet låg alltså inte här. Men att regeln är otestad gör att nästa ändring
 * av den inte märks förrän någon sitter framför en tom rullgardin, så den
 * vaktas nu på den nivå där den faktiskt avgörs.
 *
 * Gränsfallen speglas i tests/unit/election-seed-report.test.ts, som kräver
 * att seedningens besked om "öppen" använder samma villkor. Glider de isär
 * rapporterar seedningen framgång för något appen inte visar.
 */

const databaseAvailable = await isDatabaseAvailable()

if (!databaseAvailable) {
  console.warn('\n  Databasen är inte tillgänglig — öppna-omröstningar-testerna hoppas över.\n')
}

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

/** Skapar en omröstning med ett angivet tidsfönster. */
async function electionWithWindow(name: string, opensAt: Date, closesAt: Date): Promise<string> {
  const partyId = await firstPartyId()

  const outcome = await createElection({
    name,
    kind: 'RIKSDAGSVAL',
    opensAt,
    closesAt,
    ballots: [
      { kind: 'RIKSDAG', label: 'Riksdagen', allowsCandidateVote: false, parties: [{ partyId }] },
    ],
    trusteePassphrases: ['test-fras-ett', 'test-fras-tva', 'test-fras-tre'],
  })

  if (outcome.status !== 'created') throw new Error(`Kunde inte skapa ${name}.`)
  return outcome.election.id
}

const minutes = (count: number) => count * 60_000

describe.skipIf(!databaseAvailable)('listOpenElections', () => {
  beforeEach(async () => {
    await resetElectionData()
  })

  it('listar en omröstning vars fönster är igång', async () => {
    const id = await electionWithWindow(
      'Pågående',
      new Date(Date.now() - minutes(10)),
      new Date(Date.now() + minutes(60)),
    )

    const open = await listOpenElections()

    expect(open.map((election) => election.id)).toContain(id)
  })

  it('utesluter en omröstning som redan stängt', async () => {
    /**
     * EXAKT DET SOM HÄNDE.
     *
     * En testomröstning med ett fönster på en timme låg kvar i databasen.
     * Dagen efter var den stängd, och eftersom seedningen hoppade över att
     * skapa den riktiga omröstningen fanns ingen annan. Resultatet var en tom
     * lista och en knapp som inte gjorde någonting.
     */
    await electionWithWindow(
      'Stängd igår',
      new Date(Date.now() - minutes(120)),
      new Date(Date.now() - minutes(60)),
    )

    const open = await listOpenElections()

    expect(open).toHaveLength(0)
  })

  it('utesluter en omröstning som inte öppnat än', async () => {
    await electionWithWindow(
      'Öppnar senare',
      new Date(Date.now() + minutes(60)),
      new Date(Date.now() + minutes(120)),
    )

    const open = await listOpenElections()

    expect(open).toHaveLength(0)
  })

  it('tar bara med den öppna när både öppen och stängd finns', async () => {
    // Det är inte samma sak som föregående test: här måste filtret välja,
    // inte bara svara tomt.
    await electionWithWindow(
      'Stängd',
      new Date(Date.now() - minutes(120)),
      new Date(Date.now() - minutes(60)),
    )
    const öppen = await electionWithWindow(
      'Öppen',
      new Date(Date.now() - minutes(10)),
      new Date(Date.now() + minutes(60)),
    )

    const open = await listOpenElections()

    expect(open).toHaveLength(1)
    expect(open[0]!.id).toBe(öppen)
  })

  it('en stängd omröstning finns kvar i databasen — den filtreras bara bort', async () => {
    /**
     * Skillnaden spelar roll för rättningen. Vore raden borta skulle en
     * omseedning skapa en ny; eftersom den finns kvar hoppar seedningen över
     * steget, och `reset:votes` bevarar dessutom Valet 2026 med namn. Därför
     * måste beskedet från seedningen innehålla en åtgärd.
     */
    await electionWithWindow(
      'Stängd men kvar',
      new Date(Date.now() - minutes(120)),
      new Date(Date.now() - minutes(60)),
    )

    expect(await listOpenElections()).toHaveLength(0)
    expect(await votesDb.election.count({ where: { name: 'Stängd men kvar' } })).toBe(1)
  })
})
