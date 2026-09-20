'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Legitimering med BankID (attrapp).
 *
 * Sidan pollar `collect` på samma sätt som mot det riktiga BankID-API:et, så
 * att flödet ser likadant ut när `MockBankIdService` byts mot en skarp
 * implementation.
 */

type Phase = 'loading' | 'input' | 'polling' | 'rejected' | 'failed'

type OpenElection = {
  id: string
  name: string
  kind: string
  closesAt: string
}

const POLL_INTERVAL_MS = 1200

export default function LegitimeringPage() {
  const router = useRouter()

  const [personalNumber, setPersonalNumber] = useState('')
  const [elections, setElections] = useState<OpenElection[]>([])
  const [electionId, setElectionId] = useState('')
  const [phase, setPhase] = useState<Phase>('loading')
  const [message, setMessage] = useState('')
  const orderRef = useRef<string | null>(null)
  // Speglas i en ref så att poll-slingan alltid ser aktuellt värde utan att
  // behöva återskapas vid varje ändring.
  const electionRef = useRef<string>('')
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
  }, [])

  // Vilka omröstningar som är öppna är offentligt och kräver ingen
  // legitimering — se /api/elections.
  useEffect(() => {
    fetch('/api/elections')
      .then((response) => response.json())
      .then((data) => {
        const open: OpenElection[] = data.elections ?? []
        setElections(open)
        setElectionId(open[0]?.id ?? '')
        setPhase('input')
      })
      .catch(() => {
        setPhase('failed')
        setMessage('Kunde inte hämta pågående omröstningar.')
      })
  }, [])

  const poll = useCallback(async () => {
    if (!orderRef.current) return

    try {
      const response = await fetch('/api/auth/bankid/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Omröstningen följer med: sessionen som skapas knyts till den, och en
        // session för en omröstning kan inte användas i en annan.
        body: JSON.stringify({ orderRef: orderRef.current, electionId: electionRef.current }),
      })
      const data = await response.json()

      if (data.status === 'pending') {
        setMessage(data.message ?? 'Väntar på BankID …')
        pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS)
        return
      }

      if (data.status === 'complete') {
        // Sessionen ligger i en HttpOnly-cookie som servern satt. Ingenting om
        // legitimeringen sparas i webbläsarens lagring.
        //
        // Omröstnings-id:t följer med i URL:en. Det är offentlig information
        // och avslöjar ingenting om väljaren — till skillnad från sessionen,
        // som aldrig lämnar cookien.
        router.push(`/rosta?val=${encodeURIComponent(electionRef.current)}`)
        return
      }

      if (data.status === 'rejected') {
        setPhase('rejected')
        setMessage(data.message ?? 'Du kan inte rösta i det här valet.')
        return
      }

      setPhase('failed')
      setMessage(data.message ?? data.error?.message ?? 'Legitimeringen misslyckades.')
    } catch {
      setPhase('failed')
      setMessage('Kunde inte nå tjänsten. Försök igen.')
    }
  }, [router])

  async function start(event: React.FormEvent) {
    event.preventDefault()

    if (!electionId) {
      setPhase('failed')
      setMessage('Välj vilken omröstning du vill rösta i.')
      return
    }

    electionRef.current = electionId
    setPhase('polling')
    setMessage('Startar BankID …')

    try {
      const response = await fetch('/api/auth/bankid/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personalNumber }),
      })
      const data = await response.json()

      if (!response.ok) {
        setPhase('failed')
        setMessage(data.error?.message ?? 'Kunde inte starta legitimeringen.')
        return
      }

      orderRef.current = data.orderRef
      pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS)
    } catch {
      setPhase('failed')
      setMessage('Kunde inte nå tjänsten. Försök igen.')
    }
  }

  function reset() {
    orderRef.current = null
    if (pollTimer.current) clearTimeout(pollTimer.current)
    setPhase('input')
    setMessage('')
  }

  return (
    <main className="narrow">
      <div className="stack">
        <div>
          <h1>Legitimera dig</h1>
          <p className="muted">
            Ange ditt personnummer för att starta BankID. Ditt personnummer lagras aldrig — det
            omvandlas direkt till ett oåterkalleligt värde som bara används för att slå upp dig i
            röstlängden.
          </p>
        </div>

        {phase === 'loading' && (
          <div className="card">
            <p className="muted">Hämtar pågående omröstningar …</p>
          </div>
        )}

        {phase === 'input' && (
          <form className="card" onSubmit={start}>
            <label htmlFor="val">Omröstning</label>
            <select
              id="val"
              value={electionId}
              onChange={(event) => setElectionId(event.target.value)}
              required
            >
              {elections.length === 0 && <option value="">Ingen omröstning är öppen</option>}
              {elections.map((election) => (
                <option key={election.id} value={election.id}>
                  {election.name}
                </option>
              ))}
            </select>

            <label htmlFor="pnr" style={{ marginTop: '1rem' }}>
              Personnummer
            </label>
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
              Demopersonnummer: <span className="mono">19900101-1234</span> (röstberättigad),{' '}
              <span className="mono">20100101-4567</span> (ej röstberättigad),{' '}
              <span className="mono">19420404-8901</span> (annan kommun),{' '}
              <span className="mono">19800101-9876</span> (administratör).
            </p>
            <div className="button-row" style={{ marginTop: '1rem' }}>
              <button type="submit">Starta BankID</button>
            </div>
          </form>
        )}

        {phase === 'polling' && (
          <div className="card">
            <h2>Öppna BankID</h2>
            <div className="notice info" role="status" aria-live="polite">
              {message}
            </div>
            <p className="muted small" style={{ marginTop: '1rem' }}>
              I den här demonstrationen sker legitimeringen automatiskt efter några sekunder. Med
              en skarp BankID-integration skulle du signera i appen här.
            </p>
            <div className="button-row">
              <button type="button" className="secondary" onClick={reset}>
                Avbryt
              </button>
            </div>
          </div>
        )}

        {(phase === 'rejected' || phase === 'failed') && (
          <div className="card">
            <div className={phase === 'rejected' ? 'notice warning' : 'notice danger'} role="alert">
              {message}
            </div>
            <div className="button-row" style={{ marginTop: '1rem' }}>
              <button type="button" className="secondary" onClick={reset}>
                Försök igen
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
