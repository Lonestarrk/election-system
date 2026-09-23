import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '.prisma/votes'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import { closeElection, idForEnvelope } from '@/orchestration/close-election.usecase'
import { canonicalOptions, type BallotOption } from '@/lib/crypto/ballot-encoding'
import { encryptBallot } from '@/lib/encrypt-client'
import {
  MockBankIdService,
  selectDemoIdentity,
} from '@/modules/eligibility/bankid/MockBankIdService'
import { envelopePayload } from '@/modules/eligibility/bankid/envelope-signature'
import {
  castEncryptedBallot,
  nextCastSequence,
} from '@/modules/eligibility/pending-vote.service'
import { GET } from '@/app/api/demo/database-state/route'
import type { DatabaseState } from '@/app/api/demo/database-state/route'
import { createVoter, disconnect, isDatabaseAvailable, resetElectionData, voteOnce } from './helpers'

/**
 * ARKITEKTURSIDANS LIVEVY: VAD RUTTEN FAKTISKT LÄMNAR UT.
 *
 * Livevyn är den enda plats där röstlängdens innehåll visas, så rutten bakom
 * den prövas mot riktiga databaser och en riktig stängning:
 *
 *   – före stängningen syns kopplingen i pending_vote, och chiffret bredvid
 *     går inte att läsa;
 *   – efter stängningen är raden borta, och chiffret ligger i encrypted_vote
 *     utan någon kolumn som pekar på en väljare;
 *   – en stängning som avbrutits efter flytten syns, i stället för att döljas;
 *   – inga fullständiga värden och inga hemligheter lämnar rutten;
 *   – utanför demoläget finns rutten inte.
 */

/**
 * Demoläget går att slå av för ett enskilt test.
 *
 * Rutten läser `bankIdIsMocked` vid varje anrop, och vitest översätter
 * importen till en läsning ur modulen i samma ögonblick. En getter räcker
 * därför. Allt annat i modulen är det äkta.
 */
const bankIdControl = vi.hoisted(() => ({ mocked: true }))

vi.mock('@/modules/eligibility/bankid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/eligibility/bankid')>()
  return {
    ...actual,
    get bankIdIsMocked() {
      return bankIdControl.mocked
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

/** Så som rutten avkortar: tolv tecken och ett utelämningstecken. */
function shortened(value: string): string {
  return `${value.slice(0, 12)}…`
}

async function readState(): Promise<DatabaseState> {
  const response = await GET()
  expect(response.status).toBe(200)
  return (await response.json()) as DatabaseState
}

function isSorted(values: string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! <= value)
}

describe.skipIf(!databaseAvailable)('livevyns underlag, /api/demo/database-state', () => {
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

  /** Flyttar klockan i båda speglingarna, som stängningstesterna gör. */
  async function setClosesAt(at: Date): Promise<void> {
    await votersDb.election.update({ where: { id: electionId }, data: { closesAt: at } })
    await votesDb.election.update({ where: { id: electionId }, data: { closesAt: at } })
  }

  beforeEach(async () => {
    bankIdControl.mocked = true
    await resetElectionData()

    const s = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'S' } })
    const m = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'M' } })

    const outcome = await createElection({
      name: 'Livevyns testval',
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

    anna = await createVoter(ANNA_PN)
    kim = await createVoter(KIM_PN)
    robin = await createVoter(ROBIN_PN)

    personalNumberByVoter.clear()
    personalNumberByVoter.set(anna, ANNA_PN)
    personalNumberByVoter.set(kim, KIM_PN)
    personalNumberByVoter.set(robin, ROBIN_PN)
  })

  afterEach(() => {
    bankIdControl.mocked = true
  })

  /** En fullständig, ärlig röstläggning med BankID-attrappens /sign. */
  async function castFor(voterStatusId: string, party: 'S' | 'M'): Promise<string> {
    const ballot = encryptBallot(publicKey, electionId, ballotId, options, {
      kind: 'PARTY',
      ballotPartyId: party === 'S' ? bpS : bpM,
    })
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
        certificate: result.completionData.certificate,
        signedData: result.completionData.signedData,
      },
      await getEncryptedBallotShape(ballotId),
    )
    if (outcome.status !== 'recorded') throw new Error(`Kunde inte lägga rösten (${outcome.status}).`)

    return ballot.ciphertextHash
  }

  it('finns inte utanför demoläget', async () => {
    /**
     * Svaret är röstlängden. I skarpt läge får ingen sida visa den, och det
     * räcker inte att arkitektursidan låter bli att fråga: rutten ska inte
     * svara. 404 och inte 403, som de andra rutterna under /api/demo.
     */
    await castFor(anna, 'S')
    bankIdControl.mocked = false

    const response = await GET()
    const body = JSON.stringify(await response.json())

    expect(response.status).toBe(404)
    expect(body).not.toContain(shortened(anna))
    expect(body).not.toMatch(/voterStatus|pendingVote|encryptedVote/)
  })

  it('före stängningen: kopplingen syns i pending_vote, och chiffret går inte att läsa', async () => {
    const annasHash = await castFor(anna, 'S')
    await castFor(kim, 'M')

    const state = await readState()

    // Kopplingen: raden pekar på väljaren, med samma avkortade värde som i voter_status.
    const annasRow = state.votersDb.pendingVote.find(
      (row) => row.voterStatusId === shortened(anna),
    )
    expect(annasRow).toMatchObject({
      electionId,
      ballotLabel: 'Riksdagen',
      ciphertextHash: shortened(annasHash),
      castSequence: 1,
    })
    expect(state.votersDb.voterStatus.map((voter) => voter.id)).toContain(shortened(anna))

    // Chiffret: ett par per alternativ på valsedeln, tal på hundratals siffror.
    expect(annasRow!.ciphertext).toMatchObject({ pairs: options.length })
    expect(annasRow!.ciphertext!.digits).toBeGreaterThan(500)
    expect(annasRow!.ciphertext!.c1).toMatch(/^\d{12}…$/)

    expect(state.elections).toEqual([
      expect.objectContaining({
        id: electionId,
        phase: 'OPEN',
        linkClearedAt: null,
        envelopeRoot: null,
        tallyCompletedAt: null,
      }),
    ])
    expect(state.elections[0]!.encryptionPublicKey).toMatch(/^\d{12}…$/)

    // Den anonyma sidan: inga chiffer än, tre nyckelandelar, ingen dekryptering.
    expect(state.votesDb.encryptedVote).toEqual([])
    expect(state.votesDb.trusteeShare.map((share) => share.trusteeIndex)).toEqual([1, 2, 3])
    expect(state.votesDb.partialDecryption).toEqual([])
    expect(state.votesDb.ballotTally).toEqual([])

    // Frågan "vem röstade på vad" körs på riktigt och ger en rad per kuvert.
    expect(state.analysis.linkQuery.sql).toContain('JOIN pending_vote p ON p.voter_status_id = v.id')
    expect(state.analysis.linkQuery.rows).toBe(2)
    expect(state.analysis.identityValuesInVotesDb).toEqual([])
    expect(state.analysis.ciphertextHashesInBoth).toEqual([])

    // Raderna sorteras på id, inte i den ordning väljarna röstade.
    expect(isSorted(state.votersDb.pendingVote.map((row) => row.id))).toBe(true)
  })

  it('kopplingen är en främmande nyckel inom röstlängden, och ingen nyckel går mellan databaserna', async () => {
    const state = await readState()

    expect(state.votersDb.foreignKeys).toContainEqual({
      table_name: 'pending_vote',
      column_name: 'voter_status_id',
      foreign_table_name: 'voter_status',
      foreign_column_name: 'id',
    })
    expect(state.analysis.foreignKeysChecked).toBe(
      state.votersDb.foreignKeys.length + state.votesDb.foreignKeys.length,
    )
    expect(state.analysis.foreignKeysAcrossDatabases).toEqual([])

    // Kolumnerna ur information_schema: ytterkuvertet bär väljaren, innerkuvertet inte.
    expect(state.votersDb.pendingVoteColumns).toContain('voter_status_id')
    expect(state.votesDb.encryptedVoteColumns).toEqual([
      'id',
      'ballot_id',
      'ciphertext',
      'proofs',
      'ciphertext_hash',
    ])
  })

  it('efter stängningen: raden är borta, och chiffret ligger i encrypted_vote utan koppling', async () => {
    const annasHash = await castFor(anna, 'S')
    const kimsHash = await castFor(kim, 'M')
    await setClosesAt(new Date(Date.now() - 60_000))

    expect(await closeElection(electionId)).toMatchObject({ status: 'closed', moved: 2 })

    const state = await readState()

    expect(state.votersDb.pendingVote).toEqual([])
    expect(state.analysis.linkQuery.rows).toBe(0)

    // Väljaren finns kvar i röstlängden. Det är kuvertet som raderats, inte hon.
    expect(state.votersDb.voterStatus.map((voter) => voter.id)).toContain(shortened(anna))

    expect(state.votesDb.encryptedVote.map((row) => row.ciphertextHash).sort()).toEqual(
      [shortened(annasHash), shortened(kimsHash)].sort(),
    )
    for (const row of state.votesDb.encryptedVote) {
      // Exakt de här fälten. Ett fält till, till exempel en väljare, ska synas här.
      expect(Object.keys(row).sort()).toEqual(
        ['ballotId', 'ballotLabel', 'ciphertext', 'ciphertextHash', 'electionId', 'id'].sort(),
      )
    }

    // Id:t är härlett ur chifferhashen, så id-ordningen är innehållets ordning.
    const ids = state.votesDb.encryptedVote.map((row) => row.id)
    expect(isSorted(ids)).toBe(true)
    expect(ids).toEqual(
      [annasHash, kimsHash].sort().map((hash) => shortened(idForEnvelope(hash))),
    )

    const [election] = state.elections
    expect(election).toMatchObject({ phase: 'STRIPPED' })
    expect(election!.linkClearedAt).not.toBeNull()
    expect(election!.envelopeRoot).toMatch(/^[0-9a-f]{12}…$/)

    expect(state.analysis.ciphertextHashesInBoth).toEqual([])
    expect(state.analysis.identityValuesInVotesDb).toEqual([])
  })

  it('en stängning som avbrutits efter flytten syns som chifferhashar i båda databaserna', async () => {
    /**
     * Stängningen flyttar chiffren FÖRE den raderar kopplingen, och flytten
     * kan inte vara en transaktion över två databaser. Avbryts den mellan
     * stegen ligger samma hash både bredvid väljaren och i encrypted_vote,
     * tills stängningen körs om. Livevyn ska säga det, inte dölja det.
     *
     * Läget byggs här direkt i databasen, precis som steg 4 i
     * close-election.usecase.ts lämnar det.
     */
    const annasHash = await castFor(anna, 'S')
    const envelope = await votersDb.pendingVote.findFirstOrThrow({
      where: { voterStatusId: anna },
      select: { ciphertext: true, proofs: true },
    })
    await votesDb.encryptedVote.create({
      data: {
        id: idForEnvelope(annasHash),
        ballotId,
        ciphertext: envelope.ciphertext as Prisma.InputJsonValue,
        proofs: envelope.proofs as Prisma.InputJsonValue,
        ciphertextHash: annasHash,
      },
    })

    const state = await readState()

    expect(state.analysis.ciphertextHashesInBoth).toEqual([shortened(annasHash)])
    expect(state.votersDb.pendingVote).toHaveLength(1)
    expect(state.votesDb.encryptedVote).toHaveLength(1)
    expect(state.elections[0]).toMatchObject({ phase: 'OPEN', linkClearedAt: null })
  })

  it('inga fullständiga värden och inga hemligheter lämnar rutten', async () => {
    const annasHash = await castFor(anna, 'S')
    const state = JSON.stringify(await readState())

    const voter = await votersDb.voterStatus.findUniqueOrThrow({
      where: { id: anna },
      select: { externalIdentityHash: true },
    })
    const envelope = await votersDb.pendingVote.findFirstOrThrow({
      where: { voterStatusId: anna },
      select: { id: true, bankIdSignature: true, bankIdPublicKey: true, ciphertext: true },
    })
    const shares = await votesDb.trusteeShare.findMany({
      where: { electionId },
      select: { encryptedShare: true, publicShare: true },
    })
    const signingKey = await votersDb.electionBallot.findUniqueOrThrow({
      where: { id: ballotId },
      select: { signingPrivateKeyPem: true },
    })

    // Fullständiga värden: bara de första tolv tecknen får lämna rutten.
    for (const full of [anna, voter.externalIdentityHash, envelope.id, annasHash]) {
      expect(state).not.toContain(full)
      expect(state).toContain(shortened(full))
    }
    const firstPair = (envelope.ciphertext as Array<{ c1: string }>)[0]!
    expect(state).not.toContain(firstPair.c1)

    // Hemligheter och sådant som bara behövs för valideringen.
    expect(state).not.toContain(envelope.bankIdSignature)
    expect(state).not.toContain(envelope.bankIdPublicKey)
    expect(state).not.toContain('BEGIN PUBLIC KEY')
    expect(state).not.toContain('PRIVATE KEY')
    expect(state).not.toContain(signingKey.signingPrivateKeyPem.slice(40, 80))
    for (const share of shares) {
      expect(state).not.toContain(share.encryptedShare)
      expect(state).not.toContain(share.publicShare)
    }
    expect(state).not.toMatch(/"(proofs|bankIdSignature|bankIdPublicKey|encryptedShare)":/)
  })

  it('det gamla flödets tabell redovisas som den är, märkt för sig', async () => {
    /**
     * Röstsidan lägger fortfarande röster med röstintyg och blind signatur.
     * Livevyn får inte låtsas att det flödet är borta: rösten ska synas i
     * tabellen vote, med timupplösning precis som den lagras.
     */
    const attempt = await voteOnce(robin, { electionId, ballotId, ballotPartyId: bpS })
    expect(attempt.status).toBe('voted')

    const state = await readState()

    expect(state.votesDb.legacyVote).toHaveLength(1)
    expect(state.votesDb.legacyVote[0]).toMatchObject({ ballotId: shortened(ballotId) })
    expect(state.votesDb.legacyVote[0]!.tokenHash).toMatch(/^[0-9a-f]{12}…$/)
    expect(state.votesDb.legacyVote[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:00$/)

    // Det gamla flödet lägger inga kuvert.
    expect(state.votersDb.pendingVote).toEqual([])
  })
})
