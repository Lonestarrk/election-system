import { randomUUID, type KeyObject, type X509Certificate } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '.prisma/voters'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import { oldProofFormatNote, validateBeforeClose } from '@/orchestration/validate-before-close.usecase'
import { canonicalOptions, type BallotOption } from '@/lib/crypto/ballot-encoding'
import { encryptBallot } from '@/lib/encrypt-client'
import { hashCiphertext, type EncryptedBallot } from '@/lib/crypto/verify-ballot'
import {
  MockBankIdService,
  selectDemoIdentity,
} from '@/modules/eligibility/bankid/MockBankIdService'
import { parseCertificateChain } from '@/modules/eligibility/bankid/certificate-chain'
import { envelopePayload } from '@/modules/eligibility/bankid/envelope-signature'
import { MOCK_BANKID_ROOT_CERTIFICATE } from '@/modules/eligibility/bankid/mock-ca/root-certificate'
import {
  castEncryptedBallot,
  nextCastSequence,
  type SignedEnvelope,
} from '@/modules/eligibility/pending-vote.service'
import { sealCertificateChain } from '@/modules/eligibility/sealed-chain'
import { forgeBallot } from '../unit/crypto/forged-ballot'
import { legacyEncryptBallot, legacyVerifyEncryptedBallot } from '../unit/crypto/legacy-ballot'
import {
  lookalikeHierarchy,
  MOCK_INTERMEDIATE,
  rsaKeys,
  selfSignedLeaf,
  signPayload,
  voterLeaf,
} from '../unit/bankid/forged-certificates'
import { createVoter, disconnect, isDatabaseAvailable, resetElectionData } from './helpers'

/**
 * Uppgift 10: valideringen som körs medan `PendingVote` fortfarande pekar på
 * en väljare — se docs/spec/2026-09-22-dubbla-kuvert.md avsnitt 7.
 *
 * Testerna bygger avvikelserna precis som de skulle uppstå: en rad skriven
 * direkt i databasen (`stuffVoteFor`, `replayEnvelope`, `plantEnvelope`) eller
 * en helt ärlig röstläggning mot fel valsedel (`forceBallotFor`, eftersom
 * ingenting i `castEncryptedBallot` självt kontrollerar väljarens folkbokföring
 * — den kontrollen finns bara här).
 *
 * UPPGIFT 14f: UNDERSKRIFTEN BINDER PÅ RIKTIGT.
 *
 * Fram till uppgift 14f fanns här testet "en självkonsekvent förfalskning med
 * eget nyckelpar fångas INTE": den som kunde skriva i databasen lade in ett
 * eget nyckelpar, och valideringen godkände raden. Testet är vänt. Raden bär
 * nu BankID-kedjan, och varje förfalskning nedan underkänns av just sin
 * kontroll, med sitt eget skäl i avvikelsen.
 */

/**
 * Räknar identitetshashningarna, för testet av att valideringen hashar en gång
 * per väljare. Allt går vidare till den äkta funktionen.
 */
const identityControl = vi.hoisted(() => ({ hashed: [] as string[] }))

vi.mock('@/modules/eligibility/identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/eligibility/identity')>()

  return {
    ...actual,
    hashPersonalNumber: async (personalNumber: string) => {
      identityControl.hashed.push(personalNumber)
      return actual.hashPersonalNumber(personalNumber)
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

describe.skipIf(!databaseAvailable)('validering medan kopplingen finns kvar', () => {
  const ANNA_PN = '199001011234'
  const KIM_PN = '198505152345'
  const GUNVOR_PN = '194512019876'

  const FALUN = '2080'
  const STOCKHOLM = '0180'

  const DAY = 86_400_000

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

  /** Filer med betrodda rötter som ett test har skrivit. */
  const rootFiles: string[] = []

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

  afterEach(() => {
    vi.unstubAllEnvs()
    for (const path of rootFiles.splice(0)) rmSync(path, { force: true })
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
   * Simulerar BankID /sign åt ett personnummer — samma flöde som
   * /api/vote/sign-start startar och /api/vote/encrypted hämtar svaret från.
   */
  async function signWithBankId(
    personalNumber: string,
    targetBallotId: string,
    ciphertextHash: string,
    castSequence: number,
  ): Promise<SignedEnvelope> {
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
      certificateChain: result.completionData.certificateChain,
      signedData: result.completionData.signedData,
    }
  }

  /** BankID /sign åt en av testets kända väljare. */
  async function signAs(
    voterStatusId: string,
    targetBallotId: string,
    ciphertextHash: string,
    castSequence: number,
  ): Promise<SignedEnvelope> {
    const personalNumber = personalNumberByVoter.get(voterStatusId)
    if (!personalNumber) throw new Error('Okänd testväljare.')
    return signWithBankId(personalNumber, targetBallotId, ciphertextHash, castSequence)
  }

  /**
   * Kedjan ur ett BankID-svar, förseglad för en rad, som `castEncryptedBallot`
   * lagrar den. För testerna som skriver en rad med en äkta underskrift direkt.
   */
  function sealedChainOf(envelope: SignedEnvelope, voterStatusId: string, targetBallotId: string): string {
    const chain = parseCertificateChain(envelope.certificateChain)
    if (!chain) throw new Error('Kedjan i BankID-svaret gick inte att läsa.')
    return sealCertificateChain(chain, { voterStatusId, ballotId: targetBallotId })
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

  /** Skriver en rad direkt i databasen, förbi `castEncryptedBallot`. */
  async function writeRow(
    voterStatusId: string,
    targetBallotId: string,
    data: {
      ciphertext: unknown
      proofs: unknown
      ciphertextHash: string
      castSequence: number
      bankIdSignature: string
      bankIdCertificateChain: string
    },
  ): Promise<void> {
    const row = {
      ...data,
      ciphertext: data.ciphertext as Prisma.InputJsonValue,
      proofs: data.proofs as Prisma.InputJsonValue,
      updatedAt: new Date(),
    }

    await votersDb.pendingVote.upsert({
      where: { voterStatusId_ballotId: { voterStatusId, ballotId: targetBallotId } },
      create: { voterStatusId, ballotId: targetBallotId, ...row },
      update: row,
    })
  }

  /**
   * Skriver en rad direkt i databasen, förbi `castEncryptedBallot`, med ett
   * lagrat chiffer men en signatur och en kedja som inte är något alls —
   * oavsett vilken valsedel det gäller. Generaliserad över
   * `targetBallotId`/`ballot` så att samma skrivväg kan användas både för DET
   * HÅL SOM BARA SIGNATUREN STÄNGER (`stuffVoteFor`, på riksdagsvalsedeln) och
   * för testet som visar att flera avvikelser på samma rad rapporteras samtidigt
   * (på kommunvalsedeln).
   */
  async function stuffVoteForBallot(
    voterStatusId: string,
    targetBallotId: string,
    ballot: EncryptedBallot,
  ): Promise<void> {
    await writeRow(voterStatusId, targetBallotId, {
      ciphertext: ballot.ciphertext,
      proofs: ballot.proofs,
      ciphertextHash: ballot.ciphertextHash,
      castSequence: 1,
      bankIdSignature: 'inte-en-äkta-signatur',
      bankIdCertificateChain: 'inte-en-äkta-kedja',
    })
  }

  /**
   * DET HÅL SOM BARA SIGNATUREN STÄNGER.
   *
   * Raden pekar på en verklig, röstberättigad väljare, har ett i övrigt
   * korrekt chiffer på rätt valsedel, och passerar varje relationell
   * kontroll — bara signaturkontrollen avslöjar att väljaren aldrig godkänt
   * innehållet.
   */
  async function stuffVoteFor(voterStatusId: string, party: 'bp-s' | 'bp-m'): Promise<void> {
    await stuffVoteForBallot(voterStatusId, ballotId, await buildBallot(party))
  }

  /**
   * EN FÖRFALSKNING FRÅN DEN SOM DRIVER SYSTEMET.
   *
   * Angriparen skriver direkt i databasen och har dessutom pepparn, så kedjan
   * förseglas med den riktiga nyckeln och för rätt rad. Utan pepparn hade raden
   * fastnat redan på att kedjan inte går att öppna, och då hade testet visat
   * det i stället för kedjeprövningen. Valsedeln och beviset är äkta, och
   * signaturen håller mot lövets nyckel, så det enda som kan avslöja raden är
   * kedjan eller vem lövet tillhör.
   */
  async function plantEnvelope(
    voterStatusId: string,
    chain: X509Certificate[],
    signingKey: KeyObject,
  ): Promise<void> {
    const ballot = await buildBallot('bp-m')
    const castSequence = 1

    await writeRow(voterStatusId, ballotId, {
      ciphertext: ballot.ciphertext,
      proofs: ballot.proofs,
      ciphertextHash: ballot.ciphertextHash,
      castSequence,
      bankIdSignature: signPayload(
        signingKey,
        envelopePayload({ electionId, ballotId, ciphertextHash: ballot.ciphertextHash, castSequence }),
      ),
      bankIdCertificateChain: sealCertificateChain(chain, { voterStatusId, ballotId }),
    })
  }

  /** Lägger till rötter bland de betrodda, som en driftsättning med flera rötter. */
  function trustRoots(...roots: X509Certificate[]): void {
    const path = join(tmpdir(), `betrodda-rotter-${randomUUID()}.pem`)
    writeFileSync(path, MOCK_BANKID_ROOT_CERTIFICATE + roots.map((root) => root.toString()).join(''))
    rootFiles.push(path)
    vi.stubEnv('BANKID_ROOT_CERTIFICATES', path)
  }

  /** Den enda avvikelsen i rapporten ska vara en underkänd signatur för Kim, med det här skälet. */
  function expectOnlyBadSignatureForKim(
    report: Awaited<ReturnType<typeof validateBeforeClose>>,
    reason: string,
  ): void {
    expect(report.summary.passed).toBe(false)
    expect(report.anomalies).toEqual([
      expect.objectContaining({ kind: 'BAD_SIGNATURE', voterStatusId: kim, reason }),
    ])
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
        bankIdCertificateChain: old.bankIdCertificateChain,
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

  it('två väljare med samma chiffer är två giltiga röster, och ingen avvikelse (fixrunda 3 av 11d, ruling 130)', async () => {
    /**
     * Fixrunda 2 lät valideringen flagga två kuvert med samma chifferhash.
     * Sedan ruling 130 tar läggningen emot en kopia av någon annans valsedel
     * som vilken röst som helst, och urnan nycklas per kuvert, så båda kan
     * flyttas. Två väljare som lagt samma chiffer har lagt två röster.
     */
    const copied = await buildBallot('bp-s')
    for (const voter of [anna, kim]) {
      const envelope = await signAs(voter, ballotId, copied.ciphertextHash, await nextCastSequence(voter, ballotId))
      const outcome = await castEncryptedBallot(
        voter,
        electionId,
        ballotId,
        copied,
        envelope,
        await getEncryptedBallotShape(ballotId),
      )
      expect(outcome.status).toBe('recorded')
    }

    const report = await validateBeforeClose(electionId)

    expect(report.summary).toMatchObject({ votes: 2, voters: 2, passed: true })
    expect(report.anomalies).toEqual([])
  })

  it('upptäcker en röst lagd i någon annans namn', async () => {
    await stuffVoteFor(kim, 'bp-m')

    const report = await validateBeforeClose(electionId)

    expect(report.summary.passed).toBe(false)
    expect(report.anomalies).toContainEqual(
      expect.objectContaining({ kind: 'BAD_SIGNATURE', voterStatusId: kim }),
    )
  })

  describe('den som driver systemet kan inte förfalska en underskrift (uppgift 14f)', () => {
    it('en självkonsekvent förfalskning med eget nyckelpar och självsignerat certifikat fångas', async () => {
      /**
       * TESTET SOM VÄNDES.
       *
       * Förut hette det "en självkonsekvent förfalskning med eget nyckelpar
       * fångas INTE", och raden godkändes: den bar sin egen nyckel, och
       * signaturen höll mot den. Här gör angriparen samma sak med ett
       * självsignerat certifikat med Kims personnummer, och lägger det bredvid
       * attrappens äkta mellannivå, som är offentlig, så att kedjan har rätt
       * form. Lövet är inte utfärdat av mellannivån, och det är den kontrollen
       * som fäller raden.
       */
      const forger = rsaKeys('förfalskaren')
      await plantEnvelope(kim, [selfSignedLeaf(forger, KIM_PN), MOCK_INTERMEDIATE], forger.privateKey)

      expectOnlyBadSignatureForKim(await validateBeforeClose(electionId), 'not_issued_by_intermediate')
    })

    it('en kedja till en annan rot underkänns, fast namnen är attrappens', async () => {
      const forger = rsaKeys('förfalskaren')
      const lookalike = lookalikeHierarchy()
      const leaf = voterLeaf(forger, { personalNumber: KIM_PN, issuer: lookalike.issuer })

      await plantEnvelope(kim, [leaf, lookalike.intermediate], forger.privateKey)

      expectOnlyBadSignatureForKim(await validateBeforeClose(electionId), 'untrusted_root')
    })

    it('ett giltigt certifikat för en annan väljare underkänns', async () => {
      /**
       * Annas äkta underskrift, med en kedja som BankID står för, lagd i Kims
       * rad. Kuvertet bär ingen väljare i det signerade, så bara personnumret i
       * lövet avslöjar att underskriften inte är Kims.
       */
      const ballot = await buildBallot('bp-m')
      const envelope = await signWithBankId(ANNA_PN, ballotId, ballot.ciphertextHash, 1)

      await writeRow(kim, ballotId, {
        ciphertext: ballot.ciphertext,
        proofs: ballot.proofs,
        ciphertextHash: ballot.ciphertextHash,
        castSequence: 1,
        bankIdSignature: envelope.signature,
        bankIdCertificateChain: sealedChainOf(envelope, kim, ballotId),
      })

      expectOnlyBadSignatureForKim(await validateBeforeClose(electionId), 'other_voter')
    })

    it('ett utgånget certifikat underkänns', async () => {
      const forger = rsaKeys('förfalskaren')
      const expired = voterLeaf(forger, {
        personalNumber: KIM_PN,
        notBefore: new Date(Date.now() - 30 * DAY),
        notAfter: new Date(Date.now() - DAY),
      })

      await plantEnvelope(kim, [expired, MOCK_INTERMEDIATE], forger.privateKey)

      expectOnlyBadSignatureForKim(await validateBeforeClose(electionId), 'not_valid_when_signed')
    })

    it('en mellannivå utan CA-rätt underkänns, också under en betrodd rot', async () => {
      /**
       * Attrappens rot har ingen privat nyckel kvar, så en mellannivå utan
       * CA-rätt under den går inte att bygga. Testet litar därför på en egen rot
       * också, som en driftsättning med flera rötter, och bygger mellannivån
       * under den. Då är det CA-rätten och inget annat som saknas.
       */
      const forger = rsaKeys('förfalskaren')
      const lookalike = lookalikeHierarchy({ intermediateIsCa: false })
      trustRoots(lookalike.root)
      const leaf = voterLeaf(forger, { personalNumber: KIM_PN, issuer: lookalike.issuer })

      await plantEnvelope(kim, [leaf, lookalike.intermediate], forger.privateKey)

      expectOnlyBadSignatureForKim(await validateBeforeClose(electionId), 'intermediate_not_ca')
    })

    it('ett löv med CA-rätt underkänns', async () => {
      const forger = rsaKeys('förfalskaren')
      const leaf = voterLeaf(forger, { personalNumber: KIM_PN, ca: true })

      await plantEnvelope(kim, [leaf, MOCK_INTERMEDIATE], forger.privateKey)

      expectOnlyBadSignatureForKim(await validateBeforeClose(electionId), 'leaf_is_ca')
    })

    it('kontrasten: samma sorts rad med ett korrekt utfärdat löv godkänns', async () => {
      /**
       * Utan den här kunde testerna ovan ha fallit på något i `plantEnvelope`
       * och inte på sin egen kontroll. Den som har attrappens mellannivå kan
       * utfärda ett giltigt löv för vem som helst, och det är precis den
       * begränsning som gäller i demoläget.
       */
      const forger = rsaKeys('förfalskaren')
      const leaf = voterLeaf(forger, { personalNumber: KIM_PN })
      await plantEnvelope(kim, [leaf, MOCK_INTERMEDIATE], forger.privateKey)

      const report = await validateBeforeClose(electionId)

      expect(report.summary.passed).toBe(true)
      expect(report.anomalies).toHaveLength(0)
    })

    it('en kedja flyttad från en annan väljares rad går inte att öppna', async () => {
      /**
       * Annas äkta rad, med kedjan och signaturen, kopierad till Kims rad.
       * Kedjan är förseglad för Annas rad, så den öppnas inte alls i Kims.
       * Utan den bindningen hade raden fallit på att lövet är Annas, och skälet
       * hade varit ett annat.
       */
      const annasRow = await castFor(anna, 'bp-m')
      await votersDb.pendingVote.delete({ where: { id: annasRow.id } })

      await writeRow(kim, ballotId, {
        ciphertext: annasRow.ciphertext,
        proofs: annasRow.proofs,
        ciphertextHash: annasRow.ciphertextHash,
        castSequence: annasRow.castSequence,
        bankIdSignature: annasRow.bankIdSignature,
        bankIdCertificateChain: annasRow.bankIdCertificateChain,
      })

      expectOnlyBadSignatureForKim(await validateBeforeClose(electionId), 'unreadable')
    })
  })

  it('hashar personnumret en gång per väljare och körning, inte en gång per kuvert', async () => {
    /**
     * Identitetshashen tar 37 ms. Anna har två kuvert och Kim ett, alltså tre
     * kuvert men två väljare, och valideringen ska hasha två gånger.
     */
    await castFor(anna, 'bp-s')
    await forceBallotFor(anna, kommunBallotId, kommunPartyId)
    await castFor(kim, 'bp-m')
    identityControl.hashed = []

    const report = await validateBeforeClose(electionId)

    expect(report.summary).toMatchObject({ votes: 3, voters: 2 })
    expect([...identityControl.hashed].sort()).toEqual([ANNA_PN, KIM_PN].sort())
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

  it('en rad med flera samtidiga avvikelser rapporterar dem alla', async () => {
    /**
     * Fynd 3, fixrunda 1 av uppgift 10:s granskning.
     *
     * "Billigast först" avgör bara ordningen kontrollerna körs i, inte om en
     * dyrare körs efter att en billigare redan träffat. En rad kan ha flera
     * fel på samma gång — och just den kombinationen är vad en administratör
     * behöver för att skilja en bugg från ett angrepp (spec 7.2). Gunvor får
     * här en rad på Stockholms kommunvalsedel (fel för henne — WRONG_BALLOT)
     * med en signatur som inte håller (BAD_SIGNATURE), i en och samma rad.
     */
    const kommunOptions = canonicalOptions({
      allowsCandidateVote: false,
      parties: [{ id: kommunPartyId, displayOrder: 0, candidates: [] }],
    })
    const ballot = encryptBallot(publicKey, electionId, kommunBallotId, kommunOptions, {
      kind: 'PARTY',
      ballotPartyId: kommunPartyId,
    })

    await stuffVoteForBallot(gunvor, kommunBallotId, ballot)

    const report = await validateBeforeClose(electionId)

    const forGunvor = report.anomalies
      .filter((anomaly) => anomaly.voterStatusId === gunvor)
      .map((anomaly) => anomaly.kind)
      .sort()

    expect(forGunvor).toEqual(['BAD_SIGNATURE', 'WRONG_BALLOT'])
  })

  it('en rad med missformat chiffer kraschar inte valideringen', async () => {
    /**
     * Fixrunda 2, uppgift 10:s granskning.
     *
     * Innan `proofHoldsSafely` fanns gjorde `verifyEncryptedBallot`
     * `BigInt(...)` på chifferfälten utan eget felfång. Kombinerat med att
     * alla fyra kontroller nu körs för varje rad (fixrunda 1, fynd 3) skulle
     * en rad som BÅDE har fel valsedel OCH ett missformat chiffer krascha
     * HELA `validateBeforeClose` i stället för att rapporteras som två
     * avvikelser — den skyddet som `continue` råkade ge innan var en slump,
     * inte en design.
     *
     * `ciphertextHash` måste stämma mot det missformade chiffret (precis som
     * `hashCiphertext` skulle räkna fram det) för att `verifyEncryptedBallot`
     * ens ska HINNA fram till `BigInt`-konverteringen — annars fångas raden
     * redan av den tidigare hashkontrollen, utan att någonsin nå det som en
     * gång kraschade. Signaturen är däremot äkta (genererad precis som en
     * riktig röstläggning), så att testet isolerar EXAKT kombinationen
     * WRONG_BALLOT + missformat bevis, utan att blanda in en tredje
     * BAD_SIGNATURE-avvikelse.
     */
    const shape = await getEncryptedBallotShape(kommunBallotId)
    if (!shape) throw new Error('Kommunvalsedeln saknar form.')

    const malformedCiphertext = Array.from({ length: shape.optionCount }, () => ({
      c1: 'inte-ett-tal',
      c2: 'inte-heller-ett-tal',
    }))
    const malformedProofs = {
      components: Array.from({ length: shape.optionCount }, () => ({})),
      sum: {},
    }
    const ciphertextHash = hashCiphertext(malformedCiphertext)

    const castSequence = await nextCastSequence(gunvor, kommunBallotId)
    const envelope = await signAs(gunvor, kommunBallotId, ciphertextHash, castSequence)

    await writeRow(gunvor, kommunBallotId, {
      ciphertext: malformedCiphertext,
      proofs: malformedProofs,
      ciphertextHash,
      castSequence,
      bankIdSignature: envelope.signature,
      bankIdCertificateChain: sealedChainOf(envelope, gunvor, kommunBallotId),
    })

    // Den avgörande skillnaden: detta får inte kasta. Innan fixrunda 2
    // hade `await` här avslutats med en okatchad `SyntaxError`.
    const report = await validateBeforeClose(electionId)

    const forGunvor = report.anomalies
      .filter((anomaly) => anomaly.voterStatusId === gunvor)
      .map((anomaly) => anomaly.kind)
      .sort()

    expect(forGunvor).toEqual(['BAD_PROOF', 'WRONG_BALLOT'])
  })

  it('en förfalskad valsedel med +1000 för ett parti och −999 för blankt fångas som BAD_PROOF', async () => {
    /**
     * KRITISKT 1 i granskningen av uppgift 14b.
     *
     * Raden bär en äkta underskrift. `sign-start` tar hashen från klienten, så
     * en väljare kan själv låta BankID skriva under hashen över en förfalskad
     * valsedel, och signaturkontrollen håller. Det enda som kan stoppa raden
     * är bevisen. Före fixrunda 1 godkändes de: raden läses förbi
     * trådschemat, och en negativ utmaning räknades som 1. Valideringen
     * släppte alltså igenom tusen röster på ett parti, och Kim hade inte ens
     * behövt skriva i databasen för att få underskriften, bara för att lägga
     * raden där.
     */
    const { ballot } = forgeBallot(BigInt(publicKey), electionId, ballotId, [-999n, 1000n, 0n])
    const castSequence = await nextCastSequence(kim, ballotId)
    const envelope = await signAs(kim, ballotId, ballot.ciphertextHash, castSequence)

    await writeRow(kim, ballotId, {
      ciphertext: ballot.ciphertext,
      proofs: ballot.proofs,
      ciphertextHash: ballot.ciphertextHash,
      castSequence,
      bankIdSignature: envelope.signature,
      bankIdCertificateChain: sealedChainOf(envelope, kim, ballotId),
    })
    // En ärlig röst bredvid, som kontrast: den ska inte ge någon avvikelse.
    await castFor(anna, 'bp-s')

    const report = await validateBeforeClose(electionId)

    expect(report.summary.passed).toBe(false)
    // Bara bevisen avviker. Underskriften är äkta, och valsedeln gäller Kim.
    expect(report.anomalies).toEqual([
      expect.objectContaining({ kind: 'BAD_PROOF', voterStatusId: kim }),
    ])
  })

  it('ett kuvert med bevis i formatet före uppgift 14d fångas som OLD_PROOF_FORMAT, och bara som det', async () => {
    /**
     * Så ser kuverten ut som lades före uppgift 14d, i demons databaser lokalt
     * och i Azure: äkta underskrift, rätt valsedel och bevis som var giltiga
     * då. Utmaningarna band inte hela chifferlistan, och nu gör de det, så
     * bevisen håller inte längre. Kuvertet kan inte räknas, och valideringen
     * ska säga det i stället för att släppa igenom det.
     *
     * Sedan fixrunda 1 skiljer valideringen ett sådant kuvert från ett trasigt
     * bevis: det saknar formatmarkören (fixrunda 1 av uppgift 14d), och då är
     * det gamla formatet och inte ett förfalskat bevis.
     */
    const old = legacyEncryptBallot(publicKey, electionId, ballotId, options, {
      kind: 'PARTY',
      ballotPartyId: bpM,
    })
    // Giltigt i det gamla formatet. Utan det här visade testet bara att en
    // trasig valsedel underkänns.
    expect(legacyVerifyEncryptedBallot(publicKey, electionId, ballotId, options.length, old)).toBe(true)

    const castSequence = await nextCastSequence(kim, ballotId)
    const envelope = await signAs(kim, ballotId, old.ciphertextHash, castSequence)
    await writeRow(kim, ballotId, {
      ciphertext: old.ciphertext,
      proofs: old.proofs,
      ciphertextHash: old.ciphertextHash,
      castSequence,
      bankIdSignature: envelope.signature,
      bankIdCertificateChain: sealedChainOf(envelope, kim, ballotId),
    })
    await castFor(anna, 'bp-s')

    const report = await validateBeforeClose(electionId)

    expect(report.summary.passed).toBe(false)
    expect(report.summary.byKind).toEqual({ OLD_PROOF_FORMAT: 1 })
    expect(report.anomalies).toEqual([
      expect.objectContaining({ kind: 'OLD_PROOF_FORMAT', voterStatusId: kim }),
    ])
    // Det beskedet säger, med antalet ur sammanfattningen och ingen väljare.
    expect(oldProofFormatNote(report.summary)).toBe('1 kuvert har det gamla bevisformatet och kan inte räknas.')
  })

  it('ett kuvert med formatmarkören men trasiga bevis är BAD_PROOF och inte det gamla formatet', async () => {
    // Kontrasten. Markören säger vilket format bevisen påstår sig ha, och ett
    // bevis i det nuvarande formatet som inte håller är ett trasigt bevis.
    const ballot = await buildBallot('bp-m')
    const proofs = structuredClone(ballot.proofs)
    proofs.components[1]!.response0 = (BigInt(proofs.components[1]!.response0) + 1n).toString()
    const castSequence = await nextCastSequence(kim, ballotId)
    const envelope = await signAs(kim, ballotId, ballot.ciphertextHash, castSequence)
    await writeRow(kim, ballotId, {
      ciphertext: ballot.ciphertext,
      proofs,
      ciphertextHash: ballot.ciphertextHash,
      castSequence,
      bankIdSignature: envelope.signature,
      bankIdCertificateChain: sealedChainOf(envelope, kim, ballotId),
    })

    const report = await validateBeforeClose(electionId)

    expect(proofs.format).toBe(2)
    expect(report.summary.byKind).toEqual({ BAD_PROOF: 1 })
    expect(oldProofFormatNote(report.summary)).toBe('')
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

    /**
     * DEN HÄR ASSERTIONEN ÄR INTE ÖVERFLÖDIG — TA INTE BORT DEN.
     *
     * `passed`/`anomalies` ovan fångar bara varianten "avvisa och flagga".
     * Den farligare varianten av en regression är att någon lägger
     * `where: { voterStatus: { isEligible: true } } ` i `pendingVote.findMany`
     * — den mest idiomatiska Prisma-vägen att "hjälpsamt" återinföra
     * röstberättigandekontrollen. Då FILTRERAS Annas röst tyst bort ur
     * resultatmängden: `votes`/`voters` går 1 → 0, `anomalies` förblir tom,
     * `passed` förblir sant, och de två raderna ovan skulle fortsätta gå
     * gröna. Bara ett explicit antal fångar att rösten verkligen RÄKNADES,
     * inte bara att den inte flaggades.
     */
    expect(report.summary).toMatchObject({ votes: 1, voters: 1 })
  })

  it('att valideringen körts hamnar i revisionsloggen', async () => {
    // Att läsa kopplingen ska synas. En tyst läsning är oskiljbar från en
    // obehörig.
    await validateBeforeClose(electionId)

    const events = await votersDb.auditEvent.findMany({ orderBy: { sequence: 'desc' }, take: 1 })
    expect(events[0]!.eventType).toBe('PRE_CLOSE_VALIDATION')
  })
})
