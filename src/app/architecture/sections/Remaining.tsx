import Link from 'next/link'
import type { KnownLimitation } from '@/lib/known-limitations'
import { LIMITATION_STATUS, REMAINING } from '../code-facts'
import { limitationHref, listItemStyle } from './shared'
import { StatusBadge } from './StatusBadge'

/**
 * Vad som återstår, läst ur REMAINING i code-facts.ts.
 *
 * Varje punkt bär markörer och stryks när det den beskriver byggs, så listan
 * kan inte påstå att något återstår som redan finns. Därtill tre kända
 * begränsningar i kuvertmodellen, med länk till listan: adaptern för
 * XML-signaturen har specen redan en åtgärd för (spec 4.6 och 10), liksom den
 * som kan skriva i röstdatabasen och byta ut ett chiffer
 * (spec 4.6, förbehåll 4, granskningen av 11g). Uppgift 11d stängde bytet före
 * infogningen, och uppgift 12b bytet efter stängningen för den som bara kan
 * skriva i röstdatabasen. Kvar är den som kan skriva i båda databaserna. Uppgift
 * 13 publicerade urnroten (ruling 135), och det som står kvar har ingen uppgift
 * i planen, så posten är märkt "ingår inte".
 * Spärrkontrollen (OCSP) har specen också en åtgärd för, men ingen uppgift i
 * planen prövar svaret — bara uppgift 17b sparar det förseglat — så den
 * punkten är märkt "ingår inte", inte "kommer" (fixrunda 1 av uppgift 11h).
 * Meningen ovanför länklistan får därför inte påstå att specen redan anger
 * åtgärden för alla tre. Certifikatkedjan stod här fram till uppgift 14f,
 * som byggde prövningen, och BankID-ordern som bar chifferhashen fram till
 * uppgift 11e.
 */
export function Remaining({ fixable }: { fixable: KnownLimitation[] }) {
  return (
    <section className="card" aria-labelledby="aterstar">
      <h2 id="aterstar">Vad som återstår</h2>
      <ul className="small" style={{ paddingLeft: '1.25rem', marginTop: '0.75rem' }}>
        {REMAINING.map((item) => (
          <li key={item.text} style={listItemStyle}>
            {item.text} <StatusBadge status={item.status!} />
          </li>
        ))}
      </ul>
      <p className="muted small">
        Dessutom kända begränsningar i kuvertmodellen, de flesta med en åtgärd som specen redan
        anger. De står i listan på Tekniska detaljer:
      </p>
      <ul className="small" style={{ paddingLeft: '1.25rem', marginBottom: 0 }}>
        {fixable.map((entry) => (
          <li key={entry.id} style={listItemStyle}>
            <Link href={limitationHref(entry)}>{entry.title}</Link> <StatusBadge status={LIMITATION_STATUS[entry.id]!} />
          </li>
        ))}
      </ul>
    </section>
  )
}
