/**
 * Omröstningens faser som en rad steg (uppgift 12c, spec 6.1).
 *
 * Fasen kommer från servern och ingen annanstans. Ett steg är klart bara om
 * fasen står efter det, och sidan flyttar aldrig markeringen av sig själv efter
 * ett klick.
 */

export const PHASES = ['OPEN', 'CLOSED', 'VALIDATED', 'STRIPPED', 'TALLIED', 'CERTIFIED'] as const

const LABELS: Record<(typeof PHASES)[number], string> = {
  OPEN: 'Röstningen pågår',
  CLOSED: 'Stängd',
  VALIDATED: 'Validerad',
  STRIPPED: 'Kopplingen raderad',
  TALLIED: 'Räknad',
  CERTIFIED: 'Fastställd',
}

export function phaseIndex(phase: string): number {
  return (PHASES as readonly string[]).indexOf(phase)
}

export function PhaseSteps({ phase }: { phase: string }) {
  const current = phaseIndex(phase)

  return (
    <ol className="phase-steps" aria-label="Omröstningens faser">
      {PHASES.map((name, index) => {
        const state = current === -1 ? 'todo' : index < current ? 'done' : index === current ? 'current' : 'todo'
        return (
          <li
            key={name}
            className={state === 'done' ? 'phase-done' : undefined}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="phase-code">{name}</span>
            <span className="small">
              {LABELS[name]}
              {state === 'done' && <span className="sr-only"> (klar)</span>}
              {state === 'current' && <span className="sr-only"> (nu)</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
