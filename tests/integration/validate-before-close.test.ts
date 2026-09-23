import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Prisma } from '.prisma/voters'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import { validateBeforeClose } from '@/orchestration/validate-before-close.usecase'
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
  type SignedEnvelope,
} from '@/modules/eligibility/pending-vote.service'
import { createVoter, disconnect, isDatabaseAvailable, resetElectionData } from './helpers'

/**
 * Uppgift 10: valideringen som körs medan `PendingVote` fortfarande pekar på
 * en väljare — se docs/spec/2026-09-22-dubbla-kuvert.md avsnitt 7.
 *
 * Testerna bygger de fyra avvikelserna precis som de skulle uppstå: en rad
 * skriven direkt i databasen (`stuffVoteFor`, `replayEnvelope`) eller en helt
 * ärlig röstläggning mot fel valsedel (`forceBallotFor`, eftersom ingenting i
 * `castEncryptedBallot` självt kontrollerar väljarens folkbokföring — den
 * kontrollen finns bara här).
 */

const databaseAvailable = await isDatabaseAvailable()

if (!databaseAvailable) {
  process.stderr.write('\n  Ingen databas tillgänglig — integrationstesterna hoppas över.\n')
}

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

describe.skipIf(!databaseAvailable)('validering medan kopplingen finns kvar', () => {
  const ANNA_PN = '199001011234'
  const KIM_PN = '198505152345'
  const GUNVOR_PN = '194512019876'

  const FALUN = '2080'
  const STOCKHOLM = '0180'

  let electionId: string
  let ballotId: string
  let kommunBallotId: string
  let kommunPartyId: string
  let publicKey: string
  let options: BallotOption[]
  let bpS: string
  let bpM: string

  let anna: string
  let kim: string
  let gunvor: string

  /** Vilket personnummer en testväljares voterStatusId hör till — för `signAs`. */
  const personalNumberByVoter = new Map<string, string>()

  async function createSignedVoter(
    personalNumber: string,
    voterOptions: { municipalityCode?: string } = {},
  ): Promise<string> {
    const id = await createVoter(personalNumber, voterOptions)
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
      name: 'Valideringstest',
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
        {
          // Bara här för WRONG_BALLOT-testet: en kommunvalsedel som gäller
          // Stockholm, alltså inte Gunvor, som är folkbokförd i Falun.
          kind: 'KOMMUN',
          label: 'Stockholms kommunfullmäktige',
          areaCode: STOCKHOLM,
          allowsCandidateVote: false,
          parties: [{ partyId: s.id }],
        },
      ],
      trusteePassphrases: ['test-fras-ett', 'test-fras-tva', 'test-fras-tre'],
    })
    if (outcome.status !== 'created') throw new Error('Kunde inte skapa testomröstningen.')

    electionId = outcome.election.id
    ballotId = outcome.election.ballotIds[0]!.id
    kommunBallotId = outcome.election.ballotIds[1]!.id

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

    kommunPartyId = (
      await votesDb.ballotParty.findFirstOrThrow({ where: { ballotId: kommunBallotId } })
    ).id

    personalNumberByVoter.clear()
    anna = await createSignedVoter(ANNA_PN)
    kim = await createSignedVoter(KIM_PN)
    gunvor = await createSignedVoter(GUNVOR_PN, { municipalityCode: FALUN })
  })

  function ballotPartyIdFor(party: 'bp-s' | 'bp-m'): string {
    return party === 'bp-s' ? bpS : bpM
  }

  /** Krypterar ett val på riksdagsvalsedeln, precis som klienten skulle gjort det. */
  async function buildBallot(party: 'bp-s' | 'bp-m'): Promise<EncryptedBallot> {
    return encryptBallot(publicKey, electionId, ballotId, options, {
      kind: 'PARTY',
      ballotPartyId: ballotPartyIdFor(party),
    })
  }

  /**
   * Simulerar BankID /sign åt en av testets kända väljare — samma flöde som
   * /api/vote/sign-start startar och /api/vote/encrypted hämtar svaret från.
   */
  async function signAs(
    voterStatusId: string,
    targetBallotId: string,
    ciphertextHash: string,
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
        ballotId: targetBallotId,
        ciphertextHash,
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
      signedData: result.completionData.signedData,
    }
  }

  /** Genomför en fullständig, ärlig röstläggning på riksdagsvalsedeln. */
  async function castFor(voterStatusId: string, party: 'bp-s' | 'bp-m') {
    const ballot = await buildBallot(party)
    const castSequence = await nextCastSequence(voterStatusId, ballotId)
    const envelope = await signAs(voterStatusId, ballotId, ballot.ciphertextHash, castSequence)
    const shape = await getEncryptedBallotShape(ballotId)

    const outcome = await castEncryptedBallot(
      voterStatusId,
      electionId,
      ballotId,
      ballot,
      envelope,
      shape,
    )
    if (outcome.status !== 'recorded') {
      throw new Error(`Kunde inte lägga rösten (${outcome.status}).`)
    }

    // Den lagrade raden, för att kunna spela upp den igen i STALE_SEQUENCE-testet.
    return votersDb.pendingVote.findUniqueOrThrow({
      where: { voterStatusId_ballotId: { voterStatusId, ballotId } },
    })
  }

  /**
   * DET HÅL SOM BARA SIGNATUREN STÄNGER.
   *
   * Skriver en rad direkt i databasen, förbi `castEncryptedBallot`, med ett i
   * övrigt korrekt chiffer men en signatur som inte håller. Raden pekar på en
   * verklig, röstberättigad väljare och passerar varje relationell kontroll —
   * bara signaturkontrollen avslöjar att väljaren aldrig godkänt innehållet.
   */
  async function stuffVoteFor(voterStatusId: string, party: 'bp-s' | 'bp-m'): Promise<void> {
    const ballot = await buildBallot(party)

    const data = {
      ciphertext: ballot.ciphertext as unknown as Prisma.InputJsonValue,
      proofs: ballot.proofs as unknown as Prisma.InputJsonValue,
      ciphertextHash: ballot.ciphertextHash,
      castSequence: 1,
      bankIdSignature: 'inte-en-äkta-signatur',
      bankIdPublicKey: 'inte-en-äkta-nyckel',
      updatedAt: new Date(),
    }

    await votersDb.pendingVote.upsert({
      where: { voterStatusId_ballotId: { voterStatusId, ballotId } },
      create: { voterStatusId, ballotId, ...data },
      update: data,
    })
  }

  /**
   * Skriver ett tidigare, äkta kuvert tillbaka in i den liggande raden — utan
   * att röra räknarkolumnen.
   *
   * Innehållet och signaturen hör äkta ihop MED VARANDRA (väljaren skrev
   * verkligen under precis det här chiffret, vid precis det här
   * räknarvärdet). Det som gör raden inaktuell är att kolumnens eget
   * `castSequence` sedan dess hunnit högre, genom en riktig, senare röst — en
   * återställning eller en angripare som spelar upp ett gammalt kuvert glömmer
   * (eller struntar i) att räknaren redan gått vidare.
   */
  async function replayEnvelope(
    voterStatusId: string,
    old: Awaited<ReturnType<typeof castFor>>,
  ): Promise<void> {
    await votersDb.pendingVote.update({
      where: { voterStatusId_ballotId: { voterStatusId, ballotId: old.ballotId } },
      data: {
        ciphertext: old.ciphertext as unknown as Prisma.InputJsonValue,
        proofs: old.proofs as unknown as Prisma.InputJsonValue,
        ciphertextHash: old.ciphertextHash,
        bankIdSignature: old.bankIdSignature,
        bankIdPublicKey: old.bankIdPublicKey,
        // castSequence lämnas medvetet orörd — se dokumentationen ovan.
      },
    })
  }

  /**
   * Lägger en fullt giltig, korrekt signerad röst på en valsedel väljaren inte
   * har rätt till (fel kommun). `castEncryptedBallot` kontrollerar aldrig
   * detta — den känner inte ens till väljarens folkbokföring — så det här är
   * en helt ärlig röstläggning, inte en manipulerad rad. Kontrollen finns bara
   * i valideringen.
   */
  async function forceBallotFor(
    voterStatusId: string,
    targetBallotId: string,
    partyId: string,
  ): Promise<void> {
    const targetOptions = canonicalOptions({
      allowsCandidateVote: false,
      parties: [{ id: partyId, displayOrder: 0, candidates: [] }],
    })
    const ballot = encryptBallot(publicKey, electionId, targetBallotId, targetOptions, {
      kind: 'PARTY',
      ballotPartyId: partyId,
    })
    const castSequence = await nextCastSequence(voterStatusId, targetBallotId)
    const envelope = await signAs(voterStatusId, targetBallotId, ballot.ciphertextHash, castSequence)
    const shape = await getEncryptedBallotShape(targetBallotId)

    const outcome = await castEncryptedBallot(
      voterStatusId,
      electionId,
      targetBallotId,
      ballot,
      envelope,
      shape,
    )
    if (outcome.status !== 'recorded') {
      throw new Error(`Kunde inte lägga rösten (${outcome.status}).`)
    }
  }

  it('en ren omröstning ger noll avvikelser', async () => {
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')

    const report = await validateBeforeClose(electionId)

    expect(report.summary).toMatchObject({ votes: 2, voters: 2, passed: true })
    expect(report.anomalies).toHaveLength(0)
  })

  it('upptäcker en röst lagd i någon annans namn', async () => {
    await stuffVoteFor(kim, 'bp-m')

    const report = await validateBeforeClose(electionId)

    expect(report.summary.passed).toBe(false)
    expect(report.anomalies).toContainEqual(
      expect.objectContaining({ kind: 'BAD_SIGNATURE', voterStatusId: kim }),
    )
  })

  it('upptäcker en återuppspelad äldre röst', async () => {
    const first = await castFor(anna, 'bp-s')
    await castFor(anna, 'bp-m')
    await replayEnvelope(anna, first)

    const report = await validateBeforeClose(electionId)

    expect(report.anomalies).toContainEqual(
      expect.objectContaining({ kind: 'STALE_SEQUENCE', voterStatusId: anna }),
    )
  })

  it('upptäcker en valsedel väljaren inte har rätt till', async () => {
    // Gunvor är folkbokförd i Falun och ska inte kunna ha Stockholms
    // kommunvalsedel liggande, oavsett om det beror på bugg eller angrepp.
    await forceBallotFor(gunvor, kommunBallotId, kommunPartyId)

    const report = await validateBeforeClose(electionId)

    expect(report.anomalies).toContainEqual(
      expect.objectContaining({ kind: 'WRONG_BALLOT', voterStatusId: gunvor }),
    )
  })

  it('rapportens sammanfattning namnger ingen väljare', async () => {
    /**
     * Valideringen kräver att kopplingen läses, alltså precis den förmåga som
     * gör modellen svagare på valhemlighet. Det som publiceras måste därför
     * vara antal och kategorier — aldrig vem.
     */
    await stuffVoteFor(kim, 'bp-m')

    const report = await validateBeforeClose(electionId)

    expect(JSON.stringify(report.summary)).not.toContain(kim)
    expect(report.summary.byKind).toMatchObject({ BAD_SIGNATURE: 1 })
  })

  it('en struken väljares röst underkänns INTE', async () => {
    /**
     * Beslutet i spec 7.4, vaktat.
     *
     * Det är lätt att lägga till en röstberättigandekontroll "för säkerhets
     * skull" — den känns som en självklarhet. Den skulle förkasta giltiga
     * röster från väljare som strukits efter att ha röstat.
     */
    await castFor(anna, 'bp-s')
    await votersDb.voterStatus.update({ where: { id: anna }, data: { isEligible: false } })

    const report = await validateBeforeClose(electionId)

    expect(report.summary.passed).toBe(true)
    expect(report.anomalies).toHaveLength(0)
  })

  it('att valideringen körts hamnar i revisionsloggen', async () => {
    // Att läsa kopplingen ska synas. En tyst läsning är oskiljbar från en
    // obehörig.
    await validateBeforeClose(electionId)

    const events = await votersDb.auditEvent.findMany({ orderBy: { sequence: 'desc' }, take: 1 })
    expect(events[0]!.eventType).toBe('PRE_CLOSE_VALIDATION')
  })
})
