import { ConfirmButton } from './ConfirmButton'
import type { CloseView, ElectionOverview } from './types'

/**
 * Skälen en validering kan underkänna ett kuvert på (uppgift 12c, punkt 3). Koden
 * är den servern ger, och förklaringen är till den som läser rapporten. Ingen
 * av dem säger vem som lagt kuvertet, och rapporten gör det inte heller.
 */
export const VALIDATION_REASONS: Record<string, string> = {
  BAD_SIGNATURE:
    'Underskriften håller inte. Certifikatkedjan eller signaturen går inte att verifiera, eller så tillhör underskriften någon annan än den som lade kuvertet.',
  STALE_SEQUENCE: 'Kuvertet är ett äldre än det senaste: ett överspelat kuvert ligger kvar.',
  WRONG_BALLOT:
    'Kuvertet ligger på en valsedel som inte hör till omröstningen eller som inte gäller väljarens område.',
  BAD_PROOF: 'Beviset i kuvertet håller inte, eller så går kuvertet inte att tolka.',
  OLD_PROOF_FORMAT: 'Kuvertet har det gamla bevisformatet och kan inte räknas.',
  OLD_SIGNATURE_FORMAT:
    'Kuvertet är äkta men underskrivet i det gamla formatet, där BankID-ordern bar chifferhashen, och kan inte räknas.',
}

function Mono({ children }: { children: string }) {
  return <span className="mono" style={{ overflowWrap: 'anywhere' }}>{children}</span>
}

/**
 * Stängningen, valideringen och raderingen av kopplingen (steg 2 till 4).
 *
 * Servern gör alla tre i ett anrop. Knappen finns i OPEN och, för en omkörning
 * efter en avvikelse som utretts, i CLOSED och VALIDATED. I alla andra faser är
 * den avstängd, och sidan säger varför.
 */
export function CloseStep(props: {
  overview: ElectionOverview
  closeView: CloseView | null
  busy: boolean
  onClose: () => void
}) {
  const { overview, closeView } = props
  const phase = overview.phase
  const open = phase === 'OPEN'
  const rerun = phase === 'CLOSED' || phase === 'VALIDATED'
  const stripped = ['STRIPPED', 'TALLIED', 'CERTIFIED'].includes(phase)

  return (
    <section className="card" aria-labelledby="close-heading">
      <h2 id="close-heading">1. Stäng, validera och radera kopplingen</h2>

      {open && (
        <p>
          <strong>{overview.waitingEnvelopes}</strong> kuvert ligger i röstlängden. Bara antalet visas, aldrig
          vem som lagt dem eller vad de innehåller.
        </p>
      )}
      {rerun && (
        <p>
          Läggningen är stängd, men kopplingen mellan väljare och röst är kvar: <strong>{overview.waitingEnvelopes}</strong>{' '}
          kuvert ligger kvar i röstlängden. Utred avvikelsen om det fanns någon, och kör sedan om valideringen.
        </p>
      )}
      {stripped && (
        <p>
          Kopplingen är raderad. {overview.urnEnvelopes} kuvert ligger i urnan i röstdatabasen, och {overview.waitingEnvelopes}{' '}
          ligger kvar i röstlängden.
        </p>
      )}
      {overview.linkCleared && (
        <p className="small">
          Kuvertrot: <Mono>{overview.envelopeRoot ?? 'saknas'}</Mono>
          <br />
          Urnrot: <Mono>{overview.urnRoot ?? 'saknas'}</Mono>
        </p>
      )}

      <p className="muted small">
        Stängningen gör tre saker i ett anrop: den stänger läggningen, validerar varje kuvert mot dess
        underskrift och bevis, och bara om valideringen går igenom flyttar den kuverten till urnan och
        raderar kopplingen mellan väljare och röst. Det sista går inte att ångra i appen, utom för demovalet i
        demoläget. Finns en säkerhetskopia av röstlängden från före stängningen har den kvar kopplingen. Valideringen kan
        köras om från CLOSED och VALIDATED.
      </p>

      <div className="button-row">
        {open ? (
          <ConfirmButton
            label="Stäng röstningen"
            confirmText={
              'Det här går inte att ångra. Röstningen stängs, kuverten valideras, och om valideringen går ' +
              'igenom raderas kopplingen mellan väljare och röst i appens databaser. Därefter går ' +
              'omröstningen inte tillbaka till OPEN i appen. Det enda undantaget är demovalet i ' +
              'demoläget, som kan återställas.'
            }
            confirmLabel="Ja, stäng röstningen"
            disabled={props.busy}
            onConfirm={props.onClose}
          />
        ) : (
          <button type="button" disabled={props.busy || !rerun} onClick={props.onClose}>
            {rerun ? 'Kör valideringen och raderingen igen' : 'Stäng röstningen'}
          </button>
        )}
      </div>
      {!open && !rerun && (
        <p className="muted small" style={{ marginTop: '0.5rem' }}>
          Knappen är avstängd: fasen är {phase}, och bara OPEN, CLOSED och VALIDATED kan stängas.
        </p>
      )}

      {closeView && <CloseReport view={closeView} phase={phase} />}
    </section>
  )
}

/** Det som stängningens senaste anrop svarade, ordagrant, och de två stegen efter det. */
function CloseReport({ view, phase }: { view: CloseView; phase: string }) {
  const summary = view.summary
  const validationFailed = view.status === 'validation_failed'
  const verificationFailed = view.status === 'invalid_ballot'

  return (
    <div style={{ marginTop: '1.25rem' }}>
      <h3>Det senaste anropet</h3>
      <p className="small">
        Serverns besked: <q>{view.message}</q>
      </p>

      {(validationFailed || verificationFailed || view.status === 'closed') && (
        <>
          <h3>Valideringen</h3>
          {view.status === 'closed' && (
            <p>
              Godkända kuvert: <strong>{view.moved ?? 0}</strong>. Underkända: <strong>0</strong>.
            </p>
          )}
          {validationFailed && summary && (
            <p>
              Granskade kuvert: <strong>{summary.votes}</strong>. Godkända:{' '}
              <strong>{Math.max(summary.votes - summary.rejected, 0)}</strong>. Underkända:{' '}
              <strong>{summary.rejected}</strong>.
            </p>
          )}
          {verificationFailed && (
            <p>
              Valideringen av kuverten passerade, men omverifieringen av valsedlarna före skalningen föll: minst
              en valsedel verifierar inte. {summary ? 'Granskade kuvert: ' + summary.votes + '.' : ''}
            </p>
          )}
          {summary && Object.keys(summary.byKind).length > 0 && (
            <div className="admin-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Kod</th>
                    <th>Förklaring</th>
                    <th className="num">Antal</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(summary.byKind).map(([code, count]) => (
                    <tr key={code}>
                      <td className="mono">{code}</td>
                      <td>{VALIDATION_REASONS[code] ?? 'Ett skäl som den här sidan inte känner igen. Se serverloggen.'}</td>
                      <td className="num">{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {view.ciphertextHash && (
            <p className="small">
              Första kuvertet som inte verifierar, med chifferhash: <Mono>{view.ciphertextHash}</Mono>
            </p>
          )}
          {(validationFailed || verificationFailed) && (
            <div className="notice warning" style={{ marginTop: '1rem' }}>
              <strong>Vad du kan göra.</strong> Utred avvikelsen. Rapporten visar bara antal och skäl, aldrig vem
              som lagt ett kuvert. Fasen enligt servern är <strong>{phase}</strong>. Står den i CLOSED eller
              VALIDATED kan du köra stängningen igen med knappen ovan när avvikelsen är utredd.
            </div>
          )}
        </>
      )}

      {view.status === 'closed' && (
        <>
          <h3>Raderingen av kopplingen</h3>
          <p>
            Flyttade kuvert: <strong>{view.moved}</strong>. Raderade ur röstlängden: <strong>{view.cleared}</strong>.
          </p>
          {(view.residueRemoved?.length ?? 0) > 0 && (
            <p className="small">
              Före flytten togs {view.residueRemoved!.length} chiffer bort ur röstdatabasen som inte hörde till
              något validerat kuvert.
            </p>
          )}
        </>
      )}

      {(view.urnRowsReplaced?.length ?? 0) > 0 && (
        <div className="notice danger" style={{ marginTop: '1rem' }}>
          LARM: {view.urnRowsReplaced!.length} rader i röstdatabasen stod på ett validerat kuverts plats men
          med ett annat innehåll. Det tyder på att någon har skrivit i röstdatabasen förbi stängningen.
        </div>
      )}
    </div>
  )
}
