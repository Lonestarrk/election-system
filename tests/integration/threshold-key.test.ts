import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { votesDb } from '@/modules/ballot-box/db'
import { createElection } from '@/orchestration/create-election.usecase'
import { disconnect, firstPartyId, isDatabaseAvailable, resetElectionData } from './helpers'
import { isInSubgroup } from '@/lib/crypto/group'
import { decryptShare } from '@/lib/crypto/share-storage'

const databaseAvailable = await isDatabaseAvailable()

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

describe.skipIf(!databaseAvailable)('tröskelnyckel vid skapande', () => {
  beforeEach(async () => {
    await resetElectionData()
  })

  async function newElection() {
    const partyId = await firstPartyId()
    const outcome = await createElection({
      name: 'Nyckeltest',
      kind: 'RIKSDAGSVAL',
      opensAt: new Date(Date.now() - 60_000),
      closesAt: new Date(Date.now() + 3_600_000),
      ballots: [
        { kind: 'RIKSDAG', label: 'Riksdagen', allowsCandidateVote: false, parties: [{ partyId }] },
      ],
      trusteePassphrases: ['fras-ett', 'fras-tva', 'fras-tre'],
    })
    if (outcome.status !== 'created') throw new Error('kunde inte skapa')
    return outcome.election.id
  }

  it('sparar en publik nyckel i undergruppen', async () => {
    const id = await newElection()
    const election = await votesDb.election.findUniqueOrThrow({ where: { id } })

    expect(election.encryptionPublicKey).toBeTruthy()
    expect(isInSubgroup(BigInt(election.encryptionPublicKey!))).toBe(true)
  })

  it('skapar tre andelar', async () => {
    const id = await newElection()

    expect(await votesDb.trusteeShare.count({ where: { electionId: id } })).toBe(3)
  })

  it('andelen lagras skyddad, inte i klartext', async () => {
    const id = await newElection()
    const share = await votesDb.trusteeShare.findFirstOrThrow({ where: { electionId: id } })

    // AES-GCM-formatet ar iv:tag:payload — tre hexdelar.
    expect(share.encryptedShare.split(':')).toHaveLength(3)
    expect(() => BigInt(share.encryptedShare)).toThrow()
  })

  it('andelen gar inte att lasa upp med fel fras', async () => {
    // Hela skyddet. Gar den upp med vad som helst ar lösenfrasen dekoration.
    const id = await newElection()
    const share = await votesDb.trusteeShare.findFirstOrThrow({ where: { electionId: id } })

    expect(() => decryptShare(share.encryptedShare, 'fel-fras', share.trusteeIndex)).toThrow()
  })
})
