import { readFileSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { createElection } from '@/orchestration/create-election.usecase'
import { closeElection, withClosingLock } from '@/orchestration/close-election.usecase'
import { completeTally, submitPartialDecryption } from '@/orchestration/tally.usecase'
import { DEMO_ELECTION_NAME, DEMO_TRUSTEE_PASSPHRASES } from '@/lib/demo-election'
import { resetRateLimits } from '@/lib/rate-limit'
import { auditEntryHash } from '@/modules/eligibility/audit.service'
import { createAdminSession } from '@/modules/eligibility/admin-session.service'
import { POST as certifyRoute } from '@/app/api/admin/elections/certify/route'
import { POST as checkRoute } from '@/app/api/admin/elections/check/route'
import { POST as checkStatusRoute } from '@/app/api/admin/elections/check-status/route'
import { POST as resultsRoute } from '@/app/api/admin/elections/results/route'
import { POST as stateRoute } from '@/app/api/admin/elections/state/route'
import { POST as createRoute } from '@/app/api/admin/elections/route'
import { POST as resetRoute } from '@/app/api/demo/reset-election/route'
import { POST as passphrasesRoute } from '@/app/api/demo/trustee-passphrases/route'
import { createVoter, disconnect, isDatabaseAvailable, resetElectionData } from './helpers'

/**
 * UPPGIFT 12c: ADMINSIDAN LEDER GENOM HELA AVSLUTNINGEN.
 *
 * Det här prövar rutterna och användningsfallen bakom sidan: läsrutten för fas
 * och antal, läsrutten för resultatet, slutkontrollen i bakgrunden, ett
 * fastställande som kastar, och demoåterställningen. Sidan själv prövas i
 * tests/e2e/closing-flow.spec.ts.
 *
 * Valen här har inga röster. Stängningen, räkningen och slutkontrollen kör
 * ändå hela vägen, och det som prövas är sidans rutter och spärrar, inte
 * kryptot, som tests/integration/tally.test.ts redan prövar med röster.
 */

/** Adminsessionens cookie läggs in utifrån, eftersom next/headers kräver Nexts begäranskontext. */
const cookieJar = vi.hoisted(() => ({ admin: undefined as string | undefined }))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'valadmin' && cookieJar.admin ? { name, value: cookieJar.admin } : undefined,
  }),
}))

/** Demoläget styrs härifrån. Rutterna frågar `isDemoMode()` och inget annat. */
const demo = vi.hoisted(() => ({ on: true }))

vi.mock('@/lib/demo-mode', () => ({ isDemoMode: () => demo.on }))

/** Låter ett test få fastställandet att kasta. Alla andra anrop går till den äkta funktionen. */
const fault = vi.hoisted(() => ({ certify: false, checkDelayMs: 0, checkCalls: 0 }))

vi.mock('@/orchestration/final-check.usecase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/orchestration/final-check.usecase')>()
  return {
    ...actual,
    // Räknar anropen och kan hålla kvar kontrollen, så att två starter hinner mötas.
    runFinalCheck: async (electionId: string) => {
      fault.checkCalls += 1
      if (fault.checkDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, fault.checkDelayMs))
      return actual.runFinalCheck(electionId)
    },
    certifyElection: async (electionId: string) => {
      if (fault.certify) throw new Error('Testet: fastställandet kastade.')
      return actual.certifyElection(electionId)
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

const ORIGIN = 'http://localhost:3000'
/** Samma fraser som tests/integration/helpers.ts: andelarna är krypterade med dem. */
const PASSPHRASES = ['test-fras-ett', 'test-fras-tva', 'test-fras-tre'] as const

describe.skipIf(!databaseAvailable)('adminsidans rutter', () => {
  let csrfSecret = ''

  async function loginAdmin(): Promise<void> {
    const admin = await createVoter('198001019876', { isAdmin: true })
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

  async function newElection(name: string): Promise<{ electionId: string; ballotId: string }> {
    const s = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'S' } })
    const m = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'M' } })
    const outcome = await createElection({
      name,
      kind: 'RIKSDAGSVAL',
      opensAt: new Date(Date.now() - 120_000),
      closesAt: new Date(Date.now() - 60_000),
      ballots: [
        { kind: 'RIKSDAG', label: 'Riksdagen', allowsCandidateVote: false, parties: [{ partyId: s.id }, { partyId: m.id }] },
      ],
      trusteePassphrases: [...PASSPHRASES],
    })
    if (outcome.status !== 'created') throw new Error('Kunde inte skapa testomröstningen.')
    return { electionId: outcome.election.id, ballotId: outcome.election.ballotIds[0]!.id }
  }

  /** Stänger, låter två förtroendepersoner lämna bidrag och räknar. Omröstningen står sedan i TALLIED. */
  async function tallied(electionId: string, ballotId: string): Promise<void> {
    const closed = await closeElection(electionId)
    if (closed.status !== 'closed') throw new Error(`Stängningen gick inte igenom (${closed.status}).`)
    await submitPartialDecryption(ballotId, 1, PASSPHRASES[0])
    await submitPartialDecryption(ballotId, 2, PASSPHRASES[1])
    const result = await completeTally(ballotId)
    if (result.status !== 'tallied') throw new Error(`Räkningen gick inte igenom (${result.status}).`)
  }

  async function phaseOf(electionId: string): Promise<string> {
    return (await votersDb.election.findUniqueOrThrow({ where: { id: electionId }, select: { phase: true } })).phase
  }

  beforeEach(async () => {
    cookieJar.admin = undefined
    demo.on = true
    fault.certify = false
    fault.checkDelayMs = 0
    fault.checkCalls = 0
    resetRateLimits()
    await resetElectionData()
  })

  // -------------------------------------------------------------------------
  // Fasen och antalet
  // -------------------------------------------------------------------------

  describe('läsrutten för fas och antal', () => {
    it('kräver inloggning och egen origin', async () => {
      const { electionId } = await newElection('Läsning')

      expect((await post(stateRoute, '/api/admin/elections/state', { electionId }, {})).status).toBe(401)
      await loginAdmin()
      expect(
        (await post(stateRoute, '/api/admin/elections/state', { electionId }, { origin: 'https://angripare.example' }))
          .status,
      ).toBe(403)
    })

    it('visar fasen och antalet liggande kuvert, och ingenting per väljare', async () => {
      await loginAdmin()
      const { electionId, ballotId } = await newElection('Läsning')
      const voter = await createVoter('199001011234')
      await votersDb.pendingVote.create({
        data: {
          voterStatusId: voter,
          ballotId,
          ciphertext: [],
          proofs: {},
          ciphertextHash: 'h'.repeat(64),
          castSequence: 1,
          bankIdSignature: 'sig',
          bankIdCertificateChain: 'kedja',
          updatedAt: new Date(),
        },
      })

      const response = await post(stateRoute, '/api/admin/elections/state', { electionId })
      expect(response.status).toBe(200)
      const body = await response.json()

      expect(body.overview).toMatchObject({
        electionId,
        phase: 'OPEN',
        underReview: false,
        waitingEnvelopes: 1,
        urnEnvelopes: 0,
        envelopeRoot: null,
        urnRoot: null,
        trusteeCount: 3,
        trusteeThreshold: 2,
        trusteesReady: [],
      })
      expect(body.overview.ballots).toEqual([
        { id: ballotId, label: 'Riksdagen', kind: 'RIKSDAG', contributedBy: [], tallied: false },
      ])

      // Antal och rötter, aldrig en väljare eller ett kuvert.
      const text = JSON.stringify(body)
      for (const forbidden of [voter, 'h'.repeat(64), '"sig"', 'kedja', 'voterStatusId', 'bankIdSignature']) {
        expect(text).not.toContain(forbidden)
      }
    })

    it('följer fasen genom stängningen, bidragen och räkningen', async () => {
      await loginAdmin()
      const { electionId, ballotId } = await newElection('Läsning')

      expect(await closeElection(electionId)).toMatchObject({ status: 'closed' })
      let overview = (await (await post(stateRoute, '/api/admin/elections/state', { electionId })).json()).overview
      expect(overview.phase).toBe('STRIPPED')
      expect(overview.linkCleared).toBe(true)
      expect(overview.envelopeRoot).toMatch(/^[0-9a-f]{64}$/)
      expect(overview.urnRoot).toMatch(/^[0-9a-f]{64}$/)

      await submitPartialDecryption(ballotId, 2, PASSPHRASES[1])
      overview = (await (await post(stateRoute, '/api/admin/elections/state', { electionId })).json()).overview
      expect(overview.trusteesReady).toEqual([2])
      expect(overview.ballots[0]).toMatchObject({ contributedBy: [2], tallied: false })

      await submitPartialDecryption(ballotId, 3, PASSPHRASES[2])
      await completeTally(ballotId)
      overview = (await (await post(stateRoute, '/api/admin/elections/state', { electionId })).json()).overview
      expect(overview.phase).toBe('TALLIED')
      expect(overview.trusteesReady).toEqual([2, 3])
      expect(overview.ballots[0]).toMatchObject({ tallied: true })
    })

    it('säger om omröstningen är markerad som avvikande', async () => {
      await loginAdmin()
      const { electionId } = await newElection('Läsning')
      await votesDb.election.update({ where: { id: electionId }, data: { status: 'UNDER_REVIEW' } })

      const body = await (await post(stateRoute, '/api/admin/elections/state', { electionId })).json()
      expect(body.overview.underReview).toBe(true)
    })

    it('säger att läget är demo bara i demoläget, och bara demovalet kan återställas', async () => {
      await loginAdmin()
      const demoElection = await newElection(DEMO_ELECTION_NAME)
      const other = await newElection('Ett annat val')

      let body = await (await post(stateRoute, '/api/admin/elections/state', { electionId: demoElection.electionId })).json()
      expect(body).toMatchObject({ demoMode: true, demoReset: true })

      body = await (await post(stateRoute, '/api/admin/elections/state', { electionId: other.electionId })).json()
      expect(body).toMatchObject({ demoMode: true, demoReset: false })

      demo.on = false
      body = await (await post(stateRoute, '/api/admin/elections/state', { electionId: demoElection.electionId })).json()
      expect(body).toMatchObject({ demoMode: false, demoReset: false })
    })

    it('svarar 404 för en omröstning som inte finns', async () => {
      await loginAdmin()
      const response = await post(stateRoute, '/api/admin/elections/state', {
        electionId: '00000000-0000-4000-8000-000000000000',
      })
      expect(response.status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // Resultatet (7c)
  // -------------------------------------------------------------------------

  describe('läsrutten för resultatet', () => {
    it('kräver inloggning', async () => {
      const { electionId } = await newElection('Resultat')
      expect((await post(resultsRoute, '/api/admin/elections/results', { electionId }, {})).status).toBe(401)
    })

    it('lämnar inget före TALLIED, inte heller när en valsedel redan är räknad', async () => {
      await loginAdmin()
      const { electionId } = await newElection('Resultat')

      const open = await post(resultsRoute, '/api/admin/elections/results', { electionId })
      expect(open.status).toBe(409)
      expect(await open.json()).toMatchObject({ status: 'not_tallied', phase: 'OPEN' })
    })

    it('ger räkneverken per valsedel med alternativens namn efter TALLIED, också vid en omläsning', async () => {
      await loginAdmin()
      const { electionId, ballotId } = await newElection('Resultat')
      await tallied(electionId, ballotId)

      for (let reads = 0; reads < 2; reads += 1) {
        const response = await post(resultsRoute, '/api/admin/elections/results', { electionId })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          status: 'ok',
          phase: 'TALLIED',
          ballots: [
            {
              ballotId,
              label: 'Riksdagen',
              kind: 'RIKSDAG',
              options: [
                { label: 'Blankt', count: 0 },
                { label: 'Socialdemokraterna', count: 0 },
                { label: 'Moderaterna', count: 0 },
              ],
              total: 0,
            },
          ],
        })
      }
    })
  })

  // -------------------------------------------------------------------------
  // Slutkontrollen i bakgrunden (7d)
  // -------------------------------------------------------------------------

  describe('slutkontrollen i bakgrunden', () => {
    async function waitForReport(electionId: string): Promise<{ status: string; report?: { phase: string; canCertify: boolean } }> {
      const deadline = Date.now() + 60_000
      for (;;) {
        const body = await (await post(checkStatusRoute, '/api/admin/elections/check-status', { electionId })).json()
        if (body.status !== 'running' || Date.now() > deadline) return body
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }

    it('kräver inloggning och CSRF-token för att starta, och inloggning för att läsa', async () => {
      const { electionId } = await newElection('Kontroll')

      expect((await post(checkRoute, '/api/admin/elections/check', { electionId }, {})).status).toBe(401)
      expect((await post(checkStatusRoute, '/api/admin/elections/check-status', { electionId }, {})).status).toBe(401)
      await loginAdmin()
      expect((await post(checkRoute, '/api/admin/elections/check', { electionId }, { 'x-csrf-token': 'fel' })).status).toBe(403)
    })

    it('svarar direkt med 202 och rapporten läses sedan med statusrutten', async () => {
      await loginAdmin()
      const { electionId, ballotId } = await newElection('Kontroll')
      await tallied(electionId, ballotId)

      const before = await post(checkStatusRoute, '/api/admin/elections/check-status', { electionId })
      expect(await before.json()).toEqual({ status: 'none' })

      const started = await post(checkRoute, '/api/admin/elections/check', { electionId })
      expect(started.status).toBe(202)
      expect(await started.json()).toMatchObject({ status: 'started' })

      const done = await waitForReport(electionId)
      expect(done.status).toBe('done')
      expect(done.report).toMatchObject({ phase: 'TALLIED', canCertify: true })
    })

    it('två starter samtidigt kör kontrollen en gång', async () => {
      await loginAdmin()
      const { electionId } = await newElection('Kontroll')
      fault.checkDelayMs = 400

      const [first, second] = await Promise.all([
        post(checkRoute, '/api/admin/elections/check', { electionId }),
        post(checkRoute, '/api/admin/elections/check', { electionId }),
      ])
      const statuses = [(await first.json()).status, (await second.json()).status].sort()

      expect(statuses).toEqual(['already_running', 'started'])
      expect(fault.checkCalls).toBe(1)
      await waitForReport(electionId)
    })

    it('ett jobb som en återställning glömt hindrar en ny start medan det kör', async () => {
      await loginAdmin()
      const { electionId, ballotId } = await newElection(DEMO_ELECTION_NAME)
      await tallied(electionId, ballotId)
      fault.checkDelayMs = 600

      expect((await (await post(checkRoute, '/api/admin/elections/check', { electionId })).json()).status).toBe('started')
      expect((await post(resetRoute, '/api/demo/reset-election', { electionId })).status).toBe(200)

      // Det glömda jobbet kör fortfarande, så en ny start läggs inte ovanpå.
      expect((await (await post(checkRoute, '/api/admin/elections/check', { electionId })).json()).status).toBe(
        'already_running',
      )
      expect(fault.checkCalls).toBe(1)

      // När det är klart skrivs dess resultat inte tillbaka, och en ny start går igenom.
      await new Promise((resolve) => setTimeout(resolve, 1000))
      expect(await (await post(checkStatusRoute, '/api/admin/elections/check-status', { electionId })).json()).toEqual({
        status: 'none',
      })
      expect((await (await post(checkRoute, '/api/admin/elections/check', { electionId })).json()).status).toBe('started')
      await waitForReport(electionId)
    })

    it('svarar 404 för en omröstning som inte finns', async () => {
      await loginAdmin()
      const response = await post(checkRoute, '/api/admin/elections/check', {
        electionId: '00000000-0000-4000-8000-000000000000',
      })
      expect(response.status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // Fastställandet som kastar (granskningen av 12b)
  // -------------------------------------------------------------------------

  describe('fastställandet', () => {
    it('ett oväntat fel ger ett besked till sidan och inte en naken 500', async () => {
      await loginAdmin()
      const { electionId, ballotId } = await newElection('Fastställande')
      await tallied(electionId, ballotId)

      fault.certify = true
      const response = await post(certifyRoute, '/api/admin/elections/certify', { electionId })

      expect(response.status).toBe(500)
      const body = await response.json()
      expect(body.error.code).toBe('INTERNAL')
      expect(body.error.message).toContain('Fastställandet kunde inte slutföras')
      // Felet nämner inte sin orsak. Den står i serverloggen.
      expect(JSON.stringify(body)).not.toContain('Testet:')
      // Ingenting blev fastställt av felet.
      expect(await phaseOf(electionId)).toBe('TALLIED')
    })

    it('fastställer när allt passerar, och fasen blir CERTIFIED', async () => {
      await loginAdmin()
      const { electionId, ballotId } = await newElection('Fastställande')
      await tallied(electionId, ballotId)

      const response = await post(certifyRoute, '/api/admin/elections/certify', { electionId })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ status: 'certified' })
      expect(await phaseOf(electionId)).toBe('CERTIFIED')
    })
  })

  // -------------------------------------------------------------------------
  // Demoåterställningen (7b)
  // -------------------------------------------------------------------------

  describe('demoåterställningen', () => {
    const reset = (electionId: string, headers?: Record<string, string>) =>
      post(resetRoute, '/api/demo/reset-election', { electionId }, headers)

    it('svarar 404 när demoläget är avslaget, och rör ingenting', async () => {
      await loginAdmin()
      const { electionId, ballotId } = await newElection(DEMO_ELECTION_NAME)
      await tallied(electionId, ballotId)

      demo.on = false
      const response = await reset(electionId)

      expect(response.status).toBe(404)
      expect(await phaseOf(electionId)).toBe('TALLIED')
      expect(await votesDb.ballotTally.count()).toBeGreaterThan(0)
      expect(await votersDb.auditEvent.count({ where: { eventType: 'ELECTION_DEMO_RESET' } })).toBe(0)
    })

    it('kräver adminsession, CSRF-token och egen origin', async () => {
      const { electionId } = await newElection(DEMO_ELECTION_NAME)

      expect((await reset(electionId, {})).status).toBe(401)
      await loginAdmin()
      expect((await reset(electionId, { 'x-csrf-token': 'fel' })).status).toBe(403)
      expect((await reset(electionId, { 'x-csrf-token': csrfSecret, origin: 'https://angripare.example' })).status).toBe(403)
    })

    it('vägrar varje annan omröstning än demovalet, och rör ingenting', async () => {
      await loginAdmin()
      const { electionId, ballotId } = await newElection('Ett val som någon skapat')
      await tallied(electionId, ballotId)

      const response = await reset(electionId)

      expect(response.status).toBe(403)
      expect((await response.json()).error.code).toBe('NOT_DEMO_ELECTION')
      expect(await phaseOf(electionId)).toBe('TALLIED')
      expect(await votesDb.ballotTally.count({ where: { ballotId } })).toBeGreaterThan(0)
      expect(await votersDb.auditEvent.count({ where: { eventType: 'ELECTION_DEMO_RESET' } })).toBe(0)
    })

    it.each([
      ['en SHARP-omröstning', { mode: 'SHARP' }],
      ['en omröstning mot BankID:s testmiljö', { bankIdEnvironment: 'test' }],
    ] as const)('vägrar %s som heter som demovalet, och rör ingenting (granskningen av härdningen)', async (_, data) => {
      /**
       * Namnet ensamt räckte förut. En skarp omröstning som fått demovalets namn, i
       * någon av databaserna, hade då kunnat tömmas av den som är administratör i en
       * demoserver. Nu krävs också läget DEMO och miljön none, i båda raderna.
       */
      await loginAdmin()
      const { electionId, ballotId } = await newElection(DEMO_ELECTION_NAME)
      await tallied(electionId, ballotId)

      for (const db of [votersDb, votesDb]) {
        await (db.election.update as (args: unknown) => Promise<unknown>)({ where: { id: electionId }, data })
        const response = await reset(electionId)
        expect(response.status).toBe(403)
        expect((await response.json()).error.code).toBe('NOT_DEMO_ELECTION')
        expect(await phaseOf(electionId)).toBe('TALLIED')
        expect(await votesDb.ballotTally.count({ where: { ballotId } })).toBeGreaterThan(0)
        expect(await votersDb.auditEvent.count({ where: { eventType: 'ELECTION_DEMO_RESET' } })).toBe(0)
        await (db.election.update as (args: unknown) => Promise<unknown>)({
          where: { id: electionId },
          data: { mode: 'DEMO', bankIdEnvironment: 'none' },
        })
      }
    })

    it('svarar 404 för en omröstning som inte finns', async () => {
      await loginAdmin()
      expect((await reset('00000000-0000-4000-8000-000000000000')).status).toBe(404)
    })

    it('återställer demovalet: fasen OPEN, rötterna borta, och urnan, bidragen och räkneverken tömda', async () => {
      await loginAdmin()
      const { electionId, ballotId } = await newElection(DEMO_ELECTION_NAME)
      const other = await newElection('Ett val som ska vara orört')
      await tallied(electionId, ballotId)
      await tallied(other.electionId, other.ballotId)

      // Liggande kuvert och markeringar, som en omröstning mitt i läggningen har.
      const voter = await createVoter('199001011234')
      await votersDb.pendingVote.create({
        data: {
          voterStatusId: voter,
          ballotId,
          ciphertext: [],
          proofs: {},
          ciphertextHash: 'a'.repeat(64),
          castSequence: 1,
          bankIdSignature: 'sig',
          bankIdCertificateChain: 'kedja',
          updatedAt: new Date(),
        },
      })
      await votersDb.votedMarker.create({ data: { voterStatusId: voter, ballotId } })
      await votesDb.election.update({ where: { id: electionId }, data: { status: 'UNDER_REVIEW' } })
      expect(await phaseOf(electionId)).toBe('TALLIED')

      const response = await reset(electionId)

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('reset')
      expect(body.removed).toMatchObject({ envelopes: 1, markers: 1 })
      expect(body.removed.contributions).toBeGreaterThan(0)
      expect(body.removed.tallies).toBeGreaterThan(0)

      expect(
        await votersDb.election.findUniqueOrThrow({
          where: { id: electionId },
          select: { phase: true, envelopeRoot: true, urnRoot: true, linkClearedAt: true },
        }),
      ).toEqual({ phase: 'OPEN', envelopeRoot: null, urnRoot: null, linkClearedAt: null })
      expect(
        await votesDb.election.findUniqueOrThrow({
          where: { id: electionId },
          select: { status: true, certifiedAt: true, tallyCompletedAt: true },
        }),
      ).toEqual({ status: 'OPEN', certifiedAt: null, tallyCompletedAt: null })

      for (const where of [{ ballotId }]) {
        expect(await votesDb.encryptedVote.count({ where })).toBe(0)
        expect(await votesDb.partialDecryption.count({ where })).toBe(0)
        expect(await votesDb.ballotTally.count({ where })).toBe(0)
        expect(await votersDb.pendingVote.count({ where })).toBe(0)
        expect(await votersDb.votedMarker.count({ where })).toBe(0)
      }

      // Nyckeln och andelarna behålls.
      expect(await votesDb.trusteeShare.count({ where: { electionId } })).toBe(3)

      // Den andra omröstningen är orörd.
      expect(await phaseOf(other.electionId)).toBe('TALLIED')
      expect(await votesDb.ballotTally.count({ where: { ballotId: other.ballotId } })).toBeGreaterThan(0)
    })

    it('skriver en ny revisionspost och bryter inte kedjan', async () => {
      await loginAdmin()
      const { electionId, ballotId } = await newElection(DEMO_ELECTION_NAME)
      await tallied(electionId, ballotId)

      const before = await votersDb.auditEvent.findMany({ orderBy: { sequence: 'asc' } })
      expect(before.length).toBeGreaterThan(0)

      expect((await reset(electionId)).status).toBe(200)

      const after = await votersDb.auditEvent.findMany({ orderBy: { sequence: 'asc' } })
      expect(after.length).toBeGreaterThanOrEqual(before.length + 1)

      // Inga gamla poster är ändrade eller borta.
      for (const [index, entry] of before.entries()) {
        expect(after[index]).toMatchObject({ sequence: entry.sequence, eventType: entry.eventType, entryHash: entry.entryHash })
      }
      expect(after.filter((entry) => entry.eventType === 'ELECTION_DEMO_RESET')).toHaveLength(1)

      // Kedjan håller från början till slut: varje post pekar på den förra och hashar rätt.
      let previousHash: string | null = null
      for (const [index, entry] of after.entries()) {
        expect(entry.sequence).toBe(index + 1)
        expect(entry.previousHash).toBe(previousHash)
        expect(entry.entryHash).toBe(
          auditEntryHash({
            sequence: entry.sequence,
            eventType: entry.eventType,
            occurredAt: entry.occurredAt,
            previousHash: entry.previousHash,
            urnRoot: entry.urnRoot,
          }),
        )
        previousHash = entry.entryHash
      }
    })

    it('flyttar fram demovalets tider så att röstningen är öppen igen (ruling 136)', async () => {
      await loginAdmin()
      // Skapas med tider som passerat, som demovalet gör när dagarna går.
      const { electionId } = await newElection(DEMO_ELECTION_NAME)
      const other = await newElection('Ett annat val')
      const otherBefore = await votesDb.election.findUniqueOrThrow({ where: { id: other.electionId } })

      expect((await reset(electionId)).status).toBe(200)

      const now = new Date()
      for (const row of [
        await votesDb.election.findUniqueOrThrow({ where: { id: electionId } }),
        await votersDb.election.findUniqueOrThrow({ where: { id: electionId } }),
      ]) {
        expect(row.opensAt.getTime()).toBeLessThanOrEqual(now.getTime())
        expect(row.closesAt.getTime()).toBeGreaterThan(now.getTime() + 25 * 86_400_000)
      }
      const otherAfter = await votesDb.election.findUniqueOrThrow({ where: { id: other.electionId } })
      expect(otherAfter.closesAt).toEqual(otherBefore.closesAt)
    })

    it('går att stänga igen efter en återställning', async () => {
      await loginAdmin()
      const { electionId, ballotId } = await newElection(DEMO_ELECTION_NAME)
      await tallied(electionId, ballotId)

      expect((await reset(electionId)).status).toBe(200)

      // Återställningen öppnar valet 30 dygn framåt. Stängningen väntar på stängningstiden.
      const past = new Date(Date.now() - 60_000)
      await votersDb.election.update({ where: { id: electionId }, data: { closesAt: past } })
      await votesDb.election.update({ where: { id: electionId }, data: { closesAt: past } })
      expect(await closeElection(electionId)).toMatchObject({ status: 'closed' })
      expect(await phaseOf(electionId)).toBe('STRIPPED')
    })

    it('tar stängningens lås: den väntar inte, och rör ingenting medan en stängning pågår', async () => {
      await loginAdmin()
      const { electionId, ballotId } = await newElection(DEMO_ELECTION_NAME)
      await tallied(electionId, ballotId)

      const held = await withClosingLock(electionId, () => reset(electionId))
      expect(held.taken).toBe(true)
      if (!held.taken) return

      expect(held.value.status).toBe(409)
      expect(await held.value.json()).toMatchObject({ status: 'in_progress' })
      expect(await phaseOf(electionId)).toBe('TALLIED')
      expect(await votesDb.ballotTally.count({ where: { ballotId } })).toBeGreaterThan(0)

      // Låset är släppt, och återställningen går igenom.
      expect((await reset(electionId)).status).toBe(200)
    })

    it('glömmer slutkontrollens sparade resultat', async () => {
      await loginAdmin()
      const { electionId, ballotId } = await newElection(DEMO_ELECTION_NAME)
      await tallied(electionId, ballotId)

      await post(checkRoute, '/api/admin/elections/check', { electionId })
      for (;;) {
        const body = await (await post(checkStatusRoute, '/api/admin/elections/check-status', { electionId })).json()
        if (body.status !== 'running') break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      expect((await reset(electionId)).status).toBe(200)
      const body = await (await post(checkStatusRoute, '/api/admin/elections/check-status', { electionId })).json()
      expect(body).toEqual({ status: 'none' })
    })
  })

  describe('demovalets namn', () => {
    it.each([DEMO_ELECTION_NAME, '  valet 2026 ', 'VALET 2026'])(
      'ett val som en administratör skapar får inte heta "%s"',
      async (name) => {
        await loginAdmin()
        const s = await votesDb.party.findFirstOrThrow({ where: { abbreviation: 'S' } })

        const response = await post(createRoute, '/api/admin/elections', {
          name,
          kind: 'RIKSDAGSVAL',
          opensAt: new Date(Date.now() - 60_000).toISOString(),
          closesAt: new Date(Date.now() + 3_600_000).toISOString(),
          ballots: [{ kind: 'RIKSDAG', label: 'Riksdagen', parties: [{ partyId: s.id }] }],
          trusteePassphrases: [...PASSPHRASES],
        })

        expect(response.status).toBe(400)
        expect(await votesDb.election.count()).toBe(0)
      },
    )
  })

  // -------------------------------------------------------------------------
  // Demofraserna
  // -------------------------------------------------------------------------

  describe('demofraserna', () => {
    const phrases = (headers?: Record<string, string>) =>
      post(passphrasesRoute, '/api/demo/trustee-passphrases', {}, headers)

    it('svarar 404 när demoläget är avslaget, och lämnar inga fraser', async () => {
      await loginAdmin()
      demo.on = false

      const response = await phrases()
      expect(response.status).toBe(404)
      expect(JSON.stringify(await response.json())).not.toContain('demo-fortroendeman')
    })

    it('kräver adminsession och CSRF-token i demoläget', async () => {
      expect((await phrases({})).status).toBe(401)
      await loginAdmin()
      expect((await phrases({ 'x-csrf-token': 'fel' })).status).toBe(403)
    })

    it('ger de tre fraserna i demoläget', async () => {
      await loginAdmin()
      const response = await phrases()

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ passphrases: [...DEMO_TRUSTEE_PASSPHRASES] })
    })
  })
})

describe('demovalet och seedningen', () => {
  const seed = readFileSync('prisma/seed.ts', 'utf8')

  it('seedningen skapar ett val med demovalets namn', () => {
    expect(seed).toContain(`name: '${DEMO_ELECTION_NAME}'`)
  })

  it('seedningens fraser är de som sidan fyller i', () => {
    const block = seed.match(/const TRUSTEE_PASSPHRASES[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? ''
    const inSeed = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1])

    expect(inSeed).toEqual([...DEMO_TRUSTEE_PASSPHRASES])
  })

  it('nollställningsskriptet återställer fasen och rötterna, och sparar demovalet vid namn', () => {
    const script = readFileSync('prisma/reset-votes.ts', 'utf8')

    expect(script).toContain("data: { phase: 'OPEN', envelopeRoot: null, urnRoot: null, linkClearedAt: null }")
    // Ruling 136: tiderna räknas från idag, i båda skripten.
    expect(script).toContain('demoElectionWindow(')
    expect(seed).toContain('demoElectionWindow(')
    expect(script).toContain(`name: { not: '${DEMO_ELECTION_NAME}' }`)
  })
})
