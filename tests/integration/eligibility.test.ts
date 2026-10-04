import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { votersDb } from '@/modules/eligibility/db'
import { evaluateEligibility } from '@/modules/eligibility/voter-status.service'
import {
  createTestElection,
  createVoter,
  disconnect,
  isDatabaseAvailable,
  resetElectionData,
  type TestElection,
} from './helpers'

const databaseAvailable = await isDatabaseAvailable()

if (!databaseAvailable) {
  process.stderr.write('\n  Ingen databas tillgänglig — integrationstesterna hoppas över.\n')
}

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

/**
 * Vem som får legitimera sig för att rösta. Själva läggningen av kuvert och
 * stängningen prövas i pending-vote.test.ts och close-election*.test.ts.
 */
describe.skipIf(!databaseAvailable)('röstberättigande vid legitimeringen', () => {
  let election: TestElection

  beforeEach(async () => {
    await resetElectionData()
    election = await createTestElection()
  })

  it('en röstberättigad person får en röstsession på sina valsedlar', async () => {
    const voterId = await createVoter('199001011234')

    const decision = await evaluateEligibility('199001011234', election.electionId)

    expect(decision).toMatchObject({ outcome: 'eligible', voterStatusId: voterId })
    if (decision.outcome !== 'eligible') return
    expect(decision.ballots.map((ballot) => ballot.id)).toEqual([election.ballotId])
  })

  it('en icke röstberättigad person avvisas', async () => {
    await createVoter('201001014567', { isEligible: false })

    const decision = await evaluateEligibility('201001014567', election.electionId)

    expect(decision.outcome).toBe('not_eligible')
  })

  it('en person som inte finns i röstlängden avvisas', async () => {
    const decision = await evaluateEligibility('190001011111', election.electionId)

    expect(decision.outcome).toBe('not_in_roll')
  })

  it('en person som redan har ett kuvert på valsedeln får legitimera sig igen och ändra det', async () => {
    // Fram till stängningen går rösten att ändra (spec 3.1), så ett liggande
    // kuvert är inget skäl att avvisa.
    const voterId = await createVoter('199001011234')
    await votersDb.pendingVote.create({
      data: {
        voterStatusId: voterId,
        ballotId: election.ballotId,
        ciphertext: [],
        proofs: [],
        ciphertextHash: 'a'.repeat(64),
        castSequence: 1,
        bankIdSignature: 'x',
        bankIdCertificateChain: 'x',
        updatedAt: new Date(),
      },
    })

    const decision = await evaluateEligibility('199001011234', election.electionId)

    expect(decision.outcome).toBe('eligible')
  })
})
