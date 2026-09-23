import Link from 'next/link'

export default function StartPage() {
  return (
    <main className="narrow">
      <div className="stack">
        <div>
          <h1>Rösta digitalt</h1>
          <p className="muted">
            Du legitimerar dig med BankID, lägger din röst och får en token. Med token kan du
            senare kontrollera att din röst finns registrerad — utan att någon kan se att den är
            din.
          </p>
        </div>

        <div className="card">
          <h2>Så går det till</h2>
          <ol className="steps">
            <li>
              <div>
                <strong>Legitimera dig med BankID</strong>
                <div className="muted small">
                  Systemet kontrollerar att du är röstberättigad och att du inte redan har röstat.
                </div>
              </div>
            </li>
            <li>
              <div>
                <strong>Välj parti och bekräfta</strong>
                <div className="muted small">
                  Din röst registreras skilt från din identitet.
                </div>
              </div>
            </li>
            <li>
              <div>
                <strong>Spara din token</strong>
                <div className="muted small">
                  Den visas en enda gång. Med den kan du kontrollera din röst på sidan{' '}
                  <Link href="/verify">Verifiera röst</Link>.
                </div>
              </div>
            </li>
          </ol>
        </div>

        <div className="card">
          <h2>Din röst är hemlig</h2>
          <p className="muted">
            Systemet består av två åtskilda delar. Den ena vet vem du är och att du har röstat. Den
            andra vet vilka röster som lagts, men inte av vem. De två delarna lagras i olika
            databaser utan någon koppling mellan sig — kopplingen finns inte, varken för
            administratörer eller för den som skulle komma över databasen.
          </p>
          <p className="muted small">
            Du kan se exakt hur det fungerar på sidan <Link href="/architecture">Arkitektur</Link>.
          </p>
        </div>

        <div>
          <Link href="/identify">
            <button type="button">Börja rösta</button>
          </Link>
        </div>
      </div>
    </main>
  )
}
