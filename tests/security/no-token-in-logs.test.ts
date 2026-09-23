import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { castVote } from '@/modules/ballot-box'
import {
  createTestElection,
  createVoter,
  disconnect,
  isDatabaseAvailable,
  resetElectionData,
  voteOnce,
  type TestElection,
} from '../integration/helpers'

/**
 * Testpunkt 10: klartext-token skrivs aldrig till applikationsloggen.
 * Testpunkt 11: token visas exakt en gång.
 *
 * Testet fångar upp ALLT som skrivs till console under en fullständig
 * röstning — inte bara det som går via loggern — och letar efter token i
 * utdatan. Det täcker alltså även en oavsiktlig `console.log` som någon lagt in
 * under felsökning och glömt ta bort.
 */

const databaseAvailable = await isDatabaseAvailable()

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

describe.skipIf(!databaseAvailable)('token i loggarna', () => {
  let captured: string[] = []

  beforeEach(async () => {
    await resetElectionData()
    captured = []

    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((value) => String(value)).join(' '))
      })
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  let election: TestElection

  it('en fullständig röstning skriver aldrig ut token', async () => {
    election = await createTestElection()
    const voterId = await createVoter('199001011234')

    const outcome = await voteOnce(voterId, election)
    if (outcome.status !== 'voted') throw new Error('Röstningen misslyckades: ' + outcome.reason)

    const everythingLogged = captured.join('\n')

    expect(everythingLogged).not.toContain(outcome.token)
    expect(everythingLogged).not.toContain(outcome.token.replace(/-/g, ''))
    // Även en delsträng vore illa: åtta tecken räcker för att peka ut rösten
    // om någon också har databasen.
    expect(everythingLogged).not.toContain(outcome.token.slice(0, 8))
  })

  it('en misslyckad röstning skriver varken ut personnummer eller identitet', async () => {
    election = await createTestElection()
    const voterId = await createVoter('199001011234')

    // Ett påhittat röstintyg → felvägen genom inlösen.
    await castVote({
      ballotId: election.ballotId,
      ballotPartyId: election.ballotPartyId,
      credentialId: 'f'.repeat(64),
      credentialSignature: 'a'.repeat(512),
    })

    const everythingLogged = captured.join('\n')
    expect(everythingLogged).not.toContain('199001011234')
    expect(everythingLogged).not.toContain(voterId)
  })
})

describe.skipIf(!databaseAvailable)('token visas bara en gång', () => {
  beforeEach(async () => {
    await resetElectionData()
  })

  it('ett förbrukat röstintyg kan inte framkalla en ny token', async () => {
    const election = await createTestElection()
    const voterId = await createVoter('199001011234')

    const first = await voteOnce(voterId, election)
    expect(first.status).toBe('voted')

    // Väljaren är markerad som röstande på valsedeln och får inget nytt intyg.
    // Utan intyg finns ingen väg till en ny token.
    const second = await voteOnce(voterId, election)
    expect(second.status).toBe('blocked')
  })

  it('token går inte att hämta ur databasen i efterhand', async () => {
    const election = await createTestElection()
    const voterId = await createVoter('199001011234')
    const outcome = await voteOnce(voterId, election)
    if (outcome.status !== 'voted') throw new Error('Röstningen misslyckades')

    const { votesDb } = await import('@/modules/ballot-box/db')
    const votes = await votesDb.vote.findMany()

    // Endast hashen finns lagrad. Klartexten går inte att räkna fram ur den.
    const serialised = JSON.stringify(votes)
    expect(serialised).not.toContain(outcome.token)
    expect(serialised).not.toContain(outcome.token.replace(/-/g, ''))
  })
})

describe('klienten sparar inte token', () => {
  const receiptPageSource = readFileSync(join(process.cwd(), 'src/app/vote/page.tsx'), 'utf8')

  /**
   * Granskar koden, inte kommentarerna.
   *
   * Sidan förklarar i en kommentar varför den INTE använder sessionStorage.
   * Utan den här rensningen skulle förklaringen utlösa samma testfel som ett
   * verkligt anrop, och den enda vägen förbi vore att ta bort förklaringen.
   */
  const receiptPage = receiptPageSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')

  it('skriver inte token till localStorage eller sessionStorage', () => {
    expect(receiptPage).not.toMatch(/localStorage/)
    expect(receiptPage).not.toMatch(/sessionStorage/)
  })

  it('lägger inte token i en URL', () => {
    expect(receiptPage).not.toMatch(/router\.push\([^)]*token/)
    expect(receiptPage).not.toMatch(/searchParams[^)]*token/)
  })

  it('kopiering till urklipp sker bara på väljarens eget klick', () => {
    // clipboard.writeText får bara förekomma inuti copyToken, som i sin tur
    // bara anropas från en onClick-hanterare.
    const clipboardCalls = receiptPage.match(/clipboard\.writeText/g) ?? []
    expect(clipboardCalls).toHaveLength(1)
    expect(receiptPage).toMatch(/async function copyToken\(\)[\s\S]*clipboard\.writeText/)
    expect(receiptPage).toMatch(/onClick=\{copyToken\}/)
  })

  it('varnar väljaren att token bara visas en gång', () => {
    expect(receiptPage).toContain(
      'Detta är enda gången din token visas. Spara den om du vill kunna kontrollera din',
    )
  })
})
