import Link from 'next/link'
import type { KnownLimitation } from '@/lib/known-limitations'
import { CURRENTLY } from '../code-facts'
import { limitationHref, listItemStyle } from './shared'

/**
 * Vad det gamla flödet fortfarande gör.
 *
 * Röstsidan kör det gamla flödet, med röstintyg och blinda signaturer, tills
 * kuvertmodellen tar över. Dess egna problem står i listan över kända
 * begränsningar, och sidan hänvisar dit i stället för att skriva dem igen.
 * Uppslaget sker i status/page.tsx och kastar om en post tas bort, så att den
 * här sektionen inte kan fortsätta hänvisa till ett problem som är löst.
 */
export function OldFlow({ entries }: { entries: KnownLimitation[] }) {
  return (
    <section className="card" aria-labelledby="gamla-flodet">
      <h2 id="gamla-flodet">Vad det gamla flödet fortfarande gör</h2>
      <p className="muted small">
        Så länge röstsidan kör det gamla flödet gäller dess egna problem, som kuvertmodellen är
        byggd för att inte ha. {CURRENTLY.oldFlowLiveResults.text}
      </p>
      <p className="muted small">Flödets egna poster i listan över kända begränsningar:</p>
      <ul className="small" style={{ paddingLeft: '1.25rem', marginBottom: 0 }}>
        {entries.map((entry) => (
          <li key={entry.id} style={listItemStyle}>
            <Link href={limitationHref(entry)}>{entry.title}</Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
