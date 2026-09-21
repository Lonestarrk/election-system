'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { BankIdLogin, type DemoIdentity } from '../_components/BankIdLogin'

/**
 * Legitimering inför röstning.
 *
 * Sidan består av två steg: välj omröstning, legitimera dig. Ordningen spelar
 * roll — sessionen som skapas knyts till omröstningen, och en session för en
 * omröstning kan inte användas för att rösta i en annan som råkar vara öppen
 * samtidigt.
 *
 * Själva BankID-flödet ligger i BankIdLogin, som delas med adminvyn. Där finns
 * också resonemanget om varför det inte längre finns någon ruta för
 * personnummer.
 */

type OpenElection = { id: string; name: string; kind: string; closesAt: string }

/**
 * Demoidentiteter. Motsvarar att olika personer skannar QR-koden.
 *
 * Panelen finns bara så länge BankID är en attrapp — rutten den anropar
 * svarar 404 annars, och funktionen den bygger på slutar existera när mocken
 * byts ut.
 */
const DEMO_IDENTITIES: DemoIdentity[] = [
  { personalNumber: '19900101-1234', label: 'Anna — röstberättigad' },
  { personalNumber: '19850515-2345', label: 'Kim — röstberättigad' },
  { personalNumber: '19701212-3456', label: 'Robin — röstberättigad' },
  { personalNumber: '19600301-5678', label: 'Charlie — röstberättigad' },
  { personalNumber: '19550707-6789', label: 'Mira — röstberättigad' },
  { personalNumber: '19991231-7890', label: 'Noa — röstberättigad' },
  { personalNumber: '20100101-4567', label: 'Elis — ej röstberättigad' },
  { personalNumber: '19420404-8901', label: 'Gunvor — annan kommun' },
]

export default function LegitimeringPage() {
  const router = useRouter()

  const [elections, setElections] = useState<OpenElection[]>([])
  const [electionId, setElectionId] = useState('')
  const [loadError, setLoadError] = useState('')

  // Vilka omröstningar som är öppna är offentligt och kräver ingen
  // legitimering — se /api/elections.
  useEffect(() => {
    fetch('/api/elections')
      .then((response) => response.json())
      .then((data) => {
        const open: OpenElection[] = data.elections ?? []
        setElections(open)
        setElectionId(open[0]?.id ?? '')
      })
      .catch(() => setLoadError('Kunde inte hämta pågående omröstningar.'))
  }, [])

  return (
    <main className="narrow">
      <div className="stack">
        <div>
          <h1>Legitimera dig</h1>
          <p className="muted">
            Ditt personnummer lagras aldrig. Det omvandlas direkt till ett oåterkalleligt värde som
            bara används för att slå upp dig i röstlängden.
          </p>
        </div>

        {loadError && (
          <div className="notice danger" role="alert">
            {loadError}
          </div>
        )}

        <div className="card">
          <label htmlFor="val">Omröstning</label>
          <select
            id="val"
            value={electionId}
            onChange={(event) => setElectionId(event.target.value)}
          >
            {elections.length === 0 && <option value="">Ingen omröstning är öppen</option>}
            {elections.map((election) => (
              <option key={election.id} value={election.id}>
                {election.name}
              </option>
            ))}
          </select>
          <p className="muted small" style={{ marginTop: '0.75rem' }}>
            Sessionen knyts till den omröstning du väljer här och kan inte användas i en annan.
          </p>
        </div>

        <BankIdLogin
          purpose="vote"
          collectPath="/api/auth/bankid/collect"
          collectBody={{ electionId }}
          demoIdentities={DEMO_IDENTITIES}
          canStart={() => (electionId ? null : 'Välj vilken omröstning du vill rösta i.')}
          onComplete={() => {
            // Sessionen ligger i en HttpOnly-cookie som servern satt. Ingenting
            // om legitimeringen sparas i webbläsarens lagring.
            //
            // Omröstnings-id:t följer med i URL:en. Det är offentlig
            // information och avslöjar ingenting om väljaren — till skillnad
            // från sessionen, som aldrig lämnar cookien.
            router.push(`/rosta?val=${encodeURIComponent(electionId)}`)
          }}
        />
      </div>
    </main>
  )
}
