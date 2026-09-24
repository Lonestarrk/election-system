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
 * ordern, spärrkontrollen och adaptern för XML-signaturen (spec 4.6 och 10),
 * och sedan granskningen av 11g den som kan skriva i röstdatabasen och byta ut
 * ett chiffer (spec 4.6, förbehåll 4, uppgift 11d och 12b), med länk till
 * listan. Certifikatkedjan stod här fram till uppgift 14f, som byggde
 * prövningen.
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
        Dessutom kända begränsningar i kuvertmodellen som specen redan anger åtgärden för. De står
        i listan på Tekniska detaljer:
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
