import Link from 'next/link'
import type { KnownLimitation } from '@/lib/known-limitations'
import { REMAINING } from '../code-facts'
import { limitationHref, listItemStyle } from './shared'

/**
 * Vad som återstår, läst ur REMAINING i code-facts.ts.
 *
 * Varje punkt bär markörer och stryks när det den beskriver byggs, så listan
 * kan inte påstå att något återstår som redan finns. Därtill de kända
 * begränsningar i kuvertmodellen som specen redan anger åtgärden för: BankID-
 * ordern (spec 10) och certifikatkedjan (spec 4.6), med länk till listan.
 */
export function Remaining({ fixable }: { fixable: KnownLimitation[] }) {
  return (
    <section className="card" aria-labelledby="aterstar">
      <h2 id="aterstar">Vad som återstår</h2>
      <ul className="small" style={{ paddingLeft: '1.25rem', marginTop: '0.75rem' }}>
        {REMAINING.map((item) => (
          <li key={item.text} style={listItemStyle}>
            {item.text}
          </li>
        ))}
      </ul>
      <p className="muted small">
        Dessutom två kända begränsningar i kuvertmodellen som specen redan anger åtgärden för. Båda
        står i listan på Tekniska detaljer:
      </p>
      <ul className="small" style={{ paddingLeft: '1.25rem', marginBottom: 0 }}>
        {fixable.map((entry) => (
          <li key={entry.id} style={listItemStyle}>
            <Link href={limitationHref(entry)}>{entry.title}</Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
