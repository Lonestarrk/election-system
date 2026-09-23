import { CURRENTLY } from '../code-facts'

/**
 * Läget i stort, överst på Utvecklingsstatus.
 *
 * Påståendet om röstsidan läses ur code-facts.ts och ändras i samma stund som
 * koden gör. Resten av sidan går igenom delarna en i taget.
 */
export function StatusOverview() {
  return (
    <div className="notice warning">
      <strong>Ombyggnaden pågår.</strong>
      <div style={{ marginTop: '0.35rem' }}>
        Kuvertmodellen finns på serversidan: röstläggning med BankID-signatur, validering och
        stängning. {CURRENTLY.votePageUsesOldFlow.text} Resten av sidan går igenom delarna en i
        taget, och vad som återstår står längst ned.
      </div>
    </div>
  )
}
