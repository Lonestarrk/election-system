import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { DEMO_TRUSTEE_PASSPHRASES } from '@/lib/demo-election'
import { createElection } from '@/orchestration/create-election.usecase'
import { closeElection } from '@/orchestration/close-election.usecase'
import { certifyElection } from '@/orchestration/final-check.usecase'
import { checkElectionMode } from '@/orchestration/election-mode'
import { publishedResults } from '@/orchestration/publish-results.usecase'
import { castEncryptedBallot, castWindow } from '@/modules/eligibility/pending-vote.service'
import { disconnect, isDatabaseAvailable, resetElectionData } from './helpers'

/**
 * OMRÖSTNINGEN BÄR SIN BANKID-MILJÖ (härdningen, punkt 3).
 *
 * Läget från uppgift 17 sa DEMO eller SHARP, men inte vilken BankID ett skarpt
 * val gick mot. En omröstning skapad mot BankID:s testmiljö, där vem som helst
 * kan skaffa ett test-BankID för vilket personnummer som helst, kunde därför
 * stängas, räknas, publiceras och fastställas av en server mot produktionen, och
 * publiceringen såg likadan ut.
 *
 * Nu skrivs miljön när omröstningen skapas, i båda databaserna, ur serverns egen:
 * `none` för attrappen i demoläget och för skarpt läge utan klient, annars
 * `test` eller `production`. Varje väg som spärras av läget spärras också av
 * miljön, och publiceringen bär miljön ur omröstningens rad.
 */

const databaseAvailable = await isDatabaseAvailable()

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

const FRESH_PHRASES: [string, string, string] = [
  'riktig-fras-nummer-ett',
  'riktig-fras-nummer-tva',
  'riktig-fras-nummer-tre',
]

type Server = { demo: boolean; bankId?: 'test' | 'production' }

function runAs(server: Server): void {
  vi.stubEnv('DEMO_MODE', server.demo ? 'true' : '')
  vi.stubEnv('BANKID_ENV', server.bankId ?? '')
}

async function create(server: Server) {
  runAs(server)
  const party = await votesDb.party.findFirstOrThrow({ orderBy: { displayOrder: 'asc' } })
  const outcome = await createElection({
    name: 'Miljövalet',
    kind: 'RIKSDAGSVAL',
    opensAt: new Date(Date.now() - 60_000),
    closesAt: new Date(Date.now() + 3_600_000),
    ballots: [{ kind: 'RIKSDAG', label: 'Riksdagen', allowsCandidateVote: false, parties: [{ partyId: party.id }] }],
    trusteePassphrases: server.demo ? [...DEMO_TRUSTEE_PASSPHRASES] : FRESH_PHRASES,
  })
  if (outcome.status !== 'created') throw new Error(`Kunde inte skapa omröstningen: ${outcome.message}`)
  return outcome.election
}

async function environmentsOf(electionId: string): Promise<[string, string]> {
  const voters = (await votersDb.election.findUniqueOrThrow({ where: { id: electionId } })) as unknown as {
    bankIdEnvironment: string
  }
  const votes = (await votesDb.election.findUniqueOrThrow({ where: { id: electionId } })) as unknown as {
    bankIdEnvironment: string
  }
  return [voters.bankIdEnvironment, votes.bankIdEnvironment]
}

async function refusedEverywhere(election: Awaited<ReturnType<typeof create>>): Promise<void> {
  const cast = await castEncryptedBallot(
    '00000000-0000-4000-8000-000000000000',
    election.id,
    election.ballotIds[0]!.id,
    {} as never,
    { signature: '', ocspResponse: '' } as never,
    null,
  )
  expect(cast).toEqual({ status: 'wrong_mode' })
  expect(await castWindow(election.id)).toBe('wrong_mode')
  expect(await checkElectionMode(election.id)).toBe('wrong')
  expect(await closeElection(election.id)).toEqual({ status: 'wrong_mode' })
  expect(await certifyElection(election.id)).toEqual({ status: 'wrong_mode' })
  expect(await publishedResults(election.id)).toEqual({ status: 'wrong_mode' })
  // Ingenting skrevs: fasen står kvar.
  expect((await votersDb.election.findUniqueOrThrow({ where: { id: election.id } })).phase).toBe('OPEN')
}

describe.skipIf(!databaseAvailable)('omröstningens BankID-miljö', () => {
  beforeEach(async () => {
    await resetElectionData()
    if ((await votesDb.party.count()) === 0) {
      await votesDb.party.create({ data: { name: 'Testpartiet', abbreviation: 'T', color: '#000000', displayOrder: 1 } })
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('skrivs i båda databaserna ur serverns egen miljö', async () => {
    expect(await environmentsOf((await create({ demo: true })).id)).toEqual(['none', 'none'])
    // Demoläget använder attrappen också när BANKID_ENV är satt.
    expect(await environmentsOf((await create({ demo: true, bankId: 'production' })).id)).toEqual(['none', 'none'])
    expect(await environmentsOf((await create({ demo: false, bankId: 'test' })).id)).toEqual(['test', 'test'])
    expect(await environmentsOf((await create({ demo: false, bankId: 'production' })).id)).toEqual([
      'production',
      'production',
    ])
    expect(await environmentsOf((await create({ demo: false })).id)).toEqual(['none', 'none'])
  })

  it('en omröstning mot testmiljön vägras av en server mot produktionen', async () => {
    const election = await create({ demo: false, bankId: 'test' })
    runAs({ demo: false, bankId: 'production' })
    await refusedEverywhere(election)
  })

  it('en omröstning mot produktionen vägras av en server mot testmiljön', async () => {
    const election = await create({ demo: false, bankId: 'production' })
    runAs({ demo: false, bankId: 'test' })
    await refusedEverywhere(election)
  })

  it('en skarp omröstning utan BankID vägras av en server mot testmiljön', async () => {
    const election = await create({ demo: false })
    runAs({ demo: false, bankId: 'test' })
    await refusedEverywhere(election)
  })

  it('en rad som skrivits om ensam räcker inte: båda databasernas rader ska stämma', async () => {
    const election = await create({ demo: false, bankId: 'test' })
    await (votesDb.election.update as (args: unknown) => Promise<unknown>)({
      where: { id: election.id },
      data: { bankIdEnvironment: 'production' },
    })
    runAs({ demo: false, bankId: 'test' })
    expect(await checkElectionMode(election.id)).toBe('wrong')
    expect(await closeElection(election.id)).toEqual({ status: 'wrong_mode' })

    // Röstlängdens rad ensam räcker inte heller.
    const other = await create({ demo: false, bankId: 'test' })
    await (votersDb.election.update as (args: unknown) => Promise<unknown>)({
      where: { id: other.id },
      data: { bankIdEnvironment: 'production' },
    })
    runAs({ demo: false, bankId: 'test' })
    expect(await castWindow(other.id)).toBe('wrong_mode')
    expect(await closeElection(other.id)).toEqual({ status: 'wrong_mode' })
  })

  it('en omröstning i rätt miljö vägras inte av spärren', async () => {
    const election = await create({ demo: false, bankId: 'test' })
    runAs({ demo: false, bankId: 'test' })

    expect(await checkElectionMode(election.id)).toBe('ok')
    expect(await castWindow(election.id)).toBe('open')
    // Stängningen vägrar av ett annat skäl: tiden har inte gått ut.
    expect(await closeElection(election.id)).toMatchObject({ status: 'too_early' })
  })
})
