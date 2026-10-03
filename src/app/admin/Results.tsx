import type { ResultsView } from './types'

/**
 * Resultatet per valsedel, med antalet per alternativ och summan (uppgift 12c,
 * punkt 5 och 7c). Läses ur servern efter TALLIED och CERTIFIED, så det finns
 * kvar efter en omladdning.
 *
 * Det här är summor, inte röster: ingenting säger vem som röstat på vad, och
 * inget är per väljare. Talen är publiceringens omräkning ur urnan och
 * bidragen, samma som /api/observer/results publicerar med bevis (fixrunda 1
 * av uppgift 13). Stämmer omräkningen inte med de sparade räkneverken visas
 * inget resultat alls.
 */
export function Results({ view, certified }: { view: ResultsView; certified: boolean }) {
  return (
    <section className="card" aria-labelledby="results-heading">
      <h2 id="results-heading">Resultat</h2>
      <p className="muted small">
        {certified
          ? 'Resultatet är fastställt av servern (fasen är CERTIFIED).'
          : 'Resultatet är räknat men inte fastställt. Slutkontrollen kan ännu hitta en avvikelse som stoppar fastställandet.'}{' '}
        Talen är räknade om ur urnan och förtroendepersonernas bidrag, och samma tal publiceras med bevis.
        Räkneverken ligger i röstdatabasen, så den som kan läsa den ser dem också.
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
