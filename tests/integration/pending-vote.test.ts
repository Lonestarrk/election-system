import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import { canonicalOptions, type BallotOption } from '@/lib/crypto/ballot-encoding'
import { encryptBallot } from '@/lib/encrypt-client'
import { P } from '@/lib/crypto/group'
import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { castEncryptedBallotSchema } from '@/lib/validation'
import {
  MockBankIdService,
  selectDemoIdentity,
} from '@/modules/eligibility/bankid/MockBankIdService'
import { envelopePayload } from '@/modules/eligibility/bankid/envelope-signature'
import {
  castEncryptedBallot,
  clearPendingVotes,
  nextCastSequence,
  pendingVoteFor,
  type CastOutcome,
  type SignedEnvelope,
} from '@/modules/eligibility/pending-vote.service'
import { createVoter, disconnect, isDatabaseAvailable, resetElectionData } from './helpers'

/**
 * Uppgift 9: väljaren kan lägga och ändra sin röst fram till stängning.
 *
 * Det här är kärnan i hela modellen mot röstköp — se
 * docs/spec/2026-09-22-dubbla-kuvert.md avsnitt 9. En andra röst ERSÄTTER
 * den första i stället för att läggas till, så att en köpare aldrig kan lita
 * på ett kuvert han bevittnat tidigare under röstningen.
 */

const databaseAvailable = await isDatabaseAvailable()

if (!databaseAvailable) {
  process.stderr.write('\n  Ingen databas tillgänglig — integrationstesterna hoppas över.\n')
}

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

describe.skipIf(!databaseAvailable)('rösten kan läggas och ändras fram till stängning', () => {
  const VOTER_PN = '199001011234'
  const KIM_PN = '198505152345'

  let electionId: string
  let ballotId: string
  let publicKey: string
  let options: BallotOption[]
  let bpS: string
  let bpM: string
  let voter: string
  let kim: string

  /** Vilket personnummer en testväljares voterStatusId hör till — för `signAs`. */
  const personalNumberByVoter = new Map<string, string>()

  async function createSignedVoter(personalNumber: string): Promise<string> {
    const id = await createVoter(personalNumber)
    personalNumberByVoter.set(id, personalNumber)
    return id
  }

  beforeEach(async () => {
    await resetElectionData()

    // Partiregistret är delad referensdata och tas inte bort av
    // resetElectionData — S och M seedas där redan, se helpers.ts.
    const s = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'S' } })
    const m = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'M' } })

    const outcome = await createElection({
      name: 'Kuverttest',
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
    voter = await createSignedVoter(VOTER_PN)
    kim = await createSignedVoter(KIM_PN)
  })

  function ballotPartyIdFor(party: 'bp-s' | 'bp-m'): string {
    return party === 'bp-s' ? bpS : bpM
  }

  /** Krypterar ett val precis som klienten skulle gjort det i webbläsaren. */
  async function buildBallot(party: 'bp-s' | 'bp-m'): Promise<EncryptedBallot> {
    return encryptBallot(publicKey, electionId, ballotId, options, {
      kind: 'PARTY',
      ballotPartyId: ballotPartyIdFor(party),
    })
  }

  /**
   * Simulerar BankID /sign åt en av testets kända väljare — samma flöde som
   * `/api/vote/sign-start` startar och `/api/vote/encrypted` hämtar svaret
   * från, fast utan HTTP-lagret.
   */
  async function signAs(
    voterStatusId: string,
    ballot: EncryptedBallot,
    castSequence: number,
  ): Promise<SignedEnvelope> {
    const personalNumber = personalNumberByVoter.get(voterStatusId)
    if (!personalNumber) throw new Error('Okänd testväljare.')

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
    // Motsvarar att väljaren skannar QR-koden med sin BankID-app.
    selectDemoIdentity(order.orderRef, personalNumber)

    let result = await service.collect(order.orderRef)
    while (result.status === 'pending') result = await service.collect(order.orderRef)
    if (result.status !== 'complete') throw new Error('Signeringen blev inte klar.')

    return {
      signature: result.completionData.signature,
      certificate: result.completionData.certificate,
      castSequence,
    }
  }

  /**
   * Anropar `castEncryptedBallot` direkt, med formen hämtad precis som rutten
   * skulle gjort det. En egen, dold envelop-standard används när testet inte
   * bryr sig om signaturen — bevis- och stängningskontrollerna körs före
   * signaturkontrollen, så de testerna når den aldrig.
   */
  async function castRaw(
    voterStatusId: string,
    ballot: EncryptedBallot,
    envelope: SignedEnvelope = { signature: '', certificate: '', castSequence: 1 },
  ): Promise<CastOutcome> {
    const shape = await getEncryptedBallotShape(ballotId)
    return castEncryptedBallot(voterStatusId, electionId, ballotId, ballot, envelope, shape)
  }

  /** Bygger (vid behov) och lägger en röst, med en ärligt signerad räknare. */
  async function cast(
    voterStatusId: string,
    ballotOrParty: EncryptedBallot | 'bp-s' | 'bp-m',
    envelope?: SignedEnvelope,
  ): Promise<CastOutcome> {
    const ballot =
      typeof ballotOrParty === 'string' ? await buildBallot(ballotOrParty) : ballotOrParty
    const signed =
      envelope ??
      (await signAs(voterStatusId, ballot, await nextCastSequence(voterStatusId, ballotId)))
    return castRaw(voterStatusId, ballot, signed)
  }

  /**
   * Testhjälpare som simulerar stängning genom att flytta `closesAt` bakåt.
   *
   * Den riktiga stängningsrutinen (`closeElection`) byggs av uppgift 11 och
   * finns inte ännu. Det som prövas här är bara `castEncryptedBallot`s EGEN
   * kontroll av att omröstningen fortfarande är öppen.
   */
  async function closeElection(id: string): Promise<void> {
    await votersDb.election.update({
      where: { id },
      data: { closesAt: new Date(Date.now() - 1000) },
    })
  }

  it('en röstberättigad väljare kan lägga sin röst', async () => {
    const outcome = await cast(voter, 'bp-s')

    expect(outcome.status).toBe('recorded')
    if (outcome.status !== 'recorded') return
    expect(outcome.replaced).toBe(false)

    const stored = await pendingVoteFor(voter, ballotId)
    expect(stored?.ciphertextHash).toBe(outcome.ciphertextHash)
  })

  it('en andra röst ersätter den första i stället för att läggas till', async () => {
    // Hela poängen med modellen. Två liggande röster vore två röster i räkningen.
    const first = await cast(voter, 'bp-s')
    const second = await cast(voter, 'bp-m')

    expect(first.status).toBe('recorded')
    expect(second.status).toBe('recorded')
    expect((second as { replaced: boolean }).replaced).toBe(true)
    expect(await votersDb.pendingVote.count({ where: { voterStatusId: voter } })).toBe(1)
  })

  it('en röst efter stängning avvisas', async () => {
    /**
     * Accepteras rösten efter skalningen hamnar den aldrig i räkningen, och
     * väljaren tror att hon röstat. Tyst förlust är värre än ett
     * felmeddelande.
     */
    await closeElection(electionId)

    expect((await cast(voter, 'bp-s')).status).toBe('closed')
  })

  it('en valsedel med manipulerat bevis avvisas', async () => {
    const ballot = await buildBallot('bp-s')
    // Fälten på tråden är decimalsträngar (se EncryptedBallot), inte bigint —
    // ändringen görs därför via en om- och återkonvertering.
    ballot.proofs.components[0]!.response0 = (
      BigInt(ballot.proofs.components[0]!.response0) + 1n
    ).toString()

    expect((await castRaw(voter, ballot)).status).toBe('invalid_proof')
  })

  it('ett chiffer utanför undergruppen avvisas', async () => {
    // REVIEW FOCUS 1. Ett element utanför undergruppen läcker en bit av
    // tröskelnyckeln vid varje partiell dekryptering.
    const ballot = await buildBallot('bp-s')
    ballot.ciphertext[0]!.c1 = (P - 1n).toString()

    expect((await castRaw(voter, ballot)).status).toBe('invalid_proof')
  })

  it('en röst signerad av någon annan avvisas', async () => {
    // REVIEW FOCUS 7. Raden pekar på en verklig, röstberättigad väljare och
    // passerar varje relationell kontroll — bara signaturen avslöjar den.
    const ballot = await buildBallot('bp-s')
    const envelope = await signAs(kim, ballot, 1)

    expect((await castRaw(voter, ballot, envelope)).status).toBe('invalid_signature')
  })

  it('ett återuppspelat äldre kuvert avvisas', async () => {
    // REVIEW FOCUS 8. Utan detta överlever ett röstköp hela ändringsmöjligheten.
    const first = await buildBallot('bp-s')
    await cast(voter, first, await signAs(voter, first, 1))
    const second = await buildBallot('bp-m')
    await cast(voter, second, await signAs(voter, second, 2))

    expect((await castRaw(voter, first, await signAs(voter, first, 1))).status).toBe(
      'stale_sequence',
    )
  })

  it('ändring ger en ny verifikationskod', async () => {
    const first = await cast(voter, 'bp-s')
    const second = await cast(voter, 'bp-m')

    expect((second as { ciphertextHash: string }).ciphertextHash).not.toBe(
      (first as { ciphertextHash: string }).ciphertextHash,
    )
  })

  it('en signatur som klienten skickar med i kroppen ignoreras', async () => {
    /**
     * Utan detta kan vem som helst skapa ett eget nyckelpar, formatera ett
     * certifikat med valfritt personnummer, och signera vad som helst.
     * Servern hämtar därför signaturen från BankID och aldrig från begäran.
     *
     * /api/vote/encrypted kräver en riktig Next.js-begäranskontext
     * (next/headers) som Vitests Node-miljö inte tillhandahåller — samma skäl
     * till att ingen annan rutt i det här systemet anropas direkt i den här
     * svtien (HTTP-nivån täcks av tests/e2e). Egenskapen prövas därför på två
     * nivåer i stället:
     *
     *  1. Zod stryper okända fält som standard — så även om en klient skickar
     *     med `signature`, `certificate` och `castSequence` försvinner de vid
     *     valideringen, innan rutten någonsin ser dem.
     *  2. Ruttens källkod läser dem aldrig ur `body.data` ens om de funnes —
     *     signaturen och certifikatet kommer bara från BankID:s eget svar.
     */
    const forgedBody = {
      ballotId,
      orderRef: '00000000-0000-0000-0000-000000000000',
      ballot: await buildBallot('bp-s'),
      signature: 'förfalskad-signatur',
      certificate: 'förfalskat-certifikat',
      castSequence: 99,
    }

    const parsed = castEncryptedBallotSchema.parse(forgedBody)
    expect(parsed).not.toHaveProperty('signature')
    expect(parsed).not.toHaveProperty('certificate')
    expect(parsed).not.toHaveProperty('castSequence')

    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const routeSource = readFileSync(
      join(process.cwd(), 'src/app/api/vote/encrypted/route.ts'),
      'utf8',
    )

    expect(routeSource).not.toMatch(/body\.data\.(signature|certificate|castSequence)/)
    expect(routeSource).toMatch(/collected\.completionData\.signature/)
    expect(routeSource).toMatch(/collected\.completionData\.certificate/)
  })

  it('pendingVoteFor visar ingenting för en väljare utan liggande röst', async () => {
    expect(await pendingVoteFor(voter, ballotId)).toBeNull()
  })

  it('clearPendingVotes raderar kuverten och returnerar antalet', async () => {
    await cast(voter, 'bp-s')
    await cast(kim, 'bp-m')

    const cleared = await clearPendingVotes(electionId)

    expect(cleared).toBe(2)
    expect(await votersDb.pendingVote.count()).toBe(0)
  })
})
