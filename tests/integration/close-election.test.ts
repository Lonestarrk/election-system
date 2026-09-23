import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '.prisma/voters'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import {
  abortedMessageFor,
  closeElection,
  CloseAbortedError,
  envelopeRootOf,
  idForEnvelope,
  linkStateOf,
} from '@/orchestration/close-election.usecase'
import { describeErrorChain } from '@/lib/logger'
import { certifyElection, runFinalCheck } from '@/orchestration/final-check.usecase'
import { canonicalOptions, type BallotOption } from '@/lib/crypto/ballot-encoding'
import { encryptBallot } from '@/lib/encrypt-client'
import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'
import {
  MockBankIdService,
  selectDemoIdentity,
} from '@/modules/eligibility/bankid/MockBankIdService'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import { envelopePayload } from '@/modules/eligibility/bankid/envelope-signature'
import {
  castEncryptedBallot,
  nextCastSequence,
  type SignedEnvelope,
} from '@/modules/eligibility/pending-vote.service'
import { createVoter, disconnect, isDatabaseAvailable, resetElectionData } from './helpers'

/**
 * EN KONSTRUERAD TYST ROLLBACK (fixrunda 2, uppgift 11).
 *
 * Felet som en gång fanns: `recordAuditEvent` svalde ett fel som uppstått
 * inuti `closeElection`s transaktion. PostgreSQL hade då redan avbrutit
 * transaktionen, COMMIT gjordes om till ROLLBACK utan att fela, och
 * `$transaction` RESOLVADE — varpå stängningen svarade `closed` med kuverten
 * kvar och roten oskriven.
 *
 * Wrappern nedan härmar exakt den vägen, på begäran: den kör en sats som
 * avbryter transaktionen och sväljer felet, precis som svälj-grenen gjorde.
 * Felet konstrueras alltså i stället för att inväntas — det ursprungliga
 * utlösandet krävde en samtidig revisionsskrivning, vilket är en
 * tidssammanträffning ett test aldrig ska hänga på.
 *
 * Alla andra anrop går till den äkta funktionen, så resten av sviten — och
 * `validateBeforeClose`s egen revisionspost — är opåverkade.
 */
const auditControl = vi.hoisted(() => ({ poisonTransaction: false }))

vi.mock('@/modules/eligibility/audit.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/modules/eligibility/audit.service')>()

  return {
    ...actual,
    recordAuditEvent: async (eventType: string, client?: unknown) => {
      if (auditControl.poisonTransaction && client) {
        try {
          await (
            client as { $queryRawUnsafe: (sql: string) => Promise<unknown> }
          ).$queryRawUnsafe('select 1 / 0')
        } catch {
          // Svälj — det är hela poängen. Transaktionen är nu avbruten, men
          // anroparen får aldrig veta det.
        }
        return
      }

      return actual.recordAuditEvent(eventType as never, client as never)
    },
  }
})

/**
 * Låter efterkontrollens EGEN läsning fallera (fixrunda 3).
 *
 * `closeStateOf` är den läsning `closeElection` gör EFTER den oåterkalleliga
 * commiten. Fallerar den — tappad anslutning, pool-timeout, en omstart mellan
 * COMMIT och SELECT — har stängningen kanske gått igenom, kanske inte, och
 * beskedet får inte påstå att kopplingen är orörd.
 *
 * Bara `closeStateOf` byts ut. Resten av modulen går till den äkta
 * implementationen, så `mirrorElection` (som `createElection` i `beforeEach`
 * använder) och allt annat är opåverkat.
 */
const electionServiceControl = vi.hoisted(() => ({ failCloseStateRead: false }))

vi.mock('@/modules/eligibility/election.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/modules/eligibility/election.service')>()

  return {
    ...actual,
    closeStateOf: async (electionId: string) => {
      if (electionServiceControl.failCloseStateRead) {
        throw new Error('anslutningen mot röstlängden tappades')
      }

      return actual.closeStateOf(electionId)
    },
  }
})

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
  const SAM_PN = '196408083456'
  const VERA_PN = '198812247890'

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
  let sam: string
  let vera: string

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
    auditControl.poisonTransaction = false
    electionServiceControl.failCloseStateRead = false
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
    sam = await createSignedVoter(SAM_PN)
    vera = await createSignedVoter(VERA_PN)

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
  async function castFor(voterStatusId: string, party: 'bp-s' | 'bp-m'): Promise<string> {
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

      // Läggningsordningen, som testet av infogningsordningen behöver.
      return ballot.ciphertextHash
    } finally {
      await setClosesAt(electionId, new Date(Date.now() - 60_000))
    }
  }

  function isSorted(values: string[]): boolean {
    return values.every((value, index) => index === 0 || values[index - 1]! <= value)
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
    /**
     * Insättningsordningen får inte avslöja i vilken ordning folk röstade —
     * annars kan den som vet när någon legitimerade sig peka ut hens rad.
     *
     * TESTET LÄSER `ctid`, INTE `id`. Det är avsiktligt och bär hela
     * bevisvärdet. `id` härleds ur chifferhashen, så `order by id` ÄR
     * chifferhashordning oavsett i vilken ordning raderna infogades — en
     * assertion på den ordningen kan inte fallera och bevakar ingenting.
     * `ctid` är radens fysiska plats och speglar den ordning `createMany`
     * skickade arrayen i, alltså exakt det som ska prövas: arrayen kommer ur
     * en `findMany` utan `orderBy` och ligger därför i praktiken i
     * läggningsordning. Sorteringen i `closeElection` är det enda som stänger
     * den kanalen.
     *
     * `ctid` är avsiktligt Postgres-specifik. Den rör sig vid `VACUUM FULL`
     * och vid en `UPDATE`, men är trogen i en tabell som bara tar emot en enda
     * `INSERT` och sedan läses. Den bär hela testets bevisvärde och tål inte
     * att tystna: byts lagringen ut måste testet skrivas om, inte tas bort.
     *
     * FEM KUVERT, INTE TRE. Med tre är sannolikheten 1 på 6 att en osorterad
     * infogning ändå råkar se sorterad ut; med fem är den 1 på 120.
     */
    const castOrder = [
      await castFor(anna, 'bp-s'),
      await castFor(kim, 'bp-m'),
      await castFor(robin, 'bp-s'),
      await castFor(sam, 'bp-m'),
      await castFor(vera, 'bp-s'),
    ]

    /**
     * Läggningsordningen är slumpmässig — chiffret randomiseras — och kan
     * därför råka vara sorterad redan. Då hade testet varit vakuöst: det
     * skulle passera lika bra utan sorteringen i `closeElection`. Sista
     * kuvertet läggs om tills ordningen är osorterad, vilket ger det en ny
     * slumpad chifferhash.
     */
    for (let attempt = 0; attempt < 5 && isSorted(castOrder); attempt += 1) {
      castOrder[castOrder.length - 1] = await castFor(vera, 'bp-s')
    }
    expect(isSorted(castOrder), 'läggningsordningen var redan sorterad').toBe(false)

    await closeElection(electionId)

    const rows = await votesDb.$queryRawUnsafe<Array<{ ciphertext_hash: string }>>(
      'select ciphertext_hash from encrypted_vote order by ctid',
    )
    const stored = rows.map((row) => row.ciphertext_hash)

    expect(stored).toEqual([...castOrder].sort())
  })

  it('radens id härleds ur chifferhashen, inte ur slumpen', async () => {
    /**
     * Det som det gamla `order by id`-testet i själva verket prövade.
     *
     * Ett slumpat id hade gjort primärnyckelns ordning oberoende av
     * innehållet, och därmed gjort den sorterade infogningen verkningslös för
     * alla som läser tabellen sorterad i stället för i fysisk ordning.
     */
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')
    await closeElection(electionId)

    const rows = await votesDb.encryptedVote.findMany({
      select: { id: true, ciphertextHash: true },
    })

    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.id).toBe(idForEnvelope(row.ciphertextHash))
    }
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

  it('en omkörning efter ett krascherfönster rör inte den publicerade roten', async () => {
    /**
     * DEN ENDA OÅTERKALLELIGA FÖRLUSTEN I HELA FLÖDET, VAKTAD.
     *
     * Kraschar processen efter att kopplingen raderats men innan fasövergången
     * skrivits, står omröstningen kvar i OPEN utan ett enda `PendingVote`.
     * Omkörningen läser då noll kuvert och passerar valideringen — noll rader
     * ger noll avvikelser — och skulle med en tidig rotskrivning ha ersatt den
     * äkta roten med roten över ingenting, innan antalskontrollen hinner
     * avbryta. Roten går inte att räkna om: signaturerna är borta.
     *
     * Testet återskapar exakt det tillståndet och kräver att roten är
     * OFÖRÄNDRAD efteråt.
     */
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')
    expect((await closeElection(electionId)).status).toBe('closed')

    const before = await votersDb.election.findUniqueOrThrow({
      where: { id: electionId },
      select: { envelopeRoot: true },
    })

    // Fönstret: kopplingen är borta, men fasövergången hann aldrig skrivas.
    await votersDb.election.update({
      where: { id: electionId },
      data: { phase: 'OPEN', linkClearedAt: null },
    })

    await expect(closeElection(electionId)).rejects.toThrow()

    const after = await votersDb.election.findUniqueOrThrow({
      where: { id: electionId },
      select: { envelopeRoot: true },
    })

    expect(after.envelopeRoot).toBe(before.envelopeRoot)
    expect(after.envelopeRoot).not.toBe(envelopeRootOf([]))
    // Chiffren ligger kvar — omkörningen fick inte radera dem heller.
    expect(await votesDb.encryptedVote.count()).toBe(2)
  })

  it('att kopplingen raderats hamnar i revisionsloggen', async () => {
    // Den enda oåterkalleliga händelsen i systemet får inte ske tyst.
    await castFor(anna, 'bp-s')
    await closeElection(electionId)

    const events = await votersDb.auditEvent.findMany({ orderBy: { sequence: 'desc' }, take: 1 })
    expect(events[0]!.eventType).toBe('LINK_CLEARED')
  })

  it('slutkontrollen låser inte ett val som ännu inte skalats', async () => {
    /**
     * `link_cleared` är KRITISK först efter skalningen.
     *
     * Ett val som ännu inte stängts HAR liggande kopplingar — det är
     * normaltillståndet, inte en avvikelse. Vore kontrollen ovillkorligt
     * kritisk skulle `certifyElection` sätta valet i UNDER_REVIEW, ett
     * tillstånd som inte går att lämna via applikationen. En administratör som
     * trycker en dag för tidigt skulle då ha gjort valet omöjligt att
     * fastställa.
     */
    await castFor(anna, 'bp-s')

    const report = await runFinalCheck(electionId)
    const check = report!.checks.find((candidate) => candidate.id === 'link_cleared')!

    expect(check.passed).toBe(false)
    expect(check.severity).toBe('PRECONDITION')
    expect(report!.anomalous).toBe(false)

    const outcome = await certifyElection(electionId)
    expect(outcome.status).toBe('not_ready')

    const stored = await votesDb.election.findUniqueOrThrow({
      where: { id: electionId },
      select: { status: true },
    })
    expect(stored.status).toBe('OPEN')
  })

  it('revisionsskrivningen kastar inuti en transaktion i stället för att svälja felet', async () => {
    /**
     * SVÄLJ-GRENEN ÄR RÄTT FÖR EN VÄLJARE OCH FEL FÖR EN TRANSAKTION.
     *
     * Utanför en transaktion ska `recordAuditEvent` aldrig stoppa någon från
     * att rösta — den loggar och går vidare. Fick den en klient inskickad kör
     * den däremot inuti någon annans transaktion, där ett svalt fel förstör
     * anroparens atomicitetskontrakt: PostgreSQL har redan avbrutit
     * transaktionen, COMMIT görs om till ROLLBACK utan att fela, och anroparen
     * tror att allt gick bra.
     *
     * Transaktionen förgiftas här med flit, precis som en samtidig
     * revisionsskrivning hade gjort i drift. Felet som når `recordAuditEvent`
     * är då 25P02 — ett fel UTAN Prismas `code`-fält, alltså inte den
     * unikhetskonflikt slingan retas med. Varje sådant fel ska lämnas vidare.
     */
    await expect(
      votersDb.$transaction(async (tx) => {
        try {
          await tx.$queryRawUnsafe('select 1 / 0')
        } catch {
          // Transaktionen är nu avbruten. Anroparen vet ännu ingenting.
        }

        await recordAuditEvent(AUDIT_EVENTS.LINK_CLEARED, tx)
      }),
    ).rejects.toThrow()
  })

  it('påstår inte att kopplingen raderats när transaktionen tyst rullat tillbaka', async () => {
    /**
     * DET MEST KONSEKVENSRIKA BESKED SYSTEMET KAN GE MÅSTE VARA KONTROLLERAT.
     *
     * Med en tyst rollback ser `closeElection` ut att ha lyckats: `$transaction`
     * resolvar, `cleared` är ett trovärdigt tal, och ingenting har felat. Men
     * kuverten ligger kvar, roten är oskriven och fasen står i OPEN. Utan en
     * kontroll av det faktiska utfallet hade funktionen svarat `closed` — och
     * rutten 200 med beskedet att valhemligheten uppstått.
     *
     * Testet kräver att stängningen INTE rapporterar `closed`, och att
     * röstlängden är orörd efteråt. Rutten svarar 200 bara i `closed`-grenen,
     * så ett kast fångas i stället av dess 409-gren ("kopplingen är ORÖRD").
     */
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')

    auditControl.poisonTransaction = true

    await expect(closeElection(electionId)).rejects.toThrow()

    const election = await votersDb.election.findUniqueOrThrow({
      where: { id: electionId },
      select: { phase: true, envelopeRoot: true, linkClearedAt: true },
    })

    // Ingenting av det transaktionen påstod sig ha gjort finns kvar.
    expect(election.phase).toBe('OPEN')
    expect(election.envelopeRoot).toBeNull()
    expect(election.linkClearedAt).toBeNull()
    expect(await votersDb.pendingVote.count()).toBe(2)

    /**
     * Och stängningen går att köra om när felet är åtgärdat — det är hela
     * skälet att kasta i stället för att fortsätta.
     */
    auditControl.poisonTransaction = false
    expect((await closeElection(electionId)).status).toBe('closed')
    expect(await votersDb.pendingVote.count()).toBe(0)
  })

  it('påstår inte att kopplingen är orörd när utfallet inte gick att läsa tillbaka', async () => {
    /**
     * SAMMA KLASS AV FEL SOM RESTEN AV UPPGIFTEN, FAST ÅT ANDRA HÅLLET.
     *
     * Efterkontrollens läsning ligger efter den oåterkalleliga commiten.
     * Fallerar den av någon annan orsak än utfallet kastar `closeElection`
     * trots att transaktionen gick igenom — och beskedet "kopplingen är ORÖRD"
     * vore då falskt, visat för en administratör i precis det ögonblick det
     * betyder som mest.
     *
     * Testet låter läsningen fallera efter en stängning som VERKLIGEN gick
     * igenom, och kräver att beskedet inte påstår något det inte vet.
     */
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')

    electionServiceControl.failCloseStateRead = true

    const error = await closeElection(electionId).then(
      () => null,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(CloseAbortedError)
    expect((error as CloseAbortedError).linkState).toBe('unknown')

    // Stängningen gick i själva verket igenom — påståendet om motsatsen hade
    // alltså varit falskt.
    expect(await votersDb.pendingVote.count()).toBe(0)
    expect(await votesDb.encryptedVote.count()).toBe(2)

    /**
     * ORSAKEN FÅR INTE FÖRSVINNA I OMPAKETERINGEN.
     *
     * `abortedMessageFor` lovar att det som gick fel framgår av serverloggen.
     * Löftet håller bara om `cause` följer med — och det är precis vad
     * ompaketeringen tappade innan `describeErrorChain` fanns.
     */
    expect(describeErrorChain(error)).toContain('anslutningen mot röstlängden tappades')

    const besked = abortedMessageFor(error)
    expect(besked).not.toContain('ORÖRD')
    expect(besked).not.toContain('innan något raderades')
    expect(besked).toContain('KAN ha gått igenom')
    expect(besked).toContain('fas')

    // Och en omkörning är ofarlig, precis som beskedet lovar.
    electionServiceControl.failCloseStateRead = false
    expect((await closeElection(electionId)).status).toBe('already_closed')
  })

  it('ett godtyckligt fel före transaktionen säger rakt ut att kopplingen är orörd', async () => {
    /**
     * GRÄNSEN, INTE UPPRÄKNINGEN.
     *
     * De vanligaste verkliga felen bor före transaktionen — databasen nere
     * under valideringen, en läsning som inte går igenom. De lämnar kopplingen
     * bevisbart orörd, och beskedet ska säga det: ett "kan ha gått igenom" där
     * hade fått en administratör att tveka i onödan just när systemet är som
     * mest stressat.
     *
     * Felet här är inte konstruerat via en mock utan är en äkta kastväg: den
     * inledande `findUniqueOrThrow` på en omröstning som inte finns. Poängen
     * är att den INTE är en `CloseAbortedError` från början — påståendet sätts
     * av var i flödet den uppstod, inte av vem som kastade.
     */
    await castFor(anna, 'bp-s')

    const error = await closeElection('00000000-0000-0000-0000-000000000000').then(
      () => null,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(CloseAbortedError)
    expect(linkStateOf(error)).toBe('untouched')
    expect(abortedMessageFor(error)).toContain('ORÖRD')

    // Och orsaken finns kvar i kedjan, inte bara i det yttersta lagret.
    expect(describeErrorChain(error)).toContain('orsakat av')

    // Kopplingen ligger faktiskt kvar, precis som beskedet påstår.
    expect(await votersDb.pendingVote.count()).toBe(1)
  })

  it('säger däremot rakt ut att kopplingen är orörd när det ÄR kontrollerat', async () => {
    // Motstycket: den kontrollerade vägen ska inte ha blivit försiktigare än
    // den behöver vara. Antalskontrollen i steg 5 vet att ingenting raderats.
    await castFor(anna, 'bp-s')
    // Ett chiffer som redan ligger i röstdatabasen med en ANNAN hash gör att
    // antalet inte kan stämma: kuvertet flyttas, men räkningen ser en rad för
    // mycket på valsedeln.
    await votesDb.encryptedVote.create({
      data: {
        id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
        ballotId,
        ciphertext: [],
        proofs: {},
        ciphertextHash: 'en-hash-som-inte-hor-till-nagot-kuvert',
      },
    })

    const error = await closeElection(electionId).then(
      () => null,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(CloseAbortedError)
    expect((error as CloseAbortedError).linkState).toBe('untouched')
    expect(abortedMessageFor(error)).toContain('ORÖRD')

    // Och kopplingen ligger faktiskt kvar, precis som beskedet påstår.
    expect(await votersDb.pendingVote.count()).toBe(1)
  })

  it('slutkontrollen är kritisk om en koppling finns kvar EFTER skalningen', async () => {
    await castFor(anna, 'bp-s')
    expect((await closeElection(electionId)).status).toBe('closed')

    // Någon skriver tillbaka en koppling efter att raderingen påståtts vara gjord.
    await stuffVoteFor(kim, 'bp-m')

    const report = await runFinalCheck(electionId)
    const check = report!.checks.find((candidate) => candidate.id === 'link_cleared')!

    expect(check.passed).toBe(false)
    expect(check.severity).toBe('CRITICAL')
    expect(report!.anomalous).toBe(true)
  })
})
