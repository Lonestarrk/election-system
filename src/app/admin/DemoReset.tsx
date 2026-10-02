import { ConfirmButton } from './ConfirmButton'

/**
 * Återställning av demovalet (uppgift 12c, punkt 7b). Sidan visar kortet bara när
 * servern säger att den kör i demoläge och att omröstningen är demovalet. Rutten
 * frågar läget själv och vägrar varje annan omröstning, så kortet är bekvämlighet
 * och inte skydd.
 */
export function DemoReset(props: { busy: boolean; onReset: () => void }) {
  return (
    <section className="card" aria-labelledby="demo-heading">
      <h2 id="demo-heading">Demo: återställ valet</h2>
      <p>
        Sätter demovalets fas till OPEN och tömmer urnan, förtroendepersonernas bidrag, räkneverken,
        markeringarna och de liggande kuverten. Förtroendepersonernas andelar och nyckeln behålls.
      </p>
      <p className="muted small">
        Finns bara i demoläget och bara för demovalet. Revisionskedjan består: återställningen skriver en ny
        post och raderar ingen gammal. Behövs när en stängning stoppats av valideringen och lämnat valet i
        CLOSED, eftersom ingenting annat i appen går tillbaka till OPEN.
      </p>
      <div className="button-row">
        <ConfirmButton
          label="Återställ demovalet"
          confirmText="Allt som lagts i demovalet raderas, och fasen blir OPEN. Det går inte att ångra."
          confirmLabel="Ja, återställ demovalet"
          disabled={props.busy}
          onConfirm={props.onReset}
        />
      </div>
    </section>
  )
}
