import { assertBootable, logModeAtStartup } from '@/lib/runtime-mode'

/**
 * Uppstartsvakten (uppgift 17), för Node-miljön. Anropas från `register` i
 * src/instrumentation.ts.
 *
 * Skarpt läge som inte uppfyller sina stoppande krav kommer aldrig så långt som
 * att ta emot en begäran. Processen stoppas av felet, och felet räknar upp vad
 * som saknas. Läget skrivs i loggen vid varje start, före vakten, så att också
 * ett stopp syns i loggen med läget bredvid sig.
 */
export function startupGuard(): void {
  logModeAtStartup()
  assertBootable()
}
