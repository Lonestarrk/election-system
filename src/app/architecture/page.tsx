import { isDemoMode } from '@/lib/demo-mode'
import { LiveDatabaseView } from './LiveDatabaseView'
import { ArchitectureNav } from './sections/ArchitectureNav'
import { Intro } from './sections/Intro'
import { ReadMore } from './sections/ReadMore'
import { limitation } from './sections/shared'
import { TwoEnvelopes } from './sections/TwoEnvelopes'
import { Weaknesses } from './sections/Weaknesses'
import { Timeline } from './timeline/Timeline'

/**
 * Arkitektursidan, för den som aldrig har hört ordet kryptering.
 *
 * Sidan förklarar kuvertmodellen på vardagsspråk, visar hela omröstningen i
 * en klickbar tidslinje och säger rakt ut vad kuverten inte skyddar mot. I
 * demoläget visar den dessutom databasernas faktiska innehåll, med "Följ en
 * röst".
 *
 * Allt tekniskt står på två undersidor: Tekniska detaljer (./technical), med
 * faserna, kryptografin, databasgränsen, metadatariskerna och hela listan över
 * kända begränsningar, och Utvecklingsstatus (./status), med vad som är byggt.
 * Den som tror att systemet klarar mer än det gör fattar sämre beslut än den
 * som inte känner till det alls, så huvudsidan länkar till begränsningarna
 * från sin egen text, och testet i tests/security/known-limitations.test.ts
 * kräver den länken.
 *
 * Tidslinjen är en simulering och hämtar ingenting. Livevyn är det enda på
 * sidan som läser databasen, och den finns bara i demoläget.
 */
export default function ArchitecturePage() {
  /**
   * Demoläget avgörs av `isDemoMode` i src/lib/demo-mode.ts, samma funktion
   * som varje rutt under /api/demo frågar. Sidan är en serverkomponent för att
   * kunna fråga innan något skickas till webbläsaren: utanför demoläget
   * renderas livevyn inte alls, och ingen fråga efter röstlängden görs.
   */
  const demo = isDemoMode()

  const link = limitation('link-exists-during-voting')

  return (
    <main>
      <div className="stack">
        <div>
          <ArchitectureNav current="/architecture" />
          <Intro demo={demo} />
        </div>
        <TwoEnvelopes />
        <Timeline />
        <Weaknesses
          copies={link}
          bankIdOrder={limitation('bankid-order-carries-link')}
          chain={limitation('bankid-chain-not-validated')}
          dealer={limitation('trusted-dealer')}
        />

        {/* --- Livevyn och "Följ en röst" --------------------------------- */}
        {demo ? (
          <LiveDatabaseView linkLimitationTitle={link.title} />
        ) : (
          <section className="card" aria-labelledby="livevy">
            <h2 id="livevy">Databaserna just nu</h2>
            <p className="muted small" style={{ marginBottom: 0 }}>
              I demoläget visas här hur de två urnorna ser ut i databasen just nu, och du kan följa
              en röst genom stängningen. Utanför demoläget visas ingenting, eftersom vyn visar
              röstlängden inifrån, och det får ingen sida göra när systemet används på riktigt.
            </p>
          </section>
        )}

        <ReadMore />
      </div>
    </main>
  )
}
