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
import {
  castEncryptedBallot,
  nextCastSequence,
  type CastOutcome,
} from '@/modules/eligibility/pending-vote.service'
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
 *
 * SEDAN UPPGIFT 11D kan en väljare inte längre skriva i fönstret. Stängningen
 * skriver CLOSED innan den läser kuverten, och läggningen prövar fasen i samma
 * transaktion som den skriver, så en röst i sista stund avvisas med ett fel.
 * Skrivningar direkt i databasen prövas fortfarande, med äkta kuvert som
 * förberetts innan stängningen. Ett kuvert som tas bort eller byts ut efter
 * läsningen lämnar sitt chiffer kvar i votes_db, och sedan 11d tar omkörningen
 * bort det i stället för att stoppas av det.
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

  /**
   * En ärlig röstläggning med underskrift ur attrappen, medan klockan står
   * öppen. Svarar med utfallet, så att en röst som avvisas går att pröva.
   */
  async function tryCastFor(
    voterStatusId: string,
    party: 'bp-s' | 'bp-m',
  ): Promise<{ outcome: CastOutcome; ciphertextHash: string }> {
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

      return { outcome, ciphertextHash: ballot.ciphertextHash }
    } finally {
      await setClosesAt(new Date(Date.now() - 60_000))
    }
  }

  /** En ärlig röstläggning som ska lyckas. Svarar med chifferhashen. */
  async function castFor(voterStatusId: string, party: 'bp-s' | 'bp-m'): Promise<string> {
    const { outcome, ciphertextHash } = await tryCastFor(voterStatusId, party)
    if (outcome.status !== 'recorded') {
      throw new Error(`Kunde inte lägga rösten (${outcome.status}).`)
    }
    return ciphertextHash
  }

  type PendingRow = Awaited<ReturnType<typeof votersDb.pendingVote.findFirstOrThrow>>

  async function rowOf(voterStatusId: string): Promise<PendingRow> {
    return votersDb.pendingVote.findFirstOrThrow({ where: { voterStatusId } })
  }

  /** Skriver ett kuverts innehåll över raden med `id`, som den som skriver i databasen kan. */
  async function overwrite(id: string, row: PendingRow): Promise<void> {
    await votersDb.pendingVote.update({
      where: { id },
      data: {
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

  /** Lägger tillbaka ett sparat kuvert som det var, med sitt id, direkt i databasen. */
  async function insertRow(row: PendingRow): Promise<void> {
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

  /** Chifferhasharna i urnan, sorterade, så att en jämförelse inte beror på radernas ordning. */
  async function tally(): Promise<string[]> {
    const rows = await votesDb.encryptedVote.findMany({ select: { ciphertextHash: true } })
    return rows.map((row) => row.ciphertextHash).sort()
  }

  async function linkClearedEvents(): Promise<number> {
    return votersDb.auditEvent.count({ where: { eventType: AUDIT_EVENTS.LINK_CLEARED } })
  }

  /**
   * Ingenting av det skalningens transaktion skriver finns kvar.
   *
   * Sedan uppgift 11d står fasen inte kvar i OPEN efter ett avbrott. Den är
   * CLOSED om valideringen stoppade stängningen och VALIDATED om den passerade,
   * och går aldrig tillbaka. Det som bara transaktionen skriver, STRIPPED,
   * roten, tiden för raderingen och revisionsposten, ska inte finnas.
   */
  async function expectNotStripped(phase: 'CLOSED' | 'VALIDATED'): Promise<void> {
    const election = await votersDb.election.findUniqueOrThrow({
      where: { id: electionId },
      select: { phase: true, envelopeRoot: true, linkClearedAt: true },
    })
    expect(election).toEqual({ phase, envelopeRoot: null, linkClearedAt: null })
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
    await expectNotStripped('CLOSED')
  })

  it('ett äkta kuvert som tas bort efter läsningen stoppar raderingen, och ingenting raderas', async () => {
    const annas = await castFor(anna, 'bp-s')
    const kims = await castFor(kim, 'bp-m')

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
    await expectNotStripped('VALIDATED')

    /**
     * Annas chiffer ligger redan i röstdatabasen, men hennes kuvert gör det
     * inte längre. Fram till uppgift 11d stoppades varje omkörning av
     * antalskontrollen, eftersom den läste ett kuvert och hittade två chiffer.
     * Nu tar omkörningen bort chiffret, som inte hör till något validerat
     * kuvert, och flyttar Kims.
     */
    expect(await tally()).toEqual([annas, kims].sort())
    const rerun = await closeElection(electionId)
    expect(rerun).toMatchObject({ status: 'closed', moved: 1, cleared: 1, residueRemoved: [annas] })
    expect(await tally()).toEqual([kims])
    expect(await votersDb.pendingVote.count()).toBe(0)
  })

  it('ett kuvert som byts ut i databasen efter läsningen stoppar raderingen, och en omkörning tar det nya', async () => {
    const annas = await castFor(anna, 'bp-s')
    const first = await castFor(kim, 'bp-m')
    const kimsFirst = await rowOf(kim)
    // Kims andra, äkta kuvert, med högre räknare. Det första läggs tillbaka,
    // och det andra sparas för att skrivas direkt i databasen i fönstret.
    const replacement = await castFor(kim, 'bp-s')
    const kimsSecond = await rowOf(kim)
    await overwrite(kimsFirst.id, kimsFirst)

    const { outcome, error } = await closeWithWriteInWindow(async () => {
      await overwrite(kimsFirst.id, kimsSecond)
    })

    /**
     * Före rättelsen i 14f: `closed`. Det gamla kuvertet flyttades, och
     * raderingen efter valsedel tog med sig det nya, som aldrig räknades.
     */
    expect(outcome).toBeNull()
    expect(linkStateOf(error)).toBe('untouched')
    expect((error as Error).message).toContain('2 kuvert flyttades, men bara 1 av dem')

    const kimsEnvelope = await rowOf(kim)
    expect(replacement).not.toBe(first)
    expect(kimsEnvelope.ciphertextHash).toBe(replacement)
    await expectNotStripped('VALIDATED')

    // Omkörningen validerar det nya kuvertet och tar bort det gamla chiffret.
    expect(await closeElection(electionId)).toMatchObject({
      status: 'closed',
      moved: 2,
      cleared: 2,
      residueRemoved: [first],
    })
    expect(await tally()).toEqual([annas, replacement].sort())
  })

  it('en väljare som ändrar sig efter läsningen får ett fel, och det lästa kuvertet flyttas', async () => {
    const annas = await castFor(anna, 'bp-s')
    const first = await castFor(kim, 'bp-m')

    // Kim ändrar sig i sista stund, efter att stängningen läst hennes kuvert.
    let revote: CastOutcome | null = null
    const { outcome, error } = await closeWithWriteInWindow(async () => {
      revote = (await tryCastFor(kim, 'bp-s')).outcome
    })

    /**
     * Före uppgift 11d lades den nya rösten, och stängningen avbröts, eller
     * före 14f:s rättelse raderades den nya rösten utan att räknas. Nu har
     * stängningen redan skrivit CLOSED, och Kim får beskedet att röstningen
     * stängt. Det kuvert som lästes är det som flyttas.
     */
    expect(revote).toEqual({ status: 'closed' })
    expect(error).toBeNull()
    expect(outcome).toMatchObject({ status: 'closed', moved: 2, cleared: 2 })
    expect(await tally()).toEqual([annas, first].sort())
    expect(await votersDb.pendingVote.count()).toBe(0)
  })

  it('en röst som läggs efter läsningen avvisas med ett fel, och ingen röst sägs vara lagd utan att flyttas', async () => {
    const annas = await castFor(anna, 'bp-s')
    const kims = await castFor(kim, 'bp-m')

    let late: { outcome: CastOutcome; ciphertextHash: string } | null = null
    const { outcome, error } = await closeWithWriteInWindow(async () => {
      late = await tryCastFor(robin, 'bp-s')
    })

    /**
     * Före rättelsen i 14f: `closed`, med två flyttade och tre raderade. Robin
     * hade fått beskedet att rösten var lagd, och den räknades aldrig. Efter
     * 14f lades rösten, och stängningen avbröts. Nu avvisas den med ett fel.
     */
    expect(late!.outcome).toEqual({ status: 'closed' })
    expect(error).toBeNull()
    expect(outcome).toMatchObject({ status: 'closed', moved: 2, cleared: 2 })
    expect(await tally()).toEqual([annas, kims].sort())
    expect(await tally()).not.toContain(late!.ciphertextHash)
    expect(await votersDb.pendingVote.count()).toBe(0)
  })

  it('ett kuvert som skrivs in i databasen efter läsningen stoppar raderingen, och en omkörning tar med det', async () => {
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')
    // Robins äkta kuvert, sparat och borttaget, för att skrivas in i fönstret.
    const late = await castFor(robin, 'bp-s')
    const robinsRow = await rowOf(robin)
    await votersDb.pendingVote.delete({ where: { id: robinsRow.id } })

    const { outcome, error } = await closeWithWriteInWindow(async () => {
      await insertRow(robinsRow)
    })

    expect(outcome).toBeNull()
    expect(linkStateOf(error)).toBe('untouched')
    expect((error as Error).message).toContain('1 kuvert i röstlängden lästes inte')
    expect(await votersDb.pendingVote.count()).toBe(3)
    await expectNotStripped('VALIDATED')

    // Omkörningen läser alla tre, validerar dem och flyttar dem.
    expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 3, cleared: 3 })
    expect(await tally()).toContain(late)
    expect(await votersDb.pendingVote.count()).toBe(0)
  })

  it('en andra stängning medan den första pågår svarar att en stängning pågår, aldrig ett falskt "orörd"', async () => {
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')

    // En andra stängning, till exempel efter ett dubbelklick, startar i fönstret.
    let second: CloseOutcome | null = null
    const { outcome, error } = await closeWithWriteInWindow(async () => {
      second = await closeElection(electionId)
    })

    /**
     * Före uppgift 11d gick den andra stängningen hela vägen, och den första
     * svarade already_closed. Hade den andra läst fasen före den förstas
     * COMMIT men kuverten efter, hade den svarat att kopplingen var orörd fast
     * den var raderad. Nu kör bara en stängning åt gången, och den andra
     * svarar att en stängning pågår, utan att röra något.
     */
    expect(second).toEqual({ status: 'in_progress' })
    expect(error).toBeNull()
    expect(outcome).toMatchObject({ status: 'closed', moved: 2, cleared: 2 })
    expect(await linkClearedEvents()).toBe(1)
    expect(await votersDb.pendingVote.count()).toBe(0)
    expect(await tally()).toHaveLength(2)

    // En omkörning efteråt svarar som för en stängd omröstning.
    expect(await closeElection(electionId)).toEqual({ status: 'already_closed' })
  })
})
