import Link from 'next/link'
import { reviewQuestions } from './review-rows'
import { STATUS_PATH, type PageLimitations } from './shared'

/**
 * Hur valet kan granskas: designens svar på varje fråga. Vad koden gör i dag
 * med samma frågor står på Utvecklingsstatus, som läser samma lista.
 */
export function Review({ limitations }: { limitations: PageLimitations }) {
  return (
    <section className="card" aria-labelledby="granskning">
      <h2 id="granskning">Hur valet kan granskas utan att valhemligheten bryts</h2>
      <p className="muted small">
        Det ska inte räcka att lita på att administratören säger att databasen är korrekt. En
        oberoende part ska kunna kontrollera så mycket som möjligt själv. Tabellen säger hur
        kuvertmodellen svarar på varje fråga; vilka delar som finns i koden i dag står på{' '}
        <Link href={`${STATUS_PATH}#granskning-i-dag`}>Utvecklingsstatus</Link>.
      </p>

      <div className="table-wrap" style={{ marginTop: '1rem' }}>
        <table className="prose-table stack-on-mobile">
          <thead>
            <tr>
              <th>Fråga</th>
              <th>Hur kuvertmodellen svarar</th>
            </tr>
          </thead>
          <tbody>
            {reviewQuestions(limitations).map((row) => (
              <tr key={row.question}>
                <td>{row.question}</td>
                <td data-label="Hur kuvertmodellen svarar">{row.design}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Kuvertroten sorterar sina löv på innehåll, av ett skäl som är värt att förstå. En
        hashkedja i skrivordning vore den självklara lösningen, men ett löpnummer är en ordning,
        och i den här modellen vore det ordningen väljarna röstade i. Då hade manipulationsskyddet
        byggts upp genom att valhemligheten revs ned.
      </p>
    </section>
  )
}
