import Link from 'next/link'
import { reviewQuestions } from './review-rows'
import { TECHNICAL_PATH, type PageLimitations } from './shared'

/**
 * Granskningsfrågorna, med vad koden gör i dag. Samma frågor som Tekniska
 * detaljer besvarar med designen; båda läser ./review-rows.tsx.
 */
export function ReviewToday({ limitations }: { limitations: PageLimitations }) {
  return (
    <section className="card" aria-labelledby="granskning-i-dag">
      <h2 id="granskning-i-dag">Granskningen, fråga för fråga</h2>
      <p className="muted small">
        Hur kuvertmodellen är tänkt att svara på varje fråga står under{' '}
        <Link href={`${TECHNICAL_PATH}#granskning`}>Hur valet kan granskas</Link> på Tekniska
        detaljer. Här står vad som finns i koden i dag.
      </p>

      <div className="table-wrap" style={{ marginTop: '1rem' }}>
        <table className="prose-table stack-on-mobile">
          <thead>
            <tr>
              <th>Fråga</th>
              <th>I koden i dag</th>
            </tr>
          </thead>
          <tbody>
            {reviewQuestions(limitations).map((row) => (
              <tr key={row.question}>
                <td>{row.question}</td>
                <td data-label="I koden i dag">{row.today}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
