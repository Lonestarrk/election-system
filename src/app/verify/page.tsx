import Link from 'next/link'

/**
 * Verifieringssidan, medan den inte har något att verifiera.
 *
 * HÄR STOD EN RUTA FÖR TOKEN. Röstsidan delar inte längre ut några tokens:
 * kuvertmodellen har inget kvitto, eftersom ett kvitto som visar vad någon
 * röstat på är just det en köpare ber att få se (spec 3.1). Rutan hade alltså
 * ingenting att ta emot, och den som skrev in en gammal kod hade fått svar ur
 * det gamla flödet, med partiet i klartext.
 *
 * Sidan förklarar i stället var kontrollen finns. Före stängningen: på
 * röstsidan, på enheten väljaren röstade från, där servern varje gång sidan
 * laddas bekräftar att den håller exakt den rösten. Efter stängningen ska den
 * här sidan visa att väljaren röstat, men inte vad. Det är inte byggt än, och
 * sidan säger det. Det byggs i uppgift 13, som behöver markeringen "har
 * röstat" från uppgift 11d.
 *
 * Sidan anropar ingenting. /api/verify finns kvar med det gamla flödet och
 * tas bort med det.
 */
export default function VerifyPage() {
  return (
    <main className="narrow">
      <div className="stack">
        <div>
          <h1>Kontrollera din röst</h1>
          <p className="muted">
            Du får ingen kod att spara, och det finns ingenting att skriva in här. Så här
            kontrollerar du din röst i stället.
          </p>
        </div>

        <section className="card" aria-labelledby="fore-stangningen">
          <h2 id="fore-stangningen">Medan röstningen pågår</h2>
          <p>
            Du ser din röst på röstsidan, på den enhet du röstade från. Varje gång sidan öppnas
            frågar den servern om rösten som ligger där är exakt den som lades härifrån. Stämmer
            det visas vad du röstade på. Har du ändrat rösten från en annan enhet visas bara att
            den har ändrats.
          </p>
          <p className="small">
            Det som visas bevisar ingenting för någon annan, och det är med avsikt. Ingen kan
            kräva ett bevis av dig, och ingen kan få ett. Du kan rösta om så många gånger du vill
            fram till stängningen, och det är den senaste rösten som räknas.
          </p>
          <div>
            <Link href="/identify">
              <button type="button">Till röstsidan</button>
            </Link>
          </div>
        </section>

        <section className="card" aria-labelledby="efter-stangningen">
          <h2 id="efter-stangningen">När röstningen har stängt</h2>
          <p>
            Då kommer den här sidan att visa att du har röstat, men inte vad. Röstsidan slutar
            visa din röst och raderar det enheten sparat, första gången den öppnas efter
            stängningen.
          </p>
          <div className="notice warning">
            Den delen är inte byggd än. Tills den finns visar sidan ingenting efter stängningen.
          </div>
        </section>

        <section className="card" aria-labelledby="varfor-ingen-kod">
          <h2 id="varfor-ingen-kod">Varför det inte finns någon kod</h2>
          <p className="small" style={{ marginBottom: 0 }}>
            Tidigare fick du en kod som visade vilket parti rösten gällde. Den som fick se koden
            kunde alltså se hur du röstat, också någon som betalat för din röst. Därför finns den
            inte längre. Mer om hur det fungerar står på sidan{' '}
            <Link href="/architecture">Arkitektur</Link>.
          </p>
        </section>
      </div>
    </main>
  )
}
