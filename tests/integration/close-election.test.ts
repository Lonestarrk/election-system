import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Prisma } from '.prisma/voters'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import { closeElection, envelopeRootOf } from '@/orchestration/close-election.usecase'
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
 * Uppgift 11: stängningen — den punkt där valhemligheten uppstår.
 *
 * Allt före den är återställbart: kuvertet ligger kvar i röstlängden med
 * väljarens identitet bredvid, och kan bytas ut ända fram till stängningen.
 * Efter den finns ingen väljare kvar att fråga och ingen signatur kvar att
 * kontrollera — bara chiffren på den anonyma sidan och den publicerade
 * kuvertroten.
 *
 * Testerna prövar därför inte bara att flytten SKER, utan i vilken ORDNING
 * den sker: roten beräknas medan signaturerna finns, infogningen sker före
 * raderingen, och raderna skrivs i innehållets ordning — inte i den ordning
 * väljarna röstade.
 */

const databaseAvailable = await isDatabaseAvailable()

if (!databaseAvailable) {
  process.stderr.write('\n  Ingen databas tillgänglig — integrationstesterna hoppas över.\n')
}

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

describe.skipIf(!databaseAvailable)('stängningen skalar bort det yttre kuvertet', () => {
  const ANNA_PN = '199001011234'
  const KIM_PN = '198505152345'
  const ROBIN_PN = '197012125678'

  let electionId: string
  let ballotId: string
  let openElectionId: string
  let publicKey: string
  let options: BallotOption[]
  let bpS: string
  let bpM: string

  let anna: string
  let kim: string
  let robin: string

  /** Vilket personnummer en testväljares voterStatusId hör till — för `signAs`. */
  const personalNumberByVoter = new Map<string, string>()

  async function createSignedVoter(personalNumber: string): Promise<string> {
    const id = await createVoter(personalNumber)
    personalNumberByVoter.set(id, personalNumber)
    return id
  }

  /**
   * Flyttar klockan i BÅDA speglingarna.
   *
   * `closeElection` läser röstlängdens spegling, men en omröstning vars två
   * sidor säger olika saker om samma tidpunkt vore ett testfixtur som inte
   * liknar något verkligt tillstånd.
   */
  async function setClosesAt(id: string, at: Date): Promise<void> {
    await votersDb.election.update({ where: { id }, data: { closesAt: at } })
    await votesDb.election.update({ where: { id }, data: { closesAt: at } })
  }

  beforeEach(async () => {
    await resetElectionData()

    // Partiregistret är delad referensdata och tas inte bort av
    // resetElectionData — S och M seedas där redan, se helpers.ts.
    const s = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'S' } })
    const m = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'M' } })

    const outcome = await createElection({
      name: 'Stängningstest',
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

    const stillOpen = await createElection({
      name: 'Fortfarande öppet',
      kind: 'RIKSDAGSVAL',
      opensAt: new Date(Date.now() - 60_000),
      closesAt: new Date(Date.now() + 3_600_000),
      ballots: [
        {
          kind: 'RIKSDAG',
          label: 'Riksdagen',
          allowsCandidateVote: false,
          parties: [{ partyId: s.id }],
        },
      ],
      trusteePassphrases: ['test-fras-ett', 'test-fras-tva', 'test-fras-tre'],
    })
    if (stillOpen.status !== 'created') throw new Error('Kunde inte skapa den öppna omröstningen.')
    openElectionId = stillOpen.election.id

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
      parties: parties.map((party, index) => ({
        id: party.id,
        displayOrder: index,
        candidates: [],
      })),
    })

    personalNumberByVoter.clear()
    anna = await createSignedVoter(ANNA_PN)
    kim = await createSignedVoter(KIM_PN)
    robin = await createSignedVoter(ROBIN_PN)

    /**
     * Omröstningen ligger som stängd genom hela sviten.
     *
     * Varje test här stänger den, och `closeElection` vägrar innan `closesAt`
     * passerats. Röstläggningen kräver tvärtom en öppen klocka — den öppnas
     * därför bara så länge ett kuvert faktiskt läggs, se `castFor`.
     */
    await setClosesAt(electionId, new Date(Date.now() - 60_000))
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
   * från.
   */
  async function signAs(
    voterStatusId: string,
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
        ballotId,
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

  /**
   * Genomför en fullständig, ärlig röstläggning.
   *
   * Klockan öppnas bara så länge kuvertet läggs och ställs tillbaka direkt
   * efteråt — se kommentaren i `beforeEach`.
   */
  async function castFor(voterStatusId: string, party: 'bp-s' | 'bp-m'): Promise<void> {
    await setClosesAt(electionId, new Date(Date.now() + 3_600_000))

    try {
      const ballot = await buildBallot(party)
      const castSequence = await nextCastSequence(voterStatusId, ballotId)
      const envelope = await signAs(voterStatusId, ballot.ciphertextHash, castSequence)
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
    } finally {
      await setClosesAt(electionId, new Date(Date.now() - 60_000))
    }
  }

  /**
   * DET HÅL SOM BARA SIGNATUREN STÄNGER — skriven direkt i databasen.
   *
   * Raden pekar på en verklig väljare och bär ett fullt giltigt chiffer med
   * rätt hash, så varje relationell kontroll och själva valsedelsbeviset
   * håller. Bara signaturkontrollen avslöjar att väljaren aldrig godkänt
   * innehållet — det är alltså precis den avvikelse valideringen finns för.
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

  it('flyttar chiffren och raderar kopplingen', async () => {
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')

    const outcome = await closeElection(electionId)

    expect(outcome).toMatchObject({ status: 'closed', moved: 2, cleared: 2 })
    expect(await votersDb.pendingVote.count()).toBe(0)
    expect(await votesDb.encryptedVote.count()).toBe(2)
  })

  it('vägrar innan closesAt', async () => {
    expect((await closeElection(openElectionId)).status).toBe('too_early')
  })

  it('en omkörning skapar inga dubbletter och tappar inga röster', async () => {
    /**
     * REVIEW FOCUS 3.
     *
     * Flytten går över en databasgräns och kan därför inte vara en transaktion —
     * det är fysiskt omöjligt, vilket är själva poängen med separationen.
     * Idempotensen bär i stället: infogningen är nyckelfri på ciphertextHash.
     */
    await castFor(anna, 'bp-s')
    await closeElection(electionId)
    const after = await closeElection(electionId)

    expect(after.status).toBe('already_closed')
    expect(await votesDb.encryptedVote.count()).toBe(1)
  })

  it('infogar sorterat på innehåll, inte i den ordning väljarna röstade', async () => {
    // Insättningsordningen får inte avslöja i vilken ordning folk röstade —
    // annars kan den som vet när någon legitimerade sig peka ut hens rad.
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')
    await castFor(robin, 'bp-s')
    await closeElection(electionId)

    const hashes = (
      await votesDb.encryptedVote.findMany({
        orderBy: { id: 'asc' },
        select: { ciphertextHash: true },
      })
    ).map((row) => row.ciphertextHash)

    expect(hashes).toEqual([...hashes].sort())
  })

  it('publicerar en kuvertrot INNAN signaturerna raderas', async () => {
    /**
     * Spec 7.3. Roten är det enda som överlever, så den måste beräknas medan
     * signaturerna finns. Ett test som bara kontrollerar att roten finns EFTERÅT
     * skulle passera även om den beräknats över en tom mängd.
     */
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')

    const outcome = await closeElection(electionId)

    expect(outcome).toMatchObject({ status: 'closed' })
    const election = await votersDb.election.findUniqueOrThrow({ where: { id: electionId } })

    expect(election.envelopeRoot).toMatch(/^[0-9a-f]{64}$/)
    // Roten ska vara den över de två faktiska kuverten, inte över ingenting.
    expect(election.envelopeRoot).not.toBe(envelopeRootOf([]))
  })

  it('vägrar skala när valideringen hittar en avvikelse', async () => {
    // Spärren, inte rapporten. Skalningen får inte köra över ett fynd.
    await stuffVoteFor(kim, 'bp-m')

    const outcome = await closeElection(electionId)

    expect(outcome.status).toBe('validation_failed')
    expect(await votersDb.pendingVote.count()).toBeGreaterThan(0)
    expect(await votesDb.encryptedVote.count()).toBe(0)
  })

  it('avvisar hela stängningen om en valsedel inte längre verifierar', async () => {
    await castFor(anna, 'bp-s')
    await votersDb.$executeRaw`update pending_vote set ciphertext_hash = 'fel'`

    expect((await closeElection(electionId)).status).toBe('invalid_ballot')
    expect(await votersDb.pendingVote.count()).toBe(1)
  })
})
