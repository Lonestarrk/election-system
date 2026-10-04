import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { getBallotChoices, getEncryptedBallotShape } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import { closeElection } from '@/orchestration/close-election.usecase'
import { certifyElection, runFinalCheck } from '@/orchestration/final-check.usecase'
import { completeTally, submitPartialDecryption } from '@/orchestration/tally.usecase'
import { optionLabelsOf } from '@/orchestration/publish-results.usecase'
import { canonicalOptions, type BallotOption } from '@/lib/crypto/ballot-encoding'
// Serverns ingång registrerar OpenSSL, så att krypteringen i testet går fort.
import '@/lib/crypto/server'
import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { encryptBallot } from '@/lib/encrypt-client'
import { resetRateLimits } from '@/lib/rate-limit'
import { createAdminSession } from '@/modules/eligibility/admin-session.service'
import { MockBankIdService, selectDemoIdentity } from '@/modules/eligibility/bankid/MockBankIdService'
import {
  ciphertextCommitment,
  envelopePayload,
  newCommitmentSalt,
} from '@/modules/eligibility/bankid/envelope-signature'
import { castEncryptedBallot, nextCastSequence } from '@/modules/eligibility/pending-vote.service'
import { GET as resultsRoute } from '@/app/api/observer/results/route'
import { POST as adminResultsRoute } from '@/app/api/admin/elections/results/route'
import { createVoter, disconnect, isDatabaseAvailable, resetElectionData, signingTextFor } from './helpers'

/**
 * UPPGIFT 14c: EN FRÅGA I EN ALLMÄN OMRÖSTNING GÅR HELA VÄGEN.
 *
 * Förut hade en valsedel av slaget FRAGA ingen form i kuvertmodellen, så
 * getEncryptedBallotShape gav null och varje steg efter läggningen svarade
 * `unknown_ballot`: en sådan omröstning kunde aldrig nå TALLIED. Här läggs
 * kuvert på en fråga, omröstningen stängs, räknas, slutkontrolleras,
 * fastställs och publiceras, och det oberoende verktyget kontrollerar
 * publiceringen. Blankt är alternativ 0, så att summabeviset gäller som för
 * partivalsedlarna.
 */

const cookieJar = vi.hoisted(() => ({ admin: undefined as string | undefined }))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'valadmin' && cookieJar.admin ? { name, value: cookieJar.admin } : undefined),
  }),
}))

const databaseAvailable = await isDatabaseAvailable()

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

const TRUSTEE_PASSPHRASES = ['test-fras-ett', 'test-fras-tva', 'test-fras-tre'] as const
const ORIGIN = 'http://localhost:3000'
const TOOL = join(process.cwd(), 'tools/verify-election.mjs')
const QUESTION = 'Ska kommunen bygga ett nytt bibliotek?'

function runTool(publication: unknown): { status: number | null; output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'question-ballot-'))
  const file = join(directory, 'publicering.json')
  writeFileSync(file, JSON.stringify(publication))
  const result = spawnSync(process.execPath, [TOOL, file], { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

class RejectedCast extends Error {
  constructor(readonly status: string) {
    super(`Kunde inte lägga rösten (${status}).`)
  }
}

describe.skipIf(!databaseAvailable)('en fråga i kuvertmodellen, från läggning till publicering', () => {
  const PNS = { anna: '199001011234', kim: '198505152345', robin: '197012125678', lisa: '198203034567' }
  const ADMIN_PN = '198001019876'

  let electionId: string
  let ballotId: string
  let publicKey: string
  let options: BallotOption[]
  let optionIds: { ja: string; nej: string }
  const voters = new Map<string, string>()
  const personalNumberByVoter = new Map<string, string>()

  beforeEach(async () => {
    cookieJar.admin = undefined
    resetRateLimits()
    await resetElectionData()

    const outcome = await createElection({
      name: 'Frågetestet',
      kind: 'ALLMAN_OMROSTNING',
      opensAt: new Date(Date.now() - 60_000),
      closesAt: new Date(Date.now() + 3_600_000),
      ballots: [{ kind: 'FRAGA', label: QUESTION, options: ['Ja', 'Nej'] }],
      trusteePassphrases: [...TRUSTEE_PASSPHRASES],
    })
    if (outcome.status !== 'created') throw new Error('Kunde inte skapa testomröstningen.')

    electionId = outcome.election.id
    ballotId = outcome.election.ballotIds[0]!.id
    publicKey = (
      await votesDb.election.findUniqueOrThrow({ where: { id: electionId }, select: { encryptionPublicKey: true } })
    ).encryptionPublicKey!

    const rows = await votesDb.ballotOption.findMany({ where: { ballotId }, orderBy: { displayOrder: 'asc' } })
    optionIds = { ja: rows[0]!.id, nej: rows[1]!.id }
    options = canonicalOptions({
      allowsCandidateVote: false,
      parties: [],
      options: rows.map((row, index) => ({ id: row.id, displayOrder: index })),
    })

    voters.clear()
    personalNumberByVoter.clear()
    for (const [name, pn] of Object.entries(PNS)) {
      const id = await createVoter(pn)
      voters.set(name, id)
      personalNumberByVoter.set(id, pn)
    }
  })

  async function castFor(
    name: keyof typeof PNS,
    choice: BallotOption,
    prepared?: EncryptedBallot,
  ): Promise<EncryptedBallot> {
    const voterStatusId = voters.get(name)!
    const encrypted = prepared ?? (await encryptBallot(publicKey, electionId, ballotId, options, choice))
    const castSequence = await nextCastSequence(voterStatusId, ballotId)

    const service = new MockBankIdService()
    const commitmentSalt = newCommitmentSalt()
    const order = await service.sign({
      endUserIp: '127.0.0.1',
      userVisibleData: await signingTextFor(ballotId, electionId),
      userNonVisibleData: envelopePayload({
        electionId,
        ballotId,
        ciphertextCommitment: ciphertextCommitment(encrypted.ciphertextHash, commitmentSalt)!,
        castSequence,
      }),
    })
    selectDemoIdentity(order.orderRef, personalNumberByVoter.get(voterStatusId)!)
    let result = await service.collect(order.orderRef)
    while (result.status === 'pending') result = await service.collect(order.orderRef)
    if (result.status !== 'complete') throw new Error('Signeringen blev inte klar.')

    const outcome = await castEncryptedBallot(
      voterStatusId,
      electionId,
      ballotId,
      encrypted,
      { signature: result.completionData.signature, ocspResponse: result.completionData.ocspResponse, commitmentSalt },
      await getEncryptedBallotShape(ballotId),
    )
    if (outcome.status !== 'recorded') throw new RejectedCast(outcome.status)
    return encrypted
  }

  /** Två ja, ett nej och ett blankt. */
  async function castTheVotes(): Promise<void> {
    await castFor('anna', { kind: 'OPTION', optionId: optionIds.ja })
    await castFor('kim', { kind: 'OPTION', optionId: optionIds.ja })
    await castFor('robin', { kind: 'OPTION', optionId: optionIds.nej })
    await castFor('lisa', { kind: 'BLANK' })
  }

  async function closeAndTally(): Promise<void> {
    const at = new Date(Date.now() - 60_000)
    await votersDb.election.update({ where: { id: electionId }, data: { closesAt: at } })
    await votesDb.election.update({ where: { id: electionId }, data: { closesAt: at } })
    const closed = await closeElection(electionId)
    if (closed.status !== 'closed') throw new Error(`Stängningen gick inte igenom (${closed.status}).`)

    expect(await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])).toMatchObject({ status: 'accepted' })
    expect(await submitPartialDecryption(ballotId, 3, TRUSTEE_PASSPHRASES[2])).toMatchObject({ status: 'accepted' })
    expect(await completeTally(ballotId)).toMatchObject({ status: 'tallied' })
  }

  it('frågan har en form i kuvertmodellen: blankt och ett alternativ per svar', async () => {
    expect(await getEncryptedBallotShape(ballotId)).toMatchObject({ optionCount: 3 })
    expect(options).toEqual([
      { kind: 'BLANK' },
      { kind: 'OPTION', optionId: optionIds.ja },
      { kind: 'OPTION', optionId: optionIds.nej },
    ])
    expect(await optionLabelsOf(ballotId)).toEqual(['Blankt', 'Ja', 'Nej'])
    expect(await getBallotChoices(ballotId)).toMatchObject({
      kind: 'QUESTION',
      options: [
        { id: optionIds.ja, label: 'Ja', displayOrder: 1 },
        { id: optionIds.nej, label: 'Nej', displayOrder: 2 },
      ],
    })
  })

  /** En annan omröstning med en partivalsedel och en fråga med två svar, båda med tre alternativ. */
  async function otherBallots() {
    const s = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'S' } })
    const m = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'M' } })
    const outcome = await createElection({
      name: 'Den andra omröstningen',
      kind: 'RIKSDAGSVAL',
      opensAt: new Date(Date.now() - 60_000),
      closesAt: new Date(Date.now() + 3_600_000),
      ballots: [
        { kind: 'RIKSDAG', label: 'Riksdagen', allowsCandidateVote: false, parties: [{ partyId: s.id }, { partyId: m.id }] },
        { kind: 'FRAGA', label: 'En annan fråga?', options: ['Ja', 'Nej'] },
      ],
      trusteePassphrases: [...TRUSTEE_PASSPHRASES],
    })
    if (outcome.status !== 'created') throw new Error('Kunde inte skapa den andra omröstningen.')
    const otherElectionId = outcome.election.id
    const forged = []
    for (const ballot of outcome.election.ballotIds) {
      const shape = await getEncryptedBallotShape(ballot.id)
      expect(shape?.optionCount).toBe(3)
      const parties = await votesDb.ballotParty.findMany({ where: { ballotId: ballot.id }, orderBy: { displayOrder: 'asc' } })
      const rows = await votesDb.ballotOption.findMany({ where: { ballotId: ballot.id }, orderBy: { displayOrder: 'asc' } })
      const otherOptions = canonicalOptions({
        allowsCandidateVote: false,
        parties: parties.map((party, index) => ({ id: party.id, displayOrder: index, candidates: [] })),
        options: rows.map((row, index) => ({ id: row.id, displayOrder: index })),
      })
      // Krypterat till frågans nyckel, med bevis bundna till den andra valsedelns id.
      forged.push(await encryptBallot(publicKey, otherElectionId, ballot.id, otherOptions, { kind: 'BLANK' }))
    }
    return forged
  }

  it('ett chiffer bevisat för en partivalsedel eller en annan fråga, med lika många alternativ, avvisas på frågans valsedel', async () => {
    const [forAParty, forAnotherQuestion] = await otherBallots()
    for (const forged of [forAParty!, forAnotherQuestion!]) {
      expect(forged.ciphertext).toHaveLength(3)
      await expect(castFor('anna', { kind: 'BLANK' }, forged)).rejects.toMatchObject({ status: 'invalid_proof' })
    }
    expect(await votersDb.pendingVote.count({ where: { ballotId } })).toBe(0)
  })

  it('formen styrs av valsedelns slag: ett svarsalternativ på en partivalsedel och ett parti på en fråga räknas inte', async () => {
    const s = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'S' } })
    const outcome = await createElection({
      name: 'Slagtestet',
      kind: 'RIKSDAGSVAL',
      opensAt: new Date(Date.now() - 60_000),
      closesAt: new Date(Date.now() + 3_600_000),
      ballots: [{ kind: 'RIKSDAG', label: 'Riksdagen', allowsCandidateVote: false, parties: [{ partyId: s.id }] }],
      trusteePassphrases: [...TRUSTEE_PASSPHRASES],
    })
    if (outcome.status !== 'created') throw new Error('Kunde inte skapa omröstningen.')
    const partyBallotId = outcome.election.ballotIds[0]!.id
    expect(await getEncryptedBallotShape(partyBallotId)).toMatchObject({ optionCount: 2 })

    // Rader som skrivits förbi skapandet, direkt i databasen.
    await votesDb.ballotOption.create({ data: { ballotId: partyBallotId, label: 'Smugglat', displayOrder: 1 } })
    const party = await votesDb.ballotParty.findFirstOrThrow({ where: { ballotId: partyBallotId } })
    await votesDb.ballotParty.create({ data: { ballotId, partyId: party.partyId, displayOrder: 1 } })

    expect(await getEncryptedBallotShape(partyBallotId)).toMatchObject({ optionCount: 2 })
    expect(await getEncryptedBallotShape(ballotId)).toMatchObject({ optionCount: 3 })
  })

  it('texten i BankID-appen namnger frågan och säger inte vad väljaren svarat', async () => {
    const text = await signingTextFor(ballotId, electionId)
    expect(text).toContain('Frågetestet')
    expect(text).toContain(QUESTION)
    expect(text).not.toMatch(/\b(Ja|Nej)\b/)
  })

  it('ett kuvert med fel antal alternativ läggs inte', async () => {
    const wrong = await encryptBallot(publicKey, electionId, ballotId, options.slice(0, 2), { kind: 'BLANK' })
    const outcome = await castEncryptedBallot(
      voters.get('anna')!,
      electionId,
      ballotId,
      wrong,
      { signature: 'x', ocspResponse: 'x', commitmentSalt: newCommitmentSalt() },
      await getEncryptedBallotShape(ballotId),
    )
    expect(outcome.status).not.toBe('recorded')
  })

  it('stängs, räknas, slutkontrolleras, fastställs och publiceras, och verktyget godkänner publiceringen', async () => {
    await castTheVotes()
    await closeAndTally()

    // En fråga når TALLIED. Förut svarade varje steg `unknown_ballot`.
    expect((await votersDb.election.findUniqueOrThrow({ where: { id: electionId } })).phase).toBe('TALLIED')

    const report = await runFinalCheck(electionId)
    expect(report).toMatchObject({ canCertify: true, anomalous: false })
    expect(await certifyElection(electionId)).toMatchObject({ status: 'certified' })

    const response = await resultsRoute(new Request(`${ORIGIN}/api/observer/results?electionId=${electionId}`))
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      status: string
      ballots: Array<{ kind: string; label: string; options: Array<{ label: string; count: number }> }>
    }
    expect(body.status).toBe('published')
    expect(body.ballots).toHaveLength(1)
    expect(body.ballots[0]).toMatchObject({ kind: 'FRAGA', label: QUESTION })
    expect(body.ballots[0]!.options.map((option) => [option.label, option.count])).toEqual([
      ['Blankt', 1],
      ['Ja', 2],
      ['Nej', 1],
    ])

    const result = runTool(body)
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('dekrypteringen stämmer')
  })

  it('adminsidans resultat visar svaren med sina namn', async () => {
    await castTheVotes()
    await closeAndTally()

    const admin = await createVoter(ADMIN_PN, { isAdmin: true })
    cookieJar.admin = (await createAdminSession(admin)).id

    const response = await adminResultsRoute(
      new Request(`${ORIGIN}/api/admin/elections/results`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ electionId }),
      }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ballots: Array<{ options: Array<{ label: string; count: number }>; total: number }>
    }
    expect(body.ballots[0]!.options).toEqual([
      { label: 'Blankt', count: 1 },
      { label: 'Ja', count: 2 },
      { label: 'Nej', count: 1 },
    ])
    expect(body.ballots[0]!.total).toBe(4)
  })
})
