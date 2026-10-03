import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import { closeElection } from '@/orchestration/close-election.usecase'
import { aggregate, completeTally, submitPartialDecryption } from '@/orchestration/tally.usecase'
import {
  certifyElection,
  runFinalCheck,
  WHAT_BECAME_OF_THE_OLD_CHECKS,
  type CheckResult,
  type FinalCheckReport,
} from '@/orchestration/final-check.usecase'
import { canonicalOptions, unitVector, type BallotOption } from '@/lib/crypto/ballot-encoding'
import { encrypt, multiply } from '@/lib/crypto/elgamal'
import { Q, randomScalar } from '@/lib/crypto/group'
import { PROOF_FORMAT, proveSumIsOne, proveZeroOrOne } from '@/lib/crypto/proofs'
// Serverns ingång registrerar OpenSSL, så att krypteringen i testet går fort.
import { partiallyDecrypt, publicShare } from '@/lib/crypto/server'
import { serialisePartialDecryptionProof } from '@/lib/crypto/threshold'
import {
  hashCiphertext,
  serialiseEqualityProof,
  serialiseZeroOrOneProof,
  type EncryptedBallot,
} from '@/lib/crypto/verify-ballot'
import { encryptBallot } from '@/lib/encrypt-client'
import { resetRateLimits } from '@/lib/rate-limit'
import { truncateToHour } from '@/lib/time'
import { urnRootOf } from '@/lib/urn-root'
import { AUDIT_EVENTS, auditEntryHash, recordAuditEvent, verifyAuditChain } from '@/modules/eligibility/audit.service'
import {
  MockBankIdService,
  selectDemoIdentity,
} from '@/modules/eligibility/bankid/MockBankIdService'
import {
  ciphertextCommitment,
  envelopePayload,
  newCommitmentSalt,
} from '@/modules/eligibility/bankid/envelope-signature'
import {
  castEncryptedBallot,
  nextCastSequence,
  type SignedEnvelope,
} from '@/modules/eligibility/pending-vote.service'
import { createVoter, disconnect, isDatabaseAvailable, resetElectionData, signingTextFor } from './helpers'

/**
 * UPPGIFT 12b: SLUTKONTROLLEN I KUVERTMODELLEN.
 *
 * Slutkontrollen är spärren före fastställandet. Fram till uppgiften läste
 * åtta av dess kontroller det gamla flödets tabeller, som är tomma för ett val
 * i kuvertmodellen, och passerade på noll mot noll. Ett test som bara visar att
 * ett ärligt val går igenom bevisar därför ingenting om spärren.
 *
 * Varje test nedan manipulerar databasen på ett sätt som bara en kontroll ska
 * fånga, och kräver att just den, och ingen annan, fallerar. Det första testet
 * är kontrasten: samma val, orört, passerar varje kontroll. Skillnaden mellan
 * dem är alltså den enda manipulationen.
 */

/**
 * Ett fel i en viss revisionspost, och en krok efter kedjans kontroll, som är
 * slutkontrollens sista läsning. Kroken låter ett test ändra fasen mellan
 * slutkontrollen och fastställandets jämför-och-sätt. Alla andra anrop går
 * till de äkta funktionerna.
 */
const auditControl = vi.hoisted(() => ({
  failOn: null as null | string,
  afterChain: null as null | (() => Promise<void>),
  /** Varje revisionspost som skrivs eller försöks, i ordning, för testet av omförsöken. */
  calls: [] as string[],
}))

vi.mock('@/modules/eligibility/audit.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/eligibility/audit.service')>()
  return {
    ...actual,
    recordAuditEvent: async (...args: Parameters<typeof actual.recordAuditEvent>) => {
      auditControl.calls.push(args[0])
      if (auditControl.failOn !== null && args[0] === auditControl.failOn) {
        throw new Error(`Testet: revisionsposten ${args[0]} gick inte att skriva.`)
      }
      return actual.recordAuditEvent(...args)
    },
    verifyAuditChain: async () => {
      const verdict = await actual.verifyAuditChain()
      const hook = auditControl.afterChain
      auditControl.afterChain = null
      if (hook) await hook()
      return verdict
    },
  }
})

const databaseAvailable = await isDatabaseAvailable()

if (!databaseAvailable) {
  process.stderr.write('\n  Ingen databas tillgänglig — integrationstesterna hoppas över.\n')
}

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

/** Testernas fraser, samma som i tests/integration/helpers.ts. */
const TRUSTEE_PASSPHRASES = ['test-fras-ett', 'test-fras-tva', 'test-fras-tre'] as const

/** Kontrollerna i kuvertmodellen, i rapportens ordning. */
const CHECK_IDS = [
  'election_tallied',
  'link_cleared',
  'urn_matches_markers',
  'urn_root_matches',
  'every_vote_verifies',
  'partial_decryptions_verify',
  'tally_matches',
  'audit_chain_intact',
  'not_under_review',
]

type CountedBallot = { id: string; options: BallotOption[]; bpS: string; bpM: string }
type CountedElection = { electionId: string; publicKey: string; first: CountedBallot; second: CountedBallot }

/** Ett kuvert vars slumptal testet känner, så att det kan bytas mot ett med samma summa. */
type KnownBallot = { ballot: EncryptedBallot; nonces: bigint[] }
type Cast = { anna: KnownBallot; kim: KnownBallot }

/** Alternativens index på valsedlarna nedan: blankt, S och M (spec 4.3). */
const BLANK = 0
const S = 1
const M = 2

describe.skipIf(!databaseAvailable)('slutkontrollen i kuvertmodellen', () => {
  const ANNA_PN = '199001011234'
  const KIM_PN = '198505152345'
  const ROBIN_PN = '197012125678'

  let counted: CountedElection
  let electionId: string

  let anna: string
  let kim: string
  let robin: string

  const personalNumberByVoter = new Map<string, string>()

  async function setClosesAt(id: string, at: Date): Promise<void> {
    await votersDb.election.update({ where: { id }, data: { closesAt: at } })
    await votesDb.election.update({ where: { id }, data: { closesAt: at } })
  }

  async function countedBallot(id: string): Promise<CountedBallot> {
    const parties = await votesDb.ballotParty.findMany({ where: { ballotId: id }, orderBy: { displayOrder: 'asc' } })
    return {
      id,
      bpS: parties[0]!.id,
      bpM: parties[1]!.id,
      options: canonicalOptions({
        allowsCandidateVote: false,
        parties: parties.map((party, index) => ({ id: party.id, displayOrder: index, candidates: [] })),
      }),
    }
  }

  async function createCountedElection(name: string): Promise<CountedElection> {
    const s = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'S' } })
    const m = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'M' } })
    const ballot = (label: string) => ({
      kind: 'RIKSDAG' as const,
      label,
      allowsCandidateVote: false,
      parties: [{ partyId: s.id }, { partyId: m.id }],
    })

    const outcome = await createElection({
      name,
      kind: 'RIKSDAGSVAL',
      opensAt: new Date(Date.now() - 60_000),
      closesAt: new Date(Date.now() + 3_600_000),
      ballots: [ballot('Riksdagen'), ballot('Riksdagen, andra valsedeln')],
      trusteePassphrases: [...TRUSTEE_PASSPHRASES],
    })
    if (outcome.status !== 'created') throw new Error('Kunde inte skapa testomröstningen.')

    const row = await votesDb.election.findUniqueOrThrow({
      where: { id: outcome.election.id },
      select: { encryptionPublicKey: true },
    })

    // Omröstningen ligger som stängd, utom medan ett kuvert läggs, se `castBallot`.
    await setClosesAt(outcome.election.id, new Date(Date.now() - 60_000))

    return {
      electionId: outcome.election.id,
      publicKey: row.encryptionPublicKey!,
      first: await countedBallot(outcome.election.ballotIds[0]!.id),
      second: await countedBallot(outcome.election.ballotIds[1]!.id),
    }
  }

  async function createSignedVoter(personalNumber: string): Promise<string> {
    const id = await createVoter(personalNumber)
    personalNumberByVoter.set(id, personalNumber)
    return id
  }

  beforeEach(async () => {
    auditControl.failOn = null
    auditControl.afterChain = null
    auditControl.calls = []
    resetRateLimits()
    await resetElectionData()

    counted = await createCountedElection('Slutkontrollstest')
    electionId = counted.electionId

    personalNumberByVoter.clear()
    anna = await createSignedVoter(ANNA_PN)
    kim = await createSignedVoter(KIM_PN)
    robin = await createSignedVoter(ROBIN_PN)
  })

  async function signAs(
    voterStatusId: string,
    ballot: CountedBallot,
    ciphertextHash: string,
    castSequence: number,
  ): Promise<SignedEnvelope> {
    const personalNumber = personalNumberByVoter.get(voterStatusId)
    if (!personalNumber) throw new Error('Okänd testväljare.')

    const service = new MockBankIdService()
    const commitmentSalt = newCommitmentSalt()
    const order = await service.sign({
      endUserIp: '127.0.0.1',
      userVisibleData: await signingTextFor(ballot.id, electionId),
      userNonVisibleData: envelopePayload({
        electionId,
        ballotId: ballot.id,
        ciphertextCommitment: ciphertextCommitment(ciphertextHash, commitmentSalt)!,
        castSequence,
      }),
    })
    selectDemoIdentity(order.orderRef, personalNumber)

    let result = await service.collect(order.orderRef)
    while (result.status === 'pending') result = await service.collect(order.orderRef)
    if (result.status !== 'complete') throw new Error('Signeringen blev inte klar.')

    return {
      signature: result.completionData.signature,
      ocspResponse: result.completionData.ocspResponse,
      commitmentSalt,
    }
  }

  /** Lägger ett kuvert ärligt, med klockan öppen bara så länge det läggs. */
  async function castBallot(
    voterStatusId: string,
    encrypted: EncryptedBallot,
    ballot: CountedBallot,
  ): Promise<EncryptedBallot> {
    await setClosesAt(electionId, new Date(Date.now() + 3_600_000))
    try {
      const castSequence = await nextCastSequence(voterStatusId, ballot.id)
      const envelope = await signAs(voterStatusId, ballot, encrypted.ciphertextHash, castSequence)
      const shape = await getEncryptedBallotShape(ballot.id)
      const outcome = await castEncryptedBallot(voterStatusId, electionId, ballot.id, encrypted, envelope, shape)
      if (outcome.status !== 'recorded') throw new Error(`Kunde inte lägga rösten (${outcome.status}).`)
      return encrypted
    } finally {
      await setClosesAt(electionId, new Date(Date.now() - 60_000))
    }
  }

  async function castFor(voterStatusId: string, party: 'bp-s' | 'bp-m', ballot: CountedBallot): Promise<EncryptedBallot> {
    const encrypted = encryptBallot(counted.publicKey, electionId, ballot.id, ballot.options, {
      kind: 'PARTY',
      ballotPartyId: party === 'bp-s' ? ballot.bpS : ballot.bpM,
    })
    return castBallot(voterStatusId, encrypted, ballot)
  }

  /**
   * En valsedel med slumptal som testet väljer, och bevis som håller. Den som
   * känner slumptalen kan bygga två valsedlar vars summa är en annan valsedels
   * summa, och det är vad testet av urnroten behöver.
   */
  function ballotWithNonces(ballot: CountedBallot, choice: number, nonces: bigint[]): EncryptedBallot {
    const key = BigInt(counted.publicKey)
    const vector = unitVector(ballot.options.length, choice)
    const ciphertexts = vector.map((message, index) => encrypt(key, message, nonces[index]!))
    const serialised = ciphertexts.map((c) => ({ c1: c.c1.toString(), c2: c.c2.toString() }))
    const binding = { electionId, ballotId: ballot.id, ciphertextHash: hashCiphertext(serialised) }

    return {
      ciphertext: serialised,
      proofs: {
        format: PROOF_FORMAT,
        components: ciphertexts.map((ciphertext, index) =>
          serialiseZeroOrOneProof(
            proveZeroOrOne(key, ciphertext, vector[index] === 1n ? 1 : 0, nonces[index]!, binding, index),
          ),
        ),
        sum: serialiseEqualityProof(
          proveSumIsOne(
            key,
            ciphertexts.reduce((a, b) => multiply(a, b)),
            nonces.reduce((a, b) => a + b, 0n),
            binding,
          ),
        ),
      },
      ciphertextHash: binding.ciphertextHash,
    }
  }

  function freshNonces(ballot: CountedBallot): bigint[] {
    return ballot.options.map(() => randomScalar())
  }

  async function closed(id: string): Promise<void> {
    const outcome = await closeElection(id)
    if (outcome.status !== 'closed') throw new Error(`Stängningen gick inte igenom (${outcome.status}).`)
  }

  async function contributeAndCount(ballotId: string, counts: number[]): Promise<void> {
    expect(await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])).toMatchObject({ status: 'accepted' })
    expect(await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1])).toMatchObject({ status: 'accepted' })
    expect(await completeTally(ballotId)).toMatchObject({ status: 'tallied', counts })
  }

  /** Tre kuvert på den första valsedeln och ett på den andra, stängt men inte räknat. */
  async function stripped(): Promise<Cast> {
    const annaNonces = freshNonces(counted.first)
    const kimNonces = freshNonces(counted.first)
    const annas = await castBallot(anna, ballotWithNonces(counted.first, S, annaNonces), counted.first)
    const kims = await castBallot(kim, ballotWithNonces(counted.first, S, kimNonces), counted.first)
    await castFor(robin, 'bp-m', counted.first)
    await castFor(anna, 'bp-m', counted.second)
    await closed(electionId)
    return { anna: { ballot: annas, nonces: annaNonces }, kim: { ballot: kims, nonces: kimNonces } }
  }

  /** Samma val, räknat av förtroendeperson 1 och 2, i TALLIED. */
  async function tallied(): Promise<Cast> {
    const cast = await stripped()
    await contributeAndCount(counted.first.id, [0, 2, 1])
    await contributeAndCount(counted.second.id, [0, 0, 1])
    expect(await phaseOf(electionId)).toBe('TALLIED')
    return cast
  }

  async function phaseOf(id: string): Promise<string> {
    return (await votersDb.election.findUniqueOrThrow({ where: { id }, select: { phase: true } })).phase
  }

  async function statusOf(id: string): Promise<string> {
    return (await votesDb.election.findUniqueOrThrow({ where: { id }, select: { status: true } })).status
  }

  async function postsOf(eventType: string): Promise<number> {
    return votersDb.auditEvent.count({ where: { eventType } })
  }

  async function report(): Promise<FinalCheckReport> {
    const result = await runFinalCheck(electionId)
    if (!result) throw new Error('Slutkontrollen hittade inte omröstningen.')
    return result
  }

  function failed(result: FinalCheckReport): string[] {
    return result.checks.filter((check) => !check.passed).map((check) => check.id)
  }

  function checkOf(result: FinalCheckReport, id: string): CheckResult {
    const found = result.checks.find((check) => check.id === id)
    if (!found) throw new Error(`Kontrollen ${id} finns inte i rapporten.`)
    return found
  }

  /** Byter en rad i urnan mot en annan valsedel, med dess chiffer, bevis och hash. */
  async function replaceUrnRow(ciphertextHash: string, ballot: EncryptedBallot): Promise<void> {
    const result = await votesDb.encryptedVote.updateMany({
      where: { ciphertextHash },
      data: { ciphertext: ballot.ciphertext, proofs: ballot.proofs, ciphertextHash: ballot.ciphertextHash },
    })
    expect(result.count).toBe(1)
  }

  /**
   * Byter Annas och Kims rader mot två nya valsedlar för samma parti, med
   * slumptal som tar ut varandra: summan av raderna, alternativ för alternativ,
   * blir exakt densamma. Varje rad verifierar, förtroendepersonernas bidrag
   * håller fortfarande och omräkningen ger samma tal. Bara chifferhasharna är
   * andra. Det är angreppet som omgranskningen av 14f hittade: en
   * självkonsekvent rad med giltiga bevis i stället för en äkta.
   */
  async function swapKeepingTheSum(cast: Cast): Promise<void> {
    const delta = counted.first.options.map(() => randomScalar())
    const annas = ballotWithNonces(
      counted.first,
      S,
      cast.anna.nonces.map((nonce, index) => (nonce + delta[index]!) % Q),
    )
    const kims = ballotWithNonces(
      counted.first,
      S,
      cast.kim.nonces.map((nonce, index) => (nonce - delta[index]! + Q) % Q),
    )
    await replaceUrnRow(cast.anna.ballot.ciphertextHash, annas)
    await replaceUrnRow(cast.kim.ballot.ciphertextHash, kims)
  }

  // -------------------------------------------------------------------------
  // Kontrasten
  // -------------------------------------------------------------------------

  it('ett ärligt räknat val passerar varje kontroll, och rapporten bär urnroten', async () => {
    await tallied()
    const result = await report()

    expect(result.checks.map((check) => check.id)).toEqual(CHECK_IDS)
    expect(failed(result)).toEqual([])
    expect(result).toMatchObject({ canCertify: true, anomalous: false, phase: 'TALLIED', status: 'TALLIED' })
    expect(result.voteCount).toBe(4)

    const stored = await votersDb.election.findUniqueOrThrow({ where: { id: electionId }, select: { urnRoot: true } })
    expect(stored.urnRoot).toMatch(/^[0-9a-f]{64}$/)
    expect(result.urnRoot).toBe(stored.urnRoot)

    // Texterna säger vad kontrollerna inte skyddar mot (fixrunda 1, granskningens Mindre 2 och 5).
    expect(checkOf(result, 'link_cleared').detail).toMatch(/Säkerhetskopior, läsreplikor och WAL-loggen/)
    expect(checkOf(result, 'partial_decryptions_verify').detail).toMatch(/publika andelarna ligger i röstdatabasen/)
    expect(checkOf(result, 'not_under_review').detail).toMatch(/^Röstdatabasen bär ingen markering om avvikelse/)
  })

  it('ingen kontroll läser det gamla flödet', async () => {
    // Kontrollerna som läste röstintygen, åtagandena och tabellen vote är
    // borttagna eller omskrivna, och deras id står inte i rapporten.
    await tallied()
    const ids = (await report()).checks.map((check) => check.id)
    for (const old of [
      'approved_matches_recorded',
      'every_vote_authorised',
      'no_reused_credentials',
      'matches_commitment',
      'commitment_chain_intact',
      'tally_matches_ballots',
      'election_closed',
      'outstanding_credentials',
    ]) {
      expect(ids).not.toContain(old)
    }
  })

  // -------------------------------------------------------------------------
  // En förutsättning låser inget val (ruling 42)
  // -------------------------------------------------------------------------

  it('ett val som pågår kan inte fastställas, och ingenting markeras', async () => {
    await castFor(anna, 'bp-s', counted.first)
    await setClosesAt(electionId, new Date(Date.now() + 3_600_000))

    const result = await report()
    const failures = result.checks.filter((check) => !check.passed)
    expect(failures.length).toBeGreaterThan(0)
    for (const check of failures) expect(check.severity, check.id).toBe('PRECONDITION')
    expect(result).toMatchObject({ anomalous: false, canCertify: false, phase: 'OPEN' })

    expect(await certifyElection(electionId)).toMatchObject({ status: 'not_ready' })
    expect(await statusOf(electionId)).toBe('OPEN')
    expect(await phaseOf(electionId)).toBe('OPEN')
  })

  it('ett stängt val som inte räknats kan inte fastställas, och ingenting markeras', async () => {
    await stripped()

    const result = await report()
    expect(failed(result)).toEqual(['election_tallied', 'partial_decryptions_verify', 'tally_matches'])
    for (const id of failed(result)) expect(checkOf(result, id).severity, id).toBe('PRECONDITION')
    expect(result.anomalous).toBe(false)

    expect(await certifyElection(electionId)).toMatchObject({ status: 'not_ready' })
    expect(await statusOf(electionId)).toBe('OPEN')
    expect(await phaseOf(electionId)).toBe('STRIPPED')
  })

  // -------------------------------------------------------------------------
  // Fasen
  // -------------------------------------------------------------------------

  it('en räknad omröstning vars fas skrivits tillbaka till STRIPPED fångas bara av fasens kontroll', async () => {
    await tallied()
    await votersDb.election.update({ where: { id: electionId }, data: { phase: 'STRIPPED' } })

    const result = await report()
    expect(failed(result)).toEqual(['election_tallied'])
    expect(checkOf(result, 'election_tallied').severity).toBe('PRECONDITION')
    expect(await certifyElection(electionId)).toMatchObject({ status: 'not_ready' })
  })

  it('en fas som inte finns i specen är en avvikelse, och bara fasens kontroll fångar den', async () => {
    await tallied()
    await votersDb.election.update({ where: { id: electionId }, data: { phase: 'RÄKNAD' } })

    const result = await report()
    expect(failed(result)).toEqual(['election_tallied'])
    expect(checkOf(result, 'election_tallied').severity).toBe('CRITICAL')
    expect(result.anomalous).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Kopplingen och kuvertroten
  // -------------------------------------------------------------------------

  it('ett kuvert som skrivs tillbaka i röstlängden efter skalningen fångas bara av kopplingens kontroll', async () => {
    const cast = await tallied()
    await votersDb.pendingVote.create({
      data: {
        voterStatusId: kim,
        ballotId: counted.second.id,
        ciphertext: cast.kim.ballot.ciphertext,
        proofs: cast.kim.ballot.proofs,
        ciphertextHash: cast.kim.ballot.ciphertextHash,
        castSequence: 1,
        bankIdSignature: 'x',
        bankIdCertificateChain: 'x',
        updatedAt: new Date(),
      },
    })

    const result = await report()
    expect(failed(result)).toEqual(['link_cleared'])
    expect(checkOf(result, 'link_cleared').severity).toBe('CRITICAL')

    // En avvikelse: valet markeras och fastställs inte.
    expect(await certifyElection(electionId)).toMatchObject({ status: 'blocked' })
    expect(await statusOf(electionId)).toBe('UNDER_REVIEW')
    expect(await phaseOf(electionId)).toBe('TALLIED')

    /**
     * Markeringen får en post i revisionskedjan, en gång (fixrunda 1,
     * granskningens Mindre 2). Ett nytt försök på ett markerat val skriver
     * ingen ny post. Tar den som kan skriva i röstdatabasen bort markeringen
     * passerar kontrollen, men posten står kvar i röstlängdens kedja, som är
     * obruten, så att borttagningen syns där.
     */
    expect(await postsOf(AUDIT_EVENTS.ELECTION_UNDER_REVIEW)).toBe(1)
    expect(await certifyElection(electionId)).toMatchObject({ status: 'blocked' })
    expect(await postsOf(AUDIT_EVENTS.ELECTION_UNDER_REVIEW)).toBe(1)

    await votesDb.election.update({ where: { id: electionId }, data: { status: 'OPEN' } })
    expect(checkOf(await report(), 'not_under_review').passed).toBe(true)
    expect(await postsOf(AUDIT_EVENTS.ELECTION_UNDER_REVIEW)).toBe(1)
    expect(await verifyAuditChain()).toMatchObject({ intact: true })
  })

  it('en borttagen kuvertrot fångas bara av kopplingens kontroll', async () => {
    await tallied()
    await votersDb.election.update({ where: { id: electionId }, data: { envelopeRoot: null } })

    const result = await report()
    expect(failed(result)).toEqual(['link_cleared'])
    expect(checkOf(result, 'link_cleared').severity).toBe('CRITICAL')
  })

  // -------------------------------------------------------------------------
  // Antalet
  // -------------------------------------------------------------------------

  it('en borttagen markering "har röstat" fångas bara av antalets kontroll', async () => {
    await tallied()
    const marker = await votersDb.votedMarker.findFirstOrThrow({ where: { ballotId: counted.first.id } })
    await votersDb.votedMarker.delete({ where: { id: marker.id } })

    const result = await report()
    expect(failed(result)).toEqual(['urn_matches_markers'])
    expect(checkOf(result, 'urn_matches_markers').severity).toBe('CRITICAL')
    expect(checkOf(result, 'urn_matches_markers').detail).toMatch(/Riksdagen: 3 rader i urnan men 2 markeringar/)
  })

  it('antalets kontroll passerar inte på två tomma mängder när kuvert faktiskt flyttades', async () => {
    await tallied()
    const ballotIds = [counted.first.id, counted.second.id]
    await votesDb.encryptedVote.deleteMany({ where: { ballotId: { in: ballotIds } } })
    await votersDb.votedMarker.deleteMany({ where: { ballotId: { in: ballotIds } } })

    const result = await report()
    const check = checkOf(result, 'urn_matches_markers')
    expect(check.passed).toBe(false)
    expect(check.severity).toBe('CRITICAL')
    expect(check.detail).toMatch(/kuvertroten/)
  })

  // -------------------------------------------------------------------------
  // Varje röst
  // -------------------------------------------------------------------------

  it('ett trasigt bevis i urnan fångas bara av kontrollen av varje röst', async () => {
    // Chiffret och hashen står kvar, så urnroten och summan är desamma.
    const cast = await tallied()
    const row = await votesDb.encryptedVote.findFirstOrThrow({
      where: { ciphertextHash: cast.anna.ballot.ciphertextHash },
    })
    const proofs = row.proofs as EncryptedBallot['proofs']
    const response = (BigInt(proofs.components[0]!.response0) + 1n) % Q
    await votesDb.encryptedVote.update({
      where: { id: row.id },
      data: {
        proofs: {
          ...proofs,
          components: [{ ...proofs.components[0]!, response0: response.toString() }, ...proofs.components.slice(1)],
        },
      },
    })

    const result = await report()
    expect(failed(result)).toEqual(['every_vote_verifies'])
    expect(checkOf(result, 'every_vote_verifies').severity).toBe('CRITICAL')
  })

  it('skräp i databasen blir en avvikelse och inte en krasch (ruling 37)', async () => {
    // Valets nyckel är inte ett tal. Verifieringen kastar då, i stället för att
    // svara nej, och kastet ska bli en avvikelse i rapporten.
    await tallied()
    await votesDb.election.update({ where: { id: electionId }, data: { encryptionPublicKey: 'inte-ett-tal' } })

    const result = await report()
    expect(failed(result)).toEqual(['every_vote_verifies'])
    expect(checkOf(result, 'every_vote_verifies').severity).toBe('CRITICAL')
  })

  it('ett chiffer som inte ens går att läsa blir avvikelser i rapporten, inte en krasch (ruling 37)', async () => {
    // Raden har ett chiffer som inte är en lista av tal. Urnroten, varje röst,
    // bidragen och räkningen läser samma rad, och ingen av dem får kasta.
    const cast = await tallied()
    const updated = await votesDb.encryptedVote.updateMany({
      where: { ciphertextHash: cast.anna.ballot.ciphertextHash },
      data: { ciphertext: 'skräp' },
    })
    expect(updated.count).toBe(1)

    const result = await report()
    for (const id of ['urn_root_matches', 'every_vote_verifies', 'partial_decryptions_verify', 'tally_matches']) {
      expect(checkOf(result, id).passed, id).toBe(false)
      expect(checkOf(result, id).severity, id).toBe('CRITICAL')
    }
    expect(checkOf(result, 'urn_root_matches').detail).toMatch(/går att hasha/)
    expect(result.urnRoot).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Bidragen och räkningen
  // -------------------------------------------------------------------------

  it('ett ändrat bevis i ett sparat bidrag fångas bara av bidragens kontroll', async () => {
    // Värdet står kvar, så omräkningen ger samma tal. Bara beviset håller inte.
    await tallied()
    const row = await votesDb.partialDecryption.findFirstOrThrow({
      where: { ballotId: counted.first.id, trusteeIndex: 2, optionIndex: S },
    })
    const proof = row.proof as Record<string, string>
    await votesDb.partialDecryption.update({
      where: { id: row.id },
      data: { proof: { ...proof, response: ((BigInt(proof.response!) + 1n) % Q).toString() } },
    })

    const result = await report()
    expect(failed(result)).toEqual(['partial_decryptions_verify'])
    expect(checkOf(result, 'partial_decryptions_verify').severity).toBe('CRITICAL')
  })

  it('en publik andel och ett bidrag som byts ut tillsammans passerar bidragens kontroll, och bara omräkningen fångar dem', async () => {
    /**
     * Texten i partial_decryptions_verify säger det (fixrunda 1, granskningens
     * Mindre 5). Den som kan skriva i röstdatabasen väljer en ny andel åt
     * förtroendeperson 2, skriver dess publika andel och räknar nya bidrag, med
     * bevis som håller för den nya andelen. Bidragens kontroll passerar, men
     * de nya värdena kombineras inte till de sparade räkneverken.
     */
    await tallied()
    const share = { index: 2, value: randomScalar() }
    await votesDb.trusteeShare.update({
      where: { electionId_trusteeIndex: { electionId, trusteeIndex: 2 } },
      data: { publicShare: publicShare(share).toString() },
    })
    for (const ballot of [counted.first, counted.second]) {
      for (const [optionIndex, sum] of (await aggregate(ballot.id)).entries()) {
        const partial = partiallyDecrypt(share, sum, { electionId, ballotId: ballot.id, optionIndex })
        const updated = await votesDb.partialDecryption.updateMany({
          where: { ballotId: ballot.id, trusteeIndex: 2, optionIndex },
          data: { value: partial.value.toString(), proof: serialisePartialDecryptionProof(partial.proof) },
        })
        expect(updated.count).toBe(1)
      }
    }

    const result = await report()
    expect(failed(result)).toEqual(['tally_matches'])
    expect(checkOf(result, 'partial_decryptions_verify').passed).toBe(true)
  })

  it('ett räknat val vars bidrag tagits bort passerar varken bidragens eller räkningens kontroll', async () => {
    await tallied()
    await votesDb.partialDecryption.deleteMany({ where: { ballotId: counted.first.id } })

    const result = await report()
    expect(failed(result)).toEqual(['partial_decryptions_verify', 'tally_matches'])
    expect(checkOf(result, 'partial_decryptions_verify').severity).toBe('CRITICAL')
    expect(checkOf(result, 'tally_matches').severity).toBe('CRITICAL')
  })

  it('två räkneverk som bytt plats, med samma summa, fångas bara av räkningens kontroll', async () => {
    await tallied()
    await votesDb.ballotTally.updateMany({ where: { ballotId: counted.first.id, optionIndex: S }, data: { count: 1 } })
    await votesDb.ballotTally.updateMany({ where: { ballotId: counted.first.id, optionIndex: M }, data: { count: 2 } })

    const result = await report()
    expect(failed(result)).toEqual(['tally_matches'])
    expect(checkOf(result, 'tally_matches').severity).toBe('CRITICAL')
  })

  it('räkneverk som inte summerar till antalet rader fångas bara av räkningens kontroll', async () => {
    await tallied()
    await votesDb.ballotTally.updateMany({
      where: { ballotId: counted.first.id, optionIndex: BLANK },
      data: { count: 1 },
    })

    const result = await report()
    expect(failed(result)).toEqual(['tally_matches'])
    expect(checkOf(result, 'tally_matches').detail).toMatch(/summerar till 4[\s\S]*3 rader/)
  })

  it('ett räknat val utan räkneverk passerar inte räkningens kontroll', async () => {
    await tallied()
    await votesDb.ballotTally.deleteMany({ where: { ballotId: counted.first.id } })

    const result = await report()
    expect(failed(result)).toEqual(['tally_matches'])
    expect(checkOf(result, 'tally_matches').severity).toBe('CRITICAL')
  })

  // -------------------------------------------------------------------------
  // Urnroten
  // -------------------------------------------------------------------------

  it('två rader bytta mot självkonsekventa rader med giltiga bevis och samma summa fångas bara av urnroten', async () => {
    const cast = await tallied()
    await swapKeepingTheSum(cast)

    const result = await report()
    expect(failed(result)).toEqual(['urn_root_matches'])
    expect(checkOf(result, 'urn_root_matches').severity).toBe('CRITICAL')
  })

  it('en borttagen kopia ändrar urnroten, också när antalet markeringar skrivits om (ruling 130)', async () => {
    // Två kuvert med samma chiffer är två röster. Tas den ena raden bort, och
    // en markering med den, stämmer antalet, men inte roten.
    const annas = await castFor(anna, 'bp-s', counted.first)
    await castBallot(kim, annas, counted.first)
    await castFor(robin, 'bp-m', counted.first)
    await closed(electionId)

    const copies = await votesDb.encryptedVote.findMany({ where: { ciphertextHash: annas.ciphertextHash } })
    expect(copies).toHaveLength(2)
    await votesDb.encryptedVote.delete({ where: { id: copies[0]!.id } })
    const marker = await votersDb.votedMarker.findFirstOrThrow({ where: { voterStatusId: kim } })
    await votersDb.votedMarker.delete({ where: { id: marker.id } })

    const result = await report()
    const critical = result.checks.filter((check) => !check.passed && check.severity === 'CRITICAL')
    expect(critical.map((check) => check.id)).toEqual(['urn_root_matches'])
  })

  it('ett chiffer som bytts ut medan hashen står kvar fångas av urnroten, som räknar hashen ur chiffret', async () => {
    // Raden bär sin gamla hash men en annan rads chiffer. Roten räknas ur
    // chiffret och inte ur kolumnen, så den blir en annan. Raden verifierar
    // inte heller, och summan är en annan, så fler kontroller fallerar.
    const cast = await tallied()
    const other = await votesDb.encryptedVote.findFirstOrThrow({
      where: { ballotId: counted.first.id, NOT: { ciphertextHash: cast.anna.ballot.ciphertextHash } },
    })
    const result = await votesDb.encryptedVote.updateMany({
      where: { ciphertextHash: cast.anna.ballot.ciphertextHash },
      data: { ciphertext: other.ciphertext as never },
    })
    expect(result.count).toBe(1)

    const check = checkOf(await report(), 'urn_root_matches')
    expect(check.passed).toBe(false)
    expect(check.severity).toBe('CRITICAL')
  })

  it('en urnrot som skrivits om i posten LINK_CLEARED bryter revisionskedjan', async () => {
    // Roten ingår i postens hash, så den går inte att byta ut i kedjan utan att
    // kedjan bryts, och omröstningens rot finns då inte längre i någon post.
    await tallied()
    const post = await votersDb.auditEvent.findFirstOrThrow({ where: { eventType: AUDIT_EVENTS.LINK_CLEARED } })
    await votersDb.auditEvent.update({ where: { id: post.id }, data: { urnRoot: 'e'.repeat(64) } })

    const result = await report()
    expect(failed(result)).toEqual(['urn_root_matches', 'audit_chain_intact'])
  })

  it('en urnrot som skrivits om i röstlängden fångas bara av urnroten', async () => {
    await tallied()
    await votersDb.election.update({ where: { id: electionId }, data: { urnRoot: 'f'.repeat(64) } })

    const result = await report()
    expect(failed(result)).toEqual(['urn_root_matches'])
    expect(checkOf(result, 'urn_root_matches').severity).toBe('CRITICAL')
  })

  it('en urnrot som stämmer med en bytt urna men inte med revisionskedjan fångas av urnroten', async () => {
    // Den som kan skriva i båda databaserna byter raderna och skriver om roten
    // i röstlängden så att den stämmer med urnan. Posten LINK_CLEARED bär
    // fortfarande den rot stängningen skrev.
    const cast = await tallied()
    await swapKeepingTheSum(cast)
    const rows = await votesDb.encryptedVote.findMany({
      where: { ballotId: { in: [counted.first.id, counted.second.id] } },
      select: { ballotId: true, ciphertextHash: true },
    })
    await votersDb.election.update({ where: { id: electionId }, data: { urnRoot: urnRootOf(rows) } })

    const result = await report()
    expect(failed(result)).toEqual(['urn_root_matches'])
    expect(checkOf(result, 'urn_root_matches').detail).toMatch(/revisionskedjan/)
  })

  it('ett val utan urnrot kan inte fastställas, och ingenting markeras', async () => {
    // Ett val som skalades innan urnroten fanns. Det går inte att skilja från
    // en rot som tagits bort, och ingen av dem får låsa valet i UNDER_REVIEW.
    await tallied()
    await votersDb.election.update({ where: { id: electionId }, data: { urnRoot: null } })

    const result = await report()
    expect(failed(result)).toEqual(['urn_root_matches'])
    expect(checkOf(result, 'urn_root_matches').severity).toBe('PRECONDITION')
    expect(result.anomalous).toBe(false)
    expect(await certifyElection(electionId)).toMatchObject({ status: 'not_ready' })
    expect(await statusOf(electionId)).toBe('OPEN')
  })

  // -------------------------------------------------------------------------
  // Revisionskedjan och en tidigare avvikelse
  // -------------------------------------------------------------------------

  it('en ändrad post i revisionskedjan fångas bara av kedjans kontroll', async () => {
    await tallied()
    const post = await votersDb.auditEvent.findFirstOrThrow({
      where: { eventType: AUDIT_EVENTS.ELECTION_CREATED },
      orderBy: { sequence: 'asc' },
    })
    await votersDb.auditEvent.update({ where: { id: post.id }, data: { eventType: AUDIT_EVENTS.AUTH_STARTED } })

    const result = await report()
    expect(failed(result)).toEqual(['audit_chain_intact'])
    expect(checkOf(result, 'audit_chain_intact').severity).toBe('CRITICAL')
  })

  it('ett val som markerats för granskning fastställs inte, och markeringen står kvar', async () => {
    await tallied()
    await votesDb.election.update({ where: { id: electionId }, data: { status: 'UNDER_REVIEW' } })

    const result = await report()
    expect(failed(result)).toEqual(['not_under_review'])
    expect(checkOf(result, 'not_under_review').severity).toBe('CRITICAL')
    expect(checkOf(result, 'not_under_review').detail).toMatch(/^Röstdatabasen bär markeringen UNDER_REVIEW/)
    expect(result.status).toBe('UNDER_REVIEW')

    expect(await certifyElection(electionId)).toMatchObject({ status: 'blocked' })
    expect(await phaseOf(electionId)).toBe('TALLIED')
    expect(await statusOf(electionId)).toBe('UNDER_REVIEW')
    // Markeringen sattes inte av fastställandet, så ingen post skrevs.
    expect(await postsOf(AUDIT_EVENTS.ELECTION_UNDER_REVIEW)).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Fastställandet
  // -------------------------------------------------------------------------

  describe('fastställandet', () => {
    async function certifiedPosts(): Promise<number> {
      return votersDb.auditEvent.count({ where: { eventType: AUDIT_EVENTS.ELECTION_CERTIFIED } })
    }

    it('skriver CERTIFIED från TALLIED och revisionsposten, och ett fastställt val fastställs inte igen', async () => {
      await tallied()

      const outcome = await certifyElection(electionId)
      expect(outcome).toMatchObject({ status: 'certified', report: { phase: 'CERTIFIED', status: 'CERTIFIED' } })
      expect(await phaseOf(electionId)).toBe('CERTIFIED')
      expect(await certifiedPosts()).toBe(1)

      // Efteråt passerar kontrollen fortfarande, och rapporten säger CERTIFIED.
      const after = await report()
      expect(failed(after)).toEqual([])
      expect(after).toMatchObject({ phase: 'CERTIFIED', status: 'CERTIFIED' })

      expect(await certifyElection(electionId)).toMatchObject({ status: 'already_certified' })
      expect(await certifiedPosts()).toBe(1)
    })

    it('två samtidiga fastställanden ger ett fastställt val och en post', async () => {
      await tallied()

      const outcomes = await Promise.all([certifyElection(electionId), certifyElection(electionId)])
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['already_certified', 'certified'])
      expect(await phaseOf(electionId)).toBe('CERTIFIED')
      expect(await certifiedPosts()).toBe(1)
    })

    it('går revisionsposten inte att skriva står fasen kvar i TALLIED, och nästa försök gör klart', async () => {
      await tallied()

      auditControl.failOn = AUDIT_EVENTS.ELECTION_CERTIFIED
      await expect(certifyElection(electionId)).rejects.toThrow(/ELECTION_CERTIFIED/)
      auditControl.failOn = null
      expect(await phaseOf(electionId)).toBe('TALLIED')
      expect(await certifiedPosts()).toBe(0)

      expect(await certifyElection(electionId)).toMatchObject({ status: 'certified' })
      expect(await certifiedPosts()).toBe(1)
    })

    it('en avvikelse som uppstår mellan kontrollen och jämför-och-sätt markerar valet och svarar blocked (granskningens P6a)', async () => {
      /**
       * Fixrunda 1, granskningens Mindre 3. En fas utanför specen skrivs efter
       * kontrollen och före jämför-och-sätt. Jämför-och-sätt missar, och den
       * omkörda kontrollen hittar en avvikelse. Förut svarade grenen
       * `not_ready`, med `anomalous: true`, och markerade ingenting.
       */
      await tallied()
      auditControl.afterChain = async () => {
        await votersDb.election.update({ where: { id: electionId }, data: { phase: 'RÄKNAD' } })
      }

      const outcome = await certifyElection(electionId)
      expect(outcome).toMatchObject({ status: 'blocked', report: { anomalous: true, status: 'UNDER_REVIEW' } })
      expect(await statusOf(electionId)).toBe('UNDER_REVIEW')
      expect(await phaseOf(electionId)).toBe('RÄKNAD')
      expect(await certifiedPosts()).toBe(0)
      expect(await postsOf(AUDIT_EVENTS.ELECTION_UNDER_REVIEW)).toBe(1)
    })

    /** Släpper den andra skrivaren när en sats i testdatabasen väntar på ett lås, eller efter fem sekunder. */
    async function releaseWhenWaiting(release: () => void): Promise<void> {
      for (let tries = 0; tries < 200; tries += 1) {
        const [row] = await votersDb.$queryRaw<Array<{ waiting: number }>>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`
        if ((row?.waiting ?? 0) > 0) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      release()
    }

    it('en post som en annan skrivare håller på att skriva väntas in och tar inte fastställandets löpnummer (granskningens P4c)', async () => {
      /**
       * Fixrunda 1, granskningens Mindre 4. Proben skrev en ström av andra
       * poster medan valet fastställdes, och fastställandet kastade redan första
       * gången: en annan post tog löpnumret, det unika indexet avvisade
       * fastställandets post med P2002, och transaktionens nästa läsning svarade
       * 25P02. Rutten svarade 500.
       *
       * Testet framkallar samma läge en gång, utan att hänga på tidtagning. En
       * annan skrivare har tagit nästa löpnummer i en transaktion som står öppen,
       * och gör COMMIT först när fastställandets transaktion väntar på ett lås.
       * Fastställandet låser revisionstabellen innan det läser det senaste
       * numret, så låset väntar in den andra posten, och fastställandets post tar
       * numret efter. Utan låset hade posten väntat på samma nummer och fått
       * P2002, som i proben.
       */
      await tallied()

      let release!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      let taken!: () => void
      const numberTaken = new Promise<void>((resolve) => {
        taken = resolve
      })

      const other = votersDb.$transaction(
        async (tx) => {
          const previous = await tx.auditEvent.findFirstOrThrow({
            orderBy: { sequence: 'desc' },
            select: { sequence: true, entryHash: true },
          })
          const sequence = previous.sequence + 1
          const eventType = AUDIT_EVENTS.AUTH_STARTED
          const occurredAt = truncateToHour(new Date())
          const previousHash = previous.entryHash
          await tx.auditEvent.create({
            data: {
              eventType,
              occurredAt,
              sequence,
              previousHash,
              entryHash: auditEntryHash({ sequence, eventType, occurredAt, previousHash }),
            },
          })
          taken()
          await released
        },
        { timeout: 60_000 },
      )
      await numberTaken

      // Slutkontrollens sista läsning. Därefter skriver fastställandet.
      auditControl.afterChain = async () => {
        void releaseWhenWaiting(release)
      }

      const outcome = await certifyElection(electionId)
      await other

      expect(outcome).toMatchObject({ status: 'certified' })
      // Ett enda försök, utan krock, och posten står efter den andra skrivarens.
      expect(auditControl.calls.filter((eventType) => eventType === AUDIT_EVENTS.ELECTION_CERTIFIED)).toHaveLength(1)
      expect(await phaseOf(electionId)).toBe('CERTIFIED')
      expect(await certifiedPosts()).toBe(1)
      const [last, beforeLast] = await votersDb.auditEvent.findMany({
        orderBy: { sequence: 'desc' },
        take: 2,
        select: { eventType: true },
      })
      expect([beforeLast?.eventType, last?.eventType]).toEqual([AUDIT_EVENTS.AUTH_STARTED, AUDIT_EVENTS.ELECTION_CERTIFIED])
      expect(await verifyAuditChain()).toMatchObject({ intact: true })
    })

    it('fastställandet under en ström av andra revisionsposter fastställer, med en post och kedjan hel (granskningens P4c)', async () => {
      // Probens form: en annan skrivare lägger post efter post så länge
      // fastställandet pågår. Förut kastade fastställandet, också med fem
      // omförsök. Med låset väntar strömmen i stället medan posten skrivs.
      await tallied()
      let stop = false
      const flood = (async () => {
        let written = 0
        while (!stop) {
          await recordAuditEvent(AUDIT_EVENTS.AUTH_STARTED)
          written += 1
        }
        return written
      })()

      let outcome: Awaited<ReturnType<typeof certifyElection>>
      try {
        outcome = await certifyElection(electionId)
      } finally {
        stop = true
      }
      const written = await flood

      expect(written).toBeGreaterThan(0)
      expect(outcome).toMatchObject({ status: 'certified' })
      expect(await phaseOf(electionId)).toBe('CERTIFIED')
      expect(await certifiedPosts()).toBe(1)
      expect(await verifyAuditChain()).toMatchObject({ intact: true })
    })

    it('fasen skrivs med jämför-och-sätt: en fas som ändrats efter kontrollen skrivs inte över', async () => {
      await tallied()
      auditControl.afterChain = async () => {
        await votersDb.election.update({ where: { id: electionId }, data: { phase: 'STRIPPED' } })
      }

      expect(await certifyElection(electionId)).toMatchObject({ status: 'not_ready' })
      expect(await phaseOf(electionId)).toBe('STRIPPED')
      expect(await certifiedPosts()).toBe(0)
    })

    it('ett val utan röster kan räknas, kontrolleras och fastställas', async () => {
      await closed(electionId)
      await contributeAndCount(counted.first.id, [0, 0, 0])
      await contributeAndCount(counted.second.id, [0, 0, 0])

      const result = await report()
      expect(failed(result)).toEqual([])
      expect(result.voteCount).toBe(0)
      expect(await certifyElection(electionId)).toMatchObject({ status: 'certified' })
    })
  })
})

describe('det gamla flödets kontroller', () => {
  it('varje gammal kontroll har ett utskrivet öde, och ingen försvann tyst', () => {
    // Briefen: varje kontroll behålls, skrivs om mot det nya underlaget eller
    // tas bort med ett utskrivet skäl. De tio som fanns före uppgift 12b.
    expect(Object.keys(WHAT_BECAME_OF_THE_OLD_CHECKS).sort()).toEqual([
      'approved_matches_recorded',
      'audit_chain_intact',
      'commitment_chain_intact',
      'election_closed',
      'every_vote_authorised',
      'link_cleared',
      'matches_commitment',
      'no_reused_credentials',
      'outstanding_credentials',
      'tally_matches_ballots',
    ])
    for (const [id, fate] of Object.entries(WHAT_BECAME_OF_THE_OLD_CHECKS)) {
      expect(fate, id).toMatch(/^(Behållen|Omskriven till [a-z_]+\.|Borttagen\.) /)
      const rewritten = /^Omskriven till ([a-z_]+)\./.exec(fate)
      if (rewritten) expect(CHECK_IDS, id).toContain(rewritten[1])
    }
  })
})
