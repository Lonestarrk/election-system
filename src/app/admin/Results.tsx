import type { ResultsView } from './types'

/**
 * Resultatet per valsedel, med antalet per alternativ och summan (uppgift 12c,
 * punkt 5 och 7c). Läses ur servern efter TALLIED och CERTIFIED, så det finns
 * kvar efter en omladdning.
 *
 * Det här är summor, inte röster: ingenting säger vem som röstat på vad, och
 * inget är per väljare. Resultatet är inte publicerat. Det ser bara den
 * inloggade administratören, och publiceringen med bevis är uppgift 13.
 */
export function Results({ view, certified }: { view: ResultsView; certified: boolean }) {
  return (
    <section className="card" aria-labelledby="results-heading">
      <h2 id="results-heading">Resultat</h2>
      <p className="muted small">
        {certified
          ? 'Resultatet är fastställt av servern (fasen är CERTIFIED).'
          : 'Resultatet är räknat men inte fastställt. Slutkontrollen kan ännu hitta en avvikelse som stoppar fastställandet.'}{' '}
        Det är inte publicerat: appen lämnar inte ut det till någon annan än den inloggade administratören.
        Räkneverken ligger i röstdatabasen, så den som kan läsa den ser dem också. Att publicera summorna med
        bevis är nästa steg i bygget (uppgift 13).
      </p>

      {view.ballots.map((ballot) => (
        <div key={ballot.ballotId} style={{ marginTop: '1.25rem' }}>
          <h3>{ballot.label}</h3>
          <div className="admin-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Alternativ</th>
                  <th className="num">Röster</th>
                </tr>
              </thead>
              <tbody>
                {ballot.options.map((option, index) => (
                  <tr key={index}>
                    <td>{option.label}</td>
                    <td className="num">{option.count}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>
                    <strong>Summa</strong>
                  </td>
                  <td className="num">
                    <strong>{ballot.total}</strong>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ))}
    </section>
  )
}
