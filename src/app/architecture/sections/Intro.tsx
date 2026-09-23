import Link from 'next/link'
import { STATUS_PATH, TECHNICAL_PATH } from './shared'

/**
 * Huvudsidans inledning, på vardagsspråk.
 *
 * Sidan är skriven för den som aldrig har hört ordet kryptering. Fackorden,
 * och allt om vad som är byggt och inte, står på undersidorna. Här står bara
 * vad sidan förklarar och att den förklarar hur det är TÄNKT att fungera: en
 * läsare som inte kan kontrollera förklaringen själv måste få veta att allt
 * inte är byggt än.
 */
export function Intro({ demo }: { demo: boolean }) {
  return (
    <div>
      <h1>Arkitektur</h1>
      <p>
        Här förklaras hur din röst hålls hemlig, och hur den ändå kan räknas. Systemet bygger på
        dubbla kuvert, samma idé som när man röstar med brev. Estland har använt den i sina digitala
        val sedan 2005.
      </p>
      <p className="muted small">
        Det här är en teknisk demonstration, och allt är inte byggt än. Sidan visar hur valet är
        tänkt att fungera. Vad som finns i dag står på{' '}
        <Link href={STATUS_PATH}>Utvecklingsstatus</Link>, och hur det fungerar tekniskt på{' '}
        <Link href={TECHNICAL_PATH}>Tekniska detaljer</Link>.
        {demo &&
          ' Längre ned på sidan kan du dessutom se hur de två urnorna ser ut i databasen just nu.'}
      </p>
    </div>
  )
}
