import { isDemoMode } from '@/lib/demo-mode'
import { KNOWN_LIMITATIONS, type KnownLimitation } from '@/lib/known-limitations'
import { LiveDatabaseView } from './LiveDatabaseView'
import { BeforeAndAfterClose } from './sections/BeforeAndAfterClose'
import { EnvelopeModel } from './sections/EnvelopeModel'
import { Intro } from './sections/Intro'
import { LimitationsList } from './sections/LimitationsList'
import { Metadata } from './sections/Metadata'
import { Phases } from './sections/Phases'
import { Review } from './sections/Review'
import type { PageLimitations } from './sections/shared'
import { WhatItDoesNotGive } from './sections/WhatItDoesNotGive'

/**
 * Arkitektursidan.
 *
 * Sidan ska kunna läsas av någon som misstror systemet. Den förklarar
 * modellen med dubbla kuvert, visar i demoläget databasernas faktiska innehåll
 * och räknar fram slutsatserna ur det som hämtas. En demonstration som bara
 * påstår att en tabell är tom vore värdelös.
 *
 * Den redovisar också vad som INTE är löst. En arkitektursida som bara listar
 * styrkor är marknadsföring, och i ett valsystem är marknadsföring farligt: den
 * som tror att systemet klarar mer än det gör fattar sämre beslut än den som
 * inte känner till det alls.
 *
 * TRE KÄLLOR, INGEN AV DEM SKRIVEN HÄR
 *
 * Det sidan påstår om kodens nuvarande läge läses ur ./code-facts.ts. De
 * kända begränsningarna läses ur src/lib/known-limitations.ts. Databasernas
 * innehåll hämtas av livevyn. De två första bär markörer i koden och ett test
 * som går rött när en markör försvinner, så sidan kan inte bli inaktuell utan
 * att någon märker det. Det som står i sektionerna utan att komma ur någon av
 * dem är design, och ska stå som design: spec 3.1 och 6.1 i
 * docs/spec/2026-09-22-dubbla-kuvert.md.
 *
 * Varje sektion är en egen komponent under ./sections, så att sidan kan delas
 * upp på flera sidor utan att innehållet behöver röras.
 */

/**
 * En begränsning ur listan, efter id.
 *
 * Kastar om posten saknas. Sidan hänvisar till den i löpande text, och en
 * hänvisning till en post som tagits bort betyder att texten runt omkring också
 * är fel. tests/security/architecture-page.test.ts fångar det innan sidan gör
 * det.
 */
function limitation(id: string): KnownLimitation {
  const found = KNOWN_LIMITATIONS.find((entry) => entry.id === id)
  if (!found) {
    throw new Error(`Arkitektursidan hänvisar till begränsningen "${id}", som inte finns i listan.`)
  }
  return found
}

export default function ArchitecturePage() {
  /**
   * Demoläget avgörs av `isDemoMode` i src/lib/demo-mode.ts, samma funktion
   * som varje rutt under /api/demo frågar. Sidan är en serverkomponent för att
   * kunna fråga innan något skickas till webbläsaren: utanför demoläget
   * renderas livevyn inte alls, och ingen fråga efter röstlängden görs.
   */
  const demo = isDemoMode()

  const limitations: PageLimitations = {
    link: limitation('link-exists-during-voting'),
    bankIdOrder: limitation('bankid-order-carries-link'),
    chain: limitation('bankid-chain-not-validated'),
    dealer: limitation('trusted-dealer'),
    liveResults: limitation('live-results-in-old-flow'),
  }

  return (
    <main>
      <div className="stack">
        <Intro demo={demo} />
        <EnvelopeModel />
        <BeforeAndAfterClose />
        <Phases />
        <WhatItDoesNotGive limitations={limitations} />

        {/* --- 2 och 3. Livevyn och "Följ en röst" ----------------------------- */}
        {demo ? (
          <LiveDatabaseView linkLimitationTitle={limitations.link.title} />
        ) : (
          <section className="card" aria-labelledby="livevy">
            <h2 id="livevy">Databaserna just nu</h2>
            <p className="muted small">
              Livevyn och &quot;Följ en röst&quot; finns bara i demoläget. De är en insiders vy av
              databasen och visar röstlängden, och den får ingen sida visa i skarpt läge. Sidan frågar
              därför inte efter den, och rutten som lämnar ut den svarar 404 utanför demoläget.
            </p>
          </section>
        )}

        <Review limitations={limitations} />
        <Metadata limitations={limitations} />
        <LimitationsList />
      </div>
    </main>
  )
}
