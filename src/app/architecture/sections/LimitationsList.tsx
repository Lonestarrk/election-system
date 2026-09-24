import { KNOWN_LIMITATIONS } from '@/lib/known-limitations'
import { CURRENTLY } from '../code-facts'

/**
 * Varför detta inte räcker för ett riktigt val: hela listan över kända
 * begränsningar, läst ur src/lib/known-limitations.ts.
 *
 * Varje rad har ett ankare, begransning-<id>, som hänvisningarna i resten av
 * sidan länkar till.
 *
 * Vad det gamla flödet gör i dag läses ur code-facts.ts. Här stod tidigare
 * "det gamla flödet som röstsidan fortfarande kör" som fri text, och den
 * meningen blev fel utan att något test sa ifrån när röstsidan byggdes om.
 */
export function LimitationsList() {
  return (
    <section className="card" aria-labelledby="begransningar">
      <h2 id="begransningar">Varför detta inte räcker för ett riktigt val</h2>
      <p className="muted small">
        Modellen visar principen: legitimera väljaren, låt henne lägga ett krypterat kuvert som
        bär hennes egen signatur och som hon kan byta ut, skala bort identiteten vid stängningen
        och publicera bara summorna. Den visar inte ett valsystem redo för drift.
      </p>
      <p className="muted small">
        Listan gäller hela systemet, både kuvertmodellen och det gamla flödet.{' '}
        {CURRENTLY.oldFlowRoutesRemain.text} Poster som bara gäller det gamla flödet försvinner ur
        listan när det tas bort.
      </p>

      <div className="table-wrap" style={{ marginTop: '1rem' }}>
        <table className="prose-table stack-on-mobile">
          <thead>
            <tr>
              <th>Kvarstående problem</th>
              <th>Varför det är allvarligt</th>
            </tr>
          </thead>
          <tbody>
            {/*
              Läses ur src/lib/known-limitations.ts och står inte skriven här.

              Skälet är erfarenhet: listan fanns tidigare som prosa på tre
              ställen, och ordningsproblemet mellan de två databasskrivningarna
              stod kvar som olöst långt efter att röstintygen löst det. En sida
              som påstår att systemet är sämre än det är underminerar tilliten
              lika säkert som en som påstår motsatsen.

              Varje post bär en markör i källkoden. Löser någon problemet
              försvinner markören och ett säkerhetstest failar tills posten
              tagits bort, ett test som går sönder när systemet blir bättre.
            */}
            {KNOWN_LIMITATIONS.map((entry) => (
              <tr key={entry.id} id={`begransning-${entry.id}`}>
                <td>
                  <strong>{entry.title}</strong>
                </td>
                <td>{entry.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Resonemanget bakom kuvertmodellens avvägningar står i specen,{' '}
        <span className="mono">docs/spec/2026-09-22-dubbla-kuvert.md</span>. Listan är den enda
        källan: sidan läser den och skriver den inte, så den blir aldrig mer rätt än listan. Den
        som tror att systemet klarar mer än det gör fattar sämre beslut än den som inte känner
        till det alls.
      </p>
    </section>
  )
}
