import { CURRENTLY, PHASES } from '../code-facts'

/**
 * Faserna, med specens tabell (6.1) och en kolumn om vad koden gör med varje
 * fas i dag. Den kolumnen läses ur code-facts.ts och bär markörer.
 */
export function Phases() {
  return (
    <section className="card" aria-labelledby="faserna">
      <h2 id="faserna">Faserna</h2>
      <p className="muted small">
        Ordningen ska vara omöjlig att kasta om, inte bara osannolik. Därför är fasen ett fält på
        omröstningen och inte en jämförelse mot klockan: en klocka som går fel ändrar beteendet
        tyst, medan en fasövergång är en händelse som någon utfört. Enligt specen går fasen bara
        framåt. {CURRENTLY.castOnlyWhileOpen.text}
      </p>

      <div className="table-wrap" style={{ marginTop: '1rem' }}>
        <table className="prose-table stack-on-mobile">
          <thead>
            <tr>
              <th>Fas</th>
              <th>Kopplingen finns</th>
              <th>Röster tas emot</th>
              <th>Härnäst</th>
              <th>I koden i dag</th>
            </tr>
          </thead>
          <tbody>
            {PHASES.map((row, index) => {
              const previous = PHASES[index - 1]
              return (
                <tr key={row.phase}>
                  <td className="mono" style={{ width: 'auto', minWidth: 0 }}>
                    {row.phase}
                  </td>
                  <td data-label="Kopplingen finns">
                    {yesNo(row.linkExists, previous?.linkExists)}
                  </td>
                  <td data-label="Röster tas emot">
                    {yesNo(row.acceptsVotes, previous?.acceptsVotes)}
                  </td>
                  <td data-label="Härnäst">{row.next}</td>
                  <td data-label="I koden i dag">{row.today.text}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="muted small" style={{ marginTop: '1rem' }}>
        De fyra första kolumnerna är specens tabell. Att CLOSED och STRIPPED är skilda tillstånd
        gör valideringsfönstret synligt: kopplingen finns, men ingen röst tas emot. I specen är
        övergången till STRIPPED dessutom villkoret för att något ska få dekrypteras, så att
        ingen dekryptering kan beställas förrän kopplingen bevisligen är borta.{' '}
        {CURRENTLY.decryptionGateNotBuilt.text}
      </p>
      <p className="muted small">
        &quot;Nej&quot; om kopplingen betyder att raderna är borta ur den levande databasen.
        Backuper, läsreplikor, WAL-loggen och BankID:s kopia av det väljaren signerade omfattas
        inte av raderingen.
      </p>
    </section>
  )
}

/**
 * "ja" eller "nej", i fetstil där värdet skiftar från fasen före. Det är
 * övergångarna specens tabell lyfter fram: röstningen stänger i CLOSED, och
 * kopplingen försvinner i STRIPPED.
 */
function yesNo(value: boolean, previous: boolean | undefined) {
  const text = value ? 'ja' : 'nej'
  return previous !== undefined && previous !== value ? <strong>{text}</strong> : text
}
