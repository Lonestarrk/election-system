import { ConfirmButton } from './ConfirmButton'
import type { ElectionOverview, FinalCheckView } from './types'

/**
 * Slutkontrollen och fastställandet (uppgift 12c, punkt 6 och 7d).
 *
 * Slutkontrollen körs i bakgrunden: sedan 12b verifierar den varje rad i urnan,
 * omkring 0,4 s per rad. Sidan startar den, visar att den pågår och läser
 * rapporten när den är klar. "Fastställ" är aktiv bara när rapporten säger att
 * allt passerat, och fastställandet kör ändå en egen kontroll på servern.
 */
export function CertifyStep(props: {
  overview: ElectionOverview
  job: FinalCheckView
  busy: boolean
  onRunCheck: () => void
  onCertify: () => void
}) {
  const { overview, job } = props
  const tallied = overview.phase === 'TALLIED'
  const running = job.status === 'running'
  const report = job.status === 'done' ? job.report : null

  // Rapporten gäller den fas den kördes i. En rapport från en annan fas räknas inte.
  const canCertify =
    tallied && !overview.underReview && report !== null && report.canCertify && report.phase === 'TALLIED'

  return (
    <section className="card" aria-labelledby="certify-heading">
      <h2 id="certify-heading">3. Slutkontroll och fastställande</h2>

      {overview.underReview && (
        <div className="notice danger" style={{ marginBottom: '1rem' }}>
          <strong>Omröstningen är markerad som avvikande (UNDER_REVIEW). Fastställandet är stoppat.</strong>{' '}
          En slutkontroll fann en avvikelse som kräver granskning. I skarpt läge går markeringen inte att lyfta
          i appen, eftersom en knapp som markerar avvikelsen som utredd vore samma spärr med ett extra klick.
        </div>
      )}

      <p className="muted small">
        Slutkontrollen verifierar varje rad i urnan och tar omkring 0,4 sekunder per rad: tusen rader tar sju
        minuter, och ett stort val tar timmar. Den körs därför i bakgrunden, och sidan läser rapporten när den
        är klar. Rapporten sparas bara i serverns minne och försvinner vid en omstart, och kontrollen får då
        köras om.
      </p>

      <div className="button-row">
        <button type="button" disabled={props.busy || running} onClick={props.onRunCheck}>
          {running ? 'Slutkontrollen pågår …' : 'Kör slutkontrollen'}
        </button>
      </div>
      {!tallied && (
        <p className="muted small" style={{ marginTop: '0.5rem' }}>
          Rapporten är bara läsning och går att köra i varje fas: före TALLIED visar den vilka förutsättningar
          som saknas, och ingenting markeras som avvikande. Fastställandet kräver fasen TALLIED, och fasen är
          nu {overview.phase}.
        </p>
      )}

      {running && (
        <div className="notice info" style={{ marginTop: '1rem' }}>
          Slutkontrollen pågår. Du kan lämna sidan och komma tillbaka: den fortsätter i servern så länge servern inte startas om eller skalas ned. Den körs i serverns huvudtråd, så servern kan svara långsamt under tiden.
        </div>
      )}
      {job.status === 'failed' && (
        <div className="notice danger" style={{ marginTop: '1rem' }}>
          {job.message}
        </div>
      )}

      {report && (
        <div style={{ marginTop: '1.25rem' }}>
          <div className={report.canCertify ? 'notice info' : 'notice danger'}>
            {report.canCertify
              ? 'Samtliga kontroller är godkända. Resultatet kan fastställas.'
              : report.anomalous
                ? `AVVIKELSE: ${report.failures.length} kontroll(er) visar att underlaget inte stämmer. Kräver granskning.`
                : 'Inte klart att fastställas än. Se vilka förutsättningar som saknas nedan. Ingenting är fel.'}
          </div>

          <p className="muted small" style={{ marginTop: '0.75rem' }}>
            Fas: <strong>{report.phase}</strong> · Status: <strong>{report.status}</strong> · {report.voteCount}{' '}
            rader i urnan · Urnrot{' '}
            <span className="mono">{report.urnRoot ? `${report.urnRoot.slice(0, 16)}…` : 'saknas'}</span>
          </p>

          {/*
            Grundregeln i globals.css ger varje tabellcell white-space: nowrap, eftersom en
            hash som bryts mitt i blir oläslig. Här står löpande förklaringar i första
            kolumnen, och utan radbrytning blev tabellen 1 267 px bred i ett kort på 620 px,
            och i ett kort på 350 px på en telefon. Första kolumnen bryter därför rad, långa
            tecknasträngar bryts var som helst, och behållaren skrollar om något ändå inte
            ryms, så att tabellen aldrig ritas utanför kortet.
          */}
          <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
            <table style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Kontroll</th>
                  <th style={{ textAlign: 'left' }}>Utfall</th>
                </tr>
              </thead>
              <tbody>
                {report.checks.map((check) => (
                  <tr key={check.id}>
                    <td
                      style={{
                        verticalAlign: 'top',
                        paddingRight: '1rem',
                        whiteSpace: 'normal',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {check.question}
                      <div className="muted small">{check.detail}</div>
                    </td>
                    <td style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                      {check.passed
                        ? '✓ Godkänd'
                        : check.severity === 'CRITICAL'
                          ? '✗ Avvikelse'
                          : check.severity === 'PRECONDITION'
                            ? '– Inte klart än'
                            : '! Varning'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="button-row" style={{ marginTop: '1.5rem' }}>
        {overview.phase === 'CERTIFIED' ? (
          <button type="button" disabled>
            Redan fastställt
          </button>
        ) : (
          <ConfirmButton
            label="Fastställ resultatet"
            confirmText={
              'Fastställandet går inte att ångra i appen. Servern kör slutkontrollen en gång till och ' +
              'fastställer bara om allt passerar. Fallerar något kritiskt markeras omröstningen som ' +
              'avvikande och kan inte fastställas.'
            }
            confirmLabel="Ja, fastställ resultatet"
            disabled={props.busy || !canCertify}
            onConfirm={props.onCertify}
          />
        )}
      </div>
      {!canCertify && overview.phase !== 'CERTIFIED' && (
        <p className="muted small" style={{ marginTop: '0.5rem' }}>
          Knappen är avstängd tills omröstningen är räknad (TALLIED), slutkontrollen har körts färdigt och
          rapporten säger att samtliga kontroller är godkända.
        </p>
      )}

      <p className="muted small" style={{ marginTop: '0.75rem' }}>
        Knappen är inte det som avgör. Fastställandet kör om hela kontrollen på servern och vägrar om något
        kritiskt fallerar. Det finns ingen väg förbi den spärren härifrån, och ett val som markerats som
        avvikande går i skarpt läge inte att återställa via gränssnittet.
      </p>
    </section>
  )
}
