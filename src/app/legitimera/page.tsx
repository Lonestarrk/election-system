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

type Phase = 'input' | 'polling' | 'rejected' | 'failed'

const POLL_INTERVAL_MS = 1200

export default function LegitimeringPage() {
  const router = useRouter()

  const [personalNumber, setPersonalNumber] = useState('')
  const [phase, setPhase] = useState<Phase>('input')
  const [message, setMessage] = useState('')
  const orderRef = useRef<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
  }, [])

  const poll = useCallback(async () => {
    if (!orderRef.current) return

    try {
      const response = await fetch('/api/auth/bankid/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderRef: orderRef.current }),
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
        router.push('/rosta')
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

        {phase === 'input' && (
          <form className="card" onSubmit={start}>
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
              Demopersonnummer: <span className="mono">19900101-1234</span> (röstberättigad),{' '}
              <span className="mono">20100101-4567</span> (ej röstberättigad),{' '}
              <span className="mono">19420404-8901</span> (har redan röstat).
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
