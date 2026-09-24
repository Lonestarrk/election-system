import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '.prisma/voters'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import { validateBeforeClose } from '@/orchestration/validate-before-close.usecase'
import {
  abortedMessageFor,
  closeElection,
  CloseAbortedError,
  linkStateOf,
  type CloseOutcome,
} from '@/orchestration/close-election.usecase'
import { AUDIT_EVENTS } from '@/modules/eligibility/audit.service'
import { canonicalOptions, type BallotOption } from '@/lib/crypto/ballot-encoding'
import { encryptBallot } from '@/lib/encrypt-client'
import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'
import {
  MockBankIdService,
  selectDemoIdentity,
} from '@/modules/eligibility/bankid/MockBankIdService'
import { envelopePayload } from '@/modules/eligibility/bankid/envelope-signature'
import { castEncryptedBallot, nextCastSequence } from '@/modules/eligibility/pending-vote.service'
import { createVoter, disconnect, isDatabaseAvailable, resetElectionData } from './helpers'

/**
 * STÄNGNINGEN FLYTTAR EXAKT DE RADER DEN VALIDERAT (granskningen av uppgift 14f, K1).
 *
 * Felet fanns sedan uppgift 11. Stängningen läste pending_vote två gånger: en
 * gång för det som skulle flyttas och en gång inne i valideringen. Granskarens
 * prob skrev en förfalskad rad för Kim, med giltiga bevis men utan underskrift,
 * och tog bort den mellan de två läsningarna. Valideringen såg aldrig raden,
 * omverifieringen prövade bara bevisen, antalskontrollen jämförde bara med det
 * som lästs, och raderingen tog allt som fanns kvar. Stängningen svarade
 * `closed`, och den förfalskade rösten låg i urnan.
 *
 * Testerna här låter en angripare med skrivrätt i röstlängden, eller en väljare
 * i sista stund, skriva direkt efter stängningens första läsning av
 * pending_vote. Det är där fönstret fanns, och varje skrivning som landar där
 * ska antingen stoppa stängningen eller komma med i nästa körning. Ingen får
 * leda till att en rad flyttas som inte validerats, eller att en rad raderas
 * som inte flyttats.
 */

/**
 * Kör en skrivning direkt efter stängningens första läsning av pending_vote.
 *
 * Proxyn byter bara ut `pendingVote.findMany`. Allt annat går rakt till den
 * äkta klienten, och metoderna binds till den, så att `$transaction` och
 * modellerna beter sig som vanligt. Skrivningen nollställs innan den körs, så
 * att en stängning som skrivningen själv startar inte utlöser den en gång till.
 */
const interference = vi.hoisted(() => ({
  reads: 0,
  ran: false,
  afterFirstRead: null as null | (() => Promise<void>),
}))

vi.mock('@/modules/eligibility/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/eligibility/db')>()
  const real = actual.votersDb

  const pendingVote = new Proxy(real.pendingVote, {
    get(target, property) {
      const value = Reflect.get(target, property)
      if (property === 'findMany') {
        return async (...args: unknown[]) => {
          const result = await (value as (...rest: unknown[]) => Promise<unknown>).apply(target, args)
          interference.reads += 1
          const write = interference.afterFirstRead
          if (interference.reads === 1 && write) {
            interference.afterFirstRead = null
            interference.ran = true
            await write()
          }
          return result
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  const votersDbWithWindow = new Proxy(real, {
    get(target, property) {
      if (property === 'pendingVote') return pendingVote
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  return { ...actual, votersDb: votersDbWithWindow }
})

const databaseAvailable = await isDatabaseAvailable()

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

describe.skipIf(!databaseAvailable)('en skrivning mitt i stängningen', () => {
  const ANNA_PN = '199001011234'
  const KIM_PN = '198505152345'
  const ROBIN_PN = '197012125678'

  let electionId: string
  let ballotId: string
  let publicKey: string
  let options: BallotOption[]
  let bpS: string
  let bpM: string

  let anna: string
  let kim: string
  let robin: string

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

  beforeEach(async () => {
    interference.reads = 0
    interference.ran = false
    interference.afterFirstRead = null
    await resetElectionData()

    const s = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'S' } })
    const m = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'M' } })

    const outcome = await createElection({
      name: 'Skrivning mitt i stängningen',
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

    personalNumberByVoter.clear()
    anna = await createSignedVoter(ANNA_PN)
    kim = await createSignedVoter(KIM_PN)
    robin = await createSignedVoter(ROBIN_PN)

    // Omröstningen ligger som stängd och öppnas bara medan ett kuvert läggs.
    await setClosesAt(new Date(Date.now() - 60_000))
  })

  function buildBallot(party: 'bp-s' | 'bp-m'): EncryptedBallot {
    return encryptBallot(publicKey, electionId, ballotId, options, {
      kind: 'PARTY',
      ballotPartyId: party === 'bp-s' ? bpS : bpM,
    })
  }

  /** En ärlig röstläggning med underskrift ur attrappen. Svarar med chifferhashen. */
  async function castFor(voterStatusId: string, party: 'bp-s' | 'bp-m'): Promise<string> {
    await setClosesAt(new Date(Date.now() + 3_600_000))

    try {
      const ballot = buildBallot(party)
      const castSequence = await nextCastSequence(voterStatusId, ballotId)

      const service = new MockBankIdService()
      const order = await service.sign({
        endUserIp: '127.0.0.1',
        userVisibleData: 'Bekräfta din röst',
        userNonVisibleData: envelopePayload({
          electionId,
          ballotId,
          ciphertextHash: ballot.ciphertextHash,
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
        ballot,
        {
          signature: result.completionData.signature,
          certificateChain: result.completionData.certificateChain,
          signedData: result.completionData.signedData,
        },
        await getEncryptedBallotShape(ballotId),
      )
      if (outcome.status !== 'recorded') {
        throw new Error(`Kunde inte lägga rösten (${outcome.status}).`)
      }

      return ballot.ciphertextHash
    } finally {
      await setClosesAt(new Date(Date.now() - 60_000))
    }
  }

  /**
   * Granskarens förfalskning: ett giltigt chiffer med giltiga bevis, skrivet
   * direkt i databasen för en väljare som aldrig skrivit under.
   */
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

  /** Stänger, med `write` direkt efter stängningens första läsning av pending_vote. */
  async function closeWithWriteInWindow(write: () => Promise<void>): Promise<Attempt> {
    interference.reads = 0
    interference.ran = false
    interference.afterFirstRead = write

    let attempt: Attempt
    try {
      attempt = await closeElection(electionId).then(
        (outcome) => ({ outcome, error: null }),
        (error: unknown) => ({ outcome: null, error }),
      )
    } finally {
      interference.afterFirstRead = null
    }

    // Utan den här kontrollen kunde ett test gå grönt för att skrivningen
    // aldrig hamnade i fönstret, till exempel om stängningen en dag läser på
    // något annat sätt.
    expect(interference.ran, 'skrivningen hamnade aldrig i fönstret').toBe(true)
    return attempt
  }

  async function tally(): Promise<string[]> {
    const rows = await votesDb.encryptedVote.findMany({ select: { ciphertextHash: true } })
    return rows.map((row) => row.ciphertextHash)
  }

  async function linkClearedEvents(): Promise<number> {
    return votersDb.auditEvent.count({ where: { eventType: AUDIT_EVENTS.LINK_CLEARED } })
  }

  /** Ingenting av det skalningens transaktion skriver finns kvar. */
  async function expectStillOpen(): Promise<void> {
    const election = await votersDb.election.findUniqueOrThrow({
      where: { id: electionId },
      select: { phase: true, envelopeRoot: true, linkClearedAt: true },
    })
    expect(election).toEqual({ phase: 'OPEN', envelopeRoot: null, linkClearedAt: null })
    expect(await linkClearedEvents()).toBe(0)
  }

  it('kontrasten: utan någon skrivning i fönstret går stängningen igenom som vanligt', async () => {
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')

    const { outcome, error } = await closeWithWriteInWindow(async () => {})

    expect(error).toBeNull()
    expect(outcome).toMatchObject({ status: 'closed', moved: 2, cleared: 2 })
    expect(await votersDb.pendingVote.count()).toBe(0)
  })

  it('en förfalskad rad som tas bort direkt efter läsningen hamnar inte i urnan', async () => {
    await castFor(anna, 'bp-s')
    const forged = await plantUnsignedVote(kim, 'bp-m')

    // Som i granskarens prob: med raden på plats stoppar valideringen den.
    expect((await validateBeforeClose(electionId)).summary.passed).toBe(false)

    const { outcome, error } = await closeWithWriteInWindow(async () => {
      await votersDb.pendingVote.deleteMany({ where: { voterStatusId: kim } })
    })

    /**
     * Före rättelsen blev svaret `{ status: 'closed', moved: 2, cleared: 1 }`,
     * och den förfalskade rösten låg i urnan. Nu valideras den läsning som
     * flyttas, och i den finns raden.
     */
    expect(error).toBeNull()
    expect(outcome?.status).toBe('validation_failed')
    expect(await tally()).not.toContain(forged)
    expect(await tally()).toHaveLength(0)
    await expectStillOpen()
  })

  it('ett äkta kuvert som tas bort efter läsningen stoppar raderingen, och ingenting raderas', async () => {
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')

    const { outcome, error } = await closeWithWriteInWindow(async () => {
      await votersDb.pendingVote.deleteMany({ where: { voterStatusId: anna } })
    })

    // Före rättelsen: `closed`, med två flyttade och ett raderat.
    expect(outcome).toBeNull()
    expect(error).toBeInstanceOf(CloseAbortedError)
    expect(linkStateOf(error)).toBe('untouched')
    expect((error as Error).message).toContain('2 kuvert flyttades, men bara 1 av dem')
    expect(abortedMessageFor(error)).toContain('ORÖRD')

    /**
     * Kims rad raderades i transaktionen innan jämförelsen kastade. Att den
     * ligger kvar visar att jämförelsen görs före COMMIT, och att fasen, roten
     * och revisionsposten rullades tillbaka tillsammans med raderingen.
     */
    expect(await votersDb.pendingVote.count({ where: { voterStatusId: kim } })).toBe(1)
    await expectStillOpen()

    /**
     * Annas chiffer ligger redan i röstdatabasen, men hennes kuvert gör det
     * inte längre. En omkörning ska därför inte heller gå vidare: den läser ett
     * kuvert och hittar två chiffer.
     */
    const rerun = await closeElection(electionId).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(linkStateOf(rerun)).toBe('untouched')
    expect(await votersDb.pendingVote.count()).toBe(1)
    await expectStillOpen()
  })

  it('ett kuvert som byts ut efter läsningen stoppar raderingen, och den nya rösten ligger kvar', async () => {
    await castFor(anna, 'bp-s')
    const first = await castFor(kim, 'bp-m')

    // Kim ändrar sig i sista stund, efter att stängningen läst hennes kuvert.
    let replacement = ''
    const { outcome, error } = await closeWithWriteInWindow(async () => {
      replacement = await castFor(kim, 'bp-s')
    })

    /**
     * Före rättelsen: `closed`. Det gamla kuvertet flyttades, och raderingen
     * efter valsedel tog med sig det nya, som aldrig räknades.
     */
    expect(outcome).toBeNull()
    expect(linkStateOf(error)).toBe('untouched')
    expect((error as Error).message).toContain('2 kuvert flyttades, men bara 1 av dem')

    const kimsEnvelope = await votersDb.pendingVote.findFirstOrThrow({
      where: { voterStatusId: kim },
      select: { ciphertextHash: true },
    })
    expect(replacement).not.toBe(first)
    expect(kimsEnvelope.ciphertextHash).toBe(replacement)
    await expectStillOpen()
  })

  it('ett kuvert som läggs efter läsningen stoppar raderingen, och en omkörning tar med det', async () => {
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')

    let late = ''
    const { outcome, error } = await closeWithWriteInWindow(async () => {
      late = await castFor(robin, 'bp-s')
    })

    /**
     * Före rättelsen: `closed`, med två flyttade och tre raderade. Robin hade
     * fått beskedet att rösten var lagd, och den räknades aldrig.
     */
    expect(outcome).toBeNull()
    expect(linkStateOf(error)).toBe('untouched')
    expect((error as Error).message).toContain('1 kuvert i röstlängden lästes inte')
    expect(await votersDb.pendingVote.count()).toBe(3)
    await expectStillOpen()

    // Omkörningen läser alla tre, validerar dem och flyttar dem.
    expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 3, cleared: 3 })
    expect(await tally()).toContain(late)
    expect(await votersDb.pendingVote.count()).toBe(0)
  })

  it('en annan stängning som hinner före svarar already_closed, aldrig ett falskt "orörd"', async () => {
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')

    // En andra stängning, till exempel efter ett dubbelklick, går hela vägen i fönstret.
    let first: CloseOutcome | null = null
    const { outcome, error } = await closeWithWriteInWindow(async () => {
      first = await closeElection(electionId)
    })

    expect(first).toMatchObject({ status: 'closed', moved: 2, cleared: 2 })

    /**
     * Den här körningen raderade ingenting, eftersom den andra hann före. Men
     * kopplingen är raderad, så "orörd" hade varit falskt. Svaret är detsamma
     * som för en omkörning, och loggen har bara en radering.
     */
    expect(error).toBeNull()
    expect(outcome).toEqual({ status: 'already_closed' })
    expect(await linkClearedEvents()).toBe(1)
    expect(await votersDb.pendingVote.count()).toBe(0)
    expect(await tally()).toHaveLength(2)
  })
})
