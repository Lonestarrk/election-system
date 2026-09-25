import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import { closeElection, urnIdFor } from '@/orchestration/close-election.usecase'
import {
  aggregate,
  completeTally,
  submitComputedPartialDecryption,
  submitPartialDecryption,
  TallyAbortedError,
  type SubmittedPartial,
} from '@/orchestration/tally.usecase'
import { canonicalOptions, type BallotOption } from '@/lib/crypto/ballot-encoding'
import { encrypt } from '@/lib/crypto/elgamal'
import { G, P, randomScalar } from '@/lib/crypto/group'
// Serverns ingång registrerar OpenSSL, så att krypteringen i testet går fort.
import '@/lib/crypto/server'
import { hashCiphertext, type EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { encryptBallot } from '@/lib/encrypt-client'
import { resetRateLimits } from '@/lib/rate-limit'
import { AUDIT_EVENTS } from '@/modules/eligibility/audit.service'
import { createAdminSession } from '@/modules/eligibility/admin-session.service'
import {
  MockBankIdService,
  selectDemoIdentity,
} from '@/modules/eligibility/bankid/MockBankIdService'
import { envelopePayload } from '@/modules/eligibility/bankid/envelope-signature'
import {
  castEncryptedBallot,
  nextCastSequence,
  type SignedEnvelope,
} from '@/modules/eligibility/pending-vote.service'
import { POST as decryptRoute } from '@/app/api/admin/elections/decrypt/route'
import { POST as tallyRoute } from '@/app/api/admin/elections/tally/route'
import { createVoter, disconnect, isDatabaseAvailable, resetElectionData } from './helpers'

/**
 * UPPGIFT 12: SUMMERING OCH TRÖSKELDEKRYPTERING.
 *
 * Det här är första gången ett val får ett resultat. Varje röst är ett chiffer
 * i urnan, och chiffren multipliceras ihop per alternativ till ett chiffer av
 * summan. Bara summan öppnas, och bara när två av tre förtroendepersoner har
 * lämnat var sin partiell dekryptering med ett bevis.
 *
 * Testerna prövar resultatet, men framför allt spärrarna: att ingenting
 * dekrypteras förrän kopplingen mellan väljare och röst bevisligen är borta,
 * att ett bidrag som inte hör till just den här summan avvisas, och att ett
 * felaktigt röstetal aldrig blir tyst. Varje manipulation av databasen ska ge
 * ett avbrott med ett besked, inte ett annat tal.
 */

/** Adminsessionens cookie läggs in utifrån, eftersom next/headers kräver Nexts begäranskontext. */
const cookieJar = vi.hoisted(() => ({ admin: undefined as string | undefined }))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'valadmin' && cookieJar.admin ? { name, value: cookieJar.admin } : undefined,
  }),
}))

/**
 * En krok i uppslaget av valsedelns form, som räkningen gör efter att den
 * prövat fasen. Kroken körs en gång när den är satt, och låter ett test ändra
 * fasen mellan spärren och övergången till TALLIED. Alla andra anrop går till
 * den äkta funktionen.
 */
const shapeHook = vi.hoisted(() => ({ once: null as null | (() => Promise<void>) }))

vi.mock('@/modules/ballot-box', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/ballot-box')>()
  return {
    ...actual,
    getEncryptedBallotShape: async (ballotId: string) => {
      const hook = shapeHook.once
      shapeHook.once = null
      if (hook) await hook()
      return actual.getEncryptedBallotShape(ballotId)
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

const ORIGIN = 'http://localhost:3000'

type CountedBallot = { id: string; options: BallotOption[]; bpS: string; bpM: string }
type CountedElection = { electionId: string; publicKey: string; first: CountedBallot; second: CountedBallot }
type UrnPairs = Array<{ c1: unknown; c2: unknown }>

describe.skipIf(!databaseAvailable)('räkningen öppnar bara summan', () => {
  const ANNA_PN = '199001011234'
  const KIM_PN = '198505152345'
  const ROBIN_PN = '197012125678'
  const ADMIN_PN = '198001019876'

  /** Valet som räknas. Två valsedlar, så att ett bidrag kan tas från den andra. */
  let counted: CountedElection
  /** Ett val utan röster, också med två valsedlar. */
  let empty: CountedElection

  let electionId: string
  let ballotId: string
  let emptyElectionId: string
  let emptyBallotId: string

  let anna: string
  let kim: string
  let robin: string

  let csrfSecret: string

  const personalNumberByVoter = new Map<string, string>()

  async function createSignedVoter(personalNumber: string): Promise<string> {
    const id = await createVoter(personalNumber)
    personalNumberByVoter.set(id, personalNumber)
    return id
  }

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

  beforeEach(async () => {
    shapeHook.once = null
    cookieJar.admin = undefined
    resetRateLimits()
    await resetElectionData()

    counted = await createCountedElection('Räkningstest')
    empty = await createCountedElection('Tom omröstning')
    electionId = counted.electionId
    ballotId = counted.first.id
    emptyElectionId = empty.electionId
    emptyBallotId = empty.first.id

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
    const order = await service.sign({
      endUserIp: '127.0.0.1',
      userVisibleData: 'Bekräfta din röst',
      userNonVisibleData: envelopePayload({ electionId, ballotId: ballot.id, ciphertextHash, castSequence }),
    })
    selectDemoIdentity(order.orderRef, personalNumber)

    let result = await service.collect(order.orderRef)
    while (result.status === 'pending') result = await service.collect(order.orderRef)
    if (result.status !== 'complete') throw new Error('Signeringen blev inte klar.')

    return {
      signature: result.completionData.signature,
      certificateChain: result.completionData.certificateChain,
      signedData: result.completionData.signedData,
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

  async function castFor(
    voterStatusId: string,
    party: 'bp-s' | 'bp-m',
    ballot: CountedBallot = counted.first,
  ): Promise<EncryptedBallot> {
    const encrypted = await encryptBallot(counted.publicKey, electionId, ballot.id, ballot.options, {
      kind: 'PARTY',
      ballotPartyId: party === 'bp-s' ? ballot.bpS : ballot.bpM,
    })
    return castBallot(voterStatusId, encrypted, ballot)
  }

  async function closed(id: string): Promise<void> {
    const outcome = await closeElection(id)
    if (outcome.status !== 'closed') throw new Error(`Stängningen gick inte igenom (${outcome.status}).`)
  }

  async function phaseOf(id: string): Promise<string> {
    return (await votersDb.election.findUniqueOrThrow({ where: { id }, select: { phase: true } })).phase
  }

  type Contribution = { trusteeIndex: number; partials: SubmittedPartial[] }

  /** Förtroendepersonens lagrade bidrag för en valsedel, så som det står i databasen. */
  async function storedContribution(ballot: string, trusteeIndex: number): Promise<Contribution> {
    const rows = await votesDb.partialDecryption.findMany({
      where: { ballotId: ballot, trusteeIndex },
      orderBy: { optionIndex: 'asc' },
      select: { optionIndex: true, value: true, proof: true },
    })
    return { trusteeIndex, partials: rows }
  }

  /**
   * REVIEW FOCUS 4. Ett äkta bidrag från samma förtroendeperson, i samma val,
   * men för den andra valsedeln.
   */
  async function partialFromAnotherBallot(): Promise<Contribution> {
    expect(await submitPartialDecryption(counted.second.id, 1, TRUSTEE_PASSPHRASES[0])).toMatchObject({
      status: 'accepted',
    })
    return storedContribution(counted.second.id, 1)
  }

  function submitRaw(ballot: string, contribution: Contribution) {
    return submitComputedPartialDecryption(ballot, contribution.trusteeIndex, contribution.partials)
  }

  async function auditEvents(eventType: string): Promise<number> {
    return votersDb.auditEvent.count({ where: { eventType } })
  }

  /** Båda valsedlarna i det räknade valet får bidrag från förtroendeperson 1 och 2. */
  async function bothBallotsContributed(): Promise<void> {
    for (const ballot of [counted.first.id, counted.second.id]) {
      await submitPartialDecryption(ballot, 1, TRUSTEE_PASSPHRASES[0])
      await submitPartialDecryption(ballot, 2, TRUSTEE_PASSPHRASES[1])
    }
  }

  // -------------------------------------------------------------------------
  // Resultatet
  // -------------------------------------------------------------------------

  it('räknar rätt utan att öppna någon enskild röst', async () => {
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-s')
    await castFor(robin, 'bp-m')
    await closeElection(electionId)

    await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0]!)
    await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1]!)
    const result = await completeTally(ballotId)

    expect(result).toMatchObject({ status: 'tallied' })
    expect((result as { counts: number[] }).counts).toEqual([0, 2, 1]) // blank, S, M

    // Räkneverken sparas per alternativ, och ingenting annat.
    const tallies = await votesDb.ballotTally.findMany({ where: { ballotId }, orderBy: { optionIndex: 'asc' } })
    expect(tallies.map(({ optionIndex, count }) => [optionIndex, count])).toEqual([
      [0, 0],
      [1, 2],
      [2, 1],
    ])
  })

  it('vilka två förtroendepersoner som helst ger samma resultat, och alla tre också', async () => {
    await castFor(anna, 'bp-m')
    await castFor(kim, 'bp-s')
    await castFor(robin, 'bp-s', counted.second)
    await closed(electionId)

    // Förtroendeperson 2 och 3, utan 1: Lagrange-koefficienterna beror på vilka som deltar.
    expect(await submitPartialDecryption(ballotId, 3, TRUSTEE_PASSPHRASES[2])).toMatchObject({ status: 'accepted' })
    expect(await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1])).toMatchObject({ status: 'accepted' })
    expect(await completeTally(ballotId)).toMatchObject({ status: 'tallied', counts: [0, 1, 1] })

    // På den andra valsedeln bidrar alla tre innan räkningen.
    for (const index of [1, 2, 3] as const) {
      expect(await submitPartialDecryption(counted.second.id, index, TRUSTEE_PASSPHRASES[index - 1])).toMatchObject({
        status: 'accepted',
      })
    }
    expect(await completeTally(counted.second.id)).toMatchObject({ status: 'tallied', counts: [0, 1, 0] })
  })

  it('en valsedel utan röster ger nollor, inte ett kastat fel', async () => {
    // REVIEW FOCUS 6.
    await closeElection(emptyElectionId)
    await submitPartialDecryption(emptyBallotId, 1, TRUSTEE_PASSPHRASES[0]!)
    await submitPartialDecryption(emptyBallotId, 2, TRUSTEE_PASSPHRASES[1]!)

    expect(await completeTally(emptyBallotId)).toMatchObject({ status: 'tallied', counts: [0, 0, 0] })
  })

  it('två likadana kuvert räknas som två röster (ruling 130)', async () => {
    // En kopia av någon annans valsedel är en giltig röst, och urnan har en
    // rad per kuvert. Ingenting i räkningen får slå ihop rader per hash.
    const original = await castFor(anna, 'bp-s')
    await castBallot(kim, original, counted.first)
    await castFor(robin, 'bp-m')
    await closed(electionId)

    const rows = await votesDb.encryptedVote.findMany({ where: { ballotId }, select: { ciphertextHash: true } })
    expect(rows.filter((row) => row.ciphertextHash === original.ciphertextHash)).toHaveLength(2)

    await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])
    await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1])
    expect(await completeTally(ballotId)).toMatchObject({ status: 'tallied', counts: [0, 2, 1] })
  })

  it('aggregatet är produkten av varje rad i urnan, per alternativ', async () => {
    const first = await castFor(anna, 'bp-s')
    await castBallot(kim, first, counted.first)
    await closed(electionId)

    const product = first.ciphertext.map(({ c1, c2 }) => ({
      c1: (BigInt(c1) * BigInt(c1)) % P,
      c2: (BigInt(c2) * BigInt(c2)) % P,
    }))
    expect(await aggregate(ballotId)).toEqual(product)
    // Utan röster är produkten ett, i båda komponenterna.
    expect(await aggregate(emptyBallotId)).toEqual([
      { c1: 1n, c2: 1n },
      { c1: 1n, c2: 1n },
      { c1: 1n, c2: 1n },
    ])
  })

  // -------------------------------------------------------------------------
  // Förtroendepersonerna
  // -------------------------------------------------------------------------

  it('fel lösenfras låter ingen andel öppnas', async () => {
    // Utan detta är frasen dekoration och andelen lika oskyddad som förut.
    await closeElection(electionId)

    expect(await submitPartialDecryption(ballotId, 1, 'fel')).toMatchObject({
      status: 'wrong_passphrase',
    })
    // Ingenting sparat, och försöket syns i revisionsloggen (ruling 64).
    expect(await votesDb.partialDecryption.count({ where: { ballotId } })).toBe(0)
    expect(await auditEvents(AUDIT_EVENTS.TRUSTEE_PASSPHRASE_REJECTED)).toBe(1)
    // En annan förtroendepersons fras öppnar inte heller andelen.
    expect(await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[1])).toMatchObject({
      status: 'wrong_passphrase',
    })
  })

  it('en ensam förtroendeman räcker inte', async () => {
    await closeElection(electionId)
    await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0]!)

    expect(await completeTally(ballotId)).toMatchObject({ status: 'needs_more_trustees', have: 1, need: 2 })
    expect(await votesDb.ballotTally.count({ where: { ballotId } })).toBe(0)
  })

  it('ingen förtroendeperson alls ger besked, inte ett resultat', async () => {
    await closed(electionId)
    expect(await completeTally(ballotId)).toMatchObject({ status: 'needs_more_trustees', have: 0, need: 2 })
  })

  it('samma förtroendeperson två gånger ger en dubblett och ingen ny rad', async () => {
    await castFor(anna, 'bp-s')
    await closed(electionId)

    expect(await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])).toMatchObject({ status: 'accepted' })
    expect(await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])).toMatchObject({ status: 'duplicate' })
    expect(await votesDb.partialDecryption.count({ where: { ballotId, trusteeIndex: 1 } })).toBe(3)

    // Två bidrag från samma förtroendeperson räknas som ett.
    expect(await completeTally(ballotId)).toMatchObject({ status: 'needs_more_trustees', have: 1, need: 2 })
  })

  it('den som redan bidragit får beskedet att bidraget finns, och frasen prövas inte igen', async () => {
    // Ett tidigare bidrag prövas före frasen, så att en omsändning inte låser
    // upp andelen en gång till, och så att en fel fras då inte blir ett
    // gissningsförsök i revisionsloggen.
    await castFor(anna, 'bp-s')
    await closed(electionId)
    expect(await submitPartialDecryption(ballotId, 3, TRUSTEE_PASSPHRASES[2])).toMatchObject({ status: 'accepted' })

    expect(await submitPartialDecryption(ballotId, 3, 'fel fras')).toMatchObject({ status: 'duplicate' })
    expect(await auditEvents(AUDIT_EVENTS.TRUSTEE_PASSPHRASE_REJECTED)).toBe(0)
  })

  it('två samtidiga bidrag från samma förtroendeperson ger ett godkänt och en dubblett', async () => {
    await castFor(anna, 'bp-s')
    await closed(electionId)

    const outcomes = await Promise.all([
      submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1]),
      submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1]),
    ])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['accepted', 'duplicate'])
    expect(await votesDb.partialDecryption.count({ where: { ballotId, trusteeIndex: 2 } })).toBe(3)
  })

  it('en okänd förtroendeperson ger besked', async () => {
    await closed(electionId)
    expect(await submitPartialDecryption(ballotId, 4, TRUSTEE_PASSPHRASES[0])).toMatchObject({
      status: 'unknown_trustee',
    })
  })

  it('en okänd valsedel ger besked', async () => {
    expect(await submitPartialDecryption('00000000-0000-4000-8000-000000000000', 1, TRUSTEE_PASSPHRASES[0])).toEqual({
      status: 'unknown_ballot',
    })
    expect(await completeTally('00000000-0000-4000-8000-000000000000')).toEqual({ status: 'unknown_ballot' })
  })

  // -------------------------------------------------------------------------
  // Bevisen binder bidraget till sin summa och sitt sammanhang
  // -------------------------------------------------------------------------

  it('avvisar ett bidrag vars bevis inte hör till det här chiffret', async () => {
    // REVIEW FOCUS 4. Den andra valsedeln har en röst, så dess summa är en annan.
    await castFor(anna, 'bp-s', counted.second)
    await closeElection(electionId)
    const stolen = await partialFromAnotherBallot()

    expect(await submitRaw(ballotId, stolen)).toMatchObject({ status: 'rejected' })
    expect(await votesDb.partialDecryption.count({ where: { ballotId } })).toBe(0)
  })

  it('avvisar ett bidrag från en annan valsedel, också när summan är densamma (ruling 133)', async () => {
    /**
     * Två valsedlar utan röster har samma summa, ett i båda komponenterna,
     * och därmed samma partiella värde. Bara valsedelns id i utmaningen
     * skiljer bidragen åt. Utan det hade beviset flyttat mellan valsedlarna.
     */
    await closed(emptyElectionId)
    expect(await submitPartialDecryption(empty.second.id, 1, TRUSTEE_PASSPHRASES[0])).toMatchObject({
      status: 'accepted',
    })
    const moved = await storedContribution(empty.second.id, 1)

    expect(await submitRaw(emptyBallotId, moved)).toMatchObject({ status: 'rejected' })
    // Kontrasten: på sin egen valsedel håller samma bidrag.
    await votesDb.partialDecryption.deleteMany({ where: { ballotId: empty.second.id } })
    expect(await submitRaw(empty.second.id, moved)).toMatchObject({ status: 'accepted' })
  })

  it('avvisar ett bidrag där två alternativs bevis bytt plats (ruling 133)', async () => {
    // Alla tre alternativen på en tom valsedel har samma summa. Bara
    // alternativets index i utmaningen skiljer dem åt.
    await closed(emptyElectionId)
    expect(await submitPartialDecryption(empty.second.id, 1, TRUSTEE_PASSPHRASES[0])).toMatchObject({
      status: 'accepted',
    })
    const stored = await storedContribution(empty.second.id, 1)
    await votesDb.partialDecryption.deleteMany({ where: { ballotId: empty.second.id } })

    const swapped = {
      trusteeIndex: 1,
      partials: stored.partials.map((partial) => ({
        ...partial,
        optionIndex: partial.optionIndex === 0 ? 1 : partial.optionIndex === 1 ? 0 : partial.optionIndex,
      })),
    }
    expect(await submitRaw(empty.second.id, swapped)).toMatchObject({ status: 'rejected' })
    expect(await votesDb.partialDecryption.count({ where: { ballotId: empty.second.id } })).toBe(0)
  })

  it('avvisar ett bidrag som saknar ett alternativ eller har ett för mycket', async () => {
    await closed(emptyElectionId)
    await submitPartialDecryption(empty.second.id, 1, TRUSTEE_PASSPHRASES[0])
    const stored = await storedContribution(empty.second.id, 1)
    await votesDb.partialDecryption.deleteMany({ where: { ballotId: empty.second.id } })

    for (const partials of [
      stored.partials.slice(0, 2),
      [...stored.partials, stored.partials[0]!],
      [...stored.partials, { ...stored.partials[0]!, optionIndex: 3 }],
    ]) {
      expect(await submitRaw(empty.second.id, { trusteeIndex: 1, partials })).toMatchObject({ status: 'rejected' })
    }
    expect(await votesDb.partialDecryption.count({ where: { ballotId: empty.second.id } })).toBe(0)
  })

  it('avvisar ett bidrag som en annan förtroendeperson lämnar i sitt namn', async () => {
    await castFor(anna, 'bp-m')
    await closed(electionId)
    await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])
    const first = await storedContribution(ballotId, 1)

    expect(await submitRaw(ballotId, { trusteeIndex: 2, partials: first.partials })).toMatchObject({
      status: 'rejected',
    })
    expect(await votesDb.partialDecryption.count({ where: { ballotId, trusteeIndex: 2 } })).toBe(0)
  })

  it('avvisar ett bidrag vars tal inte går att tolka, utan att kasta', async () => {
    await castFor(anna, 'bp-m')
    await closed(electionId)
    await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])
    const honest = await storedContribution(ballotId, 1)
    await votesDb.partialDecryption.deleteMany({ where: { ballotId } })

    const proofOf = (partial: SubmittedPartial) => partial.proof as Record<string, unknown>
    const variants: Array<(partial: SubmittedPartial) => SubmittedPartial> = [
      (partial) => ({ ...partial, value: 'inte-ett-tal' }),
      (partial) => ({ ...partial, value: `-${String(partial.value)}` }),
      (partial) => ({ ...partial, value: `0${String(partial.value)}` }),
      (partial) => ({ ...partial, value: (P - BigInt(String(partial.value))).toString() }),
      (partial) => ({ ...partial, proof: { ...proofOf(partial), challenge: '-1' } }),
      (partial) => ({ ...partial, proof: { ...proofOf(partial), format: 1 } }),
      (partial) => ({ ...partial, proof: 'inget bevis' }),
    ]

    for (const variant of variants) {
      const partials = honest.partials.map((partial, index) => (index === 1 ? variant(partial) : partial))
      expect(await submitRaw(ballotId, { trusteeIndex: 1, partials })).toMatchObject({ status: 'rejected' })
    }
    expect(await votesDb.partialDecryption.count({ where: { ballotId } })).toBe(0)
    // Kontrasten: det ärliga bidraget godkänns.
    expect(await submitRaw(ballotId, honest)).toMatchObject({ status: 'accepted' })
  })

  // -------------------------------------------------------------------------
  // Spärren: ingenting dekrypteras förrän kopplingen bevisligen är borta
  // -------------------------------------------------------------------------

  it.each(['OPEN', 'CLOSED', 'VALIDATED'] as const)(
    'i fasen %s tas inget bidrag emot, ingenting räknas och andelen låses inte upp',
    async (phase) => {
      /**
       * Spec 6.1: en dekryptering kan inte beställas förrän kopplingen
       * bevisligen är borta. Före STRIPPED ligger kuverten bredvid namnen.
       * Spärren prövas före frasen, så att andelen aldrig låses upp i en fas
       * där den inte får användas: en fel fras ger samma besked som en rätt,
       * och ingen revisionspost om en fel fras.
       */
      await castFor(anna, 'bp-s')
      if (phase !== 'OPEN') await votersDb.election.update({ where: { id: electionId }, data: { phase } })

      for (const passphrase of [TRUSTEE_PASSPHRASES[0], 'fel']) {
        expect(await submitPartialDecryption(ballotId, 1, passphrase)).toMatchObject({
          status: 'wrong_phase',
          phase,
        })
      }
      expect(await completeTally(ballotId)).toMatchObject({ status: 'wrong_phase', phase })
      expect(await auditEvents(AUDIT_EVENTS.TRUSTEE_PASSPHRASE_REJECTED)).toBe(0)
      expect(await votesDb.partialDecryption.count()).toBe(0)
      expect(await votesDb.ballotTally.count()).toBe(0)
    },
  )

  it('ett bidrag som räknats fram utanför servern tas inte heller emot före STRIPPED', async () => {
    await closed(emptyElectionId)
    await submitPartialDecryption(empty.second.id, 1, TRUSTEE_PASSPHRASES[0])
    const contribution = await storedContribution(empty.second.id, 1)
    await votesDb.partialDecryption.deleteMany({ where: { ballotId: empty.second.id } })

    await votersDb.election.update({ where: { id: emptyElectionId }, data: { phase: 'VALIDATED', envelopeRoot: null } })
    expect(await submitRaw(empty.second.id, contribution)).toMatchObject({ status: 'wrong_phase' })
    expect(await votesDb.partialDecryption.count()).toBe(0)
  })

  it('STRIPPED utan kuvertrot räcker inte', async () => {
    // STRIPPED skrivs bara tillsammans med roten. Utan rot har någon skrivit
    // fasen förbi stängningen, och ingen vet om kopplingen är raderad.
    await castFor(anna, 'bp-s')
    await closed(electionId)
    await votersDb.election.update({ where: { id: electionId }, data: { envelopeRoot: null } })

    expect(await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])).toMatchObject({
      status: 'wrong_phase',
      phase: 'STRIPPED',
    })
    expect(await completeTally(ballotId)).toMatchObject({ status: 'wrong_phase', phase: 'STRIPPED' })
    expect(await votesDb.partialDecryption.count()).toBe(0)
  })

  it('STRIPPED med ett kuvert kvar i röstlängden räcker inte', async () => {
    const lying = await castFor(anna, 'bp-s')
    await closed(electionId)
    // Ett kuvert bredvid ett namn, skrivet förbi stängningen efter skalningen.
    await votersDb.pendingVote.create({
      data: {
        voterStatusId: kim,
        ballotId,
        ciphertext: lying.ciphertext,
        proofs: lying.proofs,
        ciphertextHash: lying.ciphertextHash,
        castSequence: 1,
        bankIdSignature: 'x',
        bankIdCertificateChain: 'x',
        updatedAt: new Date(),
      },
    })

    expect(await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])).toMatchObject({
      status: 'wrong_phase',
      phase: 'STRIPPED',
    })
    expect(await completeTally(ballotId)).toMatchObject({ status: 'wrong_phase', phase: 'STRIPPED' })
    expect(await votesDb.partialDecryption.count()).toBe(0)
  })

  // -------------------------------------------------------------------------
  // TALLIED
  // -------------------------------------------------------------------------

  it('TALLIED skrivs när den sista valsedeln är räknad, och inte före', async () => {
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m', counted.second)
    await closed(electionId)

    for (const ballot of [counted.first.id, counted.second.id]) {
      await submitPartialDecryption(ballot, 1, TRUSTEE_PASSPHRASES[0])
      await submitPartialDecryption(ballot, 3, TRUSTEE_PASSPHRASES[2])
    }

    expect(await completeTally(counted.first.id)).toMatchObject({ status: 'tallied', phase: 'STRIPPED' })
    expect(await phaseOf(electionId)).toBe('STRIPPED')
    expect((await votesDb.election.findUniqueOrThrow({ where: { id: electionId } })).tallyCompletedAt).toBeNull()

    expect(await completeTally(counted.second.id)).toMatchObject({
      status: 'tallied',
      counts: [0, 0, 1],
      phase: 'TALLIED',
    })
    expect(await phaseOf(electionId)).toBe('TALLIED')

    // Tidpunkten i röstdatabasen är grovkornig, en hel timme.
    const completedAt = (await votesDb.election.findUniqueOrThrow({ where: { id: electionId } })).tallyCompletedAt
    expect(completedAt).not.toBeNull()
    expect(completedAt!.getUTCMinutes()).toBe(0)
    expect(completedAt!.getUTCSeconds()).toBe(0)

    // Efter TALLIED tas inga fler bidrag emot och ingenting räknas om.
    expect(await submitPartialDecryption(counted.first.id, 2, TRUSTEE_PASSPHRASES[1])).toMatchObject({
      status: 'wrong_phase',
      phase: 'TALLIED',
    })
    expect(await completeTally(counted.first.id)).toMatchObject({ status: 'wrong_phase', phase: 'TALLIED' })
  })

  it('en omräkning av en redan räknad valsedel ger samma resultat och inga nya rader', async () => {
    await castFor(anna, 'bp-s')
    await closed(electionId)
    await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])
    await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1])

    expect(await completeTally(ballotId)).toMatchObject({ status: 'tallied', counts: [0, 1, 0] })
    expect(await completeTally(ballotId)).toMatchObject({ status: 'tallied', counts: [0, 1, 0] })
    expect(await votesDb.ballotTally.count({ where: { ballotId } })).toBe(3)
  })

  it('två samtidiga räkningar ger ett resultat och en fas', async () => {
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')
    await closed(electionId)
    await bothBallotsContributed()
    expect(await completeTally(counted.second.id)).toMatchObject({ status: 'tallied', phase: 'STRIPPED' })

    const outcomes = await Promise.all([completeTally(ballotId), completeTally(ballotId), completeTally(ballotId)])
    for (const outcome of outcomes) expect(outcome).toMatchObject({ status: 'tallied', counts: [0, 1, 1] })
    expect(await votesDb.ballotTally.count({ where: { ballotId } })).toBe(3)
    expect(await phaseOf(electionId)).toBe('TALLIED')
    expect(await auditEvents(AUDIT_EVENTS.ELECTION_TALLIED)).toBe(1)
  })

  it.each(['OPEN', 'CERTIFIED'] as const)(
    'TALLIED skrivs med jämför-och-sätt: en fas som skrivits till %s under räkningen står kvar',
    async (phase) => {
      /**
       * Fasen ändras efter spärren och före övergången, som när någon skriver
       * i röstlängden mitt i räkningen. Övergången till TALLIED får bara ske
       * från STRIPPED, så att ingen fas går baklänges eller hoppar.
       */
      await castFor(anna, 'bp-s')
      await closed(electionId)
      await bothBallotsContributed()
      expect(await completeTally(counted.second.id)).toMatchObject({ status: 'tallied', phase: 'STRIPPED' })

      shapeHook.once = async () => {
        await votersDb.election.update({ where: { id: electionId }, data: { phase } })
      }

      if (phase === 'CERTIFIED') {
        // Framåt, med roten skriven: räkneverken är sparade och fasen står kvar.
        expect(await completeTally(ballotId)).toMatchObject({ status: 'tallied', phase: 'CERTIFIED' })
      } else {
        await expect(completeTally(ballotId)).rejects.toThrow(TallyAbortedError)
      }
      expect(await phaseOf(electionId)).toBe(phase)
    },
  )

  // -------------------------------------------------------------------------
  // Ett felaktigt röstetal blir aldrig tyst
  // -------------------------------------------------------------------------

  /** Byter talen i urnans första rad för valsedeln och returnerar dess chifferhash. */
  async function tamperUrn(ballot: string, change: (pairs: UrnPairs) => unknown): Promise<string> {
    const row = await votesDb.encryptedVote.findFirstOrThrow({ where: { ballotId: ballot }, orderBy: { id: 'asc' } })
    const pairs = row.ciphertext as UrnPairs
    await votesDb.encryptedVote.update({
      where: { id: row.id },
      data: { ciphertext: change(pairs.map((pair) => ({ ...pair }))) as never },
    })
    return row.ciphertextHash
  }

  /** En rad i urnan som krypterar `messages`, med giltiga gruppelement men utan bevis. */
  async function forgeUrnRow(ballot: string, messages: bigint[]): Promise<string> {
    const ciphertext = messages.map((message) => {
      const pair = encrypt(BigInt(counted.publicKey), message, randomScalar())
      return { c1: pair.c1.toString(), c2: pair.c2.toString() }
    })
    const ciphertextHash = hashCiphertext(ciphertext)
    await votesDb.encryptedVote.create({
      data: {
        id: urnIdFor(ciphertextHash, ballot, 0),
        ballotId: ballot,
        ciphertext,
        proofs: { format: 2, components: [], sum: {} },
        ciphertextHash,
      },
    })
    return ciphertextHash
  }

  it('ett chiffer utanför undergruppen i urnan stoppar räkningen med ett besked som pekar ut raden', async () => {
    await castFor(anna, 'bp-s')
    await closed(electionId)
    // −4 ligger i [1, p) men inte i undergruppen, eftersom −1 inte är en kvadrat.
    const hash = await tamperUrn(ballotId, (pairs) => {
      pairs[0]!.c1 = (P - 4n).toString()
      return pairs
    })

    await expect(submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])).rejects.toThrow(TallyAbortedError)
    await expect(submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])).rejects.toThrow(hash)
    await expect(aggregate(ballotId)).rejects.toThrow(hash)
    expect(await votesDb.partialDecryption.count()).toBe(0)
  })

  it('en rad i urnan som ändrats efter bidragen stoppar räkningen', async () => {
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')
    await closed(electionId)
    await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])
    await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1])

    // En rad byter ett chiffer: summan blir en annan, och bidragen hör inte längre till den.
    await tamperUrn(ballotId, (pairs) => {
      pairs[1]!.c2 = ((BigInt(String(pairs[1]!.c2)) * G) % P).toString()
      return pairs
    })

    await expect(completeTally(ballotId)).rejects.toThrow(TallyAbortedError)
    expect(await votesDb.ballotTally.count()).toBe(0)
  })

  it.each([
    [
      'ett tal som inte är ett tal',
      (pairs: UrnPairs) => {
        pairs[0]!.c1 = 'inte-ett-tal'
        return pairs
      },
    ],
    [
      'ett negativt tal',
      (pairs: UrnPairs) => {
        pairs[0]!.c2 = '-5'
        return pairs
      },
    ],
    [
      'en inledande nolla',
      (pairs: UrnPairs) => {
        pairs[0]!.c1 = `0${String(pairs[0]!.c1)}`
        return pairs
      },
    ],
    [
      'ett tal längre än p',
      (pairs: UrnPairs) => {
        pairs[0]!.c1 = '9'.repeat(700)
        return pairs
      },
    ],
    [
      'talet ett',
      (pairs: UrnPairs) => {
        pairs[2]!.c1 = '1'
        return pairs
      },
    ],
    ['ett alternativ för lite', (pairs: UrnPairs) => pairs.slice(0, 2)],
    ['inget chiffer alls', () => null],
  ])('%s i urnan ger ett besked, inte en krasch eller ett tal', async (_label, change) => {
    await castFor(anna, 'bp-s')
    await closed(electionId)
    const hash = await tamperUrn(ballotId, change)

    await expect(submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])).rejects.toThrow(
      new RegExp(`Räkningen avbröts[\\s\\S]*${hash}`),
    )
    expect(await votesDb.partialDecryption.count()).toBe(0)
  })

  it('ett manipulerat bidrag i databasen stoppar räkningen och pekar ut vems', async () => {
    await castFor(anna, 'bp-s')
    await closed(electionId)
    await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])
    await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1])

    const row = await votesDb.partialDecryption.findFirstOrThrow({ where: { ballotId, trusteeIndex: 2, optionIndex: 1 } })
    await votesDb.partialDecryption.update({
      where: { id: row.id },
      data: { value: ((BigInt(row.value) * G) % P).toString() },
    })

    await expect(completeTally(ballotId)).rejects.toThrow(/förtroendeperson 2[\s\S]*alternativ 1/)
    expect(await votesDb.ballotTally.count()).toBe(0)
  })

  it('ett bevis med en negativ utmaning i databasen stoppar räkningen', async () => {
    await castFor(anna, 'bp-s')
    await closed(electionId)
    await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])
    await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1])

    const row = await votesDb.partialDecryption.findFirstOrThrow({ where: { ballotId, trusteeIndex: 1, optionIndex: 0 } })
    await votesDb.partialDecryption.update({
      where: { id: row.id },
      data: { proof: { ...(row.proof as Record<string, unknown>), challenge: '-1' } },
    })

    await expect(completeTally(ballotId)).rejects.toThrow(/förtroendeperson 1[\s\S]*alternativ 0/)
  })

  it('ett bidrag som saknar ett alternativ i databasen stoppar räkningen', async () => {
    await castFor(anna, 'bp-s')
    await closed(electionId)
    await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])
    await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1])
    await votesDb.partialDecryption.deleteMany({ where: { ballotId, trusteeIndex: 2, optionIndex: 2 } })

    await expect(completeTally(ballotId)).rejects.toThrow(/förtroendeperson 2/)
  })

  it('en manipulerad publik andel stoppar både bidraget och räkningen', async () => {
    await castFor(anna, 'bp-s')
    await closed(electionId)
    await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])
    await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1])

    for (const publicShare of ['1', (P - 4n).toString(), 'inte-ett-tal']) {
      await votesDb.trusteeShare.update({
        where: { electionId_trusteeIndex: { electionId, trusteeIndex: 2 } },
        data: { publicShare },
      })
      // Andelen pekas ut av sin egen kontroll, innan något prövas mot den.
      await expect(completeTally(ballotId)).rejects.toThrow(/förtroendeperson 2:s publika andel/)
      await expect(submitPartialDecryption(counted.second.id, 2, TRUSTEE_PASSPHRASES[1])).rejects.toThrow(
        /förtroendeperson 2:s publika andel/,
      )
    }
    expect(await votesDb.ballotTally.count()).toBe(0)
  })

  it('en andel som inte hör till sin publika andel stoppar bidraget', async () => {
    // Förtroendeperson 1 får förtroendeperson 2:s publika andel i databasen.
    // Frasen öppnar andelen, men andelen stämmer inte med det den prövas mot.
    await castFor(anna, 'bp-s')
    await closed(electionId)
    const two = await votesDb.trusteeShare.findUniqueOrThrow({
      where: { electionId_trusteeIndex: { electionId, trusteeIndex: 2 } },
    })
    await votesDb.trusteeShare.update({
      where: { electionId_trusteeIndex: { electionId, trusteeIndex: 1 } },
      data: { publicShare: two.publicShare },
    })

    await expect(submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])).rejects.toThrow(/förtroendeperson 1/)
    expect(await votesDb.partialDecryption.count()).toBe(0)
  })

  it('taket för den diskreta logaritmen är antalet rader i urnan', async () => {
    /**
     * Inget alternativ kan få fler röster än urnan har rader. En rad som
     * skrivits förbi stängningen och krypterar fem röster på S ger en summa
     * utanför [0, 2], och räkningen avbryts vid den i stället för att söka
     * vidare upp till antalet röstberättigade.
     */
    await castFor(anna, 'bp-s')
    await closed(electionId)
    await forgeUrnRow(ballotId, [0n, 5n, 0n])
    await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])
    await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1])

    await expect(completeTally(ballotId)).rejects.toThrow(/alternativ 1[\s\S]*\[0, 2\]/)
    expect(await votesDb.ballotTally.count()).toBe(0)
  })

  it.each([
    ['två ettor', [1n, 1n, 0n]],
    ['bara nollor', [0n, 0n, 0n]],
  ])(
    'summan av räkneverken måste vara antalet rader i urnan: en rad med %s stoppar räkningen',
    async (_label, messages) => {
      // Varje röst kodar exakt ett alternativ, också blankt. Summan av
      // räkneverken är därför antalet rader, och allt annat är ett fel.
      await castFor(anna, 'bp-s')
      await closed(electionId)
      await forgeUrnRow(ballotId, messages)
      await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])
      await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1])

      await expect(completeTally(ballotId)).rejects.toThrow(/summan av räkneverken/i)
      expect(await votesDb.ballotTally.count()).toBe(0)
    },
  )

  it('ett sparat resultat som inte stämmer med urnan stoppar en omräkning', async () => {
    await castFor(anna, 'bp-s')
    await closed(electionId)
    await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])
    await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1])
    expect(await completeTally(ballotId)).toMatchObject({ status: 'tallied', counts: [0, 1, 0] })

    await votesDb.ballotTally.updateMany({ where: { ballotId, optionIndex: 1 }, data: { count: 7 } })
    await expect(completeTally(ballotId)).rejects.toThrow(TallyAbortedError)
  })

  it('räkneverk som bytt plats, med samma summa, stoppar en omräkning', async () => {
    // Summan av räkneverken stämmer fortfarande med urnan. Bara en omräkning ur
    // urnan och bidragen visar att de inte är valsedelns.
    await castFor(anna, 'bp-s')
    await closed(electionId)
    await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])
    await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1])
    expect(await completeTally(ballotId)).toMatchObject({ status: 'tallied', counts: [0, 1, 0] })

    await votesDb.ballotTally.updateMany({ where: { ballotId, optionIndex: 1 }, data: { count: 0 } })
    await votesDb.ballotTally.updateMany({ where: { ballotId, optionIndex: 2 }, data: { count: 1 } })
    await expect(completeTally(ballotId)).rejects.toThrow(/stämmer inte med en omräkning/)
  })

  it('en räknad valsedel vars bidrag tagits bort går inte att räkna om', async () => {
    await castFor(anna, 'bp-s')
    await closed(electionId)
    await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])
    await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1])
    expect(await completeTally(ballotId)).toMatchObject({ status: 'tallied', counts: [0, 1, 0] })

    await votesDb.partialDecryption.deleteMany({ where: { ballotId, trusteeIndex: 2 } })
    await expect(completeTally(ballotId)).rejects.toThrow(/bidragen de räknades ur/)
  })

  // -------------------------------------------------------------------------
  // Valhemligheten
  // -------------------------------------------------------------------------

  it('ingen enskild röst finns dekrypterad någonstans efteråt', async () => {
    // Det som gör valhemligheten strukturell och inte en rutin.
    await castFor(anna, 'bp-s')
    await closeElection(electionId)
    await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0]!)
    await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1]!)
    await completeTally(ballotId)

    const votes = await votesDb.encryptedVote.findMany()
    for (const vote of votes) {
      expect(JSON.stringify(vote)).not.toMatch(/"plaintext"|"choice"|"optionIndex"/)
    }

    // Ingenting sparas per röst: bidragen och räkneverken har en rad per
    // alternativ, och ingen av dem nämner en rad i urnan.
    expect(await votesDb.partialDecryption.count({ where: { ballotId } })).toBe(2 * 3)
    expect(await votesDb.ballotTally.count({ where: { ballotId } })).toBe(3)
    const urnIds = votes.map((vote) => vote.id)
    for (const row of [...(await votesDb.partialDecryption.findMany()), ...(await votesDb.ballotTally.findMany())]) {
      for (const id of urnIds) expect(JSON.stringify(row)).not.toContain(id)
    }

    // Lösenfraserna finns ingenstans i någon av databaserna.
    const everything = JSON.stringify([
      await votesDb.trusteeShare.findMany(),
      await votesDb.partialDecryption.findMany(),
      await votesDb.ballotTally.findMany(),
      await votersDb.auditEvent.findMany(),
    ])
    for (const phrase of TRUSTEE_PASSPHRASES) expect(everything).not.toContain(phrase)
  })

  // -------------------------------------------------------------------------
  // Rutterna
  // -------------------------------------------------------------------------

  describe('rutterna', () => {
    async function loginAdmin(): Promise<void> {
      const admin = await createVoter(ADMIN_PN, { isAdmin: true })
      const session = await createAdminSession(admin)
      cookieJar.admin = session.id
      csrfSecret = session.csrfSecret
    }

    function post(
      handler: (request: Request) => Promise<Response>,
      path: string,
      body: unknown,
      headers?: Record<string, string>,
    ): Promise<Response> {
      return handler(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: ORIGIN,
            ...(headers ?? { 'x-csrf-token': csrfSecret }),
          },
          body: JSON.stringify(body),
        }),
      )
    }

    const decrypt = (body: unknown, headers?: Record<string, string>) =>
      post(decryptRoute, '/api/admin/elections/decrypt', body, headers)
    const tally = (body: unknown, headers?: Record<string, string>) =>
      post(tallyRoute, '/api/admin/elections/tally', body, headers)

    it('kräver inloggning, CSRF-token och egen origin', async () => {
      await closed(electionId)
      const body = { ballotId, trusteeIndex: 1, passphrase: TRUSTEE_PASSPHRASES[0] }

      expect((await decrypt(body, {})).status).toBe(401)
      expect((await tally({ ballotId }, {})).status).toBe(401)

      await loginAdmin()
      expect((await decrypt(body, { 'x-csrf-token': 'fel' })).status).toBe(403)
      expect((await tally({ ballotId }, { 'x-csrf-token': 'fel' })).status).toBe(403)
      expect((await decrypt(body, { 'x-csrf-token': csrfSecret, origin: 'https://angripare.example' })).status).toBe(
        403,
      )
      expect(await votesDb.partialDecryption.count()).toBe(0)
    })

    it('tar emot två fraser och räknar, och svaren säger vad som hände', async () => {
      await castFor(anna, 'bp-m')
      await castFor(kim, 'bp-m')
      await closed(electionId)
      await loginAdmin()

      const wrong = await decrypt({ ballotId, trusteeIndex: 1, passphrase: 'fel fras' })
      expect(wrong.status).toBe(403)
      expect(await wrong.json()).toMatchObject({ status: 'wrong_passphrase' })

      const early = await tally({ ballotId })
      expect(early.status).toBe(409)
      expect(await early.json()).toMatchObject({ status: 'needs_more_trustees', have: 0, need: 2 })

      const first = await decrypt({ ballotId, trusteeIndex: 1, passphrase: TRUSTEE_PASSPHRASES[0] })
      expect(first.status).toBe(200)
      const firstBody = await first.json()
      expect(firstBody).toMatchObject({ status: 'accepted' })

      const again = await decrypt({ ballotId, trusteeIndex: 1, passphrase: TRUSTEE_PASSPHRASES[0] })
      expect(again.status).toBe(409)
      expect(await again.json()).toMatchObject({ status: 'duplicate' })

      const second = await decrypt({ ballotId, trusteeIndex: 3, passphrase: TRUSTEE_PASSPHRASES[2] })
      expect(second.status).toBe(200)

      const result = await tally({ ballotId })
      expect(result.status).toBe(200)
      const resultBody = await result.json()
      expect(resultBody).toMatchObject({ status: 'tallied', counts: [0, 0, 2], votes: 2, phase: 'STRIPPED' })

      // Frasen lämnar aldrig servern igen.
      for (const text of [JSON.stringify(firstBody), JSON.stringify(resultBody)]) {
        for (const phrase of TRUSTEE_PASSPHRASES) expect(text).not.toContain(phrase)
      }
    })

    it('svarar med fasen när kopplingen inte är raderad, och med 404 för en okänd valsedel', async () => {
      await loginAdmin()

      const early = await decrypt({ ballotId, trusteeIndex: 1, passphrase: TRUSTEE_PASSPHRASES[0] })
      expect(early.status).toBe(409)
      expect(await early.json()).toMatchObject({ status: 'wrong_phase', phase: 'OPEN' })

      const unknown = await decrypt({
        ballotId: '00000000-0000-4000-8000-000000000000',
        trusteeIndex: 1,
        passphrase: TRUSTEE_PASSPHRASES[0],
      })
      expect(unknown.status).toBe(404)

      const invalid = await decrypt({ ballotId, trusteeIndex: 4, passphrase: TRUSTEE_PASSPHRASES[0] })
      expect(invalid.status).toBe(400)
    })

    it('ett avbrott ger ett besked med 409, inte en naken 500', async () => {
      await castFor(anna, 'bp-s')
      await closed(electionId)
      await loginAdmin()
      await tamperUrn(ballotId, (pairs) => {
        pairs[0]!.c1 = 'inte-ett-tal'
        return pairs
      })

      const response = await decrypt({ ballotId, trusteeIndex: 1, passphrase: TRUSTEE_PASSPHRASES[0] })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        status: 'aborted',
        message: expect.stringMatching(/Räkningen avbröts/),
      })
    })

    it('hastighetsgränsen gäller per förtroendeperson, inte per adress', async () => {
      // Ruling 64. Den som gissar en förtroendepersons fras får inte fler
      // försök genom att byta adress, och en annan förtroendeperson påverkas inte.
      await closed(electionId)
      await loginAdmin()

      const statuses: number[] = []
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await decrypt(
          { ballotId, trusteeIndex: 1, passphrase: `fel-${attempt}` },
          { 'x-csrf-token': csrfSecret, 'x-forwarded-for': `10.0.0.${attempt}` },
        )
        statuses.push(response.status)
      }
      expect(statuses).toContain(429)
      expect(statuses.filter((status) => status === 403).length).toBeLessThanOrEqual(10)

      const other = await decrypt({ ballotId, trusteeIndex: 2, passphrase: TRUSTEE_PASSPHRASES[1] })
      expect(other.status).toBe(200)
    })
  })
})
