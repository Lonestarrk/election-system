import Link from 'next/link'
import { listItemStyle, STATUS_PATH } from './shared'

/**
 * Före och efter stängningen, enligt spec 3.1: vad väljaren ser, varför det
 * inte är ett kvitto, att ingen kod visas och att bara summorna publiceras.
 *
 * Allt här är design. Vad som är byggt av det står på Utvecklingsstatus, under
 * granskningsfrågorna "Kan väljaren kontrollera sin röst?" och "Räknades
 * rösterna korrekt?", som läser code-facts.ts.
 */
export function BeforeAndAfterClose() {
  return (
    <section className="card" aria-labelledby="fore-efter">
      <h2 id="fore-efter">Före och efter stängningen</h2>
      <p className="muted small">
        Alla röster är förtidsröster. Fram till stängningen kan du se, kontrollera och ändra din
        röst. Efter stängningen kan ingen se eller ändra något, och du ser att du har röstat,
        inte på vad. Så här är det tänkt att fungera:
      </p>
      <ul className="small" style={{ paddingLeft: '1.25rem', marginTop: '0.75rem' }}>
        <li style={listItemStyle}>
          <strong>Före stängningen ser du din nuvarande röst på den enhet du röstade från.</strong>{' '}
          Enheten sparar valet och chifferhashen, men aldrig slumptalet som krypteringen byggde
          på. Sidan hämtar chifferhashen för den röst servern håller och jämför. Stämmer de visas
          valet. Har rösten ändrats från en annan enhet visas inte innehållet, bara att det finns
          en röst.
        </li>
        <li style={listItemStyle}>
          <strong>Det enheten visar är inget kvitto.</strong> Utan slumptalet går det inte att
          bevisa vad chiffret innehåller, och det enheten visar kan du dessutom ändra själv.
          Ingen kan kräva ett bevis av dig, och ingen kan få ett.
        </li>
        <li style={listItemStyle}>
          <strong>Ingen verifikationskod visas.</strong> En kod på skärmen är just det handtag en
          köpare antecknar och efter stängningen letar efter.
        </li>
        <li style={listItemStyle}>
          <strong>Efter stängningen publiceras bara summorna.</strong> Per valsedel: den
          krypterade summan, förtroendemännens partiella dekrypteringar med bevis, resultatet och
          kuvertroten. Aldrig något per röst, varken chiffer eller hashar.
        </li>
        <li style={listItemStyle}>
          <strong>Priset är att allmänheten inte kan räkna om summan röst för röst.</strong> Vem
          som helst kan kontrollera att resultatet är en korrekt dekryptering av den publicerade
          summan. Att summan består av exakt de giltiga rösterna vilar på valideringen medan
          kopplingen fanns och på slutkontrollen. Estland har valt samma väg.
        </li>
      </ul>

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Skyddet mot röstköp är att rösten går att ändra fram till stängningen, och att det du ser
        på skärmen inte bevisar något. En köpare kan inte lita på skärmen. Han måste se själva
        läggningen, och den som ser en läggning klockan 19 vet ingenting om vad som gäller
        klockan 20. Efter stängningen finns ingenting publicerat att matcha mot. Varje ny
        läggning kräver en ny BankID-signatur, och räknaren inuti det signerade måste vara högre
        än förra gången. Utan räknaren kunde den som fångat ditt första kuvert skicka in det igen
        efter att du ändrat dig.
      </p>

      <p className="muted small" style={{ marginBottom: 0 }}>
        Visningen på enheten, markeringen &quot;har röstat&quot; och publiceringen: vad som är
        byggt av dem står på{' '}
        <Link href={`${STATUS_PATH}#granskning-i-dag`}>Utvecklingsstatus</Link>.
      </p>
    </section>
  )
}
