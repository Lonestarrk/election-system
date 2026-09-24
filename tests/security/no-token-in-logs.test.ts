import { readdirSync, readFileSync } from 'node:fs'
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

describe('röstsidan sparar valet och hashen på ett enda ställe, och ingen kod', () => {
  /**
   * BLOCKET GÄLLDE KVITTOSIDAN, OCH KVITTOT FINNS INTE LÄNGRE.
   *
   * Röstsidan delade tidigare ut en token per valsedel. Testerna här låste fast
   * att den aldrig hamnade i webbläsarens lagring, att den kopierades till
   * urklipp bara på väljarens eget klick och att sidan varnade för att den
   * bara visades en gång. Sedan uppgift 14 lägger sidan kuvert och delar inte
   * ut någon token, så det finns ingenting att kopiera eller varna för.
   *
   * Lagringen är nu avsiktlig. Enheten sparar valet och chifferhashen för att
   * kunna visa den nuvarande rösten (spec 3.1 punkt 1), men aldrig slumptalet.
   * Det som låses fast här är att det sker på ett ställe och i en form, och
   * att ingenting från sidan går till urklipp eller adressfältet. Vad som
   * faktiskt hamnar i lagringen prövas i tests/unit/device-vote.test.ts och i
   * tests/e2e/voting-flow.spec.ts.
   *
   * Koden granskas utan kommentarerna, som förklarar just det här i löpande
   * text.
   */
  const directory = join(process.cwd(), 'src/app/vote')
  const files = readdirSync(directory)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => ({
      name,
      code: readFileSync(join(directory, name), 'utf8')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n'),
    }))

  it('hittar röstsidans filer', () => {
    expect(files.map((file) => file.name).sort()).toEqual([
      'BankIdSigning.tsx',
      'device-vote.ts',
      'page.tsx',
    ])
  })

  it('bara lagringsmodulen rör webbläsarens lagring', () => {
    const touching = files
      .filter((file) => /localStorage|sessionStorage|indexedDB|document\.cookie\s*=/.test(file.code))
      .map((file) => file.name)
    expect(touching).toEqual(['device-vote.ts'])
  })

  it('lagringsmodulen skriver bara poster som den själv rensat', () => {
    const storage = files.find((file) => file.name === 'device-vote.ts')!.code
    // En enda skrivning, och den skriver posterna som `asDeviceVote` plockat
    // ut fält för fält. Ett objekt som sprids in hade tagit med allt det bär.
    expect(storage.match(/\.setItem\(/g)).toHaveLength(1)
    expect(storage).toContain('storage.setItem(keyFor(electionId), JSON.stringify(votes))')
    expect(storage).toContain('const clean = asDeviceVote(vote)')
    expect(storage).toContain(
      'return { ciphertextHash: candidate.ciphertextHash, choice, label: candidate.label }',
    )
  })

  it('ingenting går till urklipp, och ingen hash läggs i en adress', () => {
    for (const file of files) {
      expect(file.code, file.name).not.toMatch(/clipboard/)
      expect(file.code, file.name).not.toMatch(/useRouter|useSearchParams|history\.(push|replace)State/)
      expect(file.code, file.name).not.toMatch(
        /(location\.(href|assign|replace)|searchParams)[^\n]*ciphertextHash/,
      )
    }
  })
})
