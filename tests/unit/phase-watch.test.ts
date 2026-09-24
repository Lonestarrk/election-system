import { describe, expect, it } from 'vitest'
import {
  PHASE_CHECK_INTERVAL_MS,
  watchVotingPhase,
  type Attention,
  type Ticker,
} from '@/app/vote/phase-watch'

/**
 * NÄR RÖSTSIDAN TITTAR EFTER OM RÖSTNINGEN HAR STÄNGT (spec 3.1 punkt 4).
 *
 * En flik som står öppen över stängningen ska se att fasen lämnat OPEN och
 * radera det enheten sparat. Frågar sidan bara när den laddas ser den det
 * aldrig. Här prövas när bevakningen frågar, med en falsk klocka och en falsk
 * flik. Att en fråga som svarar att röstningen stängt faktiskt raderar prövas i
 * webbläsaren, i tests/e2e/voting-flow.spec.ts.
 */

/** En klocka som bara tickar när testet säger till. */
function manualTicker() {
  const ticks: Array<() => void> = []
  const intervals: number[] = []
  let stopped = 0
  const every: Ticker = (intervalMs, tick) => {
    intervals.push(intervalMs)
    ticks.push(tick)
    return () => {
      stopped += 1
    }
  }
  return {
    every,
    tick: () => ticks.forEach((tick) => tick()),
    intervals,
    stopped: () => stopped,
  }
}

/** En flik vars synlighet testet styr, och som väljaren kan komma tillbaka till. */
function manualAttention(initiallyVisible: boolean) {
  let visible = initiallyVisible
  const listeners = new Set<() => void>()
  const attention: Attention = {
    isVisible: () => visible,
    onReturn: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    attention,
    /** Fliken byter synlighet, eller får fokus utan att byta. */
    set: (next: boolean) => {
      visible = next
      listeners.forEach((listener) => listener())
    },
    listeners: () => listeners.size,
  }
}

function start(initiallyVisible: boolean) {
  let checks = 0
  const clock = manualTicker()
  const tab = manualAttention(initiallyVisible)
  const stop = watchVotingPhase({
    check: () => {
      checks += 1
    },
    intervalMs: PHASE_CHECK_INTERVAL_MS,
    attention: tab.attention,
    every: clock.every,
  })
  return { clock, tab, stop, checks: () => checks }
}

describe('bevakningen av fasen', () => {
  it('frågar inte direkt, eftersom sidans laddning just har frågat', () => {
    const { checks } = start(true)
    expect(checks()).toBe(0)
  })

  it('frågar vid varje tick medan fliken syns, med en halv minut emellan', () => {
    const { clock, checks } = start(true)

    clock.tick()
    clock.tick()

    expect(checks()).toBe(2)
    expect(clock.intervals).toEqual([30_000])
  })

  it('frågar inte vid ett tick när fliken är dold', () => {
    const { clock, checks } = start(false)

    clock.tick()

    expect(checks()).toBe(0)
  })

  it('frågar direkt när en dold flik blir synlig igen', () => {
    // En flik som låg i bakgrunden under stängningen visade annars rösten tills
    // nästa tick.
    const { tab, checks } = start(false)

    tab.set(true)

    expect(checks()).toBe(1)
  })

  it('frågar direkt när en synlig flik får fokus, men inte när den döljs', () => {
    const { tab, checks } = start(true)

    tab.set(true)
    tab.set(false)

    expect(checks()).toBe(1)
  })

  it('slutar fråga och lyssna när bevakningen stoppas', () => {
    const { clock, tab, stop, checks } = start(true)

    stop()

    expect(clock.stopped()).toBe(1)
    expect(tab.listeners()).toBe(0)
    tab.set(true)
    expect(checks()).toBe(0)
  })
})
