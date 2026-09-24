'use client'

import { useCallback, useState } from 'react'
import { BankIdLogin, type DemoIdentity } from '../_components/BankIdLogin'

/**
 * Adminvyn.
 *
 * TVÅ SAKER SOM SKILJER DEN FRÅN EN VANLIG ADMINPANEL
 *
 * 1. Inloggningen sker med BankID. Behörigheten hänger på att personens rad i
 *    röstlängden har adminflaggan — det finns inget delat lösenord i systemet.
 *
 * 2. Resultatet går inte att bara klicka fram och godkänna. Slutkontrollen
 *    körs först och visas i sin helhet; fastställandet kör om den på servern
 *    och vägrar om något kritiskt fallerar. Det finns ingen knapp som tvingar
 *    igenom ett resultat, och det är avsiktligt.
 *
 * Notera vad vyn INTE kan visa, oavsett behörighet: vem som röstat på vad.
 * Underlaget finns inte i någon databas den når.
 */

type Phase = 'login' | 'ready'

/**
 * Demoidentiteter för adminvyn.
 *
 * Båda finns med på samma lista med flit: den som prövar att logga in som en
 * vanlig väljare ska se att svaret blir detsamma oavsett om personen saknas i
 * röstlängden eller bara saknar adminflaggan. Skilda svar skulle göra rutten
 * till ett uppslagsverk över vilka som är administratörer.
 */
const DEMO_IDENTITIES: DemoIdentity[] = [
  { personalNumber: '19800101-9876', label: 'Alex — administratör' },
  { personalNumber: '19900101-1234', label: 'Anna — vanlig väljare' },
]

type ElectionSummary = { id: string; name: string; kind: string; closesAt: string }

type CheckResult = {
  id: string
  question: string
  severity: 'CRITICAL' | 'PRECONDITION' | 'WARNING'
  passed: boolean
  detail: string
}

type FinalCheckReport = {
  electionName: string
  status: string
  checks: CheckResult[]
  canCertify: boolean
  anomalous: boolean
  failures: CheckResult[]
  merkleRoot: string
  voteCount: number
  ranAt: string
}

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)valcsrf=([^;]+)/)
  return match ? decodeURIComponent(match[1]!) : ''
}

async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
    body: JSON.stringify(body),
  })
  return { ok: response.ok, data: await response.json() }
}

export default function AdminPage() {
  const [phase, setPhase] = useState<Phase>('login')
  const [message, setMessage] = useState('')
  const [elections, setElections] = useState<ElectionSummary[]>([])
  const [selected, setSelected] = useState('')
  const [report, setReport] = useState<FinalCheckReport | null>(null)
  const [busy, setBusy] = useState(false)

  const loadElections = useCallback(async () => {
    const { ok, data } = await post('/api/admin/stats', {})
    if (ok) {
      setElections(data.elections ?? [])
      setSelected(data.elections?.[0]?.id ?? '')
    }
  }, [])

  async function runCheck() {
    if (!selected) return
    setBusy(true)
    setMessage('Kör slutkontrollen …')

    const { ok, data } = await post('/api/admin/elections/check', { electionId: selected })

    setBusy(false)
    if (!ok) {
      setMessage(data.error?.message ?? 'Kontrollen kunde inte köras.')
      return
    }

    setReport(data.report)
    setMessage('')
  }

  async function publishCommitment() {
    if (!selected) return
    setBusy(true)

    const { ok, data } = await post('/api/admin/elections/commit', { electionId: selected })

    setBusy(false)
    setMessage(
      ok
        ? `Åtagande #${data.commitment.sequence} publicerat över ${data.commitment.voteCount} röster.`
        : (data.error?.message ?? 'Åtagandet kunde inte publiceras.'),
    )
  }

  async function certify() {
    if (!selected) return
    setBusy(true)

    const { data } = await post('/api/admin/elections/certify', { electionId: selected })

    setBusy(false)
    setReport(data.report ?? null)
    setMessage(data.message ?? '')
  }

  return (
    <main className="narrow">
      <div className="stack">
        <div>
          <h1>Administration</h1>
          <p className="muted">
            Inloggning sker med BankID. Behörigheten hänger på din rad i röstlängden — det finns
            inget adminlösenord i systemet.
          </p>
        </div>

        {message && (
          <div className="notice info" role="status" aria-live="polite">
            {message}
          </div>
        )}

        {phase === 'login' && (
          <BankIdLogin
            purpose="admin"
            collectPath="/api/admin/login"
            demoIdentities={DEMO_IDENTITIES}
            onComplete={async (data) => {
              setPhase('ready')
              setMessage(`Inloggad som ${String(data.name ?? 'administratör')}.`)
              await loadElections()
            }}
          />
        )}

        {phase === 'ready' && (
          <>
            <div className="card">
              <h2>Omröstning</h2>
              <select value={selected} onChange={(event) => setSelected(event.target.value)}>
                {elections.length === 0 && <option value="">Ingen omröstning finns</option>}
                {elections.map((election) => (
                  <option key={election.id} value={election.id}>
                    {election.name}
                  </option>
                ))}
              </select>

              <div className="button-row" style={{ marginTop: '1rem' }}>
                <button type="button" disabled={busy || !selected} onClick={() => void publishCommitment()}>
                  Publicera åtagande
                </button>
                <button type="button" disabled={busy || !selected} onClick={() => void runCheck()}>
                  Kör slutkontroll
                </button>
              </div>

              <p className="muted small" style={{ marginTop: '0.75rem' }}>
                Ett åtagande binder röstunderlaget vid en tidpunkt. Ju tätare de publiceras, desto
                snävare fönster har en ändring att gömma sig i.
              </p>
            </div>

            {report && (
              <div className="card">
                <h2>Slutkontroll — {report.electionName}</h2>

                <div
                  className={report.canCertify ? 'notice info' : 'notice danger'}
                  role="status"
                >
                  {report.canCertify
                    ? 'Samtliga kontroller är godkända. Resultatet kan fastställas.'
                    : report.anomalous
                      ? `AVVIKELSE: ${report.failures.length} kontroll(er) visar att underlaget inte stämmer. Kräver granskning.`
                      : 'Inte klart att fastställas än — se vilka förutsättningar som saknas nedan. Ingenting är fel.'}
                </div>

                <p className="muted small">
                  Status: <strong>{report.status}</strong> · {report.voteCount} röster ·
                  Merklerot <span className="mono">{report.merkleRoot.slice(0, 16)}…</span>
                </p>

                {/*
                  Grundregeln i globals.css ger varje tabellcell white-space: nowrap,
                  eftersom en hash som bryts mitt i blir oläslig. Här står löpande
                  förklaringar i första kolumnen, och utan radbrytning blev tabellen
                  1 267 px bred i ett kort på 620 px, och i ett kort på 350 px på en
                  telefon. Första kolumnen bryter därför rad, långa tecknasträngar
                  bryts var som helst, och behållaren skrollar om något ändå inte ryms,
                  så att tabellen aldrig ritas utanför kortet.
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

                <div className="button-row" style={{ marginTop: '1.5rem' }}>
                  <button
                    type="button"
                    disabled={busy || !report.canCertify || report.status === 'CERTIFIED'}
                    onClick={() => void certify()}
                  >
                    {report.status === 'CERTIFIED' ? 'Redan fastställt' : 'Fastställ resultatet'}
                  </button>
                </div>

                <p className="muted small" style={{ marginTop: '0.75rem' }}>
                  Knappen är inte det som avgör. Fastställandet kör om hela kontrollen på servern
                  och vägrar om något kritiskt fallerar — det finns ingen väg förbi den spärren
                  härifrån, och ett val som markerats som avvikande går inte att återställa via
                  gränssnittet.
                </p>
              </div>
            )}

            <div className="card">
              <h2>Oberoende granskning</h2>
              <p className="muted small">
                Observatörsgränssnittet är öppet utan inloggning. Vem som helst kan hämta hela
                röstunderlaget, verifiera varje rösts intyg mot valsedelns publika nyckel och räkna
                om resultatet — utan att fråga oss om lov och utan att kunna se vem som röstat på
                vad.
              </p>
              <p className="mono small">POST /api/observer/election · POST /api/observer/votes</p>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
