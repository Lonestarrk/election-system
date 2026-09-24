/**
 * NÄR RÖSTSIDAN TITTAR EFTER OM RÖSTNINGEN HAR STÄNGT.
 *
 * Spec 3.1 punkt 4 säger att enheten raderar det den sparat när sidan ser att
 * fasen lämnat OPEN. En sida som bara frågar när den laddas ser det aldrig om
 * den står öppen över stängningen: fliken fortsätter visa rösten, och
 * uppgifterna ligger kvar. Därför frågar sidan igen medan den är öppen, i
 * samma mönster som livevyn på arkitektursidan (src/app/architecture/
 * live-refresh.ts):
 *
 *   – med jämna mellanrum, men bara medan fliken syns, för att inte belasta
 *     servern i onödan;
 *   – direkt när fliken blir synlig igen eller får fokus, eftersom en flik
 *     som legat i bakgrunden under stängningen annars visar rösten tills nästa
 *     tick.
 *
 * Till skillnad från livevyn frågar den inte direkt när bevakningen startar.
 * Sidans laddning har just ställt samma fråga.
 *
 * Tiden mellan frågorna är längre än livevyns tio sekunder. Livevyn är en
 * demonstration för en person, röstsidan står öppen hos många väljare på en
 * gång, och en halv minut räcker för att det sparade ska försvinna strax efter
 * stängningen.
 */

export const PHASE_CHECK_INTERVAL_MS = 30_000

/** Om fliken syns, och en prenumeration på när väljaren kommer tillbaka till den. */
export type Attention = {
  isVisible: () => boolean
  /** Returnerar en funktion som avslutar prenumerationen. */
  onReturn: (listener: () => void) => () => void
}

/** Ett återkommande tick. Returnerar en funktion som stoppar det. */
export type Ticker = (intervalMs: number, tick: () => void) => () => void

/**
 * Frågar vid varje tick medan fliken syns, och direkt när väljaren kommer
 * tillbaka till den. Returnerar en funktion som stoppar allt.
 */
export function watchVotingPhase(options: {
  check: () => void
  intervalMs: number
  attention: Attention
  every: Ticker
}): () => void {
  const { check, intervalMs, attention, every } = options

  const stopTicking = every(intervalMs, () => {
    if (attention.isVisible()) check()
  })

  const stopListening = attention.onReturn(() => {
    if (attention.isVisible()) check()
  })

  return () => {
    stopTicking()
    stopListening()
  }
}

/** Webbläsarens synlighet och fokus. */
export function pageAttention(): Attention {
  return {
    isVisible: () => document.visibilityState === 'visible',
    onReturn: (listener) => {
      document.addEventListener('visibilitychange', listener)
      window.addEventListener('focus', listener)
      return () => {
        document.removeEventListener('visibilitychange', listener)
        window.removeEventListener('focus', listener)
      }
    },
  }
}

/** Webbläsarens klocka. */
export const windowInterval: Ticker = (intervalMs, tick) => {
  const timer = window.setInterval(tick, intervalMs)
  return () => window.clearInterval(timer)
}
