'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

/**
 * Partival, bekräftelse och kvitto.
 *
 * Kvittot visas på SAMMA sida som röstningen, utan navigering.
 *
 * Det är ett medvetet val. Alternativet — att skicka token vidare till en
 * separat kvittosida — skulle kräva att klartexten transporteras genom en URL,
 * sessionStorage eller ett tillstånd som överlever en sidladdning. Alla tre är
 * precis vad specifikationen förbjuder. Genom att rendera kvittot direkt från
 * svaret lämnar token aldrig komponentens minne, och en omladdning av sidan
 * gör den oåterkalleligt borta — vilket är exakt vad som ska hända.
 */

type Party = { id: string; name: string; abbreviation: string; color: string }
type Stage = 'select' | 'confirm' | 'submitting' | 'receipt' | 'error'

function readCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)valcsrf=([^;]+)/)
  return match?.[1] ?? ''
}

export default function RostaPage() {
  const [parties, setParties] = useState<Party[]>([])
  const [selected, setSelected] = useState<Party | null>(null)
  const [stage, setStage] = useState<Stage>('select')
  const [token, setToken] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    fetch('/api/vote/parties')
      .then((response) => response.json())
      .then((data) => setParties(data.parties ?? []))
      .catch(() => {
        setStage('error')
        setErrorMessage('Kunde inte hämta partilistan.')
      })
  }, [])

  // Varnar om väljaren råkar lämna sidan medan token fortfarande visas. Efter
  // det går den inte att få tillbaka.
  useEffect(() => {
    if (!token || acknowledged) return

    function warn(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [token, acknowledged])

  async function submitVote() {
    if (!selected) return
    setStage('submitting')

    try {
      const response = await fetch('/api/vote/cast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': readCsrfToken(),
        },
        body: JSON.stringify({ partyId: selected.id }),
      })
      const data = await response.json()

      if (!response.ok) {
        setStage('error')
        setErrorMessage(data.error?.message ?? 'Rösten kunde inte registreras.')
        return
      }

      setToken(data.token)
      setStage('receipt')
    } catch {
      setStage('error')
      setErrorMessage('Kunde inte nå tjänsten. Din röst registrerades inte.')
    }
  }

  async function copyToken() {
    if (!token) return
    try {
      // Kopiering sker bara när väljaren själv klickar. Token skrivs aldrig
      // till urklipp, localStorage eller sessionStorage automatiskt.
      await navigator.clipboard.writeText(token)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  // --- Kvitto --------------------------------------------------------------
  if (stage === 'receipt' && token) {
    return (
      <main className="narrow">
        <div className="stack">
          <div>
            <h1>Din röst är registrerad</h1>
            <p className="muted">Rösten har lagts anonymt. Din identitet finns inte kvar i den.</p>
          </div>

          <div className="card">
            <div className="notice warning" role="alert" style={{ marginBottom: '1.25rem' }}>
              <strong>
                Detta är enda gången din token visas. Spara den om du vill kunna kontrollera din
                röst senare.
              </strong>
            </div>

            <label htmlFor="token">Din token</label>
            <div className="token-display" id="token">
              {token}
            </div>

            <div className="button-row">
              <button type="button" className="secondary" onClick={copyToken}>
                {copied ? 'Kopierad' : 'Kopiera token'}
              </button>
              <button type="button" onClick={() => setAcknowledged(true)}>
                Jag har sparat min token
              </button>
            </div>

            {acknowledged && (
              <div className="notice success" style={{ marginTop: '1.25rem' }}>
                Klart. Gå till <Link href="/verifiera">Verifiera röst</Link> när du vill kontrollera
                att rösten finns registrerad.
              </div>
            )}
          </div>

          <div className="card">
            <h3>Vad hände nyss</h3>
            <p className="muted small">
              Du markerades som röstande i röstlängden. Sedan registrerades en röst på{' '}
              {selected?.name} i en helt separat databas, tillsammans med en avtryck av din token.
              Den registreringen innehåller ingenting om dig — inget personnummer, inget väljar-id,
              ingen IP-adress, ingen sessionsuppgift. Din röstsession raderades i samma ögonblick.
            </p>
            <p className="muted small">
              Token lagras inte i klartext hos oss, bara som ett kryptografiskt avtryck. Vi kan
              alltså bekräfta en token du visar upp, men aldrig räkna fram den åt någon som inte
              redan har den.
            </p>
          </div>
        </div>
      </main>
    )
  }

  // --- Fel -----------------------------------------------------------------
  if (stage === 'error') {
    return (
      <main className="narrow">
        <div className="card">
          <div className="notice danger" role="alert">
            {errorMessage}
          </div>
          <div className="button-row" style={{ marginTop: '1rem' }}>
            <Link href="/legitimera">
              <button type="button" className="secondary">
                Tillbaka till legitimering
              </button>
            </Link>
          </div>
        </div>
      </main>
    )
  }

  // --- Bekräftelse ---------------------------------------------------------
  if (stage === 'confirm' || stage === 'submitting') {
    return (
      <main className="narrow">
        <div className="stack">
          <h1>Bekräfta din röst</h1>

          <div className="card">
            <p className="muted">Du är på väg att rösta på:</p>
            <div className="party-option" aria-pressed="true" style={{ cursor: 'default' }}>
              <span className="party-swatch" style={{ background: selected?.color }}>
                {selected?.abbreviation}
              </span>
              {selected?.name}
            </div>

            <div className="notice info" style={{ marginTop: '1.25rem' }}>
              När du bekräftar kan rösten inte ändras eller ångras.
            </div>

            <div className="button-row" style={{ marginTop: '1.25rem' }}>
              <button type="button" onClick={submitVote} disabled={stage === 'submitting'}>
                {stage === 'submitting' ? 'Registrerar …' : 'Bekräfta och rösta'}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setStage('select')}
                disabled={stage === 'submitting'}
              >
                Ändra val
              </button>
            </div>
          </div>
        </div>
      </main>
    )
  }

  // --- Partival ------------------------------------------------------------
  return (
    <main className="narrow">
      <div className="stack">
        <div>
          <h1>Välj parti</h1>
          <p className="muted">Du kan bara rösta på ett parti.</p>
        </div>

        <div className="card">
          <div className="party-list">
            {parties.map((party) => (
              <button
                key={party.id}
                type="button"
                className="party-option"
                aria-pressed={selected?.id === party.id}
                onClick={() => setSelected(party)}
              >
                <span className="party-swatch" style={{ background: party.color }}>
                  {party.abbreviation}
                </span>
                {party.name}
              </button>
            ))}
          </div>

          <div className="button-row" style={{ marginTop: '1.5rem' }}>
            <button type="button" disabled={!selected} onClick={() => setStage('confirm')}>
              Fortsätt
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}
