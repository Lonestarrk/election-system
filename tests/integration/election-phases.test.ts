import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { GET } from '@/app/api/elections/route'
import { votersDb } from '@/modules/eligibility/db'
import { createElection } from '@/orchestration/create-election.usecase'
import { disconnect, firstPartyId, isDatabaseAvailable, resetElectionData } from './helpers'

/**
 * FASEN I DEN OFFENTLIGA LISTAN (uppgift 14e, spec 6.2).
 *
 * Röstsidans bevakning läste fasen ur väljarens session, vars gräns delas av
 * alla bakom samma adress. Fasen är inte hemlig, och den offentliga listan
 * bär den nu: id, namn och fas, och ingenting annat.
 *
 * Listan väljer omröstningar på tid. En omröstning vars fas lämnat OPEN medan
 * tiden ännu inte gått ut ska ändå synas för bevakningen, med sin nya fas.
 */

const databaseAvailable = await isDatabaseAvailable()

if (!databaseAvailable) {
  console.warn('\n  Databasen är inte tillgänglig — fastesterna hoppas över.\n')
}

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

const minutes = (count: number) => count * 60_000

async function openElection(name: string): Promise<string> {
  const partyId = await firstPartyId()
  const outcome = await createElection({
    name,
    kind: 'RIKSDAGSVAL',
    opensAt: new Date(Date.now() - minutes(10)),
    closesAt: new Date(Date.now() + minutes(60)),
    ballots: [
      { kind: 'RIKSDAG', label: 'Riksdagen', allowsCandidateVote: false, parties: [{ partyId }] },
    ],
    trusteePassphrases: ['test-fras-ett', 'test-fras-tva', 'test-fras-tre'],
  })
  if (outcome.status !== 'created') throw new Error(`Kunde inte skapa ${name}.`)
  return outcome.election.id
}

type Phase = { id: string; name: string; phase: string }
const phasesOf = async (): Promise<Phase[]> =>
  ((await (await GET(new Request('http://localhost:3000/api/elections'))).json()) as { phases: Phase[] }).phases

describe.skipIf(!databaseAvailable)('GET /api/elections: fasen', () => {
  beforeEach(async () => {
    await resetElectionData()
  })

  it('bär id, namn och fas för en öppen omröstning', async () => {
    const id = await openElection('Pågående')

    expect(await phasesOf()).toEqual([{ id, name: 'Pågående', phase: 'OPEN' }])
  })

  it('ger bara id, namn och fas: inga antal och inga tal under röstningen', async () => {
    await openElection('Pågående')

    for (const entry of await phasesOf()) {
      expect(Object.keys(entry).sort()).toEqual(['id', 'name', 'phase'])
      expect(Object.values(entry).every((value) => typeof value === 'string')).toBe(true)
    }
    // Och ingenting annat i listan om fasen: inga räknare på svaret som helhet.
    expect(Object.keys(await (await GET(new Request('http://localhost:3000/api/elections'))).json()).sort()).toEqual(['elections', 'phases'])
  })

  it('en omröstning som stängts före sin tid syns med sin nya fas', async () => {
    const id = await openElection('Stängd i förtid')
    await votersDb.election.update({ where: { id }, data: { phase: 'CLOSED' } })

    // Tiden har inte gått ut, så den står kvar i listan över öppna...
    const body = (await (await GET(new Request('http://localhost:3000/api/elections'))).json()) as {
      elections: Array<{ id: string }>
      phases: Phase[]
    }
    expect(body.elections.map((election) => election.id)).toContain(id)

    // ...och fasen säger att den inte längre tar emot röster.
    expect(body.phases).toEqual([{ id, name: 'Stängd i förtid', phase: 'CLOSED' }])
  })
})
