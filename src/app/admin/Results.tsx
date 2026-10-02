import type { ResultsView } from './types'

/**
 * Resultatet per valsedel, med antalet per alternativ och summan (uppgift 12c,
 * punkt 5 och 7c). Läses ur servern efter TALLIED och CERTIFIED, så det finns
 * kvar efter en omladdning.
 *
 * Det här är summor, inte röster: ingenting säger vem som röstat på vad, och
 * inget är per väljare. Talen här är de sparade räkneverken, som den
 * inloggade administratören ser. Offentligt publiceras resultatet med bevis i
 * /api/observer/results, och först efter en omräkning ur urnan och bidragen
 * (uppgift 13).
 */
export function Results({ view, certified }: { view: ResultsView; certified: boolean }) {
  return (
    <section className="card" aria-labelledby="results-heading">
      <h2 id="results-heading">Resultat</h2>
      <p className="muted small">
        {certified
          ? 'Resultatet är fastställt av servern (fasen är CERTIFIED).'
          : 'Resultatet är räknat men inte fastställt. Slutkontrollen kan ännu hitta en avvikelse som stoppar fastställandet.'}{' '}
        Talen här är de sparade räkneverken. Offentligt publiceras resultatet med bevis, och bara om en
        omräkning ur urnan och förtroendepersonernas bidrag ger samma tal. Räkneverken ligger i
        röstdatabasen, så den som kan läsa den ser dem också.
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
