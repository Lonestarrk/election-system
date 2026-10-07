import { createServer, connect, type Server, type Socket } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import { closeElection, closingLockHeartbeat, linkStateOf } from '@/orchestration/close-election.usecase'
import { canonicalOptions, type BallotOption } from '@/lib/crypto/ballot-encoding'
// Serverns ingång registrerar OpenSSL, så att krypteringen i testet går fort.
import '@/lib/crypto/server'
import { encryptBallot } from '@/lib/encrypt-client'
import { resetRateLimits } from '@/lib/rate-limit'
import { MockBankIdService, selectDemoIdentity } from '@/modules/eligibility/bankid/MockBankIdService'
import {
  ciphertextCommitment,
  envelopePayload,
  newCommitmentSalt,
} from '@/modules/eligibility/bankid/envelope-signature'
import { castEncryptedBallot, nextCastSequence } from '@/modules/eligibility/pending-vote.service'
import { createVoter, disconnect, isDatabaseAvailable, resetElectionData, signingTextFor } from './helpers'

/**
 * STÄNGNINGENS LÅS ÖVERLEVER ATT NÄTET KAPAR ANSLUTNINGAR SOM STÅR STILLA
 * (härdningen, punkt 1).
 *
 * Stängningen håller sitt lås i en egen transaktion i röstlängden, och den
 * anslutningen gjorde ingenting medan kuverten validerades, i ett stort val i
 * timmar. Nätet emellan har egna tomgångsgränser, till exempel omkring fyra
 * minuter för SNAT i Azure. Kapades anslutningen släpptes låset, stängningen
 * avbröts åt det säkra hållet, och ett tillräckligt stort val gick inte att
 * stänga alls.
 *
 * Här går låsets anslutning genom en proxy som kapar varje anslutning där
 * inga byte gått åt något håll på 1,5 sekunder, och valideringen får ta fyra.
 * Proxyn ser bara byte, inte TCP:s keepalive-paket, så det som prövas är
 * hjärtslaget: en lätt fråga på låsets anslutning med jämna mellanrum. Att
 * keepalive är påslaget på låsets anslutning prövas för sig, med en fråga till
 * servern.
 *
 * Bara låsets transaktion går genom proxyn. Övriga anslutningar står stilla
 * mellan testerna, och en kapad anslutning i Prismas pool hade gett fel som
 * inte har med låset att göra.
 */

const IDLE_LIMIT_MS = 1_500
const VALIDATION_DELAY_MS = 4_000

const hooks = vi.hoisted(() => ({
  /** Nästa `$transaction` på röstlängden går genom proxyn. Det är låsets, som stängningen tar först. */
  proxyNextTransaction: false,
  proxyUrl: '',
  /** Låsets transaktion, för frågan om keepalive. */
  lockTx: null as null | { $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> },
  /** Körs medan valideringen står och väntar. */
  duringValidation: null as null | (() => Promise<void>),
  validationDelayMs: 0,
}))

vi.mock('@/modules/eligibility/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/eligibility/db')>()
  const { PrismaClient } = await import('.prisma/voters')
  const target = actual.votersDb

  const votersDb = new Proxy(target, {
    get(object, property) {
      if (property === '$transaction' && hooks.proxyNextTransaction) {
        hooks.proxyNextTransaction = false
        /**
         * En ny klient för varje transaktion, som kopplas ned när den är klar. En
         * anslutning som proxyn kapat hade annars legat kvar i klientens pool, och
         * en nedkopplad klient räknas inte som en kapad anslutning.
         */
        const client = new PrismaClient({ datasources: { db: { url: hooks.proxyUrl } }, log: ['error'] })
        return async (run: (tx: unknown) => Promise<unknown>, options?: Record<string, unknown>) => {
          try {
            return await client.$transaction(async (tx) => {
              hooks.lockTx = tx as typeof hooks.lockTx
              return run(tx)
            }, options)
          } finally {
            await client.$disconnect().catch(() => undefined)
          }
        }
      }
      const value = Reflect.get(object, property)
      return typeof value === 'function' ? value.bind(object) : value
    },
  })

  return { ...actual, votersDb }
})

vi.mock('@/orchestration/validate-before-close.usecase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/orchestration/validate-before-close.usecase')>()
  return {
    ...actual,
    validateEnvelopes: async (...args: Parameters<typeof actual.validateEnvelopes>) => {
      const report = await actual.validateEnvelopes(...args)
      const during = hooks.duringValidation
      hooks.duringValidation = null
      await Promise.all([
        new Promise((resolve) => setTimeout(resolve, hooks.validationDelayMs)),
        during ? during() : Promise.resolve(),
      ])
      return report
    },
  }
})

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))

/** En TCP-proxy som kapar en anslutning där inga byte gått på `idleMs`. */
type IdleProxy = { port: number; killed: () => number; close: () => Promise<void> }

function idleProxy(host: string, port: number, idleMs: number): Promise<IdleProxy> {
  let killed = 0
  const sockets = new Set<Socket>()
  const server: Server = createServer((client) => {
    const upstream = connect({ host, port })
    sockets.add(client)
    sockets.add(upstream)
    let timer: NodeJS.Timeout | undefined
    const destroy = () => {
      clearTimeout(timer)
      client.destroy()
      upstream.destroy()
    }
    const bump = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        killed += 1
        destroy()
      }, idleMs)
    }
    bump()
    client.on('data', (chunk) => {
      bump()
      upstream.write(chunk)
    })
    upstream.on('data', (chunk) => {
      bump()
      client.write(chunk)
    })
    for (const socket of [client, upstream]) {
      socket.on('error', destroy)
      socket.on('close', () => {
        sockets.delete(socket)
        destroy()
      })
    }
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        killed: () => killed,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}

const databaseAvailable = await isDatabaseAvailable()

let proxy: IdleProxy | null = null
const defaultHeartbeat = closingLockHeartbeat.intervalMs

beforeAll(async () => {
  if (!databaseAvailable) return
  const url = new URL(process.env.VOTERS_DATABASE_URL!)
  proxy = await idleProxy(url.hostname.replace(/^\[|\]$/g, '') || 'localhost', Number(url.port || 5432), IDLE_LIMIT_MS)
  // Prismas egen pool får en enda anslutning, så att låsets transaktion är den som står stilla.
  url.host = `127.0.0.1:${proxy.port}`
  url.searchParams.set('connection_limit', '1')
  hooks.proxyUrl = url.toString()
})

afterAll(async () => {
  closingLockHeartbeat.intervalMs = defaultHeartbeat
  await proxy?.close()
  if (databaseAvailable) await disconnect()
})

const PHRASES = ['test-fras-ett', 'test-fras-tva', 'test-fras-tre'] as const
let voterNumber = 0

/** En omröstning med en lagd röst och closesAt passerad. */
async function electionWithVote(name: string): Promise<string> {
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

  voterNumber += 1
  const personalNumber = `1981010${String(voterNumber).padStart(5, '0')}`
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

  const past = new Date(Date.now() - 60_000)
  await votersDb.election.update({ where: { id: electionId }, data: { closesAt: past } })
  await votesDb.election.update({ where: { id: electionId }, data: { closesAt: past } })
  return electionId
}

async function closeThroughProxy(electionId: string): Promise<string> {
  hooks.validationDelayMs = VALIDATION_DELAY_MS
  hooks.proxyNextTransaction = true
  try {
    return (await closeElection(electionId)).status
  } catch (error) {
    return `kast ${linkStateOf(error)}: ${(error as Error).message.slice(0, 160)}`
  } finally {
    hooks.proxyNextTransaction = false
    hooks.validationDelayMs = 0
  }
}

describe.skipIf(!databaseAvailable)('stängningens lås och nätets tomgångsgräns', () => {
  beforeEach(async () => {
    resetRateLimits()
    await resetElectionData()
    closingLockHeartbeat.intervalMs = defaultHeartbeat
  })

  it('kontrollen: utan hjärtslag kapar proxyn låsets anslutning, och stängningen avbryts åt det säkra hållet', async () => {
    const electionId = await electionWithVote('Utan hjärtslag')
    const killedBefore = proxy!.killed()
    closingLockHeartbeat.intervalMs = 10 * 60_000

    const outcome = await closeThroughProxy(electionId)

    expect(proxy!.killed()).toBeGreaterThan(killedBefore)
    expect(outcome).not.toBe('closed')
    // Ingenting skalades: kuvertet ligger kvar, och fasen står inte i STRIPPED.
    expect(await votersDb.pendingVote.count()).toBe(1)
    const { phase } = await votersDb.election.findUniqueOrThrow({ where: { id: electionId }, select: { phase: true } })
    expect(phase).not.toBe('STRIPPED')
  }, 120_000)

  it('med hjärtslaget står låset kvar genom en validering som är längre än tomgångsgränsen', async () => {
    const electionId = await electionWithVote('Med hjärtslag')
    closingLockHeartbeat.intervalMs = 300
    const killedBefore = proxy!.killed()

    const outcome = await closeThroughProxy(electionId)

    expect(outcome).toBe('closed')
    expect(proxy!.killed()).toBe(killedBefore)
    expect(await votersDb.pendingVote.count()).toBe(0)
    const { phase } = await votersDb.election.findUniqueOrThrow({ where: { id: electionId }, select: { phase: true } })
    expect(phase).toBe('STRIPPED')
  }, 120_000)

  it('låsets anslutning har TCP keepalive påslaget, med en minut till första paketet', async () => {
    const electionId = await electionWithVote('Keepalive')
    closingLockHeartbeat.intervalMs = 300
    const seen: Record<string, string> = {}
    hooks.duringValidation = async () => {
      const rows = (await hooks.lockTx!.$queryRaw`
        SELECT current_setting('tcp_keepalives_idle') AS idle,
               current_setting('tcp_keepalives_interval') AS interval,
               current_setting('tcp_keepalives_count') AS count`) as Array<Record<string, string>>
      Object.assign(seen, rows[0])
    }

    expect(await closeThroughProxy(electionId)).toBe('closed')
    expect(seen).toEqual({ idle: '60', interval: '10', count: '6' })
  }, 120_000)
})
