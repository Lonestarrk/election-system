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
 * läggningen prövar fasen i samma transaktion som den skriver, att rester i
 * röstdatabasen städas, att varje flyttat chiffer läses tillbaka, att kuverten
 * läses i omgångar, och att markeringen "har röstat" skrivs i skalningens
 * transaktion.
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
  /** Före infogningen i votes_db, efter valideringen. */
  beforeInsert: null as null | (() => Promise<void>),
  /** Före nästa läsning av encrypted_vote, alltså städningen eller återläsningen. */
  beforeUrnRead: null as null | (() => Promise<void>),
  /** Varje läsning av pending_vote genom den delade klienten, med sitt `take`. */
  pendingVoteReads: [] as Array<{ take: number | undefined }>,
  /**
   * En port i läggningen, efter fasens första prövning och före skrivningen.
   * `hashPersonalNumber` är det sista läggningen gör innan den skriver.
   */
  castGate: null as null | { reached: () => void; opened: Promise<void> },
}))

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

  return { ...actual, votersDb: bind(real, { electionBallot, pendingVote }) }
})

vi.mock('@/modules/ballot-box/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/ballot-box/db')>()
  const real = actual.votesDb

  const encryptedVote = new Proxy(real.encryptedVote, {
    get(inner, property) {
      const value = Reflect.get(inner, property)
      if (property === 'createMany' || property === 'findMany') {
        const key = property === 'createMany' ? 'beforeInsert' : 'beforeUrnRead'
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
      const gate = hooks.castGate
      if (gate) {
        hooks.castGate = null
        gate.reached()
        await gate.opened
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
    hooks.pendingVoteReads = []
    hooks.castGate = null
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

  type PreparedCast = { ballot: EncryptedBallot; envelope: SignedEnvelope; shape: EncryptedBallotShape | null }

  /** Krypterar och skriver under med attrappen, men lägger inte rösten. */
  async function prepareCast(voterStatusId: string, party: 'bp-s' | 'bp-m'): Promise<PreparedCast> {
    const ballot = buildBallot(party)
    const service = new MockBankIdService()
    const order = await service.sign({
      endUserIp: '127.0.0.1',
      userVisibleData: 'Bekräfta din röst',
      userNonVisibleData: envelopePayload({
        electionId,
        ballotId,
        ciphertextHash: ballot.ciphertextHash,
        castSequence: await nextCastSequence(voterStatusId, ballotId),
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
      shape: await getEncryptedBallotShape(ballotId),
    }
  }

  function castPrepared(voterStatusId: string, prepared: PreparedCast): Promise<CastOutcome> {
    return castEncryptedBallot(
      voterStatusId,
      electionId,
      ballotId,
      prepared.ballot,
      prepared.envelope,
      prepared.shape,
    )
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

  /** En port i nästa läggning: den stannar före skrivningen tills porten öppnas. */
  function armCastGate(): { reached: Promise<void>; open: () => void } {
    let reached!: () => void
    let open!: () => void
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve
    })
    const opened = new Promise<void>((resolve) => {
      open = resolve
    })
    hooks.castGate = { reached, opened }
    return { reached: reachedPromise, open }
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

  async function setPhase(value: string): Promise<void> {
    await votersDb.election.update({ where: { id: electionId }, data: { phase: value } })
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
      'already_closed betyder fas %s, och stängningen rör då ingenting',
      async (from) => {
        await castFor(anna, 'bp-s')
        await setPhase(from)

        expect(await closeElection(electionId)).toEqual({ status: 'already_closed' })
        expect(await phase()).toBe(from)
        expect(await votersDb.pendingVote.count()).toBe(1)
        expect(await urn()).toEqual([])
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
         * Allt som kastar i `prepareClose` är `untouched`: förberedelsen rör
         * aldrig pending_vote, och under låset kan ingen annan stängning ha
         * raderat kopplingen. Fasen står kvar där förberedelsen hann, och går
         * inte tillbaka.
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

      // Före transaktionen, alltså i sista kroken, är fasen VALIDATED.
      let phaseBeforeTransaction: string | null = null
      hooks.beforeUrnRead = async () => {
        hooks.beforeUrnRead = async () => {
          phaseBeforeTransaction = await phase()
        }
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
      await votesDb.encryptedVote.create({
        data: {
          id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
          ballotId,
          ciphertext: [],
          proofs: {},
          ciphertextHash: 'ett-chiffer-som-en-annan-stangning-flyttat',
        },
      })

      hooks.beforeEnvelopeRead = async () => {
        await setPhase('STRIPPED')
      }

      // Svaret följer fasen, och stängningen rör ingenting, varken chiffret
      // eller kuvertet. Att ett kuvert ligger kvar fast fasen säger STRIPPED
      // kan bara komma av en skrivning förbi stängningen, och det är det
      // slutkontrollens link_cleared larmar om.
      expect(await closeElection(electionId)).toEqual({ status: 'already_closed' })
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

  describe('en röst i sista stund', () => {
    it('en röst vars fas prövades före stängningen men som skrivs efter den läggs inte, och väljaren får ett fel', async () => {
      const annas = await castFor(anna, 'bp-s')
      const kims = await prepareCast(kim, 'bp-m')

      // Kims läggning börjar medan röstningen är öppen och stannar före skrivningen.
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
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('rester'),
        expect.objectContaining({ removed: 1 }),
      )
    })

    it('ett chiffer med en främmande hash på valsedeln tas bort före infogningen', async () => {
      const annas = await castFor(anna, 'bp-s')
      await votesDb.encryptedVote.create({
        data: {
          id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
          ballotId,
          ciphertext: [],
          proofs: {},
          ciphertextHash: 'en-hash-som-inte-hor-till-nagot-kuvert',
        },
      })

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
      await votesDb.encryptedVote.create({
        data: {
          id: idForEnvelope(other.ciphertextHash),
          ballotId: otherBallotId,
          ciphertext: other.ciphertext as unknown as Prisma.InputJsonValue,
          proofs: other.proofs as unknown as Prisma.InputJsonValue,
          ciphertextHash: other.ciphertextHash,
        },
      })

      expect(await closeElection(electionId)).toMatchObject({ status: 'closed', residueRemoved: [] })
      expect(await votesDb.encryptedVote.count({ where: { ballotId: otherBallotId } })).toBe(1)
    })
  })

  describe('varje flyttat chiffer läses tillbaka', () => {
    async function plantBeforeInsert(row: {
      ciphertextHash: string
      ballotId?: string
      ciphertext?: unknown
      proofs?: unknown
    }): Promise<void> {
      hooks.beforeInsert = async () => {
        await votesDb.encryptedVote.create({
          data: {
            id: idForEnvelope(row.ciphertextHash),
            ballotId: row.ballotId ?? ballotId,
            ciphertext: row.ciphertext as Prisma.InputJsonValue,
            proofs: row.proofs as Prisma.InputJsonValue,
            ciphertextHash: row.ciphertextHash,
          },
        })
      }
    }

    it.each([
      ['ett annat chiffer', 'ciphertext'],
      ['andra bevis', 'proofs'],
      ['en annan valsedel', 'ballot'],
    ] as const)(
      'en rad med ett äkta kuverts hash men %s, skriven före infogningen, stoppar stängningen',
      async (_label, swapped) => {
        /**
         * Granskningen av 14f: infogningen hoppar över en rad som redan finns,
         * och steg 5 räknade bara rader. Den som kunde skriva i votes_db lade
         * en rad med Annas hash och ett annat innehåll, och stängningen svarade
         * `closed` fast urnans chiffer inte var det validerade.
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

    it('en utbytt rad stoppar också omkörningen, tills den tagits bort', async () => {
      const annas = await castFor(anna, 'bp-s')
      const annasRow = await votersDb.pendingVote.findFirstOrThrow({ where: { voterStatusId: anna } })
      const forged = buildBallot('bp-m')
      await votesDb.encryptedVote.create({
        data: {
          id: idForEnvelope(annas),
          ballotId,
          ciphertext: forged.ciphertext as unknown as Prisma.InputJsonValue,
          proofs: forged.proofs as unknown as Prisma.InputJsonValue,
          ciphertextHash: annas,
        },
      })

      // Hashen finns i den validerade läsningen, så raden är ingen rest och
      // tas inte bort. Varje omkörning stoppas, och kopplingen ligger kvar.
      expect(linkStateOf((await attempt()).error)).toBe('untouched')
      expect(linkStateOf((await attempt()).error)).toBe('untouched')
      expect(await votersDb.pendingVote.count()).toBe(1)

      await votesDb.encryptedVote.deleteMany({ where: { ciphertextHash: annas } })
      expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 1 })

      const stored = await votesDb.encryptedVote.findUniqueOrThrow({ where: { ciphertextHash: annas } })
      expect(stored.ciphertext).toEqual(annasRow.ciphertext)
      expect(stored.proofs).toEqual(annasRow.proofs)
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

    it('markeringarna skrivs i en ordning som inte följer läggningen', async () => {
      /**
       * Raderna i pending_vote ligger i den ordning väljarna röstade. Skrevs
       * markeringarna i den ordningen skulle tabellens fysiska ordning säga
       * vem som röstade före vem, och markeringen säga något om när. Här
       * röstar väljarna i omvänd ordning mot sina id, så att en markering i
       * läggningsordning inte kan råka se sorterad ut.
       */
      const voters = [anna, kim, robin, sam, vera].sort().reverse()
      for (const [index, voter] of voters.entries()) await castFor(voter, index % 2 === 0 ? 'bp-s' : 'bp-m')

      expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 5 })

      const rows = await votersDb.$queryRaw<Array<{ voter_status_id: string }>>`
        SELECT voter_status_id::text AS voter_status_id FROM voted_marker ORDER BY ctid`
      expect(rows.map((row) => row.voter_status_id)).toEqual([...voters].sort())
    })
  })
})
