'use client'

import { useCallback, useEffect, useState } from 'react'

type Stats = {
  electorate: { totalEligible: number; totalVoted: number; turnoutPercent: number }
  results: {
    totalVotes: number
    perParty: Array<{ party: string; abbreviation: string; color: string; votes: number }>
  }
  integrity: { markedAsVoted: number; recordedVotes: number; discrepancy: number }
}

export default function AdminPage() {
  const [password, setPassword] = useState('')
  const [stats, setStats] = useState<Stats | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)

  const loadStats = useCallback(async () => {
    const response = await fetch('/api/admin/stats')
    if (response.ok) {
      setStats(await response.json())
      setMessage('')
    } else {
      setStats(null)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  async function login(event: React.FormEvent) {
    event.preventDefault()
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })

    if (!response.ok) {
      const data = await response.json()
      setMessage(data.error?.message ?? 'Inloggningen misslyckades.')
      return
    }

    setPassword('')
    await loadStats()
  }

  if (loading) {
    return (
      <main className="narrow">
        <p className="muted">Laddar …</p>
      </main>
    )
  }

  if (!stats) {
    return (
      <main className="narrow">
        <div className="stack">
          <h1>Administration</h1>
          <form className="card" onSubmit={login}>
            <label htmlFor="password">Lösenord</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <div className="button-row" style={{ marginTop: '1rem' }}>
              <button type="submit">Logga in</button>
            </div>
            {message && (
              <div className="notice danger" role="alert" style={{ marginTop: '1rem' }}>
                {message}
              </div>
            )}
            <p className="muted small" style={{ marginTop: '1rem' }}>
              Demolösenord: <span className="mono">admin</span>
            </p>
          </form>
        </div>
      </main>
    )
  }

  const maxVotes = Math.max(1, ...stats.results.perParty.map((row) => row.votes))

  return (
    <main>
      <div className="stack">
        <div>
          <h1>Valadministration</h1>
          <p className="muted">Aggregerad statistik. Inga enskilda väljare och inga enskilda röster.</p>
        </div>

        <div className="card">
          <h2>Valdeltagande</h2>
          <div className="stat-grid">
            <div className="stat">
              <div className="stat-value">{stats.electorate.totalEligible}</div>
              <div className="stat-label">Röstberättigade</div>
            </div>
            <div className="stat">
              <div className="stat-value">{stats.electorate.totalVoted}</div>
              <div className="stat-label">Har röstat</div>
            </div>
            <div className="stat">
              <div className="stat-value">{stats.electorate.turnoutPercent} %</div>
              <div className="stat-label">Valdeltagande</div>
            </div>
            <div className="stat">
              <div className="stat-value">{stats.results.totalVotes}</div>
              <div className="stat-label">Registrerade röster</div>
            </div>
          </div>
        </div>

        <div className="card">
          <h2>Röster per parti</h2>
          {stats.results.perParty.map((row) => (
            <div className="result-row" key={row.party}>
              <span className="party-swatch" style={{ background: row.color }}>
                {row.abbreviation}
              </span>
              <div className="result-bar-track">
                <div
                  className="result-bar-fill"
                  style={{ width: `${(row.votes / maxVotes) * 100}%`, background: row.color }}
                />
              </div>
              <span className="mono" style={{ textAlign: 'right' }}>
                {row.votes}
              </span>
            </div>
          ))}
          <p className="muted small" style={{ marginTop: '1rem' }}>
            Siffrorna kommer från den anonyma röstdatabasen. De går inte att bryta ned per väljare,
            per tidpunkt med fin upplösning eller per geografiskt område — varje sådan nedbrytning
            skulle vara ett steg mot att kunna peka ut enskilda väljare.
          </p>
        </div>

        <div className="card">
          <h2>Integritetskontroll</h2>
          <div className="stat-grid">
            <div className="stat">
              <div className="stat-value">{stats.integrity.markedAsVoted}</div>
              <div className="stat-label">Markerade som röstande</div>
            </div>
            <div className="stat">
              <div className="stat-value">{stats.integrity.recordedVotes}</div>
              <div className="stat-label">Registrerade röster</div>
            </div>
            <div className="stat">
              <div className="stat-value">{stats.integrity.discrepancy}</div>
              <div className="stat-label">Avvikelse</div>
            </div>
          </div>
          <div
            className={stats.integrity.discrepancy === 0 ? 'notice success' : 'notice danger'}
            style={{ marginTop: '1.25rem' }}
          >
            {stats.integrity.discrepancy === 0
              ? 'Antalet markerade väljare stämmer med antalet registrerade röster.'
              : 'Avvikelse upptäckt. En eller flera röster kan ha gått förlorade mellan de två databasskrivningarna.'}
          </div>
          <p className="muted small" style={{ marginTop: '1rem' }}>
            De två talen kommer från två skilda databaser som inte kan skrivas i samma transaktion.
            Kontrollen jämför dem som summor — vilket avslöjar om något gått fel, utan att avslöja
            vilken väljare eller vilken röst det gäller.
          </p>
        </div>

        <div className="card">
          <h2>Vad administratören inte kan göra</h2>
          <p className="muted small">
            Det finns ingen funktion för att söka fram en väljare, ingen för att lista enskilda
            röster och ingen för att hämta ut tokens. Begränsningen ligger inte i det här
            gränssnittet — den ligger i datan. Uppgiften om vem som röstat på vad finns inte lagrad
            i någon databas administratören har tillgång till, så funktionen går inte att bygga utan
            att först ändra hela arkitekturen.
          </p>
          <p className="muted small">
            Inloggningen här är avsiktligt enkel och skyddar bara statistiken. Även en angripare som
            tar sig förbi den kommer inte åt kopplingen mellan person och röst, eftersom den inte
            existerar.
          </p>
        </div>
      </div>
    </main>
  )
}
