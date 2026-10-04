import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import { closeElection, linkStateOf } from '@/orchestration/close-election.usecase'
import { completeTally, submitPartialDecryption } from '@/orchestration/tally.usecase'
import { canonicalOptions, type BallotOption } from '@/lib/crypto/ballot-encoding'
// Serverns ingång registrerar OpenSSL, så att krypteringen i testet går fort.
import '@/lib/crypto/server'
import { encryptBallot } from '@/lib/encrypt-client'
import { RATE_LIMITS, resetRateLimits } from '@/lib/rate-limit'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import { MockBankIdService, selectDemoIdentity } from '@/modules/eligibility/bankid/MockBankIdService'
import {
  ciphertextCommitment,
  envelopePayload,
  newCommitmentSalt,
} from '@/modules/eligibility/bankid/envelope-signature'
import { castEncryptedBallot, nextCastSequence } from '@/modules/eligibility/pending-vote.service'
import { POST as signStartRoute } from '@/app/api/vote/sign-start/route'
import { POST as encryptedRoute } from '@/app/api/vote/encrypted/route'
import { createVoter, disconnect, isDatabaseAvailable, resetElectionData, signingTextFor } from './helpers'

/**
 * REVISIONSPOSTER FRÅN NÅGON ANNAN FÅR INTE STOPPA SKALNINGEN ELLER RÄKNINGEN
 * (helgrensgranskningen, Viktigt 1, ruling 145).
 *
 * En post tar nästa löpnummer i kedjan med "läs det senaste, skriv nästa".
 * Inuti en transaktion kan en krock inte prövas om: PostgreSQL har redan
 * avbrutit transaktionen. Skalningen skrev sin post LINK_CLEARED utan att låsa
 * tabellen, och granskarens prob P6 lät åtta parallella anrop med fel Origin
 * skriva CSRF_REJECTED under skalningen. Fyra av fem stängningar avbröts som
 * `untouched`. Räkningens poster hade samma brist.
 *
 * Här skriver åtta slingor poster så fort de kan, direkt med
 * `recordAuditEvent`, medan skalningen eller räkningen pågår. Det motsvarar
 * vilken källa som helst som skriver poster, till exempel inloggningar från
 * många adresser, och prövar låset oberoende av var posterna kommer ifrån.
 */

/** Kroken startar strömmen av poster mitt i skalningen, när markeringarna ska skrivas. */
const hooks = vi.hoisted(() => ({ mark: null as null | (() => Promise<void>) }))

vi.mock('@/modules/eligibility/pending-vote.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/eligibility/pending-vote.service')>()
  return {
    ...actual,
    markEnvelopesAsVoted: async (...args: Parameters<typeof actual.markEnvelopesAsVoted>) => {
      const hook = hooks.mark
      hooks.mark = null
      if (hook) await hook()
      return actual.markEnvelopesAsVoted(...args)
    },
  }
})

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))

const databaseAvailable = await isDatabaseAvailable()

if (!databaseAvailable) {
  process.stderr.write('\n  Ingen databas tillgänglig — integrationstesterna hoppas över.\n')
}

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

const PHRASES = ['test-fras-ett', 'test-fras-tva', 'test-fras-tre'] as const

let voterNumber = 0

/** En omröstning med två lagda röster och closesAt passerad. */
async function electionWithVotes(name: string): Promise<{ electionId: string; ballotId: string }> {
  const parties = await votesDb.party.findMany({ orderBy: { displayOrder: 'asc' }, take: 2 })
  const outcome = await createElection({
    name,
    kind: 'RIKSDAGSVAL',
    opensAt: new Date(Date.now() - 60_000),
    closesAt: new Date(Date.now() + 3_600_000),
    ballots: [
      {
        kind: 'RIKSDAG',
        label: 'Riksdagen',
        allowsCandidateVote: false,
        parties: parties.map((party) => ({ partyId: party.id })),
      },
    ],
    trusteePassphrases: [...PHRASES],
  })
  if (outcome.status !== 'created') throw new Error('Kunde inte skapa testomröstningen.')

  const electionId = outcome.election.id
  const ballotId = outcome.election.ballotIds[0]!.id
  const { encryptionPublicKey } = await votesDb.election.findUniqueOrThrow({ where: { id: electionId } })
  const ballotParties = await votesDb.ballotParty.findMany({ where: { ballotId }, orderBy: { displayOrder: 'asc' } })
  const options: BallotOption[] = canonicalOptions({
    allowsCandidateVote: false,
    parties: ballotParties.map((party, index) => ({ id: party.id, displayOrder: index, candidates: [] })),
  })

  for (let n = 0; n < 2; n += 1) {
    voterNumber += 1
    const personalNumber = `1980010${String(voterNumber).padStart(5, '0')}`
    const voter = await createVoter(personalNumber)
    const ballot = encryptBallot(encryptionPublicKey!, electionId, ballotId, options, options[1]!)
    const salt = newCommitmentSalt()
    const service = new MockBankIdService()
    const order = await service.sign({
      endUserIp: '127.0.0.1',
      userVisibleData: await signingTextFor(ballotId, electionId),
      userNonVisibleData: envelopePayload({
        electionId,
        ballotId,
        ciphertextCommitment: ciphertextCommitment(ballot.ciphertextHash, salt)!,
        castSequence: await nextCastSequence(voter, ballotId),
      }),
    })
    selectDemoIdentity(order.orderRef, personalNumber)
    let result = await service.collect(order.orderRef)
    while (result.status === 'pending') result = await service.collect(order.orderRef)
    if (result.status !== 'complete') throw new Error('Signeringen blev inte klar.')
    const cast = await castEncryptedBallot(
      voter,
      electionId,
      ballotId,
      ballot,
      {
        signature: result.completionData.signature,
        ocspResponse: result.completionData.ocspResponse,
        commitmentSalt: salt,
      },
      await getEncryptedBallotShape(ballotId),
    )
    if (cast.status !== 'recorded') throw new Error(`Rösten lades inte: ${cast.status}`)
  }

  const past = new Date(Date.now() - 60_000)
  await votersDb.election.update({ where: { id: electionId }, data: { closesAt: past } })
  await votesDb.election.update({ where: { id: electionId }, data: { closesAt: past } })
  return { electionId, ballotId }
}

/** Åtta slingor som skriver poster tills de stoppas. */
function auditStream(): { stop: () => Promise<number> } {
  let running = true
  let written = 0
  const loops = Array.from({ length: 8 }, async () => {
    while (running) {
      await recordAuditEvent(AUDIT_EVENTS.AUTH_STARTED)
      written += 1
    }
  })
  return {
    stop: async () => {
      running = false
      await Promise.all(loops)
      return written
    },
  }
}

async function settle<T>(run: () => Promise<T>): Promise<T | string> {
  try {
    return await run()
  } catch (error) {
    return `kast ${linkStateOf(error)}: ${(error as Error).message.slice(0, 200)}`
  }
}

describe.skipIf(!databaseAvailable)('revisionsposter under skalningen och räkningen', () => {
  beforeEach(async () => {
    resetRateLimits()
    await resetElectionData()
  })

  it('skalningen går igenom medan andra skriver poster', async () => {
    const outcomes: unknown[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { electionId } = await electionWithVotes(`Strömmen ${attempt}`)
      let stream: ReturnType<typeof auditStream> | null = null
      hooks.mark = async () => {
        stream = auditStream()
        // Strömmen hinner komma i gång innan skalningen skriver sin post.
        await new Promise((resolve) => setTimeout(resolve, 30))
      }

      const outcome = await settle(async () => (await closeElection(electionId)).status)
      const written = await (stream as ReturnType<typeof auditStream> | null)?.stop()
      outcomes.push(outcome)
      expect(written, 'strömmen skrev inga poster, och provet prövade ingenting').toBeGreaterThan(0)
    }

    expect(outcomes).toEqual(['closed', 'closed', 'closed'])
  }, 180_000)

  it('räkningen går igenom medan andra skriver poster, och en stängning av en annan omröstning samtidigt', async () => {
    /**
     * Två omröstningar. B stängs först och får två bidrag. Sedan stängs A
     * medan B räknas, under strömmen. Skalningen tar omröstningens rad och
     * sedan tabellen, och räkningen tar fasens rad och sedan tabellen, i samma
     * ordning, så de kan vänta på varandra men inte låsa varandra.
     */
    const a = await electionWithVotes('Stängs under räkningen')
    const b = await electionWithVotes('Räknas under strömmen')

    expect(await closeElection(b.electionId)).toMatchObject({ status: 'closed' })
    expect(await submitPartialDecryption(b.ballotId, 1, PHRASES[0])).toMatchObject({ status: 'accepted' })
    expect(await submitPartialDecryption(b.ballotId, 2, PHRASES[1])).toMatchObject({ status: 'accepted' })

    const stream = auditStream()
    await new Promise((resolve) => setTimeout(resolve, 30))
    const [closed, tallied] = await Promise.all([
      settle(async () => (await closeElection(a.electionId)).status),
      settle(async () => {
        const outcome = await completeTally(b.ballotId)
        return outcome.status === 'tallied' ? `${outcome.status} ${outcome.phase}` : outcome.status
      }),
    ])
    const written = await stream.stop()

    expect(written).toBeGreaterThan(0)
    expect(closed).toBe('closed')
    expect(tallied).toBe('tallied TALLIED')
  }, 180_000)
})

describe.skipIf(!databaseAvailable)('en oinloggad kan inte skriva poster utan gräns', () => {
  /**
   * CSRF_REJECTED skrevs för varje POST med fel Origin, före hastighetsgränsen och
   * utan inloggning, och RATE_LIMITED för varje anrop över gränsen. Nu har posten
   * om fel Origin en egen gräns per adress, `rejectedOrigin`, och RATE_LIMITED
   * skrivs bara för det första avvisade anropet efter ett som släpptes igenom.
   *
   * Avvisningen av fel Origin sker fortfarande först, så att en främmande sida som
   * väljaren besöker inte kan förbruka väljarens egen gräns med anrop som ändå
   * avvisas. Det prövas också här.
   */
  beforeEach(async () => {
    resetRateLimits()
    await resetElectionData()
  })

  function request(path: string, origin: string): Request {
    return new Request(`http://localhost:3000${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: '{}',
    })
  }

  it.each([
    ['/api/vote/sign-start', signStartRoute],
    ['/api/vote/encrypted', encryptedRoute],
  ] as const)('%s: fel Origin i en slinga ger högst gränsen för posten', async (path, route) => {
    const before = await votersDb.auditEvent.count()
    const statuses = new Set<number>()
    for (let index = 0; index < 200; index += 1) {
      statuses.add((await route(request(path, 'https://angripare.example'))).status)
    }

    const written = (await votersDb.auditEvent.count()) - before
    expect(statuses).toEqual(new Set([403]))
    expect(written).toBeGreaterThan(0)
    expect(written).toBeLessThanOrEqual(RATE_LIMITS.rejectedOrigin.limit + 1)

    // Ruttens egen gräns är orörd: ett anrop med rätt Origin når sessionskontrollen.
    expect((await route(request(path, 'http://localhost:3000'))).status).toBe(401)
  }, 120_000)

  it('över ruttens gräns skrivs RATE_LIMITED en gång, inte för varje anrop', async () => {
    const before = await votersDb.auditEvent.count()
    let limited = 0
    let transitions = 0
    let previous = 0
    for (let index = 0; index < RATE_LIMITS.signStart.limit + 40; index += 1) {
      const status = (await signStartRoute(request('/api/vote/sign-start', 'http://localhost:3000'))).status
      if (status === 429) limited += 1
      if (status === 429 && previous !== 429) transitions += 1
      previous = status
    }

    expect(limited).toBeGreaterThanOrEqual(30)
    expect(transitions).toBeGreaterThanOrEqual(1)
    expect(await votersDb.auditEvent.count({ where: { eventType: AUDIT_EVENTS.RATE_LIMITED } })).toBe(transitions)
    expect((await votersDb.auditEvent.count()) - before).toBe(transitions)
  }, 120_000)
})
