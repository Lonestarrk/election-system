/**
 * Körs av Next en gång när servern startar (uppgift 17).
 *
 * Uppstartsvakten ligger i src/instrumentation-node.ts. Den importeras bara i
 * Node-miljön, med villkoret och importen i den här filen: Next bygger den här
 * filen också för edge-miljön, där node:fs och node:crypto saknas, och bygget
 * faller om importen inte ligger bakom villkoret.
 *
 * `next build` kör inte den här funktionen. Ett bygge i en miljö utan driftens
 * variabler ska gå att göra: vakten gäller processen som körs.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startupGuard } = await import('./instrumentation-node')
    startupGuard()
  }
}
