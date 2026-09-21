'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

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

type Phase = 'login' | 'polling' | 'rejected' | 'ready'

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

const POLL_INTERVAL_MS = 1200

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
  const [personalNumber, setPersonalNumber] = useState('')
  const [message, setMessage] = useState('')
  const [elections, setElections] = useState<ElectionSummary[]>([])
  const [selected, setSelected] = useState('')
  const [report, setReport] = useState<FinalCheckReport | null>(null)
  const [busy, setBusy] = useState(false)

  const orderRef = useRef<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
  }, [])

  const loadElections = useCallback(async () => {
    const { ok, data } = await post('/api/admin/stats', {})
    if (ok) {
      setElections(data.elections ?? [])
      setSelected(data.elections?.[0]?.id ?? '')
    }
  }, [])

  const poll = useCallback(async () => {
    if (!orderRef.current) return

    const { data } = await post('/api/admin/login', { orderRef: orderRef.current })

    if (data.status === 'pending') {
      setMessage(data.message ?? 'Väntar på BankID …')
      pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS)
      return
    }

    if (data.status === 'complete') {
      setPhase('ready')
      setMessage(`Inloggad som ${data.name ?? 'administratör'}.`)
      await loadElections()
      return
    }

    // Samma svar oavsett om personen saknas i röstlängden eller bara saknar
    // adminflaggan — annars blir rutten ett uppslagsverk över vilka som är
    // administratörer.
    setPhase('rejected')
    setMessage(data.message ?? 'Legitimeringen misslyckades.')
  }, [loadElections])

  async function startLogin(event: React.FormEvent) {
    event.preventDefault()
    setPhase('polling')
    setMessage('Startar BankID …')

    const { ok, data } = await post('/api/auth/bankid/start', { personalNumber })

    if (!ok) {
      setPhase('rejected')
      setMessage(data.error?.message ?? 'Kunde inte starta legitimeringen.')
      return
    }

    orderRef.current = data.orderRef
    pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS)
  }

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
          <form className="card" onSubmit={startLogin}>
            <label htmlFor="pnr">Personnummer</label>
            <input
              id="pnr"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="ÅÅÅÅMMDD-NNNN"
              value={personalNumber}
              onChange={(event) => setPersonalNumber(event.target.value)}
              required
            />
            <p className="muted small" style={{ marginTop: '0.75rem' }}>
              Demoadministratör: <span className="mono">19800101-9876</span>
            </p>
            <div className="button-row" style={{ marginTop: '1rem' }}>
              <button type="submit">Logga in med BankID</button>
            </div>
          </form>
        )}

        {phase === 'polling' && (
          <div className="card">
            <p className="muted">Legitimeringen sker automatiskt i demonstrationen …</p>
          </div>
        )}

        {phase === 'rejected' && (
          <div className="card">
            <div className="notice danger" role="alert">
              {message}
            </div>
            <div className="button-row" style={{ marginTop: '1rem' }}>
              <button type="button" className="secondary" onClick={() => setPhase('login')}>
                Försök igen
              </button>
            </div>
          </div>
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

                <table style={{ width: '100%', marginTop: '1rem' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left' }}>Kontroll</th>
                      <th style={{ textAlign: 'left' }}>Utfall</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.checks.map((check) => (
                      <tr key={check.id}>
                        <td style={{ verticalAlign: 'top', paddingRight: '1rem' }}>
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
