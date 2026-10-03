import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { DEMO_TRUSTEE_PASSPHRASES } from '@/lib/demo-election'
import { createElection } from '@/orchestration/create-election.usecase'
import { closeElection } from '@/orchestration/close-election.usecase'
import { certifyElection } from '@/orchestration/final-check.usecase'
import { castEncryptedBallot } from '@/modules/eligibility/pending-vote.service'
import { disconnect, isDatabaseAvailable, resetElectionData } from './helpers'

/**
 * OMRÖSTNINGEN BÄR SITT LÄGE (uppgift 17, steg 4).
 *
 * En demoomröstning kan aldrig fastställas i skarpt läge, och demoröster hamnar
 * aldrig i en skarp omröstning. Läget skrivs när omröstningen skapas, i båda
 * databaserna, och läggning, stängning och fastställande vägrar en omröstning
 * vars läge skiljer sig från serverns.
 *
 * Läget byts mellan skapandet och anropet med vi.stubEnv: servern läser det vid
 * varje anrop, och det ska den göra, eftersom en process som startats i ett
 * läge aldrig byter det men testet måste kunna visa båda hållen.
 */

const databaseAvailable = await isDatabaseAvailable()

if (!databaseAvailable) {
  process.stderr.write('\n  Ingen databas tillgänglig — integrationstesterna hoppas över.\n')
}

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

const FRESH_PHRASES: [string, string, string] = [
  'riktig-fras-nummer-ett',
  'riktig-fras-nummer-tva',
  'riktig-fras-nummer-tre',
]

async function request(trusteePassphrases: [string, string, string]) {
  const party = await votesDb.party.findFirstOrThrow({ orderBy: { displayOrder: 'asc' } })
  return {
    name: 'Lägesvalet',
    kind: 'RIKSDAGSVAL' as const,
    opensAt: new Date(Date.now() - 60_000),
    closesAt: new Date(Date.now() + 3_600_000),
    ballots: [
      {
        kind: 'RIKSDAG' as const,
        label: 'Riksdagen',
        allowsCandidateVote: false,
        parties: [{ partyId: party.id }],
      },
    ],
    trusteePassphrases,
  }
}

async function create(mode: 'true' | '', phrases: [string, string, string]) {
  vi.stubEnv('DEMO_MODE', mode)
  const outcome = await createElection(await request(phrases))
  if (outcome.status !== 'created') throw new Error(`Kunde inte skapa omröstningen: ${outcome.message}`)
  return outcome.election
}

describe.skipIf(!databaseAvailable)('omröstningens läge', () => {
  beforeEach(async () => {
    await resetElectionData()
    // Partiregistret är referensdata och töms inte. Saknas det i testdatabasen
    // skapas ett parti här.
    if ((await votesDb.party.count()) === 0) {
      await votesDb.party.create({ data: { name: 'Testpartiet', abbreviation: 'T', color: '#000000', displayOrder: 1 } })
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('skapandet', () => {
    it('skriver läget i båda databaserna', async () => {
      const demo = await create('true', [...DEMO_TRUSTEE_PASSPHRASES])
      expect((await votesDb.election.findUniqueOrThrow({ where: { id: demo.id } })).mode).toBe('DEMO')
      expect((await votersDb.election.findUniqueOrThrow({ where: { id: demo.id } })).mode).toBe('DEMO')

      const sharp = await create('', FRESH_PHRASES)
      expect((await votesDb.election.findUniqueOrThrow({ where: { id: sharp.id } })).mode).toBe('SHARP')
      expect((await votersDb.election.findUniqueOrThrow({ where: { id: sharp.id } })).mode).toBe('SHARP')
    })

    it('vägrar demofraserna i skarpt läge, och skriver ingenting', async () => {
      vi.stubEnv('DEMO_MODE', '')
      const outcome = await createElection(await request([...DEMO_TRUSTEE_PASSPHRASES]))

      expect(outcome.status).toBe('failed')
      expect(outcome.status === 'failed' && outcome.message).toMatch(/kända fraser|demofras/i)
      expect(await votesDb.election.count()).toBe(0)
      expect(await votersDb.election.count()).toBe(0)
      expect(await votesDb.trusteeShare.count()).toBe(0)
    })

    it('vägrar också när bara en av fraserna är en demofras, och oavsett skiftläge och blanksteg', async () => {
      vi.stubEnv('DEMO_MODE', '')
      for (const phrases of [
        [DEMO_TRUSTEE_PASSPHRASES[0], 'egen-fras-nummer-tva', 'egen-fras-nummer-tre'],
        ['egen-fras-nummer-ett', 'egen-fras-nummer-tva', DEMO_TRUSTEE_PASSPHRASES[2]],
        ['egen-fras-nummer-ett', `  ${DEMO_TRUSTEE_PASSPHRASES[1].toUpperCase()} `, 'egen-fras-nummer-tre'],
      ] as Array<[string, string, string]>) {
        const outcome = await createElection(await request(phrases))
        expect(outcome.status, JSON.stringify(phrases)).toBe('failed')
      }
      expect(await votesDb.election.count()).toBe(0)
    })

    it('godtar demofraserna i demoläget, där de hör hemma', async () => {
      vi.stubEnv('DEMO_MODE', 'true')
      const outcome = await createElection(await request([...DEMO_TRUSTEE_PASSPHRASES]))
      expect(outcome.status).toBe('created')
    })
  })

  describe('en demoomröstning i skarpt läge', () => {
    it('vägrar läggning, stängning och fastställande', async () => {
      const election = await create('true', [...DEMO_TRUSTEE_PASSPHRASES])
      vi.stubEnv('DEMO_MODE', '')

      const ballot = election.ballotIds[0]!.id
      const cast = await castEncryptedBallot(
        '00000000-0000-4000-8000-000000000000',
        election.id,
        ballot,
        {} as never,
        { signature: '', ocspResponse: '' } as never,
        null,
      )
      expect(cast).toEqual({ status: 'wrong_mode' })
      expect(await closeElection(election.id)).toEqual({ status: 'wrong_mode' })
      expect(await certifyElection(election.id)).toEqual({ status: 'wrong_mode' })

      // Ingenting skrevs: fasen står kvar, och ingen revisionspost lades.
      expect((await votersDb.election.findUniqueOrThrow({ where: { id: election.id } })).phase).toBe('OPEN')
      expect(await votersDb.auditEvent.count({ where: { eventType: { startsWith: 'ELECTION_CERTIFIED' } } })).toBe(0)
    })
  })

  describe('en skarp omröstning i demoläge', () => {
    it('vägrar läggning, stängning och fastställande, så att demoröster aldrig hamnar i den', async () => {
      const election = await create('', FRESH_PHRASES)
      vi.stubEnv('DEMO_MODE', 'true')

      const cast = await castEncryptedBallot(
        '00000000-0000-4000-8000-000000000000',
        election.id,
        election.ballotIds[0]!.id,
        {} as never,
        { signature: '', ocspResponse: '' } as never,
        null,
      )
      expect(cast).toEqual({ status: 'wrong_mode' })
      expect(await closeElection(election.id)).toEqual({ status: 'wrong_mode' })
      expect(await certifyElection(election.id)).toEqual({ status: 'wrong_mode' })
    })
  })

  describe('en rad som skrivits om ensam', () => {
    it('räcker inte: stängning och fastställande kräver att båda databasernas rader stämmer', async () => {
      const election = await create('true', [...DEMO_TRUSTEE_PASSPHRASES])
      await votesDb.election.update({ where: { id: election.id }, data: { mode: 'SHARP' } })

      expect(await closeElection(election.id)).toEqual({ status: 'wrong_mode' })
      expect(await certifyElection(election.id)).toEqual({ status: 'wrong_mode' })
    })
  })

  describe('en omröstning i rätt läge', () => {
    it('vägras inte av lägesspärren', async () => {
      const election = await create('true', [...DEMO_TRUSTEE_PASSPHRASES])

      // Stängningen vägrar av ett annat skäl: tiden har inte gått ut.
      expect(await closeElection(election.id)).toMatchObject({ status: 'too_early' })
      expect(await certifyElection(election.id)).toMatchObject({ status: 'not_ready' })
    })
  })
})
