import { describe, expect, it } from 'vitest'
import type { DatabaseState } from '@/app/api/demo/database-state/route'
import { followReducer, INITIAL_FOLLOW_STATE, type FollowState } from '@/app/architecture/follow-a-vote'
import {
  createSnapshotLoader,
  startLiveRefresh,
  type Ticker,
  type Visibility,
} from '@/app/architecture/live-refresh'

/**
 * HUR LIVEVYN HÄMTAR.
 *
 * Två egenskaper bär en del av skyddet i "Följ en röst", och ingen av dem syns
 * i reducern ensam:
 *
 *   – löpnumret delas ut när frågan skickas, så att ett sent svar från före
 *     stängningen inte kan ersätta ett nyare;
 *   – en flik som blir synlig hämtar direkt, så att den inte visar bilden från
 *     före stängningen i upp till tio sekunder.
 *
 * Båda prövas här utan webbläsare, med styrda löften, en falsk klocka och en
 * falsk synlighet. Kopplingen i webbläsaren prövas i tests/e2e/architecture.spec.ts.
 */

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Två bilder som bara skiljer sig i det som betyder något här: om kopplingen finns. */
function snapshotWith(pendingVotes: number): DatabaseState {
  return {
    elections: [],
    votersDb: {
      name: 'voters_db',
      voterStatus: [],
      pendingVote: Array.from({ length: pendingVotes }, (_, index) => ({
        id: `kuvert-${index}…`,
        voterStatusId: `väljare-${index}…`,
        electionId: null,
        ballotId: 'valsedel-11…',
        ballotLabel: null,
        ciphertextHash: `${index}`.repeat(12) + '…',
        castSequence: 1,
        updatedAt: '2026-09-23',
        ciphertext: null,
      })),
      pendingVoteColumns: [],
      foreignKeys: [],
    },
    votesDb: {
      name: 'votes_db',
      encryptedVote: [],
      encryptedVoteColumns: [],
      trusteeShare: [],
      partialDecryption: [],
      ballotTally: [],
      legacyVote: [],
      foreignKeys: [],
    },
    analysis: {
      linkQuery: { sql: '', rows: pendingVotes },
      identityValuesCompared: 0,
      identityValuesInVotesDb: [],
      ciphertextHashesInBoth: [],
      foreignKeysChecked: 0,
      foreignKeysAcrossDatabases: [],
    },
  }
}

const BEFORE_CLOSE = snapshotWith(2)
const AFTER_CLOSE = snapshotWith(0)

describe('löpnumret', () => {
  it('ett svar från före stängningen kan inte ersätta ett nyare, hur sent det än kommer', async () => {
    /**
     * Två frågor i luften samtidigt: den första skickades före stängningen,
     * den andra efter. Svaret på den första är långsamt och kommer fram sist.
     *
     * Delades löpnumret ut när svaret kom, i stället för när frågan skickades,
     * fick det sena, gamla svaret det högsta numret och ersatte det nyare. De
     * raderade raderna skulle då dyka upp igen i fliken.
     */
    const beforeClose = deferred<DatabaseState>()
    const afterClose = deferred<DatabaseState>()
    const responses = [beforeClose.promise, afterClose.promise]

    let state: FollowState = INITIAL_FOLLOW_STATE
    const load = createSnapshotLoader<DatabaseState>({
      fetchSnapshot: () => responses.shift()!,
      onSnapshot: (snapshot, sequence) => {
        state = followReducer(state, { type: 'snapshot', snapshot, sequence, fetchedAt: '' })
      },
      onError: () => {
        throw new Error('Ingen fråga ska misslyckas här.')
      },
    })

    const first = load()
    const second = load()

    afterClose.resolve(AFTER_CLOSE)
    await second
    beforeClose.resolve(BEFORE_CLOSE)
    await first

    expect(state.snapshot).toBe(AFTER_CLOSE)
    expect(state.snapshot?.votersDb.pendingVote).toEqual([])
  })

  it('numren följer den ordning frågorna skickades i, inte den ordning svaren kom', async () => {
    const slow = deferred<string>()
    const fast = deferred<string>()
    const responses = [slow.promise, fast.promise]
    const received: Array<{ snapshot: string; sequence: number }> = []

    const load = createSnapshotLoader<string>({
      fetchSnapshot: () => responses.shift()!,
      onSnapshot: (snapshot, sequence) => received.push({ snapshot, sequence }),
      onError: () => undefined,
    })

    const first = load()
    const second = load()
    fast.resolve('snabb')
    await second
    slow.resolve('långsam')
    await first

    expect(received).toEqual([
      { snapshot: 'snabb', sequence: 2 },
      { snapshot: 'långsam', sequence: 1 },
    ])
  })

  it('en misslyckad fråga rapporteras och ger ingen bild', async () => {
    let errors = 0
    const received: string[] = []
    const load = createSnapshotLoader<string>({
      fetchSnapshot: () => Promise.reject(new Error('nätet borta')),
      onSnapshot: (snapshot) => received.push(snapshot),
      onError: () => {
        errors += 1
      },
    })

    await load()

    expect(errors).toBe(1)
    expect(received).toEqual([])
  })
})

/** En klocka som bara tickar när testet säger till. */
function manualTicker() {
  const ticks: Array<() => void> = []
  let stopped = 0
  const every: Ticker = (_intervalMs, tick) => {
    ticks.push(tick)
    return () => {
      stopped += 1
    }
  }
  return {
    every,
    tick: () => ticks.forEach((tick) => tick()),
    stopped: () => stopped,
  }
}

/** En flik vars synlighet testet styr. */
function manualVisibility(initiallyVisible: boolean) {
  let visible = initiallyVisible
  const listeners = new Set<() => void>()
  const visibility: Visibility = {
    isVisible: () => visible,
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    visibility,
    set: (next: boolean) => {
      visible = next
      listeners.forEach((listener) => listener())
    },
    listeners: () => listeners.size,
  }
}

describe('synligheten', () => {
  function start(initiallyVisible: boolean) {
    let loads = 0
    const clock = manualTicker()
    const tab = manualVisibility(initiallyVisible)
    const stop = startLiveRefresh({
      load: () => {
        loads += 1
      },
      intervalMs: 10_000,
      visibility: tab.visibility,
      every: clock.every,
    })
    return { loads: () => loads, clock, tab, stop }
  }

  it('hämtar direkt när livevyn startar', () => {
    expect(start(true).loads()).toBe(1)
  })

  it('en dold flik hämtar inte vid tick, en synlig gör det', () => {
    const view = start(false)

    view.clock.tick()
    expect(view.loads()).toBe(1)

    view.tab.set(true)
    const afterBecomingVisible = view.loads()
    view.clock.tick()
    expect(view.loads()).toBe(afterBecomingVisible + 1)
  })

  it('en flik som blir synlig hämtar direkt, utan att vänta på nästa tick', () => {
    /**
     * Fliken var dold under stängningen och visar därför bilden från före
     * den, med kopplingen. Den ska inte fortsätta visa den i upp till tio
     * sekunder efter att den syns igen.
     */
    const view = start(true)
    view.tab.set(false)
    expect(view.loads()).toBe(1)

    view.tab.set(true)
    expect(view.loads()).toBe(2)
  })

  it('att fliken döljs utlöser ingen hämtning', () => {
    const view = start(true)
    view.tab.set(false)

    expect(view.loads()).toBe(1)
  })

  it('stoppas helt: ingen klocka och ingen lyssnare kvar', () => {
    const view = start(true)
    expect(view.tab.listeners()).toBe(1)

    view.stop()

    expect(view.clock.stopped()).toBe(1)
    expect(view.tab.listeners()).toBe(0)
  })
})
