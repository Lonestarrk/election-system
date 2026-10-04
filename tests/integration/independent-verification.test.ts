import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import { closeElection } from '@/orchestration/close-election.usecase'
import { completeTally, submitPartialDecryption } from '@/orchestration/tally.usecase'
import { canonicalOptions, type BallotOption } from '@/lib/crypto/ballot-encoding'
// Serverns ingång registrerar OpenSSL, så att krypteringen i testet går fort.
import '@/lib/crypto/server'
import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { encryptBallot } from '@/lib/encrypt-client'
import { resetRateLimits } from '@/lib/rate-limit'
import { createAdminSession } from '@/modules/eligibility/admin-session.service'
import { MockBankIdService, selectDemoIdentity } from '@/modules/eligibility/bankid/MockBankIdService'
import {
  ciphertextCommitment,
  envelopePayload,
  newCommitmentSalt,
} from '@/modules/eligibility/bankid/envelope-signature'
import { castEncryptedBallot, nextCastSequence } from '@/modules/eligibility/pending-vote.service'
import { createVotingSession } from '@/modules/eligibility/voting-session.service'
import { GET as resultsRoute } from '@/app/api/observer/results/route'
import { POST as observerRoute } from '@/app/api/observer/election/route'
import { POST as statsRoute } from '@/app/api/admin/stats/route'
import { POST as adminResultsRoute } from '@/app/api/admin/elections/results/route'
import { POST as participationRoute } from '@/app/api/vote/participation/route'
import { GET as databaseStateRoute } from '@/app/api/demo/database-state/route'
import type { DatabaseState } from '@/app/api/demo/database-state/route'
import { createVoter, disconnect, isDatabaseAvailable, resetElectionData, signingTextFor } from './helpers'

/**
 * UPPGIFT 13: BARA SUMMORNA PUBLICERAS, OCH VEM SOM HELST KAN KONTROLLERA DEM.
 *
 * Efter räkningen publiceras per valsedel summan per alternativ, varje
 * förtroendepersons partiella dekryptering med bevis och resultatet, och per
 * omröstning kuvertroten och urnroten (spec 3.1, 7.2 och ruling 135). Ingenting
 * publiceras per röst. Det oberoende verktyget, tools/verify-election.mjs,
 * körs här som en egen process mot exakt det rutten publicerar.
 *
 * Före räkningen finns inget resultat att se, inte heller för administratören:
 * under röstningen publiceras bara valdeltagandet (spec 6.2).
 */

/** Sessionernas cookies läggs in utifrån, eftersom next/headers kräver Nexts begäranskontext. */
const cookieJar = vi.hoisted(() => ({ admin: undefined as string | undefined, session: undefined as string | undefined }))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name === 'valadmin' && cookieJar.admin) return { name, value: cookieJar.admin }
      if (name === 'valsession' && cookieJar.session) return { name, value: cookieJar.session }
      return undefined
    },
  }),
}))

const databaseAvailable = await isDatabaseAvailable()

if (!databaseAvailable) {
  process.stderr.write('\n  Ingen databas tillgänglig — integrationstesterna hoppas över.\n')
}

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

const TRUSTEE_PASSPHRASES = ['test-fras-ett', 'test-fras-tva', 'test-fras-tre'] as const
const ORIGIN = 'http://localhost:3000'
const TOOL = join(process.cwd(), 'tools/verify-election.mjs')

type CountedBallot = { id: string; options: BallotOption[]; bpS: string; bpM: string }

/** Kör verktyget som en egen process mot en publicering, sparad som fil. */
function runTool(publication: unknown): { status: number | null; output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'independent-verification-'))
  const file = join(directory, 'publicering.json')
  writeFileSync(file, JSON.stringify(publication))
  const result = spawnSync(process.execPath, [TOOL, file], { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

function post(handler: (request: Request) => Promise<Response>, path: string, body: unknown): Promise<Response> {
  return handler(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(body),
    }),
  )
}

describe.skipIf(!databaseAvailable)('publiceringen och den oberoende kontrollen', () => {
  const ANNA_PN = '199001011234'
  const KIM_PN = '198505152345'
  const ROBIN_PN = '197012125678'
  const ADMIN_PN = '198001019876'

  let electionId: string
  let publicKey: string
  let first: CountedBallot
  let second: CountedBallot

  let anna: string
  let kim: string
  let robin: string

  const personalNumberByVoter = new Map<string, string>()

  async function setClosesAt(at: Date): Promise<void> {
    await votersDb.election.update({ where: { id: electionId }, data: { closesAt: at } })
    await votesDb.election.update({ where: { id: electionId }, data: { closesAt: at } })
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

  beforeEach(async () => {
    cookieJar.admin = undefined
    cookieJar.session = undefined
    resetRateLimits()
    await resetElectionData()

    const s = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'S' } })
    const m = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'M' } })
    const ballot = (label: string) => ({
      kind: 'RIKSDAG' as const,
      label,
      allowsCandidateVote: false,
      parties: [{ partyId: s.id }, { partyId: m.id }],
    })

    const outcome = await createElection({
      name: 'Publiceringstestet',
      kind: 'RIKSDAGSVAL',
      opensAt: new Date(Date.now() - 60_000),
      closesAt: new Date(Date.now() + 3_600_000),
      ballots: [ballot('Riksdagen'), ballot('Riksdagen, andra valsedeln')],
      trusteePassphrases: [...TRUSTEE_PASSPHRASES],
    })
    if (outcome.status !== 'created') throw new Error('Kunde inte skapa testomröstningen.')

    electionId = outcome.election.id
    const row = await votesDb.election.findUniqueOrThrow({
      where: { id: electionId },
      select: { encryptionPublicKey: true },
    })
    publicKey = row.encryptionPublicKey!
    first = await countedBallot(outcome.election.ballotIds[0]!.id)
    second = await countedBallot(outcome.election.ballotIds[1]!.id)

    personalNumberByVoter.clear()
    for (const [pn, assign] of [
      [ANNA_PN, (id: string) => (anna = id)],
      [KIM_PN, (id: string) => (kim = id)],
      [ROBIN_PN, (id: string) => (robin = id)],
    ] as const) {
      const id = await createVoter(pn)
      personalNumberByVoter.set(id, pn)
      assign(id)
    }
  })

  /** Lägger ett kuvert ärligt, signerat med väljarens BankID-attrapp. */
  async function castFor(voterStatusId: string, party: 'bp-s' | 'bp-m', ballot: CountedBallot = first) {
    const encrypted: EncryptedBallot = await encryptBallot(publicKey, electionId, ballot.id, ballot.options, {
      kind: 'PARTY',
      ballotPartyId: party === 'bp-s' ? ballot.bpS : ballot.bpM,
    })
    const castSequence = await nextCastSequence(voterStatusId, ballot.id)

    const service = new MockBankIdService()
    const commitmentSalt = newCommitmentSalt()
    const order = await service.sign({
      endUserIp: '127.0.0.1',
      userVisibleData: await signingTextFor(ballot.id, electionId),
      userNonVisibleData: envelopePayload({
        electionId,
        ballotId: ballot.id,
        ciphertextCommitment: ciphertextCommitment(encrypted.ciphertextHash, commitmentSalt)!,
        castSequence,
      }),
    })
    selectDemoIdentity(order.orderRef, personalNumberByVoter.get(voterStatusId)!)
    let result = await service.collect(order.orderRef)
    while (result.status === 'pending') result = await service.collect(order.orderRef)
    if (result.status !== 'complete') throw new Error('Signeringen blev inte klar.')

    const shape = await getEncryptedBallotShape(ballot.id)
    const outcome = await castEncryptedBallot(
      voterStatusId,
      electionId,
      ballot.id,
      encrypted,
      {
        signature: result.completionData.signature,
        ocspResponse: result.completionData.ocspResponse,
        commitmentSalt,
      },
      shape,
    )
    if (outcome.status !== 'recorded') throw new Error(`Kunde inte lägga rösten (${outcome.status}).`)
    return encrypted
  }

  /** Tre väljare på den första valsedeln och två på den andra, så att ingen summa är en enda röst. */
  async function castTheVotes(): Promise<EncryptedBallot[]> {
    return [
      await castFor(anna, 'bp-s'),
      await castFor(kim, 'bp-s'),
      await castFor(robin, 'bp-m'),
      await castFor(anna, 'bp-m', second),
      await castFor(kim, 'bp-m', second),
    ]
  }

  async function close(): Promise<void> {
    await setClosesAt(new Date(Date.now() - 60_000))
    const outcome = await closeElection(electionId)
    if (outcome.status !== 'closed') throw new Error(`Stängningen gick inte igenom (${outcome.status}).`)
  }

  async function tallyBallot(ballotId: string): Promise<void> {
    expect(await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0])).toMatchObject({ status: 'accepted' })
    expect(await submitPartialDecryption(ballotId, 3, TRUSTEE_PASSPHRASES[2])).toMatchObject({ status: 'accepted' })
    expect(await completeTally(ballotId)).toMatchObject({ status: 'tallied' })
  }

  async function closeAndTally(): Promise<void> {
    await close()
    await tallyBallot(first.id)
    await tallyBallot(second.id)
  }

  async function published(id = electionId): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await resultsRoute(
      new Request(`${ORIGIN}/api/observer/results?electionId=${encodeURIComponent(id)}`),
    )
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  async function observed(): Promise<Record<string, unknown>> {
    const response = await post(observerRoute, '/api/observer/election', { electionId })
    expect(response.status).toBe(200)
    return (await response.json()) as Record<string, unknown>
  }

  // -------------------------------------------------------------------------
  // Verktyget mot det som publiceras
  // -------------------------------------------------------------------------

  it('verktyget kontrollerar dekrypteringen ur publiceringen, utan att importera något från src', async () => {
    // Bevisvärdet ligger i oberoendet. Delar verktyget kod med appen bevisar det
    // bara att appen är konsekvent med sig själv. Att verktyget inte importerar
    // något ur src prövas i tests/unit/independent-verifier.test.ts.
    await castTheVotes()
    await closeAndTally()

    const { status, body } = await published()
    expect(status).toBe(200)
    expect(body.status).toBe('published')

    const ballots = body.ballots as Array<{ ballotId: string; options: Array<{ label: string; count: number }> }>
    expect(ballots.map((ballot) => ballot.options.map((option) => option.count))).toEqual([
      [0, 2, 1],
      [0, 0, 2],
    ])
    expect(ballots[0]!.options.map((option) => option.label)).toEqual(['Blankt', 'Socialdemokraterna', 'Moderaterna'])

    const result = runTool(body)
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('dekrypteringen stämmer')
  })

  it('publiceringen bär kuvertroten och urnroten som stängningen skrev, och summan av markeringarna', async () => {
    await castTheVotes()
    await closeAndTally()

    const election = await votersDb.election.findUniqueOrThrow({
      where: { id: electionId },
      select: { envelopeRoot: true, urnRoot: true },
    })
    const { body } = await published()
    expect(body.envelopeRoot).toBe(election.envelopeRoot)
    expect(body.urnRoot).toBe(election.urnRoot)
    expect(body.markedAsVotedTotal).toBe(5)
    expect((body.ballots as Array<{ rows: number; markedAsVoted: number }>).map((b) => [b.rows, b.markedAsVoted])).toEqual([
      [3, 3],
      [2, 2],
    ])
  })

  it('ett bevis där en enda byte ändrats i publiceringen underkänns av verktyget', async () => {
    await castTheVotes()
    await closeAndTally()

    const { body } = await published()
    const ballots = body.ballots as Array<{ contributions: Array<{ partials: Array<{ proof: { a: string } }> }> }>
    const proof = ballots[1]!.contributions[0]!.partials[2]!.proof
    const last = proof.a.at(-1)!
    proof.a = proof.a.slice(0, -1) + (last === '9' ? '8' : String(Number(last) + 1))

    const result = runTool(body)
    expect(result.status).toBe(1)
    expect(result.output).toMatch(/FEL.*Riksdagen, andra valsedeln: förtroendeperson 1:s bidrag för alternativ 2/)
    expect(result.output).not.toContain('dekrypteringen stämmer')
  })

  it('ett manipulerat resultat i publiceringen underkänns av verktyget', async () => {
    await castTheVotes()
    await closeAndTally()

    const { body } = await published()
    const options = (body.ballots as Array<{ options: Array<{ count: number }> }>)[0]!.options
    // Två räkneverk som byter plats har samma summa. Bara dekrypteringen visar det.
    ;[options[1]!.count, options[2]!.count] = [options[2]!.count, options[1]!.count]

    const result = runTool(body)
    expect(result.status).toBe(1)
    expect(result.output).toMatch(/FEL.*resultatet för alternativ 1 är inte dekrypteringen av summan/)
  })

  // -------------------------------------------------------------------------
  // Talen räknas om före publiceringen
  // -------------------------------------------------------------------------

  it('ett manipulerat räkneverk i databasen ger ingen publicering, och det sparade talet visas inte', async () => {
    await castTheVotes()
    await closeAndTally()

    await votesDb.ballotTally.updateMany({ where: { ballotId: first.id, optionIndex: 1 }, data: { count: 77 } })

    const { status, body } = await published()
    expect(status).toBe(409)
    expect(body.status).toBe('result_mismatch')
    expect(body.message).toMatch(/stämmer inte/)
    expect(JSON.stringify(body)).not.toMatch(/77/)
    expect(body).not.toHaveProperty('ballots')
  })

  it('en valsedel i röstlängdens lista som saknar form i röstdatabasen ger ingen publicering', async () => {
    /**
     * Helgrensgranskningen, Mindre. Publiceringen hoppade tyst över en sådan
     * valsedel. Har den rader fäller urnroten borttagningen, men en tom valsedel
     * kunde försvinna ur publiceringen utan att något märktes.
     */
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')
    await closeAndTally()
    expect((await published()).status).toBe(200)

    await votesDb.electionBallot.delete({ where: { id: second.id } })

    const { status, body } = await published()
    expect(status).toBe(409)
    expect(body.status).toBe('result_mismatch')
    expect(body).not.toHaveProperty('ballots')
  })

  it('en manipulerad partiell dekryptering i databasen ger ingen publicering', async () => {
    await castTheVotes()
    await closeAndTally()

    const row = await votesDb.partialDecryption.findFirstOrThrow({ where: { ballotId: second.id, trusteeIndex: 3 } })
    await votesDb.partialDecryption.update({ where: { id: row.id }, data: { value: '4' } })

    const { status, body } = await published()
    expect(status).toBe(409)
    expect(body.status).toBe('result_mismatch')
    expect(body).not.toHaveProperty('ballots')
  })

  it('en rad som lagts till i urnan efter stängningen ger ingen publicering', async () => {
    const ballots = await castTheVotes()
    await closeAndTally()

    // En kopia av en röst, efter räkningen: urnroten stämmer inte längre.
    const copy = ballots[0]!
    await votesDb.encryptedVote.create({
      data: {
        id: 'f'.repeat(32),
        ballotId: first.id,
        ciphertext: copy.ciphertext,
        proofs: copy.proofs,
        ciphertextHash: copy.ciphertextHash,
      },
    })

    const { status, body } = await published()
    expect(status).toBe(409)
    expect(body.status).toBe('result_mismatch')
  })

  it('publiceringen säger att den inte bär BankID-miljön', async () => {
    // Helgrensgranskningen: en publicering från testmiljön ser likadan ut som en från produktion.
    await castTheVotes()
    await closeAndTally()

    const { body } = await published()
    expect((body.notCheckable as string[]).some((entry) => /Vilken BankID-miljö underskrifterna kom från/.test(entry))).toBe(true)
  })

  it('fältet för antalet heter efter vad det är: markeringarna, inte kuverten (fixrunda 1, Mindre 3)', async () => {
    await castTheVotes()
    await closeAndTally()

    const { body } = await published()
    expect(body).not.toHaveProperty('envelopeCount')
    expect(body.markedAsVotedTotal).toBe(5)
    expect((await observed()).markedAsVotedTotal).toBe(5)
  })

  it('en publik andel för en förtroendeperson som inte bidrog, ändrad i databasen, ger ingen publicering (Mindre 2)', async () => {
    await castTheVotes()
    await closeAndTally()

    // Förtroendeperson 2 bidrog inte, så omräkningen läser aldrig hennes andel.
    // Publiceringen prövar ändå att alla tre hör till valets nyckel.
    const share = await votesDb.trusteeShare.findFirstOrThrow({ where: { electionId, trusteeIndex: 2 } })
    await votesDb.trusteeShare.update({ where: { id: share.id }, data: { publicShare: '16' } })

    const { status, body } = await published()
    expect(status).toBe(409)
    expect(body.status).toBe('result_mismatch')
  })

  it('en annan publik nyckel för valet i databasen ger ingen publicering (Mindre 2)', async () => {
    await castTheVotes()
    await closeAndTally()

    await votesDb.election.update({ where: { id: electionId }, data: { encryptionPublicKey: '16' } })

    const { status, body } = await published()
    expect(status).toBe(409)
    expect(body.status).toBe('result_mismatch')
  })

  it('adminsidans resultat är omräkningens, och ett ändrat räkneverk visas inte där heller (Mindre 6)', async () => {
    await castTheVotes()
    await closeAndTally()

    const admin = await createVoter(ADMIN_PN, { isAdmin: true })
    cookieJar.admin = (await createAdminSession(admin)).id

    const honest = await post(adminResultsRoute, '/api/admin/elections/results', { electionId })
    expect(honest.status).toBe(200)
    const honestBody = (await honest.json()) as { ballots: Array<{ options: Array<{ count: number }>; total: number }> }
    expect(honestBody.ballots.map((ballot) => ballot.options.map((option) => option.count))).toEqual([
      [0, 2, 1],
      [0, 0, 2],
    ])

    await votesDb.ballotTally.updateMany({ where: { ballotId: first.id, optionIndex: 1 }, data: { count: 77 } })
    const changed = await post(adminResultsRoute, '/api/admin/elections/results', { electionId })
    expect(changed.status).toBe(409)
    const changedBody = await changed.json()
    expect(changedBody.status).toBe('result_mismatch')
    expect(JSON.stringify(changedBody)).not.toMatch(/77/)
  })

  it('ingenting publiceras före TALLIED, inte heller när en valsedel redan är räknad', async () => {
    await castTheVotes()
    await close()

    expect((await published()).body).toMatchObject({ status: 'not_published', phase: 'STRIPPED' })

    await tallyBallot(first.id)
    const { status, body } = await published()
    expect(status).toBe(409)
    expect(body).toMatchObject({ status: 'not_published', phase: 'STRIPPED' })
    expect(JSON.stringify(body)).not.toMatch(/count|ballots/)
  })

  it('en omröstning som inte finns, och ett id som inte är ett id, ger inget', async () => {
    expect((await published('00000000-0000-4000-8000-000000000000')).status).toBe(404)
    expect((await published('inte-ett-id')).status).toBe(400)
  })

  // -------------------------------------------------------------------------
  // Ingenting per röst
  // -------------------------------------------------------------------------

  it('ingenting per röst publiceras', async () => {
    // Spec 3.1. Allt publicerat per röst är ett handtag en köpare kan matcha mot.
    const ballots = await castTheVotes()
    await closeAndTally()

    const everything = JSON.stringify([(await published()).body, await observed()])

    expect(everything).not.toMatch(/ciphertextHash/)
    for (const ballot of ballots) {
      expect(everything).not.toContain(ballot.ciphertextHash)
      for (const pair of ballot.ciphertext) {
        expect(everything).not.toContain(pair.c1)
        expect(everything).not.toContain(pair.c2)
      }
    }
    // Ingen identitet och ingen tid som rösterna går att ordna efter.
    for (const forbidden of [anna, kim, robin, 'voterStatusId', 'personalNumber', 'createdAt', 'updatedAt']) {
      expect(everything).not.toContain(forbidden)
    }
  })

  it('ingen observatörsrutt lämnar ut röster en och en', () => {
    expect(existsSync(join(process.cwd(), 'src/app/api/observer/votes/route.ts'))).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Inga löpande resultat
  // -------------------------------------------------------------------------

  it('inga delsummor under röstningen, bara valdeltagandet', async () => {
    // Spec 6.2. Ett löpande resultat är en tröskeldekryptering per siffra, eller
    // en räkning i klartext.
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-s')

    const observedNow = await observed()
    const text = JSON.stringify(observedNow)
    expect(text).not.toMatch(/Socialdemokraterna.*\d|votesByParty|counts|"results"|totalVotes/)
    expect(observedNow).toMatchObject({ election: { phase: 'OPEN' } })
    const turnout = (observedNow.ballots as Array<{ id: string; voted: number }>).map((ballot) => [ballot.id, ballot.voted])
    expect(turnout).toEqual([
      [first.id, 2],
      [second.id, 0],
    ])
    // Rötterna finns inte förrän stängningen skrivit dem.
    expect(observedNow.envelopeRoot).toBeNull()
    expect(observedNow.urnRoot).toBeNull()

    expect((await published()).body).toMatchObject({ status: 'not_published', phase: 'OPEN' })
  })

  it('administratören ser inga delsummor heller', async () => {
    await castFor(anna, 'bp-s')

    const admin = await createVoter(ADMIN_PN, { isAdmin: true })
    cookieJar.admin = (await createAdminSession(admin)).id

    const response = await post(statsRoute, '/api/admin/stats', { electionId })
    expect(response.status).toBe(200)
    const text = JSON.stringify(await response.json())
    expect(text).not.toMatch(/Socialdemokraterna|votesByParty|counts|"rows"|totalVotes|recordedVotes/)
    expect(text).toMatch(/"voted":1/)
  })

  it('observatörsrutten publicerar rötterna från stängningen, så att de kan sparas före räkningen', async () => {
    await castTheVotes()
    await close()

    const election = await votersDb.election.findUniqueOrThrow({
      where: { id: electionId },
      select: { envelopeRoot: true, urnRoot: true },
    })
    const observedNow = await observed()
    expect(observedNow).toMatchObject({
      election: { phase: 'STRIPPED' },
      envelopeRoot: election.envelopeRoot,
      urnRoot: election.urnRoot,
      markedAsVotedTotal: 5,
    })
    expect(JSON.stringify(observedNow)).not.toMatch(/counts|"results"/)
  })

  it('livevyn visar räkneverken först när resultatet är publicerat', async () => {
    await castTheVotes()
    await close()
    await tallyBallot(first.id)

    const read = async () => (await (await databaseStateRoute(new Request('http://localhost:3000/api/demo/database-state'))).json()) as DatabaseState
    // Den första valsedeln är räknad, men omröstningen står i STRIPPED.
    expect((await read()).votesDb.ballotTally).toEqual([])

    await tallyBallot(second.id)
    expect((await read()).votesDb.ballotTally).toHaveLength(6)
  })

  // -------------------------------------------------------------------------
  // Väljaren ser att hon röstat, inte vad
  // -------------------------------------------------------------------------

  describe('väljarens besked', () => {
    async function participationOf(voterStatusId: string): Promise<{ status: number; body: Record<string, unknown> }> {
      cookieJar.session = (await createVotingSession(voterStatusId, electionId)).id
      const response = await post(participationRoute, '/api/vote/participation', {})
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    }

    const votedPerBallot = (body: Record<string, unknown>) =>
      (body.ballots as Array<{ id: string; voted: boolean }>).map((ballot) => [ballot.id, ballot.voted])

    it('kräver en session', async () => {
      const response = await post(participationRoute, '/api/vote/participation', {})
      expect(response.status).toBe(401)
    })

    it('före stängningen ur kuvertet, efter stängningen ur markeringen', async () => {
      await castFor(anna, 'bp-s')

      const before = await participationOf(anna)
      expect(before.status).toBe(200)
      expect(before.body.phase).toBe('OPEN')
      expect(votedPerBallot(before.body)).toEqual([
        [first.id, true],
        [second.id, false],
      ])

      await close()
      // Kuvertet är raderat. Beskedet kommer nu ur markeringen "har röstat".
      expect(await votersDb.pendingVote.count({ where: { voterStatusId: anna } })).toBe(0)
      const after = await participationOf(anna)
      expect(after.body.phase).toBe('STRIPPED')
      expect(votedPerBallot(after.body)).toEqual([
        [first.id, true],
        [second.id, false],
      ])

      const nobody = await participationOf(robin)
      expect(votedPerBallot(nobody.body)).toEqual([
        [first.id, false],
        [second.id, false],
      ])
    })

    it('säger att väljaren röstat, aldrig vad, när eller med vilket chiffer', async () => {
      const [ballot] = [await castFor(anna, 'bp-s')]
      await close()

      const { body } = await participationOf(anna)
      const text = JSON.stringify(body)
      expect(text).not.toMatch(/ciphertext|bpS|ballotPartyId|Socialdemokraterna|At"|time|date/i)
      expect(text).not.toContain(ballot!.ciphertextHash)
      expect(text).not.toContain(anna)
    })
  })
})
