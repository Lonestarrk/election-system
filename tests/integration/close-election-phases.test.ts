import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Prisma } from '.prisma/voters'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import {
  ENVELOPE_READ_BATCH_SIZE,
  readEnvelopes,
} from '@/orchestration/validate-before-close.usecase'
import {
  abortedMessageFor,
  closeElection,
  CloseAbortedError,
  idForEnvelope,
  linkStateOf,
  urnRowsReplacedOf,
  type CloseOutcome,
} from '@/orchestration/close-election.usecase'
import { AUDIT_EVENTS } from '@/modules/eligibility/audit.service'
import { logger } from '@/lib/logger'
import { canonicalOptions, type BallotOption } from '@/lib/crypto/ballot-encoding'
import { encryptBallot } from '@/lib/encrypt-client'
import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'
import {
  MockBankIdService,
  selectDemoIdentity,
} from '@/modules/eligibility/bankid/MockBankIdService'
import { envelopePayload } from '@/modules/eligibility/bankid/envelope-signature'
import {
  castEncryptedBallot,
  nextCastSequence,
  type CastOutcome,
  type EncryptedBallotShape,
  type SignedEnvelope,
} from '@/modules/eligibility/pending-vote.service'
import { createVoter, disconnect, isDatabaseAvailable, resetElectionData } from './helpers'

/**
 * FASERNA ÄR VERKLIGA TILLSTÅND (uppgift 11d).
 *
 * Spec 6.1 säger att fasen går enkelriktat OPEN → CLOSED → VALIDATED →
 * STRIPPED. Fram till uppgift 11d skrev stängningen bara STRIPPED, och fasen
 * stod kvar i OPEN efter en avvikelse. Här prövas att varje fas skrivs när den
 * ska, att en fas aldrig går baklänges, och att två stängningar inte kan gå om
 * varandra.
 *
 * Här prövas också det som hänger på faserna i punkt 5b och 6 i uppgiften: att
 * läggningen prövar fasen och räknaren i samma transaktion som den skriver,
 * att rester och förfalskade rader i röstdatabasen tas bort, att varje flyttat
 * chiffer läses tillbaka, att kuverten läses i omgångar, att markeringen "har
 * röstat" skrivs i skalningens transaktion, och vad stängningen säger när dess
 * lås går förlorat (fixrunda 1).
 */

/**
 * Krokar i stängningen och i läggningen.
 *
 * Varje krok körs en gång och nollställs innan den körs, så att en stängning
 * som kroken själv startar inte utlöser den igen. Klienterna byts ut med en
 * Proxy som bara byter de metoder krokarna sitter på. Allt annat går rakt till
 * den äkta klienten, bundet till den, så att `$transaction` och modellerna
 * beter sig som vanligt.
 */
const hooks = vi.hoisted(() => ({
  /** Före stängningens läsning av valsedlarna, alltså efter fasen och före kuverten. */
  beforeEnvelopeRead: null as null | (() => Promise<void>),
  /** Före infogningen i votes_db, efter valideringen och städningen. */
  beforeInsert: null as null | (() => Promise<void>),
  /** Före nästa läsning av encrypted_vote, alltså städningens första läsning. */
  beforeUrnRead: null as null | (() => Promise<void>),
  /** Före nästa radering i encrypted_vote, alltså städningens radering. */
  beforeUrnDelete: null as null | (() => Promise<void>),
  /** Varje läsning av pending_vote genom den delade klienten, med sitt `take`. */
  pendingVoteReads: [] as Array<{ take: number | undefined }>,
  /**
   * Portar i läggningen, en per läggning och i den ordning de sätts upp.
   *
   * `castGates` sitter efter fasens och räknarens första prövning och före
   * transaktionen: `hashPersonalNumber` är det sista läggningen gör innan den
   * öppnar den. `castTxGates` sitter inne i läggningens transaktion, efter
   * fasens prövning med FOR SHARE: vid den första skrivningen i pending_vote,
   * eller vid `create` när `castTxGateAt` säger det.
   */
  castGates: [] as Array<{ reached: () => void; opened: Promise<void> }>,
  castTxGates: [] as Array<{ reached: () => void; opened: Promise<void> }>,
  castTxGateAt: 'write' as 'write' | 'create',
  /** Väljarna i den ordning skalningen skickar markeringarna till `createMany`. */
  markerInsertOrder: [] as string[],
  /**
   * Före skalningens första sats, jämför-och-sätt till STRIPPED, i varje
   * stängning, med ordningsnumret 1, 2 och så vidare. Nollställs inte.
   */
  beforeStrip: null as null | ((n: number) => Promise<void>),
  stripCalls: 0,
  /** Direkt efter skalningens första sats, alltså mitt i skalningen. Körs en gång. */
  afterStripWrite: null as null | (() => Promise<void>),
  /** Så många av de närmaste läsningarna av fasen och roten, `closeStateOf`, kastar. */
  failCloseStateReads: 0,
  /**
   * Sessionens `idle_in_transaction_session_timeout` på låsets anslutning,
   * satt före låset, som på en server med gränsen påslagen.
   */
  lockSessionIdleTimeoutMs: null as null | number,
  /** Stängningens egen `set_config` för gränsen körs inte (motprovet till S1). */
  skipCodeSetConfig: false,
  /** Svaret på låsets COMMIT går förlorat, efter att COMMIT gått igenom. */
  failAfterLockCommit: false,
  /** Vid valideringens första hashning av ett personnummer. Körs en gång. */
  onValidationHash: null as null | (() => Promise<void>),
  /** Slumptalen i krypteringen: spelas in och spelas upp, så att två chiffer blir lika. */
  rng: { mode: 'off' as 'off' | 'record' | 'replay', tape: [] as bigint[], position: 0 },
}))

/** Låsets transaktion känns igen på sin tidsgräns, sex timmar. */
const LOCK_TIMEOUT_MS = 6 * 60 * 60 * 1000

vi.mock('@/lib/crypto/group', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crypto/group')>()
  return {
    ...actual,
    randomScalar: () => {
      const rng = hooks.rng
      if (rng.mode === 'replay') {
        const value = rng.tape[rng.position]
        rng.position += 1
        if (value === undefined) throw new Error('Inspelningen av slumptalen tog slut.')
        return value
      }
      const value = actual.randomScalar()
      if (rng.mode === 'record') rng.tape.push(value)
      return value
    },
  }
})

vi.mock('@/modules/eligibility/election.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/eligibility/election.service')>()
  return {
    ...actual,
    closeStateOf: async (electionId: string) => {
      if (hooks.failCloseStateReads > 0) {
        hooks.failCloseStateReads -= 1
        throw new Error('fasen gick inte att läsa (simulerad pool-timeout)')
      }
      return actual.closeStateOf(electionId)
    },
  }
})

vi.mock('@/modules/eligibility/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/eligibility/db')>()
  const real = actual.votersDb

  function bind<T extends object>(target: T, overrides: Record<string | symbol, unknown>): T {
    return new Proxy(target, {
      get(inner, property) {
        if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property]
        const value = Reflect.get(inner, property)
        return typeof value === 'function' ? value.bind(inner) : value
      },
    })
  }

  const electionBallot = bind(real.electionBallot, {
    findMany: async (args: Parameters<typeof real.electionBallot.findMany>[0]) => {
      const hook = hooks.beforeEnvelopeRead
      if (hook) {
        hooks.beforeEnvelopeRead = null
        await hook()
      }
      return real.electionBallot.findMany(args)
    },
  })

  const pendingVote = bind(real.pendingVote, {
    findMany: async (args: Parameters<typeof real.pendingVote.findMany>[0]) => {
      hooks.pendingVoteReads.push({ take: args?.take })
      return real.pendingVote.findMany(args)
    },
  })

  /**
   * Varje interaktiv transaktion får krokarna. Bara läggningen skriver i
   * pending_vote med upsert, updateMany eller create i en transaktion, och
   * bara skalningen skriver markeringar. Varje transaktion tar högst en port.
   */
  function withTxHooks(tx: Prisma.TransactionClient): Prisma.TransactionClient {
    let gated = false
    const gateHere = async (method: 'upsert' | 'updateMany' | 'create') => {
      if (gated) return
      if (hooks.castTxGateAt === 'create' && method !== 'create') return
      const gate = hooks.castTxGates.shift()
      if (!gate) return
      gated = true
      gate.reached()
      await gate.opened
    }

    const txPendingVote = bind(tx.pendingVote, {
      upsert: async (args: Parameters<typeof tx.pendingVote.upsert>[0]) => {
        await gateHere('upsert')
        return tx.pendingVote.upsert(args)
      },
      updateMany: async (args: Parameters<typeof tx.pendingVote.updateMany>[0]) => {
        await gateHere('updateMany')
        return tx.pendingVote.updateMany(args)
      },
      create: async (args: Parameters<typeof tx.pendingVote.create>[0]) => {
        await gateHere('create')
        return tx.pendingVote.create(args)
      },
    })

    const txVotedMarker = bind(tx.votedMarker, {
      createMany: async (args: Parameters<typeof tx.votedMarker.createMany>[0]) => {
        const rows = args ? [args.data].flat() : []
        hooks.markerInsertOrder.push(...rows.map((row) => row.voterStatusId))
        return tx.votedMarker.createMany(args)
      },
    })

    /**
     * Skalningens första sats är jämför-och-sätt till STRIPPED. Krokarna före
     * och efter den sitter här, i vilken interaktiv transaktion det än är,
     * så att de når skalningen var den än körs.
     */
    const txElection = bind(tx.election, {
      updateMany: async (args: Parameters<typeof tx.election.updateMany>[0]) => {
        const stripping = (args?.data as { phase?: unknown } | undefined)?.phase === 'STRIPPED'
        if (stripping) {
          hooks.stripCalls += 1
          if (hooks.beforeStrip) await hooks.beforeStrip(hooks.stripCalls)
        }
        const result = await tx.election.updateMany(args)
        const after = hooks.afterStripWrite
        if (stripping && after) {
          hooks.afterStripWrite = null
          await after()
        }
        return result
      },
    })

    /**
     * Låsets satser går genom `$queryRaw`. Med `lockSessionIdleTimeoutMs` får
     * låsets transaktion en gräns för tomgång innan låset tas, som på en
     * server där gränsen är påslagen, och med `skipCodeSetConfig` körs inte
     * stängningens egen `set_config`. Gränsen sätts för transaktionen och inte
     * för sessionen, så att anslutningen inte bär den vidare i poolen när
     * transaktionen är slut. Stängningens egen `set_config` skriver över den
     * på samma sätt som en gräns satt för servern.
     */
    const $queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?')
      if (sql.includes('pg_try_advisory_xact_lock') && hooks.lockSessionIdleTimeoutMs !== null) {
        await tx.$queryRawUnsafe(
          `SELECT set_config('idle_in_transaction_session_timeout', '${hooks.lockSessionIdleTimeoutMs}', true)`,
        )
      }
      if (sql.includes("set_config('idle_in_transaction_session_timeout', '0', true)") && hooks.skipCodeSetConfig) {
        return [{ set_config: '0' }]
      }
      return tx.$queryRaw(strings, ...values)
    }

    return bind(tx, { pendingVote: txPendingVote, votedMarker: txVotedMarker, election: txElection, $queryRaw })
  }

  const $transaction = async (arg: unknown, options?: unknown) => {
    const transaction = real.$transaction.bind(real) as (a: unknown, o?: unknown) => Promise<unknown>
    if (typeof arg !== 'function') return transaction(arg, options)
    const fn = arg as (tx: Prisma.TransactionClient) => Promise<unknown>
    const result = await transaction((tx: Prisma.TransactionClient) => fn(withTxHooks(tx)), options)
    if ((options as { timeout?: number } | undefined)?.timeout === LOCK_TIMEOUT_MS && hooks.failAfterLockCommit) {
      hooks.failAfterLockCommit = false
      throw new Error('svaret på låsets COMMIT gick förlorat (simulerat)')
    }
    return result
  }

  return { ...actual, votersDb: bind(real, { electionBallot, pendingVote, $transaction }) }
})

vi.mock('@/modules/ballot-box/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/ballot-box/db')>()
  const real = actual.votesDb

  const hookFor: Record<string, 'beforeInsert' | 'beforeUrnRead' | 'beforeUrnDelete'> = {
    createMany: 'beforeInsert',
    findMany: 'beforeUrnRead',
    deleteMany: 'beforeUrnDelete',
  }

  const encryptedVote = new Proxy(real.encryptedVote, {
    get(inner, property) {
      const value = Reflect.get(inner, property)
      const key = typeof property === 'string' ? hookFor[property] : undefined
      if (key) {
        return async (...args: unknown[]) => {
          const hook = hooks[key]
          if (hook) {
            hooks[key] = null
            await hook()
          }
          return (value as (...rest: unknown[]) => Promise<unknown>).apply(inner, args)
        }
      }
      return typeof value === 'function' ? value.bind(inner) : value
    },
  })

  const votesDbWithHooks = new Proxy(real, {
    get(inner, property) {
      if (property === 'encryptedVote') return encryptedVote
      const value = Reflect.get(inner, property)
      return typeof value === 'function' ? value.bind(inner) : value
    },
  })

  return { ...actual, votesDb: votesDbWithHooks }
})

vi.mock('@/modules/eligibility/identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/eligibility/identity')>()
  return {
    ...actual,
    hashPersonalNumber: async (personalNumber: string) => {
      const gate = hooks.castGates.shift()
      if (gate) {
        gate.reached()
        await gate.opened
      }
      const onHash = hooks.onValidationHash
      if (onHash) {
        hooks.onValidationHash = null
        await onHash()
      }
      return actual.hashPersonalNumber(personalNumber)
    },
  }
})

const databaseAvailable = await isDatabaseAvailable()

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

describe.skipIf(!databaseAvailable)('faserna i stängningen', () => {
  const ANNA_PN = '199001011234'
  const KIM_PN = '198505152345'
  const ROBIN_PN = '197012125678'
  const SAM_PN = '196408083456'
  const VERA_PN = '198812247890'

  let electionId: string
  let ballotId: string
  let otherBallotId: string
  let publicKey: string
  let options: BallotOption[]
  let bpS: string
  let bpM: string

  let anna: string
  let kim: string
  let robin: string
  let sam: string
  let vera: string

  const personalNumberByVoter = new Map<string, string>()

  async function createSignedVoter(personalNumber: string): Promise<string> {
    const id = await createVoter(personalNumber)
    personalNumberByVoter.set(id, personalNumber)
    return id
  }

  async function setClosesAt(at: Date): Promise<void> {
    await votersDb.election.update({ where: { id: electionId }, data: { closesAt: at } })
    await votesDb.election.update({ where: { id: electionId }, data: { closesAt: at } })
  }

  const inTheFuture = () => new Date(Date.now() + 3_600_000)
  const inThePast = () => new Date(Date.now() - 60_000)

  beforeEach(async () => {
    hooks.beforeEnvelopeRead = null
    hooks.beforeInsert = null
    hooks.beforeUrnRead = null
    hooks.beforeUrnDelete = null
    hooks.pendingVoteReads = []
    hooks.castGates = []
    hooks.castTxGates = []
    hooks.castTxGateAt = 'write'
    hooks.markerInsertOrder = []
    hooks.beforeStrip = null
    hooks.stripCalls = 0
    hooks.afterStripWrite = null
    hooks.failCloseStateReads = 0
    hooks.lockSessionIdleTimeoutMs = null
    hooks.skipCodeSetConfig = false
    hooks.failAfterLockCommit = false
    hooks.onValidationHash = null
    hooks.rng = { mode: 'off', tape: [], position: 0 }
    vi.restoreAllMocks()
    await resetElectionData()

    const s = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'S' } })
    const m = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'M' } })

    const outcome = await createElection({
      name: 'Faserna i stängningen',
      kind: 'RIKSDAGSVAL',
      opensAt: new Date(Date.now() - 60_000),
      closesAt: inTheFuture(),
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

    // En valsedel i en annan omröstning, för ett chiffer som flyttats till fel valsedel.
    const other = await createElection({
      name: 'En annan omröstning',
      kind: 'RIKSDAGSVAL',
      opensAt: new Date(Date.now() - 60_000),
      closesAt: inTheFuture(),
      ballots: [
        { kind: 'RIKSDAG', label: 'Riksdagen', allowsCandidateVote: false, parties: [{ partyId: s.id }] },
      ],
      trusteePassphrases: ['test-fras-ett', 'test-fras-tva', 'test-fras-tre'],
    })
    if (other.status !== 'created') throw new Error('Kunde inte skapa den andra omröstningen.')
    otherBallotId = other.election.ballotIds[0]!.id

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

    personalNumberByVoter.clear()
    anna = await createSignedVoter(ANNA_PN)
    kim = await createSignedVoter(KIM_PN)
    robin = await createSignedVoter(ROBIN_PN)
    sam = await createSignedVoter(SAM_PN)
    vera = await createSignedVoter(VERA_PN)

    // Omröstningen ligger som stängd och öppnas bara medan ett kuvert läggs.
    await setClosesAt(inThePast())
  })

  function buildBallot(party: 'bp-s' | 'bp-m'): EncryptedBallot {
    return encryptBallot(publicKey, electionId, ballotId, options, {
      kind: 'PARTY',
      ballotPartyId: party === 'bp-s' ? bpS : bpM,
    })
  }

  type PreparedCast = {
    ballot: EncryptedBallot
    envelope: SignedEnvelope
    shape: EncryptedBallotShape | null
    target: { electionId: string; ballotId: string }
  }

  /**
   * Krypterar och skriver under med attrappen, men lägger inte rösten. Utan
   * `castSequence` skrivs nästa räknare under, som röstsidan gör.
   */
  async function prepareCast(
    voterStatusId: string,
    party: 'bp-s' | 'bp-m',
    castSequence?: number,
  ): Promise<PreparedCast> {
    return prepareCastOf(voterStatusId, buildBallot(party), castSequence)
  }

  /** Skriver under en given valsedel, på omröstningens valsedel eller på en annan. */
  async function prepareCastOf(
    voterStatusId: string,
    ballot: EncryptedBallot,
    castSequence?: number,
    target = { electionId, ballotId },
  ): Promise<PreparedCast> {
    const service = new MockBankIdService()
    const order = await service.sign({
      endUserIp: '127.0.0.1',
      userVisibleData: 'Bekräfta din röst',
      userNonVisibleData: envelopePayload({
        electionId: target.electionId,
        ballotId: target.ballotId,
        ciphertextHash: ballot.ciphertextHash,
        castSequence: castSequence ?? (await nextCastSequence(voterStatusId, target.ballotId)),
      }),
    })
    selectDemoIdentity(order.orderRef, personalNumberByVoter.get(voterStatusId)!)
    let result = await service.collect(order.orderRef)
    while (result.status === 'pending') result = await service.collect(order.orderRef)
    if (result.status !== 'complete') throw new Error('Signeringen blev inte klar.')

    return {
      ballot,
      envelope: {
        signature: result.completionData.signature,
        certificateChain: result.completionData.certificateChain,
        signedData: result.completionData.signedData,
      },
      shape: await getEncryptedBallotShape(target.ballotId),
      target,
    }
  }

  function castPrepared(voterStatusId: string, prepared: PreparedCast): Promise<CastOutcome> {
    return castEncryptedBallot(
      voterStatusId,
      prepared.target.electionId,
      prepared.target.ballotId,
      prepared.ballot,
      prepared.envelope,
      prepared.shape,
    )
  }

  /** Lägger en förberedd röst medan omröstningens klocka står öppen. */
  async function castOpen(voterStatusId: string, prepared: PreparedCast): Promise<CastOutcome> {
    await setClosesAt(inTheFuture())
    try {
      return await castPrepared(voterStatusId, prepared)
    } finally {
      await setClosesAt(inThePast())
    }
  }

  /** En ärlig röstläggning medan klockan står öppen. Svarar med utfallet och chifferhashen. */
  async function tryCast(
    voterStatusId: string,
    party: 'bp-s' | 'bp-m',
  ): Promise<{ outcome: CastOutcome; ciphertextHash: string }> {
    const prepared = await prepareCast(voterStatusId, party)
    await setClosesAt(inTheFuture())
    try {
      return { outcome: await castPrepared(voterStatusId, prepared), ciphertextHash: prepared.ballot.ciphertextHash }
    } finally {
      await setClosesAt(inThePast())
    }
  }

  async function castFor(voterStatusId: string, party: 'bp-s' | 'bp-m'): Promise<string> {
    const { outcome, ciphertextHash } = await tryCast(voterStatusId, party)
    if (outcome.status !== 'recorded') throw new Error(`Kunde inte lägga rösten (${outcome.status}).`)
    return ciphertextHash
  }

  type Gate = { reached: Promise<void>; open: () => void }

  function makeGate(): { gate: Gate; armed: { reached: () => void; opened: Promise<void> } } {
    let reached!: () => void
    let open!: () => void
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve
    })
    const opened = new Promise<void>((resolve) => {
      open = resolve
    })
    return { gate: { reached: reachedPromise, open }, armed: { reached, opened } }
  }

  /** En port i nästa läggning, före dess transaktion: den stannar tills porten öppnas. */
  function armCastGate(): Gate {
    const { gate, armed } = makeGate()
    hooks.castGates.push(armed)
    return gate
  }

  /** En port inne i nästa läggnings transaktion, efter fasens prövning med FOR SHARE. */
  function armCastTxGate(): Gate {
    const { gate, armed } = makeGate()
    hooks.castTxGates.push(armed)
    return gate
  }

  async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`Villkoret uppfylldes inte inom ${timeoutMs} ms.`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  /** Granskarens förfalskning: giltigt chiffer och giltiga bevis, ingen underskrift. */
  async function plantUnsignedVote(voterStatusId: string, party: 'bp-s' | 'bp-m'): Promise<string> {
    const ballot = buildBallot(party)
    await votersDb.pendingVote.create({
      data: {
        voterStatusId,
        ballotId,
        ciphertext: ballot.ciphertext as unknown as Prisma.InputJsonValue,
        proofs: ballot.proofs as unknown as Prisma.InputJsonValue,
        ciphertextHash: ballot.ciphertextHash,
        castSequence: 1,
        bankIdSignature: 'ingen',
        bankIdCertificateChain: '',
        updatedAt: new Date(),
      },
    })
    return ballot.ciphertextHash
  }

  type PendingRow = Awaited<ReturnType<typeof votersDb.pendingVote.findFirstOrThrow>>

  /** Ett äkta kuvert, lagt och sedan borttaget, för att skrivas direkt i röstlängden senare. */
  async function saveAndRemoveEnvelope(voterStatusId: string): Promise<PendingRow> {
    await castFor(voterStatusId, 'bp-s')
    const row = await votersDb.pendingVote.findFirstOrThrow({ where: { voterStatusId } })
    await votersDb.pendingVote.delete({ where: { id: row.id } })
    return row
  }

  async function insertPendingRow(row: PendingRow): Promise<void> {
    await votersDb.pendingVote.create({
      data: {
        id: row.id,
        voterStatusId: row.voterStatusId,
        ballotId: row.ballotId,
        ciphertext: row.ciphertext as Prisma.InputJsonValue,
        proofs: row.proofs as Prisma.InputJsonValue,
        ciphertextHash: row.ciphertextHash,
        castSequence: row.castSequence,
        bankIdSignature: row.bankIdSignature,
        bankIdCertificateChain: row.bankIdCertificateChain,
        updatedAt: row.updatedAt,
      },
    })
  }

  /** Ett chiffer i röstdatabasen utan något kuvert, som en rest efter en avbruten stängning. */
  async function plantUrnRow(row: {
    ciphertextHash: string
    id?: string
    ballotId?: string
    ciphertext: unknown
    proofs: unknown
  }): Promise<void> {
    await votesDb.encryptedVote.create({
      data: {
        id: row.id ?? idForEnvelope(row.ciphertextHash),
        ballotId: row.ballotId ?? ballotId,
        ciphertext: row.ciphertext as Prisma.InputJsonValue,
        proofs: row.proofs as Prisma.InputJsonValue,
        ciphertextHash: row.ciphertextHash,
      },
    })
  }

  async function plantForeignResidue(): Promise<void> {
    await plantUrnRow({
      id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      ciphertextHash: 'en-hash-som-inte-hor-till-nagot-kuvert',
      ciphertext: [],
      proofs: {},
    })
  }

  type Attempt = { outcome: CloseOutcome | null; error: unknown }

  async function attempt(): Promise<Attempt> {
    return closeElection(electionId).then(
      (outcome) => ({ outcome, error: null }),
      (error: unknown) => ({ outcome: null, error }),
    )
  }

  async function state() {
    return votersDb.election.findUniqueOrThrow({
      where: { id: electionId },
      select: { phase: true, envelopeRoot: true, linkClearedAt: true },
    })
  }

  async function phase(): Promise<string> {
    return (await state()).phase
  }

  async function setPhase(value: string, envelopeRoot: string | null = null): Promise<void> {
    await votersDb.election.update({ where: { id: electionId }, data: { phase: value, envelopeRoot } })
  }

  async function urn(): Promise<string[]> {
    const rows = await votesDb.encryptedVote.findMany({
      where: { ballotId },
      select: { ciphertextHash: true },
    })
    return rows.map((row) => row.ciphertextHash).sort()
  }

  async function linkClearedEvents(): Promise<number> {
    return votersDb.auditEvent.count({ where: { eventType: AUDIT_EVENTS.LINK_CLEARED } })
  }

  /** Anslutningarna som håller ett advisory lock i röstlängden, alltså stängningens lås. */
  async function closingLockHolders(): Promise<number[]> {
    const rows = await votersDb.$queryRaw<Array<{ pid: number }>>`
      SELECT l.pid FROM pg_locks l JOIN pg_database d ON d.oid = l.database
      WHERE l.locktype = 'advisory' AND l.granted AND d.datname = current_database()`
    return rows.map((row) => Number(row.pid))
  }

  /**
   * Avslutar anslutningen som håller stängningens lås, som när en anslutning
   * tappas eller låsets tidsgräns går ut. Bara i testdatabasen.
   */
  async function dropClosingLock(): Promise<void> {
    const [database] = await votersDb.$queryRaw<Array<{ name: string }>>`
      SELECT current_database()::text AS name`
    expect(database?.name).toBe('voters_test')
    const holders = await closingLockHolders()
    expect(holders).toHaveLength(1)
    await votersDb.$queryRaw`SELECT pg_terminate_backend(${holders[0]!}::int)`
    await waitUntil(async () => (await closingLockHolders()).length === 0, 5_000)
  }

  /** Stängningens övergång till CLOSED som väntar på ett radlås på omröstningen. */
  async function waitingElectionUpdates(): Promise<number> {
    const [row] = await votersDb.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'UPDATE%election%'`
    return row?.n ?? 0
  }

  describe('varje fas skrivs när den ska', () => {
    it('CLOSED skrivs före valideringen och står kvar när valideringen hittar en avvikelse', async () => {
      await castFor(anna, 'bp-s')
      await plantUnsignedVote(kim, 'bp-m')

      let phaseWhenEnvelopesAreRead: string | null = null
      hooks.beforeEnvelopeRead = async () => {
        phaseWhenEnvelopesAreRead = await phase()
      }

      expect((await closeElection(electionId)).status).toBe('validation_failed')

      // Före uppgift 11d stod fasen i OPEN hela tiden, och röster avvisades
      // bara av klockan.
      expect(phaseWhenEnvelopesAreRead).toBe('CLOSED')
      expect(await state()).toEqual({ phase: 'CLOSED', envelopeRoot: null, linkClearedAt: null })

      // Röstningen öppnas inte igen, inte heller om klockan flyttas fram.
      const late = await tryCast(robin, 'bp-s')
      expect(late.outcome.status).toBe('closed')
      expect(await votersDb.pendingVote.count({ where: { voterStatusId: robin } })).toBe(0)
    })

    it('VALIDATED skrivs när valideringen passerat, före infogningen, och STRIPPED sist', async () => {
      await castFor(anna, 'bp-s')
      await castFor(kim, 'bp-m')

      let phaseBeforeInsert: string | null = null
      hooks.beforeInsert = async () => {
        phaseBeforeInsert = await phase()
      }

      expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 2, cleared: 2 })
      expect(phaseBeforeInsert).toBe('VALIDATED')
      expect((await state()).phase).toBe('STRIPPED')
    })

    it('en omkörning från CLOSED fortsätter när avvikelsen är borttagen', async () => {
      const annas = await castFor(anna, 'bp-s')
      await plantUnsignedVote(kim, 'bp-m')
      expect((await closeElection(electionId)).status).toBe('validation_failed')
      expect(await phase()).toBe('CLOSED')

      // Administratören utreder och tar bort den förfalskade raden.
      await votersDb.pendingVote.deleteMany({ where: { voterStatusId: kim } })

      expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 1, cleared: 1 })
      expect(await urn()).toEqual([annas])
    })

    it.each(['CLOSED', 'VALIDATED'])('en omkörning från %s fortsätter och flyttar kuverten', async (from) => {
      /**
       * Fram till uppgift 11d räknades allt som inte var OPEN som att
       * kopplingen redan var raderad. En omröstning i CLOSED eller VALIDATED
       * har kvar sina kuvert, och en omkörning ska ta dem.
       */
      const annas = await castFor(anna, 'bp-s')
      const kims = await castFor(kim, 'bp-m')
      await setPhase(from)

      expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 2, cleared: 2 })
      expect(await urn()).toEqual([annas, kims].sort())
      expect(await votersDb.pendingVote.count()).toBe(0)
    })

    it.each(['STRIPPED', 'TALLIED', 'CERTIFIED'])(
      'already_closed betyder fas %s med skriven kuvertrot, och stängningen rör då ingenting',
      async (from) => {
        await castFor(anna, 'bp-s')
        await setPhase(from, 'f'.repeat(64))

        expect(await closeElection(electionId)).toEqual({ status: 'already_closed' })
        expect(await phase()).toBe(from)
        expect(await votersDb.pendingVote.count()).toBe(1)
        expect(await urn()).toEqual([])
      },
    )

    it.each(['STRIPPED', 'TALLIED', 'CERTIFIED'])(
      'fas %s utan kuvertrot ger inget already_closed, eftersom STRIPPED bara skrivs med roten',
      async (from) => {
        /**
         * Fixrunda 1, M3. STRIPPED skrivs i samma sats som roten, så en sådan
         * fas utan rot kan bara komma av en skrivning förbi stängningen. Före
         * rättelsen svarade stängningen already_closed, och rutten "kopplingen
         * raderad", fast kuvertet låg kvar.
         */
        await castFor(anna, 'bp-s')
        await setPhase(from)

        const { outcome, error } = await attempt()

        expect(outcome).toBeNull()
        expect(error).toBeInstanceOf(CloseAbortedError)
        expect(linkStateOf(error)).toBe('unknown')
        expect((error as Error).message).toContain('kuvertroten är oskriven')
        expect(abortedMessageFor(error)).not.toContain('ORÖRD')
        expect(await phase()).toBe(from)
        expect(await votersDb.pendingVote.count()).toBe(1)
      },
    )

    it('ingen fas går baklänges: en omkörning som stoppas av valideringen lämnar VALIDATED', async () => {
      await castFor(anna, 'bp-s')
      await castFor(kim, 'bp-m')

      // Första körningen validerar, men ett kuvert tas bort före raderingen.
      hooks.beforeInsert = async () => {
        await votersDb.pendingVote.deleteMany({ where: { voterStatusId: anna } })
      }
      const first = await attempt()
      expect(linkStateOf(first.error)).toBe('untouched')
      expect(await phase()).toBe('VALIDATED')

      // En förfalskning läggs in, och omkörningen stoppas av valideringen.
      await plantUnsignedVote(robin, 'bp-s')
      expect((await closeElection(electionId)).status).toBe('validation_failed')
      expect(await state()).toEqual({ phase: 'VALIDATED', envelopeRoot: null, linkClearedAt: null })
    })
  })

  describe('invarianterna från uppgift 11', () => {
    it.each([
      ['när kuverten läses', 'beforeEnvelopeRead', 'CLOSED'],
      ['i votes_db efter VALIDATED', 'beforeUrnRead', 'VALIDATED'],
      ['när chiffren infogas', 'beforeInsert', 'VALIDATED'],
    ] as const)(
      'ett kast i förberedelsen %s ger untouched, och ingenting av skalningen finns',
      async (_label, hook, phaseAfter) => {
        /**
         * Allt som kastar i `prepareClose` är `untouched` så länge stängningens
         * lås hålls: förberedelsen rör aldrig pending_vote, och ingen annan
         * stängning kan ha raderat kopplingen. Fasen står kvar där
         * förberedelsen hann, och går inte tillbaka.
         */
        await castFor(anna, 'bp-s')
        await castFor(kim, 'bp-m')
        hooks[hook] = async () => {
          throw new Error('simulerat databasfel')
        }

        const { outcome, error } = await attempt()

        expect(outcome).toBeNull()
        expect(error).toBeInstanceOf(CloseAbortedError)
        expect(linkStateOf(error)).toBe('untouched')
        expect(abortedMessageFor(error)).toContain('ORÖRD')
        expect(await votersDb.pendingVote.count()).toBe(2)
        expect(await state()).toEqual({ phase: phaseAfter, envelopeRoot: null, linkClearedAt: null })
        expect(await linkClearedEvents()).toBe(0)
        expect(await votersDb.votedMarker.count()).toBe(0)

        // Och en omkörning går igenom när felet är borta.
        expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 2, cleared: 2 })
      },
    )

    it('STRIPPED skrivs bara i skalningens transaktion, tillsammans med roten och raderingen', async () => {
      const annas = await castFor(anna, 'bp-s')

      // Före transaktionen, i infogningens krok, är fasen VALIDATED.
      let phaseBeforeTransaction: string | null = null
      hooks.beforeInsert = async () => {
        phaseBeforeTransaction = await phase()
      }

      expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 1 })
      expect(phaseBeforeTransaction).toBe('VALIDATED')
      const after = await state()
      expect(after.phase).toBe('STRIPPED')
      expect(after.envelopeRoot).not.toBeNull()
      expect(after.linkClearedAt).not.toBeNull()
      expect(await votersDb.pendingVote.count()).toBe(0)
      expect(await urn()).toEqual([annas])
    })
  })

  describe('övergångarna är jämför-och-sätt', () => {
    /**
     * Under stängningens lås kan ingen annan stängning ändra fasen. Villkoren
     * på övergångarna finns för det fall låset inte håller, och prövas här med
     * någon som skriver fasen direkt i röstlängden mitt i stängningen.
     */
    it('STRIPPED skrivs bara från VALIDATED: har fasen gått tillbaka raderas ingenting', async () => {
      await castFor(anna, 'bp-s')
      await castFor(kim, 'bp-m')

      hooks.beforeInsert = async () => {
        await setPhase('CLOSED')
      }
      const { outcome, error } = await attempt()

      expect(outcome).toBeNull()
      expect(linkStateOf(error)).toBe('untouched')
      expect((error as Error).message).toContain('stod inte längre i VALIDATED')
      expect(await votersDb.pendingVote.count()).toBe(2)
      expect(await state()).toEqual({ phase: 'CLOSED', envelopeRoot: null, linkClearedAt: null })
      expect(await linkClearedEvents()).toBe(0)
      expect(await votersDb.votedMarker.count()).toBe(0)
    })

    it('städningen körs inte när fasen lämnat CLOSED och VALIDATED', async () => {
      /**
       * Villkoret omgranskningen av 14f satte för städningen: fasen skild från
       * STRIPPED och roten null. En stängning som städar när kopplingen redan
       * är raderad tar bort det en annan just flyttat.
       */
      await castFor(anna, 'bp-s')
      await plantUrnRow({
        id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
        ciphertextHash: 'ett-chiffer-som-en-annan-stangning-flyttat',
        ciphertext: [],
        proofs: {},
      })

      hooks.beforeEnvelopeRead = async () => {
        await setPhase('STRIPPED')
      }

      // STRIPPED utan rot kan bara komma av en skrivning förbi stängningen, och
      // svaret är det försiktiga (fixrunda 1, M3). Stängningen rör ingenting,
      // varken chiffret eller kuvertet.
      const { outcome, error } = await attempt()
      expect(outcome).toBeNull()
      expect(linkStateOf(error)).toBe('unknown')
      expect(await votesDb.encryptedVote.count({ where: { ballotId } })).toBe(1)
      expect(await votersDb.pendingVote.count()).toBe(1)
    })
  })

  describe('två stängningar kan inte gå om varandra', () => {
    it('två stängningar samtidigt: en stänger, den andra svarar att en stängning pågår', async () => {
      const annas = await castFor(anna, 'bp-s')
      const kims = await castFor(kim, 'bp-m')

      const outcomes = await Promise.all([closeElection(electionId), closeElection(electionId)])

      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['closed', 'in_progress'])
      expect(outcomes.find((outcome) => outcome.status === 'closed')).toMatchObject({ moved: 2, cleared: 2 })
      expect(await linkClearedEvents()).toBe(1)
      expect(await urn()).toEqual([annas, kims].sort())
      expect(await votersDb.pendingVote.count()).toBe(0)
      expect(await phase()).toBe('STRIPPED')
    })

    it('en andra stängning medan den första pågår rör ingenting och påstår inte att kopplingen är orörd', async () => {
      /**
       * Granskningen av 14f: en andra stängning som läste fasen före den
       * förstas COMMIT men kuverten efter svarade att 0 kuvert skulle flyttas
       * men 2 fanns, och att kopplingen var ORÖRD, fast fasen var STRIPPED.
       * Här körs den andra stängningen hela vägen efter att den första läst
       * fasen och innan den läst kuverten.
       */
      const annas = await castFor(anna, 'bp-s')
      const kims = await castFor(kim, 'bp-m')

      let inner: Attempt | null = null
      hooks.beforeEnvelopeRead = async () => {
        inner = await attempt()
      }
      const outer = await attempt()

      expect(inner).toEqual({ outcome: { status: 'in_progress' }, error: null })
      expect(outer.error).toBeNull()
      expect(outer.outcome).toMatchObject({ status: 'closed', moved: 2, cleared: 2 })
      expect(await linkClearedEvents()).toBe(1)
      expect(await urn()).toEqual([annas, kims].sort())

      // Och när den första är klar svarar nästa att omröstningen är stängd.
      expect(await closeElection(electionId)).toEqual({ status: 'already_closed' })
    })

    it('dubbel stängning med noll kuvert ger en stängning och en radering i loggen', async () => {
      let inner: Attempt | null = null
      hooks.beforeEnvelopeRead = async () => {
        inner = await attempt()
      }
      const outer = await attempt()

      expect(inner).toEqual({ outcome: { status: 'in_progress' }, error: null })
      expect(outer.outcome).toMatchObject({ status: 'closed', moved: 0, cleared: 0 })
      expect(await linkClearedEvents()).toBe(1)
      expect(await closeElection(electionId)).toEqual({ status: 'already_closed' })
      expect(await linkClearedEvents()).toBe(1)
    })

    it('en stängning som pågår svarar också en stängning i en annan anslutning, och den skriver ingenting', async () => {
      /**
       * Låset ligger i databasen och inte i processens minne. Den första
       * stängningen stannar här före kuverten, medan en andra, som tar en egen
       * anslutning ur poolen precis som en annan process hade gjort, försöker.
       */
      await castFor(anna, 'bp-s')

      let release!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      let paused!: () => void
      const isPaused = new Promise<void>((resolve) => {
        paused = resolve
      })
      hooks.beforeEnvelopeRead = async () => {
        paused()
        await released
      }

      const first = attempt()
      await isPaused
      const before = await state()

      const second = await attempt()
      expect(second).toEqual({ outcome: { status: 'in_progress' }, error: null })
      expect(await state()).toEqual(before)

      release()
      expect((await first).outcome).toMatchObject({ status: 'closed', moved: 1 })
    })
  })

  describe('stängningens lås går förlorat (fixrunda 1)', () => {
    /**
     * Låset hålls av en egen transaktion. Här avslutas dess anslutning med
     * `pg_terminate_backend`, som när en anslutning tappas eller låsets
     * tidsgräns går ut. Påståendet "orörd" får då inte längre vila på låset.
     */
    it('ett lås som går förlorat under läsningen upptäcks före städningen, och ingenting städas', async () => {
      await castFor(anna, 'bp-s')
      await castFor(kim, 'bp-m')
      await plantForeignResidue()

      hooks.beforeEnvelopeRead = async () => {
        await dropClosingLock()
      }
      const { outcome, error } = await attempt()

      /**
       * Stängningen frågar låset före städningen och avbryter. Fasen står i
       * CLOSED med oskriven rot, men utan lås kan en annan stängning ha börjat,
       * så beskedet är det försiktiga och inte "orörd".
       */
      expect(outcome).toBeNull()
      expect(error).toBeInstanceOf(CloseAbortedError)
      expect(linkStateOf(error)).toBe('unknown')
      expect((error as Error).message).toContain('lås har gått förlorat')
      expect(await votesDb.encryptedVote.count({ where: { ballotId } })).toBe(1)
      expect(await votersDb.pendingVote.count()).toBe(2)
      expect(await state()).toEqual({ phase: 'CLOSED', envelopeRoot: null, linkClearedAt: null })
      expect(await votersDb.votedMarker.count()).toBe(0)
      expect(await linkClearedEvents()).toBe(0)

      // En omkörning tar ett nytt lås och går hela vägen.
      expect(await closeElection(electionId)).toMatchObject({
        status: 'closed',
        moved: 2,
        residueRemoved: ['en-hash-som-inte-hor-till-nagot-kuvert'],
      })
    })

    it('tappat lås, en annan stängning skalar och sedan ett kast i förberedelsen: svaret följer fasen, inte "orörd"', async () => {
      /**
       * Granskningen av 11d (V1, prob L3). Före fixrundan svarade den första
       * stängningen `untouched` och "Kopplingen … är ORÖRD", fast den andra
       * redan skalat och kopplingen var raderad.
       */
      await castFor(anna, 'bp-s')
      await castFor(kim, 'bp-m')

      let second: Attempt | null = null
      hooks.beforeEnvelopeRead = async () => {
        await dropClosingLock()
        second = await attempt()
        throw new Error('simulerat databasfel efter att den andra skalat')
      }
      const first = await attempt()

      expect(second).toMatchObject({ outcome: { status: 'closed', moved: 2 }, error: null })
      expect(first).toEqual({ outcome: { status: 'already_closed' }, error: null })
      expect(await phase()).toBe('STRIPPED')
      expect(await votersDb.pendingVote.count()).toBe(0)
    })

    it('tappat lås och ett kast i förberedelsen: beskedet är det försiktiga, inte "orörd"', async () => {
      await castFor(anna, 'bp-s')
      await castFor(kim, 'bp-m')

      hooks.beforeEnvelopeRead = async () => {
        await dropClosingLock()
        throw new Error('simulerat databasfel')
      }
      const { outcome, error } = await attempt()

      expect(outcome).toBeNull()
      expect(linkStateOf(error)).toBe('unknown')
      expect(abortedMessageFor(error)).not.toContain('ORÖRD')
      expect(await votersDb.pendingVote.count()).toBe(2)
      expect(await phase()).toBe('CLOSED')
    })

    it('tappat lås och en avvikelse i valideringen: svaret säger inte att kopplingen finns kvar', async () => {
      /**
       * `validation_failed` säger att kopplingen är kvar så att avvikelsen går
       * att utreda. Utan lås kan en annan stängning ha raderat den, så svaret
       * får inte ges förrän låset bekräftats (V1).
       */
      await castFor(anna, 'bp-s')
      await plantUnsignedVote(kim, 'bp-m')

      hooks.beforeEnvelopeRead = async () => {
        await dropClosingLock()
      }
      const { outcome, error } = await attempt()

      expect(outcome).toBeNull()
      expect(linkStateOf(error)).toBe('unknown')
      expect((error as Error).message).toContain('Valideringen hittade avvikelser')
      expect(await votersDb.pendingVote.count()).toBe(2)
    })

    it('tappat lås före städningens radering: ett chiffer som en annan stängning flyttat tas inte bort', async () => {
      /**
       * Granskningen av 11d (M2, prob L4). Robins äkta kuvert skrivs direkt i
       * röstlängden efter den första stängningens läsning, låset tappas, och
       * en andra stängning flyttar tre kuvert. Före fixrundan tog den första
       * stängningens städning sedan bort Robins chiffer, som inte fanns i dess
       * egen läsning, och urnan saknade en röst. Nu frågar städningen låset
       * direkt före raderingen.
       */
      await castFor(anna, 'bp-s')
      await castFor(kim, 'bp-m')
      const robins = await saveAndRemoveEnvelope(robin)

      let second: Attempt | null = null
      hooks.beforeUrnRead = async () => {
        await insertPendingRow(robins)
        await dropClosingLock()
        second = await attempt()
      }
      const first = await attempt()

      expect(second).toMatchObject({ outcome: { status: 'closed', moved: 3 }, error: null })
      expect(first).toEqual({ outcome: { status: 'already_closed' }, error: null })
      expect(await urn()).toContain(robins.ciphertextHash)
      expect(await urn()).toHaveLength(3)
      expect(await votersDb.votedMarker.count()).toBe(3)
    })

    it('tappat lås mellan frågan och raderingen: stängningen larmar och ger det försiktiga beskedet', async () => {
      /**
       * Fönstret som återstår (M2). Robins chiffer ligger kvar i röstdatabasen
       * från en avbruten stängning, och hans kuvert skrivs tillbaka direkt i
       * röstlängden först när den första stängningen ska radera resterna. Låset
       * tappas där, och en andra stängning flyttar Robins kuvert. Den första
       * tar sedan bort chiffret, eftersom det var en rest när den läste. Efter
       * raderingen frågar den låset och fasen, larmar i loggen och ger inget
       * besked om att kopplingen är orörd.
       */
      await castFor(anna, 'bp-s')
      await castFor(kim, 'bp-m')
      const robins = await saveAndRemoveEnvelope(robin)
      await plantUrnRow({ ciphertextHash: robins.ciphertextHash, ciphertext: robins.ciphertext, proofs: robins.proofs })
      const alarm = vi.spyOn(logger, 'error')

      let second: Attempt | null = null
      hooks.beforeUrnDelete = async () => {
        await insertPendingRow(robins)
        await dropClosingLock()
        second = await attempt()
      }
      const first = await attempt()

      expect(second).toMatchObject({ outcome: { status: 'closed', moved: 3 }, error: null })
      expect(first.outcome).toBeNull()
      expect(linkStateOf(first.error)).toBe('unknown')
      expect(abortedMessageFor(first.error)).not.toContain('ORÖRD')
      expect(alarm).toHaveBeenCalledWith(expect.stringContaining('LARM'), expect.objectContaining({ removed: 1 }))
      // Det larmet gäller: den andra stängningens urna saknar nu Robins chiffer.
      expect(await urn()).not.toContain(robins.ciphertextHash)
    })
  })

  describe('skalningen körs i låsets transaktion (fixrunda 2, ruling 128)', () => {
    /**
     * Omgranskningen av fixrunda 1 (Z1 och Z2). Skalningen hade en egen
     * transaktion, på en annan anslutning än låset. En stängning vars lås
     * gått förlorat efter den sista frågan kunde därför ändå skala, medan en
     * annan stängning tog låset. Nu körs skalningens satser i låsets egen
     * transaktion, och ett förlorat lås tar skalningen med sig.
     */
    function deferred(): { promise: Promise<void>; resolve: () => void } {
      let resolve!: () => void
      const promise = new Promise<void>((settle) => {
        resolve = settle
      })
      return { promise, resolve }
    }

    it('Z1: en stängning vars lås tappas före skalningen kan inte skala, och den som tog låset stänger', async () => {
      await castFor(anna, 'bp-s')
      await castFor(kim, 'bp-m')

      const secondAtStrip = deferred()
      const openSecond = deferred()
      let second: Promise<Attempt> | null = null
      hooks.beforeStrip = async (n) => {
        if (n === 1) {
          // Den första har frågat låset före skalningen. Låset tappas, och en
          // andra stängning tar det och går fram till sin egen skalning.
          await dropClosingLock()
          second = attempt()
          await secondAtStrip.promise
        } else if (n === 2) {
          secondAtStrip.resolve()
          await openSecond.promise
        }
      }

      const first = await attempt()
      openSecond.resolve()
      const secondResult = await second!

      /**
       * Före rättelsen skalade den första, eftersom dess skalning inte hängde
       * på låset. Den andra fick sedan ett misslyckat jämför-och-sätt, och
       * gick fasen inte att läsa svarade den ORÖRD.
       */
      expect(first.outcome).toBeNull()
      expect(linkStateOf(first.error)).toBe('unknown')
      expect(abortedMessageFor(first.error)).not.toContain('ORÖRD')
      expect(secondResult).toMatchObject({ outcome: { status: 'closed', moved: 2 }, error: null })
      expect(await phase()).toBe('STRIPPED')
      expect(await votersDb.pendingVote.count()).toBe(0)
      expect(await linkClearedEvents()).toBe(1)
    })

    it('Z2: en stängning vars låsanslutning avslutas mitt i skalningen raderar ingenting, och den andra stänger', async () => {
      await castFor(anna, 'bp-s')
      await castFor(kim, 'bp-m')

      let second: Promise<Attempt> | null = null
      hooks.afterStripWrite = async () => {
        // Den första har skrivit STRIPPED i sin skalning och håller omröstningens rad.
        await dropClosingLock()
        second = attempt()
        // Den andra stänger, eller fastnar på radlåset om skalningen lever vidare utan låset.
        await Promise.race([second, waitUntil(async () => (await waitingElectionUpdates()) > 0, 20_000)])
      }

      const first = await attempt()
      const secondResult = await second!

      expect(first.outcome).toBeNull()
      expect(linkStateOf(first.error)).toBe('unknown')
      expect(abortedMessageFor(first.error)).not.toContain('ORÖRD')
      expect(secondResult).toMatchObject({ outcome: { status: 'closed', moved: 2 }, error: null })
      expect(await linkClearedEvents()).toBe(1)
      expect(await votersDb.votedMarker.count()).toBe(2)
    })

    it('en stängning vars låsanslutning avslutas mitt i skalningen raderar ingenting, och en omkörning stänger', async () => {
      /**
       * Beviset som ruling 128 begär. Anslutningen avslutas efter skalningens
       * första sats, när STRIPPED redan är skriven i transaktionen. Ingenting
       * av skalningen får finnas kvar: fasen, roten, kuverten, markeringarna
       * och revisionsposten är som före skalningen.
       */
      const annas = await castFor(anna, 'bp-s')
      const kims = await castFor(kim, 'bp-m')
      hooks.afterStripWrite = async () => {
        await dropClosingLock()
      }

      const { outcome, error } = await attempt()

      expect(outcome).toBeNull()
      expect(linkStateOf(error)).toBe('unknown')
      expect(await state()).toEqual({ phase: 'VALIDATED', envelopeRoot: null, linkClearedAt: null })
      expect(await votersDb.pendingVote.count()).toBe(2)
      expect(await votersDb.votedMarker.count()).toBe(0)
      expect(await linkClearedEvents()).toBe(0)
      // Chiffren infogades före skalningen och ligger kvar, som efter varje avbrott.
      expect(await urn()).toEqual([annas, kims].sort())

      expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 2, cleared: 2 })
    })

    it('svaret på låsets COMMIT går förlorat: beskedet är det försiktiga, och kopplingen är raderad', async () => {
      /**
       * Skalningen görs nu av låsets COMMIT. Går svaret på den förlorat vet
       * stängningen inte om skalningen gick igenom. Före rättelsen hade låsets
       * transaktion inget eget att skriva, och ett fel vid dess COMMIT loggades
       * bara.
       */
      await castFor(anna, 'bp-s')
      hooks.failAfterLockCommit = true

      const { outcome, error } = await attempt()

      expect(outcome).toBeNull()
      expect(linkStateOf(error)).toBe('unknown')
      expect(abortedMessageFor(error)).not.toContain('ORÖRD')
      expect((await state()).phase).toBe('STRIPPED')
      expect(await votersDb.pendingVote.count()).toBe(0)
      expect(await closeElection(electionId)).toEqual({ status: 'already_closed' })
    })
  })

  describe('en fas som inte går att läsa ger det försiktiga beskedet (fixrunda 2)', () => {
    /**
     * Omgranskningen av fixrunda 1, nytt fel 1. Gick fasen inte att läsa men
     * låset höll, sade stängningen att kopplingen var orörd. Låset utesluter
     * bara en stängning som tar det senare, och "orörd" kräver därför en läst
     * fas, oavsett lås.
     */
    it.each([
      ['efter att skalningens jämför-och-sätt inte träffat', 'strip'],
      ['efter en övergång till VALIDATED som inte ändrade något', 'validated'],
      ['efter ett kast i förberedelsen', 'throw'],
    ] as const)('%s', async (_label, where) => {
      await castFor(anna, 'bp-s')
      await castFor(kim, 'bp-m')

      if (where === 'strip') {
        hooks.beforeInsert = async () => {
          await setPhase('CLOSED')
          hooks.failCloseStateReads = 1
        }
      } else if (where === 'validated') {
        hooks.beforeEnvelopeRead = async () => {
          await setPhase('STRIPPED')
          hooks.failCloseStateReads = 1
        }
      } else {
        hooks.beforeUrnRead = async () => {
          hooks.failCloseStateReads = 1
          throw new Error('simulerat databasfel')
        }
      }

      const { outcome, error } = await attempt()

      expect(outcome).toBeNull()
      expect(error).toBeInstanceOf(CloseAbortedError)
      expect(linkStateOf(error)).toBe('unknown')
      expect(abortedMessageFor(error)).not.toContain('ORÖRD')
      expect((error as Error).message).toContain('Fasen gick inte att läsa')
      expect(await votersDb.pendingVote.count()).toBe(2)
    })
  })

  describe('gränsen för tomgång i låsets transaktion (fixrunda 2)', () => {
    /**
     * Omgranskningens S1 och S1m. Låsets transaktion står stilla medan
     * stängningen arbetar i andra anslutningar. Här får den en gräns på en
     * sekund innan låset tas, och stängningen står stilla i två och en halv.
     */
    async function stallTheClosing(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 2_500))
    }

    it('S1: stängningens set_config håller låset över gränsen', async () => {
      await castFor(anna, 'bp-s')
      hooks.lockSessionIdleTimeoutMs = 1_000
      hooks.beforeEnvelopeRead = stallTheClosing

      expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 1 })
    })

    it('S1m: utan stängningens set_config avslutar servern låsets anslutning, och stängningen avbryts', async () => {
      // Motprovet: gränsen i testet slår faktiskt till, så S1 prövar något.
      await castFor(anna, 'bp-s')
      hooks.lockSessionIdleTimeoutMs = 1_000
      hooks.skipCodeSetConfig = true
      hooks.beforeEnvelopeRead = stallTheClosing

      const { outcome, error } = await attempt()

      expect(outcome).toBeNull()
      expect(linkStateOf(error)).toBe('unknown')
      expect((error as Error).message).toContain('lås har gått förlorat')
      expect(await votersDb.pendingVote.count()).toBe(1)
    })
  })

  describe('en röst i sista stund', () => {
    it('en röst vars fas prövades före stängningen men som skrivs efter den läggs inte, och väljaren får ett fel', async () => {
      const annas = await castFor(anna, 'bp-s')
      const kims = await prepareCast(kim, 'bp-m')

      // Kims läggning börjar medan röstningen är öppen och stannar före sin transaktion.
      await setClosesAt(inTheFuture())
      const gate = armCastGate()
      const kimsCast = castPrepared(kim, kims)
      await gate.reached
      await setClosesAt(inThePast())

      expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 1, cleared: 1 })

      // Klockan står åter öppen, så att det är fasen och inte klockan som prövas.
      await setClosesAt(inTheFuture())
      gate.open()

      /**
       * Före uppgift 11d prövade läggningen fasen med en läsning före
       * verifieringen och skrev sedan utan villkor. Kims kuvert hamnade då i
       * pending_vote efter skalningen, och hon fick beskedet att rösten var
       * lagd.
       */
      expect((await kimsCast).status).toBe('closed')
      expect(await votersDb.pendingVote.count()).toBe(0)
      expect(await urn()).toEqual([annas])
    })

    it('en röst som skrivs mellan läsningen och raderingen flyttas eller avvisas, men sägs aldrig vara lagd utan att flyttas', async () => {
      const annas = await castFor(anna, 'bp-s')
      const kims = await prepareCast(kim, 'bp-m')

      await setClosesAt(inTheFuture())
      const gate = armCastGate()
      const kimsCast = castPrepared(kim, kims)
      await gate.reached
      await setClosesAt(inThePast())

      // Kims läggning fortsätter när stängningen har läst och validerat kuverten.
      let kimsOutcome: CastOutcome | null = null
      hooks.beforeInsert = async () => {
        gate.open()
        kimsOutcome = await kimsCast
      }

      const close = await attempt()

      expect(kimsOutcome).not.toBeNull()
      if (kimsOutcome!.status === 'recorded') {
        expect(await urn(), 'rösten sades vara lagd men flyttades inte').toContain(kims.ballot.ciphertextHash)
      } else {
        expect(kimsOutcome!.status).toBe('closed')
      }
      expect(close.error).toBeNull()
      expect(close.outcome).toMatchObject({ status: 'closed', moved: 1, cleared: 1 })
      expect(await urn()).toEqual([annas])
      expect(await votersDb.pendingVote.count()).toBe(0)
    })

    it('en läggning som prövat fasen i sin transaktion skriver klart, och stängningen väntar på den', async () => {
      /**
       * Granskningen av 11d (M1, prob C1). Det här är ordningen `FOR SHARE`
       * finns för: läggningen har prövat fasen i sin transaktion men inte
       * skrivit än, när stängningen vill skriva CLOSED. Stängningens UPDATE
       * väntar då på läggningens lås, och kuvertet finns på plats när
       * kuverten läses. Utan `FOR SHARE` skrivs CLOSED direkt, och kuvertet
       * hamnar i pending_vote efter läsningen, eller efter skalningen.
       */
      const annas = await castFor(anna, 'bp-s')
      const kims = await prepareCast(kim, 'bp-m')

      // Röstningen står öppen i tre sekunder till, så att läggningen hinner pröva fasen.
      const closesAt = new Date(Date.now() + 3_000)
      await setClosesAt(closesAt)
      const gate = armCastTxGate()
      const kimsCast = castPrepared(kim, kims)
      await gate.reached

      // Klockan får passera. Omröstningens rad går inte att ändra medan läggningen håller den.
      await waitUntil(() => Date.now() > closesAt.getTime() + 50, 10_000)
      const closing = attempt()
      await waitUntil(async () => (await waitingElectionUpdates()) > 0, 10_000)
      expect(await phase()).toBe('OPEN')

      gate.open()
      expect(await kimsCast).toMatchObject({ status: 'recorded', ciphertextHash: kims.ballot.ciphertextHash })

      const { outcome, error } = await closing
      expect(error).toBeNull()
      expect(outcome).toMatchObject({ status: 'closed', moved: 2, cleared: 2 })
      expect(await urn()).toEqual([annas, kims.ballot.ciphertextHash].sort())
      expect(await votersDb.pendingVote.count()).toBe(0)
    })
  })

  describe('räknaren prövas i läggningens transaktion (fixrunda 1, ruling 127)', () => {
    /**
     * Två läggningar för samma väljare och valsedel, med olika räknare, som
     * båda har passerat prövningen före transaktionen. Den med högre räknare
     * skriver först. Före rättelsen skrev den lägre sedan över den högre, och
     * ett äldre kuvert blev det som räknades.
     */
    it('med ett kuvert som redan ligger: den högre står kvar, och den lägre får stale_sequence', async () => {
      await castFor(anna, 'bp-s')
      const lower = await prepareCast(anna, 'bp-m', 2)
      const higher = await prepareCast(anna, 'bp-s', 3)

      await setClosesAt(inTheFuture())
      try {
        const lowerGate = armCastGate()
        const lowerCast = castPrepared(anna, lower)
        await lowerGate.reached
        const higherGate = armCastGate()
        const higherCast = castPrepared(anna, higher)
        await higherGate.reached

        higherGate.open()
        expect(await higherCast).toMatchObject({ status: 'recorded', ciphertextHash: higher.ballot.ciphertextHash })
        lowerGate.open()
        expect(await lowerCast).toEqual({ status: 'stale_sequence' })
      } finally {
        await setClosesAt(inThePast())
      }

      const row = await votersDb.pendingVote.findFirstOrThrow({ where: { voterStatusId: anna } })
      expect(row).toMatchObject({ castSequence: 3, ciphertextHash: higher.ballot.ciphertextHash })
    })

    it('utan kuvert sedan tidigare: den högre står kvar, och den lägre får stale_sequence', async () => {
      const lower = await prepareCast(anna, 'bp-m', 1)
      const higher = await prepareCast(anna, 'bp-s', 2)

      await setClosesAt(inTheFuture())
      try {
        const lowerGate = armCastGate()
        const lowerCast = castPrepared(anna, lower)
        await lowerGate.reached
        const higherGate = armCastGate()
        const higherCast = castPrepared(anna, higher)
        await higherGate.reached

        higherGate.open()
        expect(await higherCast).toMatchObject({ status: 'recorded', replaced: false })
        lowerGate.open()
        expect(await lowerCast).toEqual({ status: 'stale_sequence' })
      } finally {
        await setClosesAt(inThePast())
      }

      const row = await votersDb.pendingVote.findFirstOrThrow({ where: { voterStatusId: anna } })
      expect(row).toMatchObject({ castSequence: 2, ciphertextHash: higher.ballot.ciphertextHash })
    })

    it('två första läggningar som båda ser att inget kuvert finns: den som skriver sist prövas mot den första', async () => {
      /**
       * Båda läggningarna står vid `create` i sina transaktioner. Den högre
       * skapar raden. Den lägre stoppas av det unika indexet, och läggningen
       * gör om sin transaktion och prövar då räknaren mot raden som finns.
       */
      const lower = await prepareCast(anna, 'bp-m', 1)
      const higher = await prepareCast(anna, 'bp-s', 2)
      hooks.castTxGateAt = 'create'

      await setClosesAt(inTheFuture())
      try {
        const lowerGate = armCastTxGate()
        const lowerCast = castPrepared(anna, lower)
        await lowerGate.reached
        const higherGate = armCastTxGate()
        const higherCast = castPrepared(anna, higher)
        await higherGate.reached

        higherGate.open()
        expect(await higherCast).toMatchObject({ status: 'recorded', replaced: false })
        lowerGate.open()
        expect(await lowerCast).toEqual({ status: 'stale_sequence' })
      } finally {
        await setClosesAt(inThePast())
      }

      const row = await votersDb.pendingVote.findFirstOrThrow({ where: { voterStatusId: anna } })
      expect(row).toMatchObject({ castSequence: 2, ciphertextHash: higher.ballot.ciphertextHash })
    })
  })

  describe('två kuvert får aldrig ha samma chifferhash (fixrunda 2, ruling 129)', () => {
    /**
     * Omgranskningen av fixrunda 1 (D1 och D2). Chifferhashen är unik i urnan,
     * så två kuvert med samma chiffer kan aldrig båda infogas, och återläsningen
     * avbröt då varje stängning. Den som lade samma chiffer två gånger kunde
     * alltså hindra valet från att stängas. Nu tar läggningen inte emot ett
     * chiffer som redan ligger på ett annat kuvert.
     */
    async function alarms(spy: ReturnType<typeof vi.spyOn>): Promise<number> {
      return spy.mock.calls.filter(([message]) => String(message).includes('LARM')).length
    }

    it('D1: samma chiffer på två valsedlar tas emot bara på den första, och stängningen går igenom utan larm', async () => {
      const s = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'S' } })
      const m = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'M' } })
      const created = await createElection({
        name: 'Samma chiffer på två valsedlar',
        kind: 'RIKSDAGSVAL',
        opensAt: new Date(Date.now() - 60_000),
        closesAt: inTheFuture(),
        ballots: [
          { kind: 'RIKSDAG', label: 'Riksdagen', allowsCandidateVote: false, parties: [{ partyId: s.id }, { partyId: m.id }] },
          { kind: 'RIKSDAG', label: 'Riksdagen, en gång till', allowsCandidateVote: false, parties: [{ partyId: s.id }, { partyId: m.id }] },
        ],
        trusteePassphrases: ['test-fras-ett', 'test-fras-tva', 'test-fras-tre'],
      })
      if (created.status !== 'created') throw new Error('Kunde inte skapa omröstningen.')
      const twoBallotElection = created.election.id
      const [first, second] = created.election.ballotIds.map((ballot) => ballot.id)
      const key = await votesDb.election.findUniqueOrThrow({
        where: { id: twoBallotElection },
        select: { encryptionPublicKey: true },
      })

      // Samma slumptal i båda krypteringarna ger samma chiffer, med bevis för var sin valsedel.
      const encryptFor = async (target: string) => {
        const parties = await votesDb.ballotParty.findMany({ where: { ballotId: target }, orderBy: { displayOrder: 'asc' } })
        const targetOptions = canonicalOptions({
          allowsCandidateVote: false,
          parties: parties.map((party, index) => ({ id: party.id, displayOrder: index, candidates: [] })),
        })
        return encryptBallot(key.encryptionPublicKey!, twoBallotElection, target, targetOptions, {
          kind: 'PARTY',
          ballotPartyId: parties[0]!.id,
        })
      }
      hooks.rng = { mode: 'record', tape: [], position: 0 }
      const onFirst = await encryptFor(first!)
      hooks.rng = { mode: 'replay', tape: hooks.rng.tape, position: 0 }
      const onSecond = await encryptFor(second!)
      hooks.rng = { mode: 'off', tape: [], position: 0 }
      expect(onSecond.ciphertextHash).toBe(onFirst.ciphertextHash)

      const castOn = async (target: string, ballot: EncryptedBallot) =>
        castPrepared(anna, await prepareCastOf(anna, ballot, undefined, { electionId: twoBallotElection, ballotId: target }))

      expect(await castOn(first!, onFirst)).toMatchObject({ status: 'recorded' })
      expect(await castOn(second!, onSecond)).toEqual({ status: 'duplicate_ciphertext' })
      expect(await votersDb.pendingVote.count({ where: { ballotId: { in: [first!, second!] } } })).toBe(1)

      // Stängningen flyttar det enda kuvertet, utan larm om en förfalskad rad.
      const errors = vi.spyOn(logger, 'error')
      await votersDb.election.update({ where: { id: twoBallotElection }, data: { closesAt: inThePast() } })
      await votesDb.election.update({ where: { id: twoBallotElection }, data: { closesAt: inThePast() } })
      expect(await closeElection(twoBallotElection)).toMatchObject({ status: 'closed', moved: 1, urnRowsReplaced: [] })
      expect(await alarms(errors)).toBe(0)
    })

    it('D2: två väljare med exakt samma chiffer: bara den första tas emot, och stängningen går igenom', async () => {
      const copied = buildBallot('bp-s')
      expect(await castOpen(anna, await prepareCastOf(anna, copied))).toMatchObject({ status: 'recorded' })
      expect(await castOpen(kim, await prepareCastOf(kim, copied))).toEqual({ status: 'duplicate_ciphertext' })
      expect(await votersDb.pendingVote.count()).toBe(1)

      const errors = vi.spyOn(logger, 'error')
      expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 1 })
      expect(await urn()).toEqual([copied.ciphertextHash])
      expect(await alarms(errors)).toBe(0)
    })

    it('samma väljare som lägger om samma chiffer på samma valsedel byter som förut', async () => {
      const ballot = buildBallot('bp-s')
      expect(await castOpen(anna, await prepareCastOf(anna, ballot))).toMatchObject({ status: 'recorded', replaced: false })
      expect(await castOpen(anna, await prepareCastOf(anna, ballot))).toMatchObject({ status: 'recorded', replaced: true })

      const row = await votersDb.pendingVote.findFirstOrThrow({ where: { voterStatusId: anna } })
      expect(row).toMatchObject({ castSequence: 2, ciphertextHash: ballot.ciphertextHash })
    })

    it('två väljare som lägger samma chiffer samtidigt: den ena tas emot, den andra får ett tydligt fel', async () => {
      /**
       * Båda läggningarna står vid `create` i sina transaktioner. Den andra
       * stoppas av det unika indexet på chifferhashen, och det är inte samma
       * sak som att två läggningar för samma väljare möts. Den ska inte göra om
       * sin transaktion, utan svara att chiffret redan finns.
       */
      const copied = buildBallot('bp-s')
      const annas = await prepareCastOf(anna, copied)
      const kims = await prepareCastOf(kim, copied)
      hooks.castTxGateAt = 'create'

      await setClosesAt(inTheFuture())
      try {
        const annaGate = armCastTxGate()
        const annaCast = castPrepared(anna, annas)
        await annaGate.reached
        const kimGate = armCastTxGate()
        const kimCast = castPrepared(kim, kims)
        await kimGate.reached

        annaGate.open()
        expect(await annaCast).toMatchObject({ status: 'recorded', replaced: false })
        kimGate.open()
        expect(await kimCast).toEqual({ status: 'duplicate_ciphertext' })
      } finally {
        await setClosesAt(inThePast())
      }

      expect(await votersDb.pendingVote.count()).toBe(1)
    })
  })

  describe('rester i röstdatabasen', () => {
    it('en omkörning tar bort chiffer som inte hör till något validerat kuvert, loggar antalet och pekar ut dem', async () => {
      const annas = await castFor(anna, 'bp-s')
      const kims = await castFor(kim, 'bp-m')

      // Annas kuvert tas bort efter valideringen. Hennes chiffer har då redan
      // flyttats, och transaktionen avbryts.
      hooks.beforeInsert = async () => {
        await votersDb.pendingVote.deleteMany({ where: { voterStatusId: anna } })
      }
      const first = await attempt()
      expect(linkStateOf(first.error)).toBe('untouched')
      expect(await urn()).toEqual([annas, kims].sort())

      /**
       * Fram till uppgift 11d stoppade antalskontrollen varje omkörning här,
       * eftersom ett kuvert lästes och två chiffer fanns, tills någon städade
       * för hand. Den som kunde skriva i databasen kunde alltså låsa ett val.
       */
      const warn = vi.spyOn(logger, 'warn')
      const rerun = await closeElection(electionId)

      expect(rerun).toMatchObject({ status: 'closed', moved: 1, cleared: 1, residueRemoved: [annas] })
      expect(await urn()).toEqual([kims])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('rester'), expect.objectContaining({ found: 1 }))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('rester'), expect.objectContaining({ removed: 1 }))
    })

    it('ett chiffer med en främmande hash på valsedeln tas bort före infogningen', async () => {
      const annas = await castFor(anna, 'bp-s')
      await plantForeignResidue()

      expect(await closeElection(electionId)).toMatchObject({
        status: 'closed',
        moved: 1,
        residueRemoved: ['en-hash-som-inte-hor-till-nagot-kuvert'],
      })
      expect(await urn()).toEqual([annas])
    })

    it('städningen rör inte chiffer på en annan omröstnings valsedlar', async () => {
      await castFor(anna, 'bp-s')
      const other = buildBallot('bp-s')
      await plantUrnRow({
        ballotId: otherBallotId,
        ciphertextHash: other.ciphertextHash,
        ciphertext: other.ciphertext,
        proofs: other.proofs,
      })

      expect(await closeElection(electionId)).toMatchObject({
        status: 'closed',
        residueRemoved: [],
        urnRowsReplaced: [],
      })
      expect(await votesDb.encryptedVote.count({ where: { ballotId: otherBallotId } })).toBe(1)
    })

    it('resterna loggas innan de raderas, också när raderingen fallerar', async () => {
      /**
       * Granskningen av 11d (M8). Beskedet för `untouched` säger att chiffer
       * kan ha tagits bort och att det står i serverloggen. Loggades antalet
       * först efter raderingen fanns ingen loggrad om en omgång kastade.
       */
      await castFor(anna, 'bp-s')
      await plantForeignResidue()
      const warn = vi.spyOn(logger, 'warn')

      hooks.beforeUrnDelete = async () => {
        throw new Error('simulerat fel i röstdatabasen')
      }
      const { outcome, error } = await attempt()

      expect(outcome).toBeNull()
      expect(linkStateOf(error)).toBe('untouched')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('rester'), expect.objectContaining({ found: 1 }))
    })
  })

  describe('förfalskade rader i urnan', () => {
    async function plantBeforeInsert(row: {
      ciphertextHash: string
      ballotId?: string
      ciphertext?: unknown
      proofs?: unknown
    }): Promise<void> {
      hooks.beforeInsert = async () => {
        await plantUrnRow({
          ciphertextHash: row.ciphertextHash,
          ballotId: row.ballotId,
          ciphertext: row.ciphertext,
          proofs: row.proofs,
        })
      }
    }

    it.each([
      ['ett annat chiffer', 'ciphertext'],
      ['andra bevis', 'proofs'],
      ['en annan valsedel', 'ballot'],
    ] as const)(
      'en rad med ett äkta kuverts hash men %s, skriven efter städningen och före infogningen, stoppar stängningen',
      async (_label, swapped) => {
        /**
         * Granskningen av 14f: infogningen hoppar över en rad som redan finns,
         * och steg 5 räknade bara rader. Den som kunde skriva i votes_db lade
         * en rad med Annas hash och ett annat innehåll, och stängningen svarade
         * `closed` fast urnans chiffer inte var det validerade. Återläsningen
         * fångar en rad som skrivs efter städningen, som här.
         */
        const annas = await castFor(anna, 'bp-s')
        await castFor(kim, 'bp-m')
        const annasRow = await votersDb.pendingVote.findFirstOrThrow({ where: { voterStatusId: anna } })
        const forged = buildBallot('bp-m')

        await plantBeforeInsert({
          ciphertextHash: annas,
          ballotId: swapped === 'ballot' ? otherBallotId : ballotId,
          ciphertext: swapped === 'ciphertext' ? forged.ciphertext : annasRow.ciphertext,
          proofs: swapped === 'proofs' ? forged.proofs : annasRow.proofs,
        })

        const { outcome, error } = await attempt()

        expect(outcome).toBeNull()
        expect(error).toBeInstanceOf(CloseAbortedError)
        expect(linkStateOf(error)).toBe('untouched')
        expect(abortedMessageFor(error)).toContain('ORÖRD')
        expect(await votersDb.pendingVote.count()).toBe(2)
        expect(await state()).toEqual({ phase: 'VALIDATED', envelopeRoot: null, linkClearedAt: null })
        expect(await linkClearedEvents()).toBe(0)
        expect(await votersDb.votedMarker.count()).toBe(0)
      },
    )

    it.each([
      ['ett annat chiffer', 'ciphertext'],
      ['andra bevis', 'proofs'],
      ['en annan omröstnings valsedel', 'ballot'],
      ['ett annat id', 'id'],
      ['en annan hash, på kuvertets id och en annan omröstnings valsedel', 'squat'],
    ] as const)(
      'en rad som redan ligger på ett äkta kuverts plats men med %s ersätts med det validerade, och det står i beskedet',
      async (_label, swapped) => {
        /**
         * Ruling 126. Hashen räknas ur chiffret och id:t ur hashen, så ingen
         * legitim väg ger en rad med ett validerat kuverts hash eller id och
         * ett annat innehåll. Före fixrundan stoppade en sådan rad varje
         * stängning tills någon tog bort den för hand, och den som kunde skriva
         * i röstdatabasen kunde hålla valet öppet. Nu ersätts raden under
         * låset, före infogningen, och det larmas. Den sista raden tar
         * kuvertets id med en annan hash, så att infogningen hade stoppats av
         * primärnyckeln.
         */
        const annas = await castFor(anna, 'bp-s')
        const annasRow = await votersDb.pendingVote.findFirstOrThrow({ where: { voterStatusId: anna } })
        const forged = buildBallot('bp-m')
        await plantUrnRow({
          ciphertextHash: swapped === 'squat' ? forged.ciphertextHash : annas,
          id: swapped === 'id' ? 'ffffffff-ffff-ffff-ffff-ffffffffffff' : idForEnvelope(annas),
          ballotId: swapped === 'ballot' || swapped === 'squat' ? otherBallotId : ballotId,
          ciphertext: swapped === 'ciphertext' || swapped === 'squat' ? forged.ciphertext : annasRow.ciphertext,
          proofs: swapped === 'proofs' || swapped === 'squat' ? forged.proofs : annasRow.proofs,
        })
        const alarm = vi.spyOn(logger, 'error')

        expect(await closeElection(electionId)).toMatchObject({
          status: 'closed',
          moved: 1,
          urnRowsReplaced: [annas],
          residueRemoved: [],
        })

        const stored = await votesDb.encryptedVote.findUniqueOrThrow({ where: { ciphertextHash: annas } })
        expect(stored).toMatchObject({ id: idForEnvelope(annas), ballotId })
        expect(stored.ciphertext).toEqual(annasRow.ciphertext)
        expect(stored.proofs).toEqual(annasRow.proofs)
        expect(await votesDb.encryptedVote.count({ where: { ballotId: otherBallotId } })).toBe(0)
        expect(alarm).toHaveBeenCalledWith(expect.stringContaining('LARM'), expect.objectContaining({ found: 1 }))
      },
    )

    it('en ersättning som följs av ett avbrott står i felet, eftersom en omkörning inte hittar raden igen', async () => {
      /**
       * Beskedet ska ange varje ersättning med chifferhash (ruling 126). Här
       * ersätts raden, och infogningen fallerar sedan. Omkörningen hittar
       * ingenting att ersätta, så det enda beskedet om raden är det avbrutna
       * försökets.
       */
      const annas = await castFor(anna, 'bp-s')
      const forged = buildBallot('bp-m')
      await plantUrnRow({ ciphertextHash: annas, ciphertext: forged.ciphertext, proofs: forged.proofs })

      hooks.beforeInsert = async () => {
        throw new Error('simulerat fel i röstdatabasen')
      }
      const { outcome, error } = await attempt()

      expect(outcome).toBeNull()
      expect(linkStateOf(error)).toBe('untouched')
      expect(urnRowsReplacedOf(error)).toEqual([annas])

      expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 1, urnRowsReplaced: [] })
    })
  })

  describe('ersättningar och avvikelser når beskedet och loggen (fixrunda 2)', () => {
    it('AC1: en ersättning följs av ett tappat lås och en annan stängning, och already_closed bär hashen', async () => {
      /**
       * Omgranskningen av fixrunda 1, nytt fel 4. Den första stängningen ersätter
       * en förfalskad rad och tappar sedan låset. Den andra stänger och hittar
       * ingenting att ersätta. Före rättelsen svarade den första
       * `already_closed` utan hashen, och ersättningen stod bara i loggen.
       */
      const annas = await castFor(anna, 'bp-s')
      await castFor(kim, 'bp-m')
      const forged = buildBallot('bp-m')
      await plantUrnRow({ ciphertextHash: annas, ciphertext: forged.ciphertext, proofs: forged.proofs })

      let second: Attempt | null = null
      hooks.beforeInsert = async () => {
        await dropClosingLock()
        second = await attempt()
      }
      const first = await attempt()

      expect(second).toMatchObject({ outcome: { status: 'closed', moved: 2, urnRowsReplaced: [] }, error: null })
      expect(first).toEqual({ outcome: { status: 'already_closed', urnRowsReplaced: [annas] }, error: null })
    })

    it('avvikelser som valideringen hittat loggas med sin sammanfattning, också när svaret blir already_closed', async () => {
      /**
       * Nytt fel 5. Valideringen hittar en avvikelse medan en annan stängning
       * skalar, och svaret blir `already_closed`. Före rättelsen syntes
       * avvikelsen då ingenstans.
       */
      await castFor(anna, 'bp-s')
      await plantUnsignedVote(kim, 'bp-m')
      const warn = vi.spyOn(logger, 'warn')

      let second: Attempt | null = null
      hooks.onValidationHash = async () => {
        // Den första har läst kuverten och validerar. Låset tappas, den
        // förfalskade raden tas bort, och en andra stängning skalar.
        await dropClosingLock()
        await votersDb.pendingVote.deleteMany({ where: { voterStatusId: kim } })
        second = await attempt()
      }
      const first = await attempt()

      expect(second).toMatchObject({ outcome: { status: 'closed', moved: 1 }, error: null })
      expect(first).toEqual({ outcome: { status: 'already_closed' }, error: null })
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Valideringen hittade avvikelser'),
        expect.objectContaining({ summary: expect.objectContaining({ passed: false, votes: 2 }) }),
      )
    })

    it('ett avbrott innan de förfalskade raderna tagits bort bär inga ersättningar', async () => {
      /**
       * Nytt fel 6. Hasharna sattes innan något raderats. Kastade raderingen
       * av resterna innan de förfalskade raderna nåddes bar felet ändå
       * hasharna, och svaret sade att raderna tagits bort.
       */
      const annas = await castFor(anna, 'bp-s')
      const forged = buildBallot('bp-m')
      await plantUrnRow({ ciphertextHash: annas, ciphertext: forged.ciphertext, proofs: forged.proofs })
      await plantForeignResidue()
      hooks.beforeUrnDelete = async () => {
        throw new Error('simulerat fel i röstdatabasen')
      }

      const { outcome, error } = await attempt()

      expect(outcome).toBeNull()
      expect(linkStateOf(error)).toBe('untouched')
      expect(urnRowsReplacedOf(error)).toEqual([])
      // Den förfalskade raden ligger kvar, och en omkörning ersätter den.
      const stored = await votesDb.encryptedVote.findUniqueOrThrow({ where: { ciphertextHash: annas } })
      expect(stored.ciphertext).toEqual(forged.ciphertext)
      expect(await closeElection(electionId)).toMatchObject({
        status: 'closed',
        urnRowsReplaced: [annas],
        residueRemoved: ['en-hash-som-inte-hor-till-nagot-kuvert'],
      })
    })
  })

  describe('kuverten läses i omgångar', () => {
    it('läsningen delas i omgångar under taket, och varje kuvert kommer med exakt en gång', async () => {
      /**
       * Prisma kastar för svar över 536 870 888 tecken, och med utfyllnaden
       * från 14f blev taket några tusen kuvert per stängning. Raderna här är
       * inga riktiga kuvert, eftersom läsningen inte validerar något själv.
       */
      const batch = ENVELOPE_READ_BATCH_SIZE
      const count = batch * 2 + 1
      const voters = Array.from({ length: count }, () => ({
        id: randomUUID(),
        externalIdentityHash: randomBytes(32).toString('hex'),
      }))
      await votersDb.voterStatus.createMany({ data: voters })
      await votersDb.pendingVote.createMany({
        data: voters.map((voter) => ({
          voterStatusId: voter.id,
          ballotId,
          ciphertext: [],
          proofs: {},
          ciphertextHash: randomBytes(32).toString('hex'),
          castSequence: 1,
          bankIdSignature: 'x',
          bankIdCertificateChain: 'x',
          updatedAt: new Date(),
        })),
      })

      hooks.pendingVoteReads = []
      const snapshot = await readEnvelopes(electionId)

      expect(snapshot.envelopes).toHaveLength(count)
      expect(new Set(snapshot.envelopes.map((envelope) => envelope.id)).size).toBe(count)
      expect(hooks.pendingVoteReads.length).toBeGreaterThan(2)
      for (const read of hooks.pendingVoteReads) {
        expect(read.take).toBeDefined()
        expect(read.take!).toBeLessThanOrEqual(batch)
      }

      await votersDb.pendingVote.deleteMany()
    })
  })

  describe('markeringen "har röstat"', () => {
    it('skalningen markerar varje väljare vars kuvert flyttas, per valsedel och utan tidsstämpel', async () => {
      await castFor(anna, 'bp-s')
      await castFor(kim, 'bp-m')

      // Före stängningen finns ingen markering.
      expect(await votersDb.votedMarker.count()).toBe(0)

      expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 2 })

      const markers = await votersDb.votedMarker.findMany({ select: { voterStatusId: true, ballotId: true } })
      const byVoter = (a: { voterStatusId: string }, b: { voterStatusId: string }) =>
        a.voterStatusId < b.voterStatusId ? -1 : 1
      expect(markers.sort(byVoter)).toEqual(
        [
          { voterStatusId: anna, ballotId },
          { voterStatusId: kim, ballotId },
        ].sort(byVoter),
      )

      // Tabellen har ingen kolumn för tid, så markeringen säger inte när.
      const columns = await votersDb.$queryRaw<Array<{ column_name: string; data_type: string }>>`
        SELECT column_name::text AS column_name, data_type::text AS data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'voted_marker'`
      expect(columns.map((column) => column.column_name).sort()).toEqual(['ballot_id', 'id', 'voter_status_id'])
      expect(columns.filter((column) => /time|date|interval/i.test(column.data_type))).toEqual([])

      // Det gamla flödets markering rörs inte, så röstsidan tolkar ingenting nytt.
      expect(await votersDb.voterBallotStatus.count()).toBe(0)
    })

    it('ingen markering skrivs när valideringen stoppar stängningen', async () => {
      await castFor(anna, 'bp-s')
      await plantUnsignedVote(kim, 'bp-m')
      expect((await closeElection(electionId)).status).toBe('validation_failed')
      expect(await votersDb.votedMarker.count()).toBe(0)
    })

    it('ingen markering finns kvar när skalningens transaktion avbryts', async () => {
      await castFor(anna, 'bp-s')
      await castFor(kim, 'bp-m')
      hooks.beforeInsert = async () => {
        await votersDb.pendingVote.deleteMany({ where: { voterStatusId: anna } })
      }

      // Kims markering skrivs i transaktionen, som sedan rullas tillbaka.
      expect(linkStateOf((await attempt()).error)).toBe('untouched')
      expect(await votersDb.votedMarker.count()).toBe(0)
    })

    it.each([
      ['för en väljare utan kuvert', 'robin'],
      ['för en väljare med kuvert', 'anna'],
    ] as const)(
      'en markering som redan finns före skalningen, %s, stoppar den, och ingenting raderas',
      async (_label, who) => {
        await castFor(anna, 'bp-s')
        await castFor(kim, 'bp-m')
        await votersDb.votedMarker.create({ data: { voterStatusId: who === 'robin' ? robin : anna, ballotId } })

        const { outcome, error } = await attempt()

        expect(outcome).toBeNull()
        expect(linkStateOf(error)).toBe('untouched')
        expect(abortedMessageFor(error)).toContain('ORÖRD')
        expect(await votersDb.pendingVote.count()).toBe(2)
        expect(await votersDb.votedMarker.count()).toBe(1)
        expect(await state()).toEqual({ phase: 'VALIDATED', envelopeRoot: null, linkClearedAt: null })
      },
    )

    it('markeringarna skickas till databasen i väljarnas ordning, inte i läggningens', async () => {
      /**
       * Raderna i pending_vote ligger i den ordning väljarna röstade. Skrevs
       * markeringarna i den ordningen skulle tabellens fysiska ordning säga
       * vem som röstade före vem, och markeringen säga något om när. Här
       * röstar väljarna i omvänd ordning mot sina id, så att en markering i
       * läggningsordning inte kan råka se sorterad ut.
       *
       * Testet prövar ordningen som skickas till `createMany` och inte
       * `ORDER BY ctid` (granskningen av 11d, M5): PostgreSQL lägger en rad
       * där det finns plats, så den fysiska ordningen följer inte alltid
       * insättningen.
       */
      const voters = [anna, kim, robin, sam, vera].sort().reverse()
      for (const [index, voter] of voters.entries()) await castFor(voter, index % 2 === 0 ? 'bp-s' : 'bp-m')

      hooks.markerInsertOrder = []
      expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 5 })
      expect(hooks.markerInsertOrder).toEqual([...voters].sort())
    })
  })
})
