import Link from 'next/link'
import type { KnownLimitation } from '@/lib/known-limitations'
import { CURRENTLY, LIMITATION_STATUS } from '../code-facts'
import { limitationHref, listItemStyle } from './shared'
import { StatusBadge } from './StatusBadge'

/**
 * Vad det gamla flödet fortfarande gör.
 *
 * Röstsidan lägger kuvert sedan uppgift 14, men det gamla flödets rutter och
 * tabeller finns kvar tills de tas bort, och med dem dess egna problem. De står
 * i listan över kända begränsningar, och sidan hänvisar dit i stället för att
 * skriva dem igen. Uppslaget sker i status/page.tsx och kastar om en post tas
 * bort, så att den här sektionen inte kan fortsätta hänvisa till ett problem
 * som är löst.
 */
export function OldFlow({ entries }: { entries: KnownLimitation[] }) {
  return (
    <section className="card" aria-labelledby="gamla-flodet">
      <h2 id="gamla-flodet">Vad det gamla flödet fortfarande gör</h2>
      <p className="muted small">
        {CURRENTLY.oldFlowRoutesRemain.text} <StatusBadge status={CURRENTLY.oldFlowRoutesRemain.status!} /> Så
        länge det finns kvar gäller dess egna problem, som kuvertmodellen är byggd för att inte ha.{' '}
        {CURRENTLY.oldFlowLiveResults.text} <StatusBadge status={CURRENTLY.oldFlowLiveResults.status!} />
      </p>
      <p className="muted small">Flödets egna poster i listan över kända begränsningar:</p>
      <ul className="small" style={{ paddingLeft: '1.25rem', marginBottom: 0 }}>
        {entries.map((entry) => (
          <li key={entry.id} style={listItemStyle}>
            <Link href={limitationHref(entry)}>{entry.title}</Link> <StatusBadge status={LIMITATION_STATUS[entry.id]!} />
          </li>
        ))}
      </ul>
    </section>
  )
}
