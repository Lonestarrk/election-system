/**
 * HUR LIVEVYN HÄMTAR: LÖPNUMMER OCH SYNLIGHET.
 *
 * Två egenskaper hos hämtningen bär en del av skyddet i "Följ en röst", och
 * båda är lätta att bryta med en ändring som ser ofarlig ut. De ligger därför
 * här, utanför komponenten, där de går att pröva utan webbläsare
 * (tests/unit/live-refresh.test.ts).
 *
 * 1. LÖPNUMRET DELAS UT NÄR FRÅGAN SKICKAS, INTE NÄR SVARET KOMMER.
 *
 *    Livevyn frågar var tionde sekund och när man trycker på "Uppdatera nu",
 *    så två frågor kan vara ute samtidigt. Kommer svaret på den äldre fram
 *    sist, till exempel från strax före stängningen, får det inte ersätta det
 *    nyare. `followReducer` kastar ett svar vars löpnummer inte är högre än
 *    det som visas, men det hjälper bara om numret sattes innan `await`.
 *    Flyttas det till efter svaret får det sena, gamla svaret det högsta
 *    numret, och de raderade raderna dyker upp igen.
 *
 * 2. EN FLIK SOM BLIR SYNLIG HÄMTAR DIREKT.
 *
 *    En dold flik frågar inte, för att inte belasta servern i onödan. Men en
 *    flik som varit dold under stängningen visar då bilden från före den, med
 *    kopplingen, tills nästa tick om upp till tio sekunder. Därför hämtar den
 *    i samma ögonblick den blir synlig.
 */

export function createSnapshotLoader<Snapshot>(deps: {
  fetchSnapshot: () => Promise<Snapshot>
  onSnapshot: (snapshot: Snapshot, sequence: number) => void
  onError: () => void
}): () => Promise<void> {
  let issued = 0

  return async () => {
    // Punkt 1 ovan. Raden får inte flyttas förbi `await`.
    const sequence = ++issued

    try {
      const snapshot = await deps.fetchSnapshot()
      deps.onSnapshot(snapshot, sequence)
    } catch {
      deps.onError()
    }
  }
}

/** Om fliken syns, och en prenumeration på när det ändras. */
export type Visibility = {
  isVisible: () => boolean
  /** Returnerar en funktion som avslutar prenumerationen. */
  onChange: (listener: () => void) => () => void
}

/** Ett återkommande tick. Returnerar en funktion som stoppar det. */
export type Ticker = (intervalMs: number, tick: () => void) => () => void

/**
 * Hämtar direkt, sedan vid varje tick medan fliken syns, och direkt när den
 * blir synlig igen (punkt 2 ovan). Returnerar en funktion som stoppar allt.
 */
export function startLiveRefresh(options: {
  load: () => void
  intervalMs: number
  visibility: Visibility
  every: Ticker
}): () => void {
  const { load, intervalMs, visibility, every } = options

  load()

  const stopTicking = every(intervalMs, () => {
    if (visibility.isVisible()) load()
  })

  const stopListening = visibility.onChange(() => {
    if (visibility.isVisible()) load()
  })

  return () => {
    stopTicking()
    stopListening()
  }
}

/** Webbläsarens synlighet. */
export function documentVisibility(): Visibility {
  return {
    isVisible: () => document.visibilityState === 'visible',
    onChange: (listener) => {
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    },
  }
}

/** Webbläsarens klocka. */
export const windowInterval: Ticker = (intervalMs, tick) => {
  const timer = window.setInterval(tick, intervalMs)
  return () => window.clearInterval(timer)
}
