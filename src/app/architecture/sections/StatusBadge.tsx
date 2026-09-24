import { describeStatus, type Status } from '../code-facts'

/**
 * DEN LILLA ETIKETTEN VID EN PUNKT PÅ UTVECKLINGSSTATUS (uppgift 11h).
 *
 * Klart, Kommer (uppgift N) eller Ingår inte — alltid som text, aldrig bara
 * en färg, så att etiketten står kvar också utan färgseende eller CSS. Texten
 * kommer ur describeStatus i code-facts.ts, samma funktion som
 * sammanfattningen överst på sidan läser, så de aldrig kan säga olika saker.
 *
 * EGEN FIL, INTE shared.tsx. shared.tsx importeras också av huvudsidan, som
 * inte får fackord, och code-facts.ts:s påståenden är skrivna med fackord.
 * Bara Utvecklingsstatus sektioner importerar den här filen.
 */
export function StatusBadge({ status }: { status: Status }) {
  const modifier =
    status.kind === 'done' ? 'status-done' : status.kind === 'out_of_scope' ? 'status-out-of-scope' : 'status-planned'

  return <span className={`status-badge ${modifier}`}>{describeStatus(status)}</span>
}
