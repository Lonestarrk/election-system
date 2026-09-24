import { BUILT, OUT_OF_SCOPE, REMAINING } from '../code-facts'
import { StatusBadge } from './StatusBadge'

/**
 * LÄGET I KORTHET, ÖVERST PÅ UTVECKLINGSSTATUS (uppgift 11h).
 *
 * Tre grupper säger direkt vad som är klart, vad som kommer och vad som inte
 * ingår, i stället för att läsaren måste gå igenom hela sidan för att veta.
 * Grupperna läser BUILT, REMAINING och OUT_OF_SCOPE ur code-facts.ts, samma
 * listor som märkningen längre ned på sidan bygger på, så de aldrig kan säga
 * olika saker. REMAINING står i den ordning uppgifterna körs, se
 * tests/security/architecture-page.test.ts.
 */
export function StatusOverview() {
  return (
    <section className="card" aria-labelledby="laget-i-korthet">
      <h2 id="laget-i-korthet">Läget i korthet</h2>
      <div className="status-groups">
        <div>
          <h3>Klart</h3>
          <ul className="small status-list">
            {BUILT.map((item) => (
              <li key={item.text}>
                {item.text} <StatusBadge status={item.status!} />
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Kommer att implementeras</h3>
          <ul className="small status-list">
            {REMAINING.map((item) => (
              <li key={item.text}>
                {item.text} <StatusBadge status={item.status!} />
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Saknas och ingår inte i demon</h3>
          <ul className="small status-list">
            {OUT_OF_SCOPE.map((item) => (
              <li key={item.text}>
                {item.text} <StatusBadge status={item.status} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
