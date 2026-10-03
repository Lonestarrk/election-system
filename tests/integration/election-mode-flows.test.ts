import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { votesDb } from '@/modules/ballot-box/db'
import { votersDb } from '@/modules/eligibility/db'
import { castVote } from '@/modules/ballot-box'
import { issueCredential } from '@/modules/eligibility/credential.service'
import { DEMO_TRUSTEE_PASSPHRASES } from '@/lib/demo-election'
import { createElection } from '@/orchestration/create-election.usecase'
import { checkElectionMode } from '@/orchestration/election-mode'
import {
  aggregate,
  completeTally,
  recountForPublication,
  submitComputedPartialDecryption,
  submitPartialDecryption,
} from '@/orchestration/tally.usecase'
import { getElectionTallyResults, publishedResults } from '@/orchestration/publish-results.usecase'
import { disconnect, isDatabaseAvailable, resetElectionData } from './helpers'

/**
 * LÄGESSPÄRREN I DET GAMLA FLÖDET, RÄKNINGEN OCH PUBLICERINGEN (uppgift 17,
 * fixrunda 1).
 *
 * Förut prövade bara läggning av kuvert, stängning och fastställande
 * omröstningens läge. Röstintygen och `castVote` i det gamla flödet, räkningens
 * ingångar, dekrypteringen och publiceringen fick en omröstning i det andra
 * läget. Här prövas varje ingång åt båda håll. Spärren står före fasen: att
 * omröstningen står i OPEN ska inte vara det som stoppar.
 */

const databaseAvailable = await isDatabaseAvailable()

if (!databaseAvailable) {
  process.stderr.write('\n  Ingen databas tillgänglig — integrationstesterna hoppas över.\n')
}

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

const FRESH: [string, string, string] = ['riktig-fras-ett-x', 'riktig-fras-tva-x', 'riktig-fras-tre-x']
const NO_ONE = '00000000-0000-4000-8000-000000000000'

async function create(demoMode: 'true' | '') {
  vi.stubEnv('DEMO_MODE', demoMode)
  const party = await votesDb.party.findFirstOrThrow({ orderBy: { displayOrder: 'asc' } })
  const outcome = await createElection({
    name: 'Lägesflödet',
    kind: 'RIKSDAGSVAL',
    opensAt: new Date(Date.now() - 60_000),
    closesAt: new Date(Date.now() + 3_600_000),
    ballots: [{ kind: 'RIKSDAG', label: 'Riksdagen', allowsCandidateVote: false, parties: [{ partyId: party.id }] }],
    trusteePassphrases: demoMode === 'true' ? [...DEMO_TRUSTEE_PASSPHRASES] : FRESH,
  })
  if (outcome.status !== 'created') throw new Error(outcome.message)
  return { id: outcome.election.id, ballotId: outcome.election.ballotIds[0]!.id }
}

describe.skipIf(!databaseAvailable)('lägesspärren i övriga ingångar', () => {
  beforeEach(async () => {
    await resetElectionData()
    if ((await votesDb.party.count()) === 0) {
      await votesDb.party.create({ data: { name: 'Testpartiet', abbreviation: 'T', color: '#000000', displayOrder: 1 } })
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // [läget omröstningen skapas i, läget servern byter till]
  const directions = [
    ['demoomröstning i skarpt läge', 'true', ''],
    ['skarp omröstning i demoläge', '', 'true'],
  ] as const

  describe.each(directions)('%s', (_label, createdIn, serverIn) => {
    it('röstintyget i det gamla flödet utfärdas inte', async () => {
      const election = await create(createdIn)
      vi.stubEnv('DEMO_MODE', serverIn)

      expect(await issueCredential(NO_ONE, election.id, election.ballotId, 'ab')).toEqual({ status: 'wrong_mode' })
    })

    it('castVote i det gamla flödet lägger ingen röst', async () => {
      const election = await create(createdIn)
      vi.stubEnv('DEMO_MODE', serverIn)

      const result = await castVote({
        ballotId: election.ballotId,
        credentialId: 'x',
        credentialSignature: 'y',
      })
      expect(result).toEqual({ status: 'wrong_mode' })
      expect(await votesDb.vote.count()).toBe(0)
    })

    it('båda sätten att lämna ett bidrag, och räkningen, vägras', async () => {
      const election = await create(createdIn)
      vi.stubEnv('DEMO_MODE', serverIn)

      expect(await submitPartialDecryption(election.ballotId, 1, 'fras')).toMatchObject({ status: 'wrong_mode' })
      expect(await submitComputedPartialDecryption(election.ballotId, 1, [])).toMatchObject({ status: 'wrong_mode' })
      expect(await completeTally(election.ballotId)).toMatchObject({ status: 'wrong_mode' })
    })

    it('summan räknas inte fram', async () => {
      const election = await create(createdIn)
      vi.stubEnv('DEMO_MODE', serverIn)

      await expect(aggregate(election.ballotId)).rejects.toThrow(/läge/)
    })

    it('omräkningen och publiceringen vägras, och inget resultat lämnas ut', async () => {
      const election = await create(createdIn)
      vi.stubEnv('DEMO_MODE', serverIn)

      expect(await recountForPublication(election.ballotId)).toMatchObject({ status: 'wrong_mode' })
      expect(await publishedResults(election.id)).toMatchObject({ status: 'wrong_mode' })
      expect(await getElectionTallyResults(election.id)).toMatchObject({ status: 'wrong_mode' })
    })

    it('spärren står före fasen: en omröstning i TALLIED vägras också', async () => {
      const election = await create(createdIn)
      await votersDb.election.update({
        where: { id: election.id },
        data: { phase: 'TALLIED', envelopeRoot: 'a', urnRoot: 'b' },
      })
      vi.stubEnv('DEMO_MODE', serverIn)

      expect(await publishedResults(election.id)).toMatchObject({ status: 'wrong_mode' })
      expect(await completeTally(election.ballotId)).toMatchObject({ status: 'wrong_mode' })
    })
  })

  describe('en omröstning i rätt läge', () => {
    it('vägras inte av lägesspärren i något av dem', async () => {
      const election = await create('true')

      expect(await issueCredential(NO_ONE, election.id, election.ballotId, 'ab')).not.toEqual({ status: 'wrong_mode' })
      expect(await submitPartialDecryption(election.ballotId, 1, 'fras')).toMatchObject({ status: 'wrong_phase' })
      expect(await publishedResults(election.id)).toMatchObject({ status: 'not_published' })
    })
  })

  describe('checkElectionMode', () => {
    it('säger ok, wrong eller unknown, och unknown för en omröstning som saknar rad i röstlängden', async () => {
      const election = await create('true')
      expect(await checkElectionMode(election.id)).toBe('ok')

      vi.stubEnv('DEMO_MODE', '')
      expect(await checkElectionMode(election.id)).toBe('wrong')
      vi.stubEnv('DEMO_MODE', 'true')

      // Fel läge bara i röstdatabasen räcker.
      await votesDb.election.update({ where: { id: election.id }, data: { mode: 'SHARP' } })
      expect(await checkElectionMode(election.id)).toBe('wrong')

      // Saknas raden i röstlängden är omröstningen okänd, och spärren säger inget om den.
      await votersDb.election.delete({ where: { id: election.id } })
      expect(await checkElectionMode(election.id)).toBe('unknown')
    })
  })
})
