'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { MOMENTS } from './moments'
import { TimelineScene } from './TimelineScene'

/**
 * TIDSLINJEN: HELA OMRÖSTNINGEN, ETT MOMENT I TAGET.
 *
 * En knapp per moment. Ett klick visar momentets text och spelar dess
 * animation, och ett nytt klick på samma moment spelar den igen. Föregående och
 * Nästa går ett steg i taget.
 *
 * TIDSLINJEN ÄR EN SIMULERING. Den hämtar ingenting och läser ingenting ur
 * databasen eller livevyn, så den fungerar likadant i och utanför demoläget,
 * och den kan inte råka visa något om en verklig väljare. Det enda tillstånd
 * den har är vilket moment som visas och hur många gånger det har spelats.
 * tests/security/architecture-page.test.ts håller den så.
 *
 * TILLGÄNGLIGHET
 *
 * Texten står i en aria-live-region och bär hela berättelsen. Scenen är
 * dekorativ och dold för skärmläsare. Knapparna är vanliga knappar, som går
 * att nå med tangentbordet och får projektets fokusram. Vid
 * `prefers-reduced-motion` spelas ingen animation: scenen visar momentets
 * slutläge direkt, och knappraden rullar utan mjuk rörelse.
 *
 * Föregående och Nästa blir aldrig `disabled`, bara `aria-disabled`. En knapp
 * som stängs av medan den har fokus tappar det, och den som går framåt med
 * tangentbordet hamnar då plötsligt överst på sidan.
 */
export function Timeline() {
  const [index, setIndex] = useState(0)
  /**
   * Hur många gånger ett moment har spelats. Noll när sidan laddas: då visas
   * första momentets slutläge utan rörelse, eftersom ingen har bett om något.
   */
  const [plays, setPlays] = useState(0)
  const stepsRef = useRef<HTMLOListElement>(null)

  const moment = MOMENTS[index]!
  const first = index === 0
  const last = index === MOMENTS.length - 1

  function show(next: number) {
    if (next < 0 || next >= MOMENTS.length) return
    setIndex(next)
    setPlays((count) => count + 1)
  }

  /**
   * Aktuellt moment rullas in i knappraden när den är bredare än skärmen.
   * Raden rullas för sig, inte sidan: `scrollIntoView` hade också flyttat
   * sidan till knapparna, bort från texten läsaren just läste. Avståndet mäts
   * mot raden själv och inte med `offsetLeft`, som räknas från knappens
   * listpunkt.
   */
  useEffect(() => {
    const steps = stepsRef.current
    const button = steps?.querySelectorAll('button')[index]
    if (!steps || !button || steps.scrollWidth <= steps.clientWidth) return

    const row = steps.getBoundingClientRect()
    const step = button.getBoundingClientRect()
    const offset = step.left - row.left - (row.width - step.width) / 2
    steps.scrollBy({ left: offset, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [index])

  return (
    <section className="card tl-section" aria-labelledby="tidslinjen">
      <h2 id="tidslinjen">Din röst, steg för steg</h2>
      <p className="muted small">
        Välj ett moment för att se vad som händer med din röst. Ditt kuvert är markerat fram till
        att namnen tas bort.
      </p>
      <p className="muted small" style={{ marginBottom: 0 }}>
        Tidslinjen visar hur valet är tänkt att fungera, och allt är inte byggt än. Vad som finns i
        dag står på <Link href="/architecture/status">Utvecklingsstatus</Link>.
      </p>

      <ol className="tl-steps" ref={stepsRef} aria-label="Omröstningens moment">
        {MOMENTS.map((entry, position) => (
          <li
            key={entry.number}
            className={position < index ? 'tl-passed' : position === index ? 'tl-current' : undefined}
          >
            <button
              type="button"
              className="tl-step"
              aria-current={position === index ? 'step' : undefined}
              aria-controls="tidslinjen-text"
              onClick={() => show(position)}
            >
              <span className="tl-step-number">{entry.number}</span>{' '}
              <span className="tl-step-label">{entry.label}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="tl-body">
        {/*
          Föregående och Nästa står direkt under scenen och inte under texten.
          Texterna är olika långa, och knappar under dem hade flyttat sig mellan
          varje tryck, just när man trycker på dem igen.
        */}
        <div className="tl-visual">
          <div className="tl-stage" aria-hidden="true">
            <TimelineScene key={`${moment.number}-${plays}`} moment={moment} animate={plays > 0} />
          </div>

          <div className="button-row tl-nav">
            <button
              type="button"
              className="secondary"
              aria-disabled={first || undefined}
              onClick={() => show(index - 1)}
            >
              Föregående
            </button>
            <button type="button" aria-disabled={last || undefined} onClick={() => show(index + 1)}>
              Nästa
            </button>
          </div>
        </div>

        <div className="tl-panel" id="tidslinjen-text" aria-live="polite" aria-atomic="true">
          <p className="tl-eyebrow">
            Moment {moment.number} av {MOMENTS.length} · {moment.stage}
          </p>
          <h3 className="tl-title">{moment.title}</h3>
          <p className="tl-text">{moment.text}</p>
        </div>
      </div>
    </section>
  )
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
