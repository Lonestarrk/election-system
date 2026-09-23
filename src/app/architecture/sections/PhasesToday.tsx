import Link from 'next/link'
import { CURRENTLY, PHASES } from '../code-facts'
import { TECHNICAL_PATH } from './shared'

/**
 * Vad koden gör med varje fas i dag. Specens tabell, med vad faserna betyder,
 * står på Tekniska detaljer; båda läser PHASES i code-facts.ts.
 */
export function PhasesToday() {
  return (
    <section className="card" aria-labelledby="faserna-i-dag">
      <h2 id="faserna-i-dag">Faserna i koden i dag</h2>
      <p className="muted small">
        Vad varje fas betyder står under <Link href={`${TECHNICAL_PATH}#faserna`}>Faserna</Link> på
        Tekniska detaljer. {CURRENTLY.castOnlyWhileOpen.text}
      </p>

      <div className="table-wrap" style={{ marginTop: '1rem' }}>
        <table className="prose-table stack-on-mobile">
          <thead>
            <tr>
              <th>Fas</th>
              <th>I koden i dag</th>
            </tr>
          </thead>
          <tbody>
            {PHASES.map((row) => (
              <tr key={row.phase}>
                <td className="mono" style={{ width: 'auto', minWidth: 0 }}>
                  {row.phase}
                </td>
                <td data-label="I koden i dag">{row.today.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="muted small" style={{ marginTop: '1rem', marginBottom: 0 }}>
        I designen är övergången till STRIPPED villkoret för att något ska få dekrypteras.{' '}
        {CURRENTLY.decryptionGateNotBuilt.text}
      </p>
    </section>
  )
}
