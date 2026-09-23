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

    expect(() =>
      decryptShare(share.encryptedShare, 'fel-fras', id, share.trusteeIndex),
    ).toThrow()
  })

  it('samma fras och samma index i tva olika val ger olika chiffer', async () => {
    // Vaktar saltet, inte bara kryptot. Saltades bara pa trusteeIndex (1, 2
    // eller 3 i evighet) skulle en aterkommande fortroendemans vanliga fras ge
    // BYTE-FOR-BYTE samma AES-nyckel i varje val hen tjanstgor i — och en
    // angripare skulle kunna forberakna en ordlista over scrypt en enda gang
    // och prova den mot varje val systemet nagonsin hallit. Utan det har
    // testet kan saltet tystna tillbaka till den svagare formen utan att
    // nagot annat test slar larm, eftersom "andelen gar inte att lasa upp med
    // fel fras" bara provar EN fras mot EN andel och inte ser over valgranser.
    const firstId = await newElection()
    const secondId = await newElection()

    const firstShare = await votesDb.trusteeShare.findFirstOrThrow({
      where: { electionId: firstId, trusteeIndex: 1 },
    })
    const secondShare = await votesDb.trusteeShare.findFirstOrThrow({
      where: { electionId: secondId, trusteeIndex: 1 },
    })

    // Samma fras ('fras-ett') och samma index (1) i bada anropen — se
    // newElection ovan — men olika omrostnings-id.
    expect(firstShare.encryptedShare).not.toBe(secondShare.encryptedShare)

    // Och den avgorande punkten: andelens VARDE (efter dekryptering med ratt
    // fras och ratt omrostnings-id) far inte rakas ut fel bara for att en
    // annan omrostnings salt anvands av misstag — dekryptering med FEL
    // omrostnings-id ska kasta precis som fel fras gor.
    expect(() =>
      decryptShare(firstShare.encryptedShare, 'fras-ett', secondId, firstShare.trusteeIndex),
    ).toThrow()
  })
})
