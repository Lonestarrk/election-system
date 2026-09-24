import { LegendIcon } from '../timeline/TimelineScene'

/**
 * Kuvertmodellen på vardagsspråk, med tidslinjens figurer.
 *
 * Förklaringen använder samma bilder som tidslinjen under den, så att läsaren
 * känner igen kuverten, låset och urnorna när animationen börjar. Varje rad
 * säger vad saken GÖR, inte vad den heter i tekniken; det står på Tekniska
 * detaljer, under "Från liknelsen till tekniken".
 *
 * Den sista meningen är den som skiljer modellen från en vanlig brevröst, och
 * den som en förenklad förklaring lättast får fel: de inre kuverten öppnas
 * aldrig ett och ett.
 *
 * Valvet kom till i uppgift 11g, när systemet fick en uppsättning i Azure. Raden
 * om det säger vad det förvarar och, lika tydligt, att nyckelns delar inte finns
 * där: tre delar i samma valv vore inte tre innehavare (spec 4.5). Att urnorna
 * har var sin nyckel gäller den som får tag i en av dem. Systemet har båda, och
 * det står bland svagheterna.
 */
export function TwoEnvelopes() {
  return (
    <section className="card" aria-labelledby="tva-kuvert">
      <h2 id="tva-kuvert">Två kuvert och ett lås</h2>
      <p>
        Ditt val ligger i ett inre kuvert utan namn. Det inre kuvertet ligger i ett yttre kuvert med
        ditt namn på. Namnet behövs medan röstningen pågår, så att du kan ändra dig. När röstningen
        har stängt och kuverten kontrollerats tas namnen bort.
      </p>

      <ul className="legend">
        <li>
          <LegendIcon kind="inner" />
          <span>
            <strong>Det inre kuvertet</strong> är ditt val. Det är låst, och ingen av
            förtroendepersonerna kan öppna det ensam.
          </span>
        </li>
        <li>
          <LegendIcon kind="outer" />
          <span>
            <strong>Det yttre kuvertet</strong> har ditt namn och din underskrift, och märket i
            hörnet är ditt intyg från BankID, inlåst med en hemlighet ur valvet. Kuvertet visar att
            rösten är din, men inte vad du har röstat på.
          </span>
        </li>
        <li>
          <LegendIcon kind="lock" />
          <span>
            <strong>Låset</strong> går bara upp när två av tre förtroendepersoner har lämnat var sin
            del av nyckeln. Den som driver systemet gör låset i ordning, och då finns hela nyckeln
            ett ögonblick på ett ställe.
          </span>
        </li>
        <li>
          <LegendIcon kind="urns" />
          <span>
            <strong>Två urnor:</strong> en med namn medan röstningen pågår, och en utan namn när den
            har stängt.
          </span>
        </li>
        <li>
          <LegendIcon kind="vault" />
          <span>
            <strong>Valvet</strong> förvarar systemets egna hemligheter i Microsofts moln, Azure, där
            systemet körs. I valvet finns hemligheten som gör ditt personnummer till ett
            fingeravtryck, och var sin nyckel till de två urnorna, så att den som får tag i den ena
            inte ens kommer in i den andra. Nyckelns tre delar finns inte i valvet. Dem har
            förtroendepersonerna.
          </span>
        </li>
      </ul>

      <p style={{ marginBottom: 0 }}>
        En sak skiljer sig från en vanlig brevröst, och den är viktig: de inre kuverten öppnas aldrig
        ett och ett. De läggs ihop till en summa, och bara summan öppnas.
      </p>
    </section>
  )
}
