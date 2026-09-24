import Link from 'next/link'
import { STATUS_PATH, TECHNICAL_PATH } from './shared'

/**
 * Vidare till undersidorna, längst ned på huvudsidan.
 *
 * Beskrivningarna säger vad man hittar där utan fackord, eftersom de står på
 * huvudsidan.
 */
export function ReadMore() {
  return (
    <section className="card" aria-labelledby="las-mer">
      <h2 id="las-mer">Läs mer</h2>
      <div className="read-more">
        <Link href={TECHNICAL_PATH}>
          <strong>Tekniska detaljer</strong>
          <span className="muted small">
            Hur låset och kuverten är byggda, vad som ligger i valvet och vad det inte skyddar mot,
            vad som publiceras, vilka spår systemet lämnar och alla kända begränsningar.
          </span>
        </Link>
        <Link href={STATUS_PATH}>
          <strong>Utvecklingsstatus</strong>
          <span className="muted small">
            Vad som är byggt och inte, vad det gamla röstflödet fortfarande gör, vad som återstår och
            vad som finns av uppsättningen i Azure.
          </span>
        </Link>
      </div>
    </section>
  )
}
