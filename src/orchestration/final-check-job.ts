import { describeErrorChain, logger } from '@/lib/logger'
import { runFinalCheck, type FinalCheckReport } from './final-check.usecase'

/**
 * Slutkontrollen i bakgrunden (uppgift 12c, punkt 7d).
 *
 * Sedan 12b verifierar slutkontrollen varje rad i urnan, omkring 0,4 s per rad.
 * Tusen rader tar omkring sju minuter, och ett stort val tar timmar. En HTTP-
 * begäran ska inte vänta så länge. Startrutten svarar därför direkt, kontrollen
 * körs i processen, och sidan läser resultatet med en statusrutt.
 *
 * RESULTATET LIGGER BARA I MINNET, PER OMRÖSTNING. Startas servern om, eller
 * körs appen i flera processer, går resultatet förlorat eller ligger i en annan
 * process, och statusrutten svarar då `none`. Kontrollen får då köras om. Ett
 * pågående jobb överlever heller inte en omstart. Det är ett val för att hålla
 * det enkelt: jobbet sparar ingenting i någon databas, så det finns ingen rad
 * att ta bort eller skriva om.
 *
 * RESULTATET ÄR INTE BEHÖRIGHET. Fastställandet litar inte på den sparade
 * rapporten. Det kör sin egen slutkontroll på servern, som förut, och vägrar om
 * något kritiskt fallerar. Rapporten här är bara det administratören ser.
 */
export type FinalCheckJob =
  | { status: 'running'; startedAt: string }
  | { status: 'done'; report: FinalCheckReport; finishedAt: string }
  | { status: 'failed'; message: string; finishedAt: string }

/**
 * Kartan hänger på globalThis. Start- och statusrutten är två rutter, och Next
 * kan bygga var och en med en egen kopia av den här modulen, särskilt i
 * utvecklingsservern. Med en modulvariabel hade statusrutten inte sett jobbet.
 */
const store = globalThis as typeof globalThis & { __finalCheckJobs?: Map<string, FinalCheckJob> }
const jobs: Map<string, FinalCheckJob> = (store.__finalCheckJobs ??= new Map())

/** Startar kontrollen, om ingen redan körs för omröstningen. Svarar direkt. */
export function startFinalCheck(electionId: string): 'started' | 'already_running' {
  if (jobs.get(electionId)?.status === 'running') return 'already_running'

  const running: FinalCheckJob = { status: 'running', startedAt: new Date().toISOString() }
  jobs.set(electionId, running)

  void runFinalCheck(electionId).then(
    (report) => {
      // Ett jobb som glömts under tiden, till exempel av en återställning, skrivs inte tillbaka.
      if (jobs.get(electionId) !== running) return
      jobs.set(
        electionId,
        report
          ? { status: 'done', report, finishedAt: new Date().toISOString() }
          : { status: 'failed', message: 'Omröstningen finns inte.', finishedAt: new Date().toISOString() },
      )
    },
    (error: unknown) => {
      logger.error('Slutkontrollen i bakgrunden avbröts', { reason: describeErrorChain(error) })
      if (jobs.get(electionId) !== running) return
      jobs.set(electionId, {
        status: 'failed',
        message:
          'Slutkontrollen kunde inte köras färdigt, av ett skäl som står i serverloggen. Ingenting är ' +
          'fastställt eller markerat. Kör den igen.',
        finishedAt: new Date().toISOString(),
      })
    },
  )

  return 'started'
}

/** Det som finns i minnet för omröstningen, eller null när inget körts sedan processen startade. */
export function readFinalCheck(electionId: string): FinalCheckJob | null {
  return jobs.get(electionId) ?? null
}

/** Glömmer resultatet, till exempel efter att demovalet återställts. */
export function forgetFinalCheck(electionId: string): void {
  jobs.delete(electionId)
}
