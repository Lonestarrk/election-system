import { describe, expect, it } from 'vitest'
import {
  ballotStatus,
  forgetDeviceVote,
  forgetElectionsNotOpen,
  forgetIfVotingEnded,
  hashesToCompare,
  readDeviceVotes,
  rememberDeviceVote,
  staleDeviceVotes,
  storedElectionIds,
  type DeviceStorage,
  type DeviceVote,
  type ServerBallot,
} from '@/app/vote/device-vote'

/**
 * Vad röstsidan sparar på enheten, och när den raderar det (spec 3.1).
 *
 * Lagringen prövas här i stället för i e2e, där en stängning av valet vore
 * för tung att ta sig fram till: radering när fasen lämnat OPEN, radering när
 * rösten ändrats från en annan enhet, och att bara valet och chifferhashen
 * någonsin skrivs, aldrig ett slumptal eller en kod.
 */

/** En lagring med samma gränssnitt som localStorage, i minnet. */
class MemoryStorage implements DeviceStorage {
  private readonly items = new Map<string, string>()

  get length(): number {
    return this.items.size
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }

  removeItem(key: string): void {
    this.items.delete(key)
  }

  dump(): string {
    return JSON.stringify(Object.fromEntries(this.items))
  }
}

const ELECTION = '11111111-1111-4111-8111-111111111111'
const OTHER_ELECTION = '22222222-2222-4222-8222-222222222222'
const RIKSDAG = '33333333-3333-4333-8333-333333333333'
const KOMMUN = '44444444-4444-4444-8444-444444444444'

const VOTE: DeviceVote = {
  ciphertextHash: 'a'.repeat(64),
  choice: { kind: 'PARTY', ballotPartyId: '55555555-5555-4555-8555-555555555555' },
  label: 'Socialdemokraterna',
}

function ballot(id: string, overrides: Partial<ServerBallot> = {}): ServerBallot {
  return { id, kind: 'RIKSDAG', label: 'Riksdagen', hasPendingVote: false, votedInOldFlow: false, ...overrides }
}

describe('vad enheten sparar', () => {
  it('sparar valet och chifferhashen per valsedel och läser tillbaka dem', () => {
    const storage = new MemoryStorage()
    rememberDeviceVote(storage, ELECTION, RIKSDAG, VOTE)

    expect(readDeviceVotes(storage, ELECTION)).toEqual({ [RIKSDAG]: VOTE })
    expect(storedElectionIds(storage)).toEqual([ELECTION])
  })

  it('skriver bara valet och chifferhashen, också om rösten bär mer', () => {
    // Ett objekt som sprids in i lagringen tar med sig allt det bär. Här bär
    // det ett slumptal och en kod, och ingetdera får hamna på enheten.
    const storage = new MemoryStorage()
    const carrying = {
      ...VOTE,
      nonce: '123456789',
      randomness: ['1', '2'],
      token: 'ABCD-EFGH',
      choice: { ...VOTE.choice, slumptal: '42' },
    } as unknown as DeviceVote

    rememberDeviceVote(storage, ELECTION, RIKSDAG, carrying)

    const stored = storage.dump()
    expect(stored).not.toMatch(/random|slump|nonce|token|123456789|ABCD/i)
    expect(Object.keys(readDeviceVotes(storage, ELECTION)[RIKSDAG]!).sort()).toEqual([
      'choice',
      'ciphertextHash',
      'label',
    ])
  })

  it('skriver ingenting för en post som inte har formen', () => {
    const storage = new MemoryStorage()
    rememberDeviceVote(storage, ELECTION, RIKSDAG, { ...VOTE, ciphertextHash: 'inte en hash' })
    expect(storage.length).toBe(0)
  })

  it('en ny röst på samma valsedel ersätter den gamla', () => {
    const storage = new MemoryStorage()
    rememberDeviceVote(storage, ELECTION, RIKSDAG, VOTE)
    rememberDeviceVote(storage, ELECTION, RIKSDAG, { ...VOTE, ciphertextHash: 'b'.repeat(64), label: 'Moderaterna' })

    expect(readDeviceVotes(storage, ELECTION)[RIKSDAG]!.label).toBe('Moderaterna')
    expect(storage.dump()).not.toContain('Socialdemokraterna')
  })

  it('tål en trasig post i stället för att fälla sidan', () => {
    const storage = new MemoryStorage()
    storage.setItem(`valsystem.enhetens-rost.${ELECTION}`, '{inte json')
    expect(readDeviceVotes(storage, ELECTION)).toEqual({})
  })
})

describe('när enheten raderar', () => {
  it('raderar allt om valet när fasen lämnat OPEN', () => {
    for (const phase of ['CLOSED', 'VALIDATED', 'STRIPPED', 'TALLIED', 'CERTIFIED']) {
      const storage = new MemoryStorage()
      rememberDeviceVote(storage, ELECTION, RIKSDAG, VOTE)
      rememberDeviceVote(storage, OTHER_ELECTION, RIKSDAG, VOTE)

      expect(forgetIfVotingEnded(storage, ELECTION, { phase, acceptsVotes: false }), phase).toBe(true)
      expect(readDeviceVotes(storage, ELECTION), phase).toEqual({})
      // Bara det valet. En annan omröstning har sin egen fas.
      expect(readDeviceVotes(storage, OTHER_ELECTION), phase).toEqual({ [RIKSDAG]: VOTE })
    }
  })

  it('raderar också när closesAt passerats men fasen ännu står i OPEN', () => {
    const storage = new MemoryStorage()
    rememberDeviceVote(storage, ELECTION, RIKSDAG, VOTE)

    expect(forgetIfVotingEnded(storage, ELECTION, { phase: 'OPEN', acceptsVotes: false })).toBe(true)
    expect(storage.length).toBe(0)
  })

  it('behåller allt medan röstningen pågår', () => {
    const storage = new MemoryStorage()
    rememberDeviceVote(storage, ELECTION, RIKSDAG, VOTE)

    expect(forgetIfVotingEnded(storage, ELECTION, { phase: 'OPEN', acceptsVotes: true })).toBe(false)
    expect(readDeviceVotes(storage, ELECTION)).toEqual({ [RIKSDAG]: VOTE })
  })

  it('raderar utan session varje val som inte längre står bland de öppna', () => {
    const storage = new MemoryStorage()
    rememberDeviceVote(storage, ELECTION, RIKSDAG, VOTE)
    rememberDeviceVote(storage, OTHER_ELECTION, RIKSDAG, VOTE)

    expect(forgetElectionsNotOpen(storage, [OTHER_ELECTION])).toEqual([ELECTION])
    expect(storedElectionIds(storage)).toEqual([OTHER_ELECTION])
  })

  it('raderar en post vars röst ändrats från en annan enhet eller inte längre finns', () => {
    const votes = { [RIKSDAG]: VOTE, [KOMMUN]: VOTE }
    const ballots = [ballot(RIKSDAG, { hasPendingVote: true }), ballot(KOMMUN, { hasPendingVote: true })]

    expect(staleDeviceVotes(votes, ballots, { [RIKSDAG]: 'same', [KOMMUN]: 'different' })).toEqual([
      KOMMUN,
    ])
    expect(staleDeviceVotes(votes, ballots, { [RIKSDAG]: 'none', [KOMMUN]: 'same' })).toEqual([RIKSDAG])
    // Utan kuvert bakom sig finns ingenting att visa, och posten frågas inte ens om.
    expect(staleDeviceVotes(votes, [ballot(RIKSDAG, { hasPendingVote: true })], { [RIKSDAG]: 'same' })).toEqual([
      KOMMUN,
    ])
    // Svarade servern inte raderas ingenting: posten kan fortfarande stämma.
    expect(staleDeviceVotes(votes, ballots, {})).toEqual([])
  })

  it('glömmer en enskild valsedel och lämnar de andra', () => {
    const storage = new MemoryStorage()
    rememberDeviceVote(storage, ELECTION, RIKSDAG, VOTE)
    rememberDeviceVote(storage, ELECTION, KOMMUN, VOTE)

    forgetDeviceVote(storage, ELECTION, KOMMUN)
    expect(Object.keys(readDeviceVotes(storage, ELECTION))).toEqual([RIKSDAG])

    forgetDeviceVote(storage, ELECTION, RIKSDAG)
    // Den sista posten tar nyckeln med sig, så att ingenting står kvar.
    expect(storage.length).toBe(0)
  })
})

describe('vad valsedeln visar', () => {
  it('visar valet bara när servern håller exakt den röst som lades härifrån', () => {
    const withEnvelope = ballot(RIKSDAG, { hasPendingVote: true })
    const open = { acceptsVotes: true, deviceVote: VOTE }

    expect(ballotStatus({ ...open, ballot: withEnvelope, comparison: 'same' })).toEqual({
      kind: 'current',
      label: 'Socialdemokraterna',
    })
    expect(ballotStatus({ ...open, ballot: withEnvelope, comparison: 'different' })).toEqual({
      kind: 'changed-elsewhere',
    })
    // Inget svar från servern: bara att rösten finns, aldrig innehållet.
    expect(ballotStatus({ ...open, ballot: withEnvelope, comparison: undefined })).toEqual({
      kind: 'registered',
    })
  })

  it('en enhet utan egen post ser att rösten finns, men inte vad den innehåller', () => {
    expect(
      ballotStatus({
        ballot: ballot(RIKSDAG, { hasPendingVote: true }),
        acceptsVotes: true,
        deviceVote: undefined,
        comparison: undefined,
      }),
    ).toEqual({ kind: 'registered' })
  })

  it('en post utan kuvert bakom sig visar ingenting', () => {
    expect(
      ballotStatus({ ballot: ballot(RIKSDAG), acceptsVotes: true, deviceVote: VOTE, comparison: 'same' }),
    ).toEqual({ kind: 'not-voted' })
  })

  it('efter stängningen visas inget innehåll, vad enheten än har sparat', () => {
    expect(
      ballotStatus({
        ballot: ballot(RIKSDAG, { hasPendingVote: true }),
        acceptsVotes: false,
        deviceVote: VOTE,
        comparison: 'same',
      }),
    ).toEqual({ kind: 'closed', hasPendingVote: true })
  })

  it('en röst i det gamla flödet går inte att ändra, och ett kuvert erbjuds inte ovanpå den', () => {
    expect(
      ballotStatus({
        ballot: ballot(RIKSDAG, { votedInOldFlow: true }),
        acceptsVotes: true,
        deviceVote: undefined,
        comparison: undefined,
      }),
    ).toEqual({ kind: 'old-flow' })
  })

  it('en fråga i en allmän omröstning kan kuvertmodellen inte ta emot', () => {
    expect(
      ballotStatus({
        ballot: ballot(RIKSDAG, { kind: 'FRAGA' }),
        acceptsVotes: true,
        deviceVote: undefined,
        comparison: undefined,
      }),
    ).toEqual({ kind: 'unsupported' })
  })

  it('frågar servern bara om valsedlar där ett kuvert ligger', () => {
    const votes = { [RIKSDAG]: VOTE, [KOMMUN]: VOTE }
    expect(hashesToCompare(votes, [ballot(RIKSDAG, { hasPendingVote: true }), ballot(KOMMUN)])).toEqual([
      { ballotId: RIKSDAG, ciphertextHash: VOTE.ciphertextHash },
    ])
  })
})
