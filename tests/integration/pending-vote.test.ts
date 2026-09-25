import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import { canonicalOptions, type BallotOption } from '@/lib/crypto/ballot-encoding'
import { encryptBallot } from '@/lib/encrypt-client'
import { P } from '@/lib/crypto/group'
import { VerificationAborted } from '@/lib/crypto/server'
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
import { openCertificateChain } from '@/modules/eligibility/sealed-chain'
import {
  lookalikeHierarchy,
  MOCK_INTERMEDIATE,
  MOCK_ROOT,
  pemChain,
  rsaKeys,
  signPayload,
  voterLeaf,
  type KeyPair,
} from '../unit/bankid/forged-certificates'
import { createBlindedCredential } from '@/lib/blind-client'
import { issueCredential } from '@/modules/eligibility/credential.service'
import { closeElection as closeAndStrip } from '@/orchestration/close-election.usecase'
import { createVoter, disconnect, isDatabaseAvailable, resetElectionData } from './helpers'

/**
 * Låter testet ge upp i precis rätt ögonblick (fixrunda 1, uppgift 14b).
 *
 * Verifieringen stannar vid nästa steg när besökaren ger upp, men efter dess
 * sista steg finns inget nästa. Omslutningen kör den äkta verifieringen och
 * anropar sedan `afterVerification`, så att testet kan avbryta mellan
 * verifieringen och skrivningen. Alla andra tester går rakt igenom till den
 * äkta funktionen.
 */
const verificationControl = vi.hoisted(() => ({
  afterVerification: null as null | (() => void),
}))

vi.mock('@/lib/crypto/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crypto/server')>()

  return {
    ...actual,
    verifyEncryptedBallotOnServer: async (
      ...args: Parameters<typeof actual.verifyEncryptedBallotOnServer>
    ) => {
      const verdict = await actual.verifyEncryptedBallotOnServer(...args)
      verificationControl.afterVerification?.()
      return verdict
    },
  }
})

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
    verificationControl.afterVerification = null
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
      certificateChain: result.completionData.certificateChain,
      // Ordagrant det som skrevs under — inte castSequence vid sidan av. Se
      // SignedEnvelope.signedData för varför (fixrunda 1, fynd 1).
      signedData: result.completionData.signedData,
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
    envelope: SignedEnvelope = { signature: '', certificateChain: [], signedData: '' },
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

  it('en röst avvisas när fasen är stängd, fast klockan är kvar i framtiden', async () => {
    /**
     * FASEN ÄR AUKTORITATIV DÄR DEN FINNS (uppgift 9:s granskning).
     *
     * `Election.phase` finns sedan uppgift 11 och sätts av `closeElection`.
     * En klocka som går fel ändrar beteendet tyst; en fasövergång är en
     * händelse någon utfört. Testet håller klockan kvar i framtiden just för
     * att visa att det är fasen — och inte tiden — som avgör här.
     */
    await votersDb.election.update({ where: { id: electionId }, data: { phase: 'CLOSED' } })

    const stored = await votersDb.election.findUniqueOrThrow({
      where: { id: electionId },
      select: { closesAt: true },
    })
    expect(stored.closesAt.getTime()).toBeGreaterThan(Date.now())

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

  describe('en besökare som ger upp (granskningen av uppgift 14b, MINDRE 3)', () => {
    /** Allt en ärlig röstläggning behöver, fram till anropet. */
    async function prepared() {
      const ballot = await buildBallot('bp-s')
      const envelope = await signAs(voter, ballot, await nextCastSequence(voter, ballotId))
      const shape = await getEncryptedBallotShape(ballotId)
      return { ballot, envelope, shape }
    }

    it('får sin röst prövad men inte lagd, om den ger upp efter verifieringens sista steg', async () => {
      // Förut prövades och lades rösten, fast klienten redan hade gått.
      const { ballot, envelope, shape } = await prepared()
      const controller = new AbortController()
      verificationControl.afterVerification = () => controller.abort()

      await expect(
        castEncryptedBallot(voter, electionId, ballotId, ballot, envelope, shape, controller.signal),
      ).rejects.toBeInstanceOf(VerificationAborted)
      expect(await votersDb.pendingVote.count()).toBe(0)
    })

    it('prövas inte alls om den redan har gett upp', async () => {
      const { ballot, envelope, shape } = await prepared()

      await expect(
        castEncryptedBallot(voter, electionId, ballotId, ballot, envelope, shape, AbortSignal.abort()),
      ).rejects.toBeInstanceOf(VerificationAborted)
      expect(await votersDb.pendingVote.count()).toBe(0)
    })

    it('kontrasten: med en signal som aldrig avbryts läggs rösten', async () => {
      const { ballot, envelope, shape } = await prepared()
      const signal = new AbortController().signal

      const outcome = await castEncryptedBallot(
        voter,
        electionId,
        ballotId,
        ballot,
        envelope,
        shape,
        signal,
      )
      expect(outcome.status).toBe('recorded')
      expect(await votersDb.pendingVote.count()).toBe(1)
    })
  })

  it('en röst signerad av någon annan avvisas', async () => {
    // REVIEW FOCUS 7. Raden pekar på en verklig, röstberättigad väljare och
    // passerar varje relationell kontroll — bara signaturen avslöjar den.
    const ballot = await buildBallot('bp-s')
    const envelope = await signAs(kim, ballot, 1)

    expect((await castRaw(voter, ballot, envelope)).status).toBe('invalid_signature')
  })

  describe('kedjan prövas när rösten läggs (uppgift 14f)', () => {
    /**
     * Ett kuvert som en klient byggt själv, med ett eget nyckelpar och ett
     * certifikat med väljarens personnummer. Rutten tar aldrig emot kedjan ur
     * begärans kropp, men prövningen ska hålla också om den gjorde det, och
     * den prövas därför direkt mot `castEncryptedBallot`.
     */
    async function forgedEnvelope(ballot: EncryptedBallot, chainFor: (pair: KeyPair) => string[]) {
      const forger = rsaKeys('förfalskaren')
      const signedData = envelopePayload({
        electionId,
        ballotId,
        ciphertextHash: ballot.ciphertextHash,
        castSequence: 1,
      })
      return {
        signature: signPayload(forger.privateKey, signedData),
        certificateChain: chainFor(forger),
        signedData,
      }
    }

    it('en kedja till en annan rot avvisas', async () => {
      const ballot = await buildBallot('bp-s')
      const lookalike = lookalikeHierarchy()
      const envelope = await forgedEnvelope(ballot, (pair) =>
        pemChain(voterLeaf(pair, { personalNumber: VOTER_PN, issuer: lookalike.issuer }), lookalike.intermediate),
      )

      expect((await castRaw(voter, ballot, envelope)).status).toBe('invalid_signature')
      expect(await votersDb.pendingVote.count()).toBe(0)
    })

    it('ett utgånget certifikat avvisas', async () => {
      const ballot = await buildBallot('bp-s')
      const envelope = await forgedEnvelope(ballot, (pair) =>
        pemChain(
          voterLeaf(pair, {
            personalNumber: VOTER_PN,
            notBefore: new Date(Date.now() - 30 * 86_400_000),
            notAfter: new Date(Date.now() - 86_400_000),
          }),
          MOCK_INTERMEDIATE,
        ),
      )

      expect((await castRaw(voter, ballot, envelope)).status).toBe('invalid_signature')
    })

    it('kontrasten: ett korrekt utfärdat certifikat med väljarens personnummer godtas', async () => {
      // Samma förfalskning som ovan, men med attrappens mellannivå. Det är
      // begränsningen i demoläget: mellannivåns nyckel är incheckad.
      const ballot = await buildBallot('bp-s')
      const envelope = await forgedEnvelope(ballot, (pair) =>
        pemChain(voterLeaf(pair, { personalNumber: VOTER_PN }), MOCK_INTERMEDIATE),
      )

      expect((await castRaw(voter, ballot, envelope)).status).toBe('recorded')
    })

    it('en kedja med roten i stället för mellannivån avvisas', async () => {
      // Roten får aldrig komma ur svaret. Här är den dessutom inte lövets utfärdare.
      const ballot = await buildBallot('bp-s')
      const envelope = await forgedEnvelope(ballot, (pair) =>
        pemChain(voterLeaf(pair, { personalNumber: VOTER_PN }), MOCK_ROOT),
      )

      expect((await castRaw(voter, ballot, envelope)).status).toBe('invalid_signature')
    })

    it('kedjan lagras krypterad, utan personnummer eller namn, och går bara att öppna för sin rad', async () => {
      await cast(voter, 'bp-s')

      const stored = await votersDb.pendingVote.findFirstOrThrow({
        where: { voterStatusId: voter },
        select: { bankIdCertificateChain: true, ballotId: true },
      })

      expect(stored.bankIdCertificateChain).not.toContain(VOTER_PN)
      expect(stored.bankIdCertificateChain).not.toContain('Lindqvist')
      expect(stored.bankIdCertificateChain).not.toContain('CERTIFICATE')

      const opened = openCertificateChain(stored.bankIdCertificateChain, {
        voterStatusId: voter,
        ballotId: stored.ballotId,
      })
      expect(opened?.[0]?.toLegacyObject().subject).toMatchObject({ serialNumber: VOTER_PN })
      expect(openCertificateChain(stored.bankIdCertificateChain, { voterStatusId: kim, ballotId })).toBeNull()
    })
  })

  it('en signatur för ett annat chiffer kan inte återanvändas mot ett nytt', async () => {
    /**
     * Fixrunda 1 av granskningen, fynd 1, krav 3.
     *
     * En genuint giltig, äkta signatur — riktigt undertecknad av väljaren
     * själv — för valet "bp-s" försöks lämnas in mot chiffret för "bp-m". Den
     * ska avvisas trots att den håller kryptografiskt mot SIG SJÄLV: det
     * signerade innehållet pekar på fel chiffer.
     */
    const forS = await buildBallot('bp-s')
    const forM = await buildBallot('bp-m')
    const envelopeForS = await signAs(voter, forS, 1)

    expect((await castRaw(voter, forM, envelopeForS)).status).toBe('invalid_signature')
  })

  it('ett återuppspelat äldre kuvert avvisas — den riktiga vägen', async () => {
    /**
     * REVIEW FOCUS 8, prövad så som den faktiskt uppstår (fixrunda 1 av
     * granskningen, fynd 1).
     *
     * Väljaren startar en signering i en flik ("bp-s") utan att slutföra
     * den, röstar klart i en annan flik under tiden ("bp-m"), och går sedan
     * tillbaka och slutför den första, nu inaktuella, signeringen. Den ska
     * avvisas — inte med ett missvisande `invalid_signature` (det gamla
     * felet: en färskt omräknad räknare jämfördes i stället för den som
     * faktiskt signerades), utan med `stale_sequence`, eftersom räknaren
     * som prövas nu alltid är den som verkligen skrevs under.
     *
     * `castRaw` — inte `cast` — används för den första signeringen, för att
     * kontrollera exakt det kuvert som en gång signerades, precis som
     * `/api/vote/encrypted` skulle göra när väljaren till slut slutför den
     * hängande fliken.
     */
    const started = await buildBallot('bp-s')
    // Signeringen PÅBÖRJAS (nextCastSequence anropas här, precis som
    // /api/vote/sign-start gör) men slutförs inte än — se signAs ovan.
    const staleEnvelope = await signAs(voter, started, await nextCastSequence(voter, ballotId))

    // Väljaren röstar klart i en annan flik under tiden.
    const competing = await cast(voter, 'bp-m')
    expect(competing.status).toBe('recorded')

    // Väljaren går tillbaka och slutför den första, nu inaktuella, signeringen.
    expect((await castRaw(voter, started, staleEnvelope)).status).toBe('stale_sequence')
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
      certificateChain: ['förfalskat-certifikat'],
      castSequence: 99,
    }

    const parsed = castEncryptedBallotSchema.parse(forgedBody)
    expect(parsed).not.toHaveProperty('signature')
    expect(parsed).not.toHaveProperty('certificate')
    expect(parsed).not.toHaveProperty('certificateChain')
    expect(parsed).not.toHaveProperty('castSequence')

    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const routeSource = readFileSync(
      join(process.cwd(), 'src/app/api/vote/encrypted/route.ts'),
      'utf8',
    )

    expect(routeSource).not.toMatch(/body\.data\.(signature|certificate|castSequence|signedData)/)
    expect(routeSource).toMatch(/collected\.completionData\.signature/)
    expect(routeSource).toMatch(/collected\.completionData\.certificateChain/)
    expect(routeSource).toMatch(/collected\.completionData\.signedData/)
    // castSequence får inte räknas om av rutten längre — se fixrunda 1, fynd 1.
    expect(routeSource).not.toMatch(/nextCastSequence/)
  })

  it('pendingVoteFor visar ingenting för en väljare utan liggande röst', async () => {
    expect(await pendingVoteFor(voter, ballotId)).toBeNull()
  })

  it('clearPendingVotes raderar kuverten och returnerar antalet', async () => {
    await cast(voter, 'bp-s')
    await cast(kim, 'bp-m')

    const envelopes = await votersDb.pendingVote.findMany({ select: { id: true, ciphertextHash: true } })
    const cleared = await clearPendingVotes(electionId, envelopes, votersDb)

    expect(cleared).toEqual({ removed: 2, left: 0 })
    expect(await votersDb.pendingVote.count()).toBe(0)
  })

  it('clearPendingVotes raderar bara de kuvert den får, och bara med rätt chifferhash', async () => {
    /**
     * Granskningen av uppgift 14f, K1: skalningen raderade förut allt som låg
     * på valsedlarna, också det som tillkommit eller bytts ut efter att
     * kuverten lästes. Nu raderas bara de kuvert skalningen flyttat, och ett
     * kuvert vars innehåll bytts ut är inte längre samma kuvert.
     */
    await cast(voter, 'bp-s')
    await cast(kim, 'bp-m')

    const [first, second] = await votersDb.pendingVote.findMany({
      select: { id: true, ciphertextHash: true },
      orderBy: { id: 'asc' },
    })
    const cleared = await clearPendingVotes(
      electionId,
      [first!, { id: second!.id, ciphertextHash: 'f'.repeat(64) }],
      votersDb,
    )

    expect(cleared).toEqual({ removed: 1, left: 1 })
    expect(await votersDb.pendingVote.findMany({ select: { id: true } })).toEqual([{ id: second!.id }])
  })

  describe('spärren mellan det gamla flödets bok och kuverten (uppgift 12)', () => {
    /**
     * Granskaren av uppgift 14 fann att en väljare med direkta anrop kan ha
     * både en röst i det gamla flödet, med markering i voter_ballot_status,
     * och ett kuvert på samma valsedel. Röstsidan spärrar det, men inte
     * servern. Ingen räkning dubblerar i dag, eftersom de två böckerna aldrig
     * räknas ihop, men kuvertens räkning byggs i uppgift 12, och spärren ska
     * finnas på servern innan dess. Den tas bort med det gamla flödet i
     * uppgift 15.
     */
    async function issueOldFlowCredential(voterStatusId: string) {
      const keys = await votersDb.electionBallot.findUniqueOrThrow({
        where: { id: ballotId },
        select: { signingPublicKeyPem: true },
      })
      const credential = await createBlindedCredential(keys.signingPublicKeyPem)
      return issueCredential(voterStatusId, electionId, ballotId, credential.blinded)
    }

    /**
     * Håller väljarens rad låst i en egen transaktion, som en läggning eller ett
     * utfärdande mitt i sin skrivning, i samma läge som de tar raden: läggningen
     * med FOR SHARE och utfärdandet med FOR NO KEY UPDATE.
     */
    function holdVoterRow(
      voterStatusId: string,
      as: 'envelope' | 'old-flow',
      write: (tx: typeof votersDb) => Promise<unknown>,
    ) {
      let release!: () => void
      let locked!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      const lockTaken = new Promise<void>((resolve) => (locked = resolve))
      const done = votersDb.$transaction(
        async (tx) => {
          if (as === 'envelope') {
            await tx.$queryRaw`SELECT 1 AS locked FROM voter_status WHERE id = ${voterStatusId} FOR SHARE`
          } else {
            await tx.$queryRaw`SELECT 1 AS locked FROM voter_status WHERE id = ${voterStatusId} FOR NO KEY UPDATE`
          }
          await write(tx as unknown as typeof votersDb)
          locked()
          await released
        },
        { timeout: 30_000 },
      )
      return { lockTaken, release, done }
    }

    it('ett kuvert tas inte emot från en väljare som röstat i det gamla flödet', async () => {
      expect(await issueOldFlowCredential(voter)).toMatchObject({ status: 'issued' })

      expect(await cast(voter, 'bp-s')).toEqual({ status: 'voted_in_old_flow' })
      expect(await pendingVoteFor(voter, ballotId)).toBeNull()
    })

    it('det gamla flödet utfärdar inget röstintyg till en väljare med ett liggande kuvert', async () => {
      expect((await cast(voter, 'bp-s')).status).toBe('recorded')

      expect(await issueOldFlowCredential(voter)).toEqual({ status: 'envelope_cast' })
      expect(await votersDb.voterBallotStatus.count({ where: { voterStatusId: voter } })).toBe(0)
    })

    it('det gamla flödet utfärdar inget röstintyg till en väljare vars kuvert redan flyttats till urnan', async () => {
      // Efter stängningen ligger kuvertet inte längre i röstlängden, men
      // markeringen "har röstat" säger att det räknas.
      expect((await cast(voter, 'bp-s')).status).toBe('recorded')
      const past = new Date(Date.now() - 60_000)
      await votersDb.election.update({ where: { id: electionId }, data: { closesAt: past } })
      await votesDb.election.update({ where: { id: electionId }, data: { closesAt: past } })
      expect(await closeAndStrip(electionId)).toMatchObject({ status: 'closed' })
      expect(await votersDb.votedMarker.count({ where: { voterStatusId: voter } })).toBe(1)

      expect(await issueOldFlowCredential(voter)).toEqual({ status: 'envelope_cast' })
      expect(await votersDb.voterBallotStatus.count({ where: { voterStatusId: voter } })).toBe(0)
    })

    it('en annan väljares bok påverkar ingenting', async () => {
      expect(await issueOldFlowCredential(kim)).toMatchObject({ status: 'issued' })
      expect((await cast(voter, 'bp-s')).status).toBe('recorded')
      expect(await issueOldFlowCredential(kim)).toEqual({ status: 'already_issued' })
    })

    it('ett kuvert som läggs medan det gamla flödet utfärdar väntar, och avvisas sedan', async () => {
      /**
       * Utan ett gemensamt lås läser läggningen och utfärdandet var sin tabell
       * och ser inte varandras oskrivna rader, så båda hade gått igenom.
       * Utfärdandet härmas här av en transaktion som håller väljarens rad och
       * har skrivit markeringen men inte gjort COMMIT. Läggningen ska vänta på
       * raden och sedan se markeringen.
       */
      const issuing = holdVoterRow(voter, 'old-flow', (tx) =>
        tx.voterBallotStatus.create({ data: { voterStatusId: voter, ballotId, votedAt: new Date() } }),
      )
      try {
        await issuing.lockTaken

        let settled = false
        const casting = cast(voter, 'bp-s').finally(() => {
          settled = true
        })
        await new Promise((resolve) => setTimeout(resolve, 2_500))
        expect(settled, 'läggningen väntade inte på väljarens rad').toBe(false)

        issuing.release()
        await issuing.done
        expect(await casting).toEqual({ status: 'voted_in_old_flow' })
        expect(await pendingVoteFor(voter, ballotId)).toBeNull()
      } finally {
        issuing.release()
        await issuing.done.catch(() => undefined)
      }
    })

    it('ett utfärdande medan ett kuvert läggs väntar, och avvisas sedan', async () => {
      const ballot = await buildBallot('bp-m')
      const laying = holdVoterRow(voter, 'envelope', (tx) =>
        tx.pendingVote.create({
          data: {
            voterStatusId: voter,
            ballotId,
            ciphertext: ballot.ciphertext,
            proofs: ballot.proofs,
            ciphertextHash: ballot.ciphertextHash,
            castSequence: 1,
            bankIdSignature: 'x',
            bankIdCertificateChain: 'x',
            updatedAt: new Date(),
          },
        }),
      )
      try {
        await laying.lockTaken

        let settled = false
        const issuing = issueOldFlowCredential(voter).finally(() => {
          settled = true
        })
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        expect(settled, 'utfärdandet väntade inte på väljarens rad').toBe(false)

        laying.release()
        await laying.done
        expect(await issuing).toEqual({ status: 'envelope_cast' })
        expect(await votersDb.voterBallotStatus.count({ where: { voterStatusId: voter } })).toBe(0)
      } finally {
        laying.release()
        await laying.done.catch(() => undefined)
      }
    })
  })
})
