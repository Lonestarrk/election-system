'use client'

import { useState } from 'react'

/**
 * Verifieringssidan.
 *
 * Token skickas i begärans kropp, aldrig i URL:en — och sidan har inget
 * formulärfält som ens kan ta emot något annat än en token. Det finns
 * medvetet ingen möjlighet att söka på personnummer: den funktionen saknas
 * inte bara i gränssnittet utan i hela systemet.
 */

type Result =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'registered'; party: string }
  | { state: 'not_found' }
  | { state: 'error'; message: string }

export default function VerifieraPage() {
  const [token, setToken] = useState('')
  const [result, setResult] = useState<Result>({ state: 'idle' })

  async function verify(event: React.FormEvent) {
    event.preventDefault()
    setResult({ state: 'loading' })

    try {
      const response = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = await response.json()

      if (!response.ok) {
        setResult({ state: 'error', message: data.error?.message ?? 'Verifieringen misslyckades.' })
        return
      }

      setResult(data.registered ? { state: 'registered', party: data.party } : { state: 'not_found' })
    } catch {
      setResult({ state: 'error', message: 'Kunde inte nå tjänsten. Försök igen.' })
    }
  }

  return (
    <main className="narrow">
      <div className="stack">
        <div>
          <h1>Verifiera din röst</h1>
          <p className="muted">
            Ange den token du fick när du röstade. Systemet svarar om rösten finns registrerad och
            vilket parti den avsåg.
          </p>
        </div>

        <form className="card" onSubmit={verify}>
          <label htmlFor="token">Token</label>
          <input
            id="token"
            type="text"
            className="mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            required
          />
          <p className="muted small" style={{ marginTop: '0.6rem' }}>
            Bindestreck och versaler spelar ingen roll. Tecknen I, L och O tolkas som 1, 1 och 0.
          </p>

          <div className="button-row" style={{ marginTop: '1rem' }}>
            <button type="submit" disabled={result.state === 'loading'}>
              {result.state === 'loading' ? 'Kontrollerar …' : 'Verifiera'}
            </button>
          </div>

          {result.state === 'registered' && (
            <div className="notice success" role="status" style={{ marginTop: '1.25rem' }}>
              <strong>Din röst är registrerad.</strong>
              <div style={{ marginTop: '0.35rem' }}>Rösten avsåg: {result.party}</div>
            </div>
          )}

          {result.state === 'not_found' && (
            <div className="notice warning" role="status" style={{ marginTop: '1.25rem' }}>
              Ingen röst hittades för den här token. Kontrollera att du skrivit av den rätt.
            </div>
          )}

          {result.state === 'error' && (
            <div className="notice danger" role="alert" style={{ marginTop: '1.25rem' }}>
              {result.message}
            </div>
          )}
        </form>

        <div className="card">
          <h3>Vad verifieringen inte kan göra</h3>
          <p className="muted small">
            Svaret innehåller aldrig någon uppgift om vem som röstat. Det finns heller ingen väg åt
            andra hållet: ingen kan mata in ett personnummer och få ut en token. Den kopplingen
            finns inte lagrad någonstans i systemet, så frågan saknar svar — även för den som har
            full tillgång till databaserna.
          </p>
          <p className="muted small">
            Att den som har din token också kan se vad du röstat på är en följd av att du ska kunna
            kontrollera din egen röst. Behandla token som en privat uppgift.
          </p>
        </div>
      </div>
    </main>
  )
}
