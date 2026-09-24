'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { BankIdLogin } from '../_components/BankIdLogin'
import { DEMO_IDENTITIES } from '../_components/demo-identities'

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

export default function LegitimeringPage() {
  const router = useRouter()

  const [elections, setElections] = useState<OpenElection[]>([])
  const [electionId, setElectionId] = useState('')
  const [loadError, setLoadError] = useState('')

  /**
   * "INTE HÄMTAT ÄN" ÄR INTE SAMMA SAK SOM "INGET FINNS".
   *
   * Utan den här flaggan är listan tom vid första rendringen, och tomt-läget
   * hann visas i ett ögonblick innan svaret kom — "Ingen omröstning är öppen
   * just nu" blinkade förbi vid varje sidladdning. Det är värre än det låter:
   * beskedet är korrekt formulerat för ett läge som ännu inte är känt, så det
   * ser ut som ett fel som försvinner av sig själv, och den som felsöker
   * något annat leds fel.
   *
   * Tre tillstånd behövs alltså, inte två: hämtar, tomt, har innehåll.
   */
  const [loading, setLoading] = useState(true)

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
      .finally(() => setLoading(false))
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

        {/*
          ATT INTE HA NÅGON ÖPPEN OMRÖSTNING ÄR ETT EGET TILLSTÅND, INTE EN TOM LISTA.

          Tidigare låg beskedet som ett alternativ inuti rullgardinen, och
          BankID-knapparna svarade "Välj vilken omröstning du vill rösta i" —
          en uppmaning som inte går att följa när det inte finns något att
          välja. Det ser ut som att knappen är trasig, vilket är den sortens
          återvändsgränd en väljare rimligen tolkar som att systemet inte
          fungerar.
        */}
        {loading ? (
          <div className="card" role="status" aria-live="polite">
            <p className="muted" style={{ margin: 0 }}>
              Hämtar pågående omröstningar …
            </p>
          </div>
        ) : !loadError && elections.length === 0 ? (
          <div className="notice info" role="status">
            <strong>Ingen omröstning är öppen just nu.</strong>
            <p className="small" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
              Det går därför inte att legitimera sig — en session knyts alltid till en pågående
              omröstning. Är det här en demonstrationsmiljö saknas troligen seedad data; kör{' '}
              <code>npm run seed</code>.
            </p>
          </div>
        ) : (
          <div className="card">
            <label htmlFor="val">Omröstning</label>
            <select
              id="val"
              value={electionId}
              onChange={(event) => setElectionId(event.target.value)}
            >
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
        )}

        {/*
          Ingen legitimering utan något att legitimera sig till. Knapparna
          visas inte alls när listan är tom, i stället för att svara med en
          uppmaning som inte går att följa.

          `canStart` är kvar som skydd om valet hinner stängas medan sidan är
          öppen — men meddelandet stämmer nu med det enda läge det kan uppstå
          i. Det gamla sa "välj en omröstning", och eftersom den första väljs
          automatiskt när listan har något i sig kunde det bara visas när det
          inte fanns något att välja.
        */}
        {elections.length > 0 && (
          <BankIdLogin
            purpose="vote"
            collectPath="/api/auth/bankid/collect"
            collectBody={{ electionId }}
            demoIdentities={DEMO_IDENTITIES}
            canStart={() =>
              electionId ? null : 'Omröstningen är inte längre öppen. Ladda om sidan.'
            }
            onComplete={() => {
              // Sessionen ligger i en HttpOnly-cookie som servern satt.
              // Ingenting om legitimeringen sparas i webbläsarens lagring.
              //
              // Omröstnings-id:t följer med i URL:en. Det är offentlig
              // information och avslöjar ingenting om väljaren — till skillnad
              // från sessionen, som aldrig lämnar cookien.
              router.push(`/vote?election=${encodeURIComponent(electionId)}`)
            }}
          />
        )}
      </div>
    </main>
  )
}
