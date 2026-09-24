import Link from 'next/link'

/**
 * Startsidan.
 *
 * Här stod tidigare att väljaren får en token att spara, och att kopplingen
 * mellan väljare och röst inte finns någonstans. Båda slutade vara sanna när
 * röstsidan började lägga kuvert (uppgift 14): ingen token delas ut, och
 * medan röstningen pågår finns kopplingen med avsikt, så att rösten går att
 * ändra. Sidan säger nu det, på vardagsspråk som arkitektursidan, och lovar
 * inte mer än den. Vad systemet inte skyddar mot står där, inte här.
 */
export default function StartPage() {
  return (
    <main className="narrow">
      <div className="stack">
        <div>
          <h1>Rösta digitalt</h1>
          <p className="muted">
            Du legitimerar dig med BankID, lägger din röst och skriver under den med BankID. Fram
            till att röstningen stänger kan du rösta om så många gånger du vill, och det är den
            senaste rösten som räknas.
          </p>
        </div>

        <div className="card">
          <h2>Så går det till</h2>
          <ol className="steps">
            <li>
              <div>
                <strong>Legitimera dig med BankID</strong>
                <div className="muted small">
                  Systemet kontrollerar att du är röstberättigad och vilka valsedlar som gäller dig.
                </div>
              </div>
            </li>
            <li>
              <div>
                <strong>Välj och skriv under</strong>
                <div className="muted small">
                  Din röst låses på din egen enhet innan den skickas. Sedan skriver du under den med
                  BankID.
                </div>
              </div>
            </li>
            <li>
              <div>
                <strong>Ändra dig om du vill</strong>
                <div className="muted small">
                  Enheten du röstade från visar din röst fram till stängningen, men det den visar
                  bevisar ingenting för någon annan. Du får ingen kod att spara, och det är med
                  avsikt.
                </div>
              </div>
            </li>
          </ol>
        </div>

        <div className="card">
          <h2>Så hålls din röst hemlig</h2>
          <p className="muted">
            Ditt val ligger i ett låst inre kuvert, i ett yttre kuvert med ditt namn på. Namnet
            behövs medan röstningen pågår, så att du kan ändra dig. När röstningen har stängt tas
            namnen bort, och bara summan av alla röster öppnas. De inre kuverten öppnas aldrig ett
            och ett.
          </p>
          <p className="muted small">
            Så är det tänkt att fungera, och allt är inte byggt än. Hur det fungerar, vad som finns
            i dag och vad systemet inte skyddar mot står på sidan{' '}
            <Link href="/architecture">Arkitektur</Link>.
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
