import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import { canonicalOptions, type BallotOption } from '@/lib/crypto/ballot-encoding'
import { encryptBallot } from '@/lib/encrypt-client'
import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { resetRateLimits } from '@/lib/rate-limit'
import {
  MockBankIdService,
  selectDemoIdentity,
} from '@/modules/eligibility/bankid/MockBankIdService'
import { envelopePayload } from '@/modules/eligibility/bankid/envelope-signature'
import {
  castEncryptedBallot,
  nextCastSequence,
  type CastOutcome,
} from '@/modules/eligibility/pending-vote.service'
import { createVotingSession } from '@/modules/eligibility/voting-session.service'
import { POST as compare } from '@/app/api/vote/compare/route'
import { POST as session } from '@/app/api/vote/session/route'
import { createVoter, disconnect, isDatabaseAvailable, resetElectionData, voteOnce } from './helpers'

/**
 * SERVERN JÄMFÖR, DEN LÄMNAR INTE UT (uppgift 14).
 *
 * Röstsidan sparar chifferhashen för den röst enheten lade, och frågar när den
 * laddas om det är den som ligger. /api/vote/compare svarar bara lika, olika
 * eller ingen röst. Hade servern i stället lämnat ut sin hash hade en enhet
 * fått veta hashen för en röst som lagts från en annan enhet, den som räknas,
 * och med läsrätt i votes_db pekar den ut rätt rad efter stängningen (spec 10).
 *
 * Rutterna körs här på riktigt, mot testdatabaserna. Bara sessionscookien
 * läggs in utifrån, eftersom next/headers kräver Nexts begäranskontext.
 * Varje svar prövas mot mönstret för en chifferhash, 64 hextecken, och inte
 * bara mot hasharna testet känner till: en hash för något annat hade varit
 * lika fel.
 */

const cookieJar = vi.hoisted(() => ({ session: undefined as string | undefined }))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'valsession' && cookieJar.session ? { name, value: cookieJar.session } : undefined,
  }),
}))

const databaseAvailable = await isDatabaseAvailable()

if (!databaseAvailable) {
  process.stderr.write('\n  Ingen databas tillgänglig — integrationstesterna hoppas över.\n')
}

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

const ORIGIN = 'http://localhost:3000'
const ANY_HASH = /[0-9a-f]{64}/

describe.skipIf(!databaseAvailable)('jämförelsen av enhetens röst', () => {
  const ANNA_PN = '199001011234'

  let electionId: string
  let ballotId: string
  let publicKey: string
  let options: BallotOption[]
  let bpS: string
  let bpM: string
  let anna: string
  let csrfSecret: string

  beforeEach(async () => {
    resetRateLimits()
    await resetElectionData()

    const s = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'S' } })
    const m = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'M' } })

    const outcome = await createElection({
      name: 'Jämförelsens testval',
      kind: 'RIKSDAGSVAL',
      opensAt: new Date(Date.now() - 60_000),
      closesAt: new Date(Date.now() + 3_600_000),
      ballots: [
        {
          kind: 'RIKSDAG',
          label: 'Riksdagen',
          allowsCandidateVote: false,
          parties: [{ partyId: s.id }, { partyId: m.id }],
        },
      ],
      trusteePassphrases: ['test-fras-ett', 'test-fras-tva', 'test-fras-tre'],
    })
    if (outcome.status !== 'created') throw new Error('Kunde inte skapa testomröstningen.')

    electionId = outcome.election.id
    ballotId = outcome.election.ballotIds[0]!.id

    const electionRow = await votesDb.election.findUniqueOrThrow({
      where: { id: electionId },
      select: { encryptionPublicKey: true },
    })
    publicKey = electionRow.encryptionPublicKey!

    const parties = await votesDb.ballotParty.findMany({
      where: { ballotId },
      orderBy: { displayOrder: 'asc' },
    })
    bpS = parties[0]!.id
    bpM = parties[1]!.id
    options = canonicalOptions({
      allowsCandidateVote: false,
      parties: parties.map((party, index) => ({ id: party.id, displayOrder: index, candidates: [] })),
    })

    anna = await createVoter(ANNA_PN)
    const created = await createVotingSession(anna, electionId)
    cookieJar.session = created.id
    csrfSecret = created.csrfSecret
  })

  /** Krypterar, signerar med attrappen och lägger rösten, som rutterna skulle gjort. */
  async function cast(ballotPartyId: string): Promise<{ ballot: EncryptedBallot; outcome: CastOutcome }> {
    const ballot = encryptBallot(publicKey, electionId, ballotId, options, {
      kind: 'PARTY',
      ballotPartyId,
    })

    const service = new MockBankIdService()
    const order = await service.sign({
      endUserIp: '127.0.0.1',
      userVisibleData: 'Bekräfta din röst',
      userNonVisibleData: envelopePayload({
        electionId,
        ballotId,
        ciphertextHash: ballot.ciphertextHash,
        castSequence: await nextCastSequence(anna, ballotId),
      }),
    })
    selectDemoIdentity(order.orderRef, ANNA_PN)

    let result = await service.collect(order.orderRef)
    while (result.status === 'pending') result = await service.collect(order.orderRef)
    if (result.status !== 'complete') throw new Error('Signeringen blev inte klar.')

    const outcome = await castEncryptedBallot(
      anna,
      electionId,
      ballotId,
      ballot,
      {
        signature: result.completionData.signature,
        certificate: result.completionData.certificate,
        signedData: result.completionData.signedData,
      },
      await getEncryptedBallotShape(ballotId),
    )
    return { ballot, outcome }
  }

  function post(
    handler: (request: Request) => Promise<Response>,
    body: unknown,
    headers: Record<string, string> = { 'x-csrf-token': csrfSecret },
  ): Promise<Response> {
    return handler(
      new Request(`${ORIGIN}/api/vote/compare`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
        body: JSON.stringify(body),
      }),
    )
  }

  async function compareWith(hash: string): Promise<{ status: number; text: string }> {
    const response = await post(compare, { ballots: [{ ballotId, ciphertextHash: hash }] })
    return { status: response.status, text: await response.text() }
  }

  it('svarar lika när enheten har exakt den röst som ligger, utan att nämna hashen', async () => {
    const { ballot, outcome } = await cast(bpS)
    expect(outcome.status).toBe('recorded')

    const { status, text } = await compareWith(ballot.ciphertextHash)

    expect(status).toBe(200)
    expect(JSON.parse(text)).toEqual({ ballots: [{ ballotId, result: 'same' }] })
    expect(text).not.toMatch(ANY_HASH)
  })

  it('svarar olika när rösten ändrats från en annan enhet, och bär ingen av hasharna', async () => {
    // Den här enheten lade den första rösten. En annan enhet ersatte den.
    const { ballot: first } = await cast(bpS)
    const { ballot: second } = await cast(bpM)

    const { status, text } = await compareWith(first.ciphertextHash)

    expect(status).toBe(200)
    expect(JSON.parse(text)).toEqual({ ballots: [{ ballotId, result: 'different' }] })
    // Den nya rösten, den som räknas, får enheten aldrig veta hashen för.
    expect(text).not.toContain(second.ciphertextHash)
    expect(text).not.toMatch(ANY_HASH)
  })

  it('svarar ingen röst när inget kuvert ligger', async () => {
    const { status, text } = await compareWith('a'.repeat(64))

    expect(status).toBe(200)
    expect(JSON.parse(text)).toEqual({ ballots: [{ ballotId, result: 'none' }] })
  })

  it('kräver CSRF-token, som sessionens övriga POST-rutter', async () => {
    const { ballot } = await cast(bpS)
    const response = await post(compare, { ballots: [{ ballotId, ciphertextHash: ballot.ciphertextHash }] }, {})

    expect(response.status).toBe(403)
    expect(await response.text()).not.toMatch(ANY_HASH)
  })

  it('kräver en session', async () => {
    cookieJar.session = undefined
    const response = await post(compare, { ballots: [{ ballotId, ciphertextHash: 'a'.repeat(64) }] })

    expect(response.status).toBe(401)
  })

  it('avvisar en främmande origin', async () => {
    const response = await post(
      compare,
      { ballots: [{ ballotId, ciphertextHash: 'a'.repeat(64) }] },
      { 'x-csrf-token': csrfSecret, origin: 'https://evil.example' },
    )

    expect(response.status).toBe(403)
  })

  it('avvisar en valsedel i en annan omröstning', async () => {
    const response = await post(compare, {
      ballots: [{ ballotId: '00000000-0000-4000-8000-000000000000', ciphertextHash: 'a'.repeat(64) }],
    })

    expect(response.status).toBe(400)
  })

  it('tar bara en hash per valsedel och anrop', async () => {
    // Annars gick det att pröva femtio kandidater i ett anrop, förbi
    // hastighetsgränsen.
    const response = await post(compare, {
      ballots: [
        { ballotId, ciphertextHash: 'a'.repeat(64) },
        { ballotId, ciphertextHash: 'b'.repeat(64) },
      ],
    })

    expect(response.status).toBe(400)
  })

  it('sessionen säger att ett kuvert ligger och vilken fas valet har, men ingen hash', async () => {
    await cast(bpS)

    const response = await post(session, {})
    const text = await response.text()
    const body = JSON.parse(text)

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      electionId,
      phase: 'OPEN',
      acceptsVotes: true,
      ballots: [{ id: ballotId, hasPendingVote: true, votedInOldFlow: false }],
    })
    expect(text).not.toMatch(ANY_HASH)
  })

  it('"har en röst" kommer ur kuvertet, inte ur det gamla flödets markering', async () => {
    const before = JSON.parse(await (await post(session, {})).text())
    expect(before.ballots[0]).toMatchObject({ hasPendingVote: false, votedInOldFlow: false })

    // En röst i det gamla flödet markerar väljaren men lägger inget kuvert.
    const oldFlow = await voteOnce(anna, { electionId, ballotId, ballotPartyId: bpS })
    expect(oldFlow.status).toBe('voted')

    const after = JSON.parse(await (await post(session, {})).text())
    expect(after.ballots[0]).toMatchObject({ hasPendingVote: false, votedInOldFlow: true })
  })

  it('när closesAt passerats tar sessionen inte längre emot röster, precis som läggningen', async () => {
    await votersDb.election.update({
      where: { id: electionId },
      data: { closesAt: new Date(Date.now() - 1000) },
    })

    const body = JSON.parse(await (await post(session, {})).text())
    expect(body).toMatchObject({ phase: 'OPEN', acceptsVotes: false })

    // Samma villkor som castEncryptedBallot avvisar på. Skilde de sig åt
    // erbjöd sidan en röstning som servern sedan vägrade ta emot.
    const { outcome } = await cast(bpS)
    expect(outcome.status).toBe('closed')
  })

  it('när fasen lämnat OPEN säger sessionen det, så att enheten kan radera', async () => {
    await votersDb.election.update({ where: { id: electionId }, data: { phase: 'STRIPPED' } })

    const body = JSON.parse(await (await post(session, {})).text())
    expect(body).toMatchObject({ phase: 'STRIPPED', acceptsVotes: false })
  })
})
