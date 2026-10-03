'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { BankIdLogin } from '../_components/BankIdLogin'
import { DEMO_IDENTITIES } from '../_components/demo-identities'

/**
 * VERIFIERINGSSIDAN: ATT DU RÖSTAT, INTE VAD (uppgift 13, spec 3.1).
 *
 * Väljaren legitimerar sig och ser per valsedel "Du har röstat" eller "Du har
 * inte röstat". Före skalningen kommer beskedet ur hennes liggande kuvert,
 * efter skalningen ur markeringen "har röstat", som skalningen skriver när den
 * raderar kopplingen. Se /api/vote/participation.
 *
 * SIDAN PEKAR INTE UT NÅGOT CHIFFER OCH VISAR INGEN TID. Ett chiffer, en hash
 * eller en kod som väljaren kan visa upp efter stängningen är just det handtag
 * en köpare antecknar (spec 3.1 punkt 3 och 5), och markeringen har ingen
 * tidsstämpel. Före stängningen ser väljaren sin röst på röstsidan, på
 * enheten hon röstade från, och bara där.
 *
 * HÄR STOD EN RUTA FÖR TOKEN, och sedan uppgift 14 en förklaring av var
 * kontrollen finns. Sidan bygger ut förklaringen: den länkar till det
 * publicerade resultatet och säger hur man kontrollerar det själv, och vad den
 * kontrollen inte kan visa.
 */

type Participation = {
  electionId: string
  electionName: string
  phase: string
  ballots: Array<{ id: string; kind: string; label: string; voted: boolean }>
}

type ElectionChoice = { id: string; name: string }

type View =
  | { kind: 'loading' }
  | { kind: 'login' }
  | { kind: 'known'; participation: Participation }
  | { kind: 'failed'; message: string }

async function fetchParticipation(): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch('/api/vote/participation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    cache: 'no-store',
  })
  return { status: response.status, data: (await response.json()) as Record<string, unknown> }
}

/** Var omröstningen står, i ord, och vad det betyder för den som röstat. */
function phaseText(phase: string): string {
  switch (phase) {
    case 'OPEN':
      return 'Röstningen pågår. Du kan rösta om fram till stängningen, och det är den senaste rösten som räknas.'
    case 'CLOSED':
    case 'VALIDATED':
      return 'Röstningen är stängd. Rösterna kontrolleras innan kopplingen mellan väljare och röst raderas.'
    case 'STRIPPED':
      return 'Röstningen är stängd, och kopplingen mellan väljare och röst är raderad. Rösterna räknas.'
    case 'TALLIED':
      return 'Röstningen är räknad, och resultatet är publicerat.'
    case 'CERTIFIED':
      return 'Röstningen är räknad, och resultatet är fastställt och publicerat.'
    default:
      return 'Omröstningen står i en fas som sidan inte känner till.'
  }
}

const resultsPath = (electionId: string) => `/api/observer/results?electionId=${encodeURIComponent(electionId)}`

export default function VerifyPage() {
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [elections, setElections] = useState<ElectionChoice[]>([])
  const [electionId, setElectionId] = useState('')

  const load = useCallback(async () => {
    try {
      const { status, data } = await fetchParticipation()
      if (status === 200) {
        setView({ kind: 'known', participation: data as unknown as Participation })
      } else if (status === 401) {
        setView({ kind: 'login' })
      } else {
        const message = (data.error as { message?: string } | undefined)?.message
        setView({ kind: 'failed', message: message ?? 'Det gick inte att hämta beskedet.' })
      }
    } catch {
      setView({ kind: 'failed', message: 'Det gick inte att hämta beskedet.' })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Omröstningarna att välja bland är offentliga, också de som är stängda.
  useEffect(() => {
    if (view.kind !== 'login' || elections.length > 0) return
    fetch('/api/observer/election', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
      .then((response) => response.json())
      .then((data: { elections?: ElectionChoice[] }) => {
        const list = data.elections ?? []
        setElections(list)
        setElectionId((current) => current || list[0]?.id || '')
      })
      .catch(() => setView({ kind: 'failed', message: 'Det gick inte att hämta omröstningarna.' }))
  }, [view.kind, elections.length])

  return (
    <main className="narrow">
      <div className="stack">
        <div>
          <h1>Kontrollera din röst</h1>
          <p className="muted">
            Här ser du om du har röstat, men inte på vad. Du får ingen kod att spara, och sidan visar
            ingen tid.
          </p>
        </div>

        {view.kind === 'loading' && (
          <div className="card" role="status" aria-live="polite">
            <p className="muted" style={{ margin: 0 }}>
              Hämtar …
            </p>
          </div>
        )}

        {view.kind === 'failed' && (
          <div className="notice danger" role="alert">
            {view.message}
          </div>
        )}

        {view.kind === 'login' && (
          <>
            <div className="card">
              <label htmlFor="val">Omröstning</label>
              <select id="val" value={electionId} onChange={(event) => setElectionId(event.target.value)}>
                {elections.map((election) => (
                  <option key={election.id} value={election.id}>
                    {election.name}
                  </option>
                ))}
              </select>
              <p className="muted small" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
                Legitimera dig för att se om du har röstat i den omröstning du väljer här.
              </p>
            </div>
            <BankIdLogin
              purpose="verify"
              collectPath="/api/auth/bankid/collect"
              collectBody={{ electionId }}
              demoIdentities={DEMO_IDENTITIES}
              canStart={() => (electionId ? null : 'Välj en omröstning först.')}
              onComplete={() => {
                setView({ kind: 'loading' })
                void load()
              }}
            />
          </>
        )}

        {view.kind === 'known' && <Answer participation={view.participation} onOther={() => setView({ kind: 'login' })} />}

        <section className="card" aria-labelledby="vad-sidan-visar">
          <h2 id="vad-sidan-visar">Vad beskedet bygger på</h2>
          <p>
            Medan röstningen pågår kommer beskedet ur din liggande röst. När röstningen stängs raderas
            kopplingen mellan dig och rösten, och det enda som står kvar är en markering om att du har
            röstat, utan tid och utan rösten.
          </p>
          <p className="small" style={{ marginBottom: 0 }}>
            Beskedet är inget bevis. Det kommer ur systemets egen röstlängd, och den som kan ändra i den
            kan också ändra beskedet. Har en röst tagits bort före stängningen visas att du inte har
            röstat. Har någon lagt tillbaka en äldre röst som du lade själv syns det inte här. Ändrar du
            din röst före stängningen, kontrollera den på röstsidan på enheten du röstade från.
          </p>
        </section>

        <section className="card" aria-labelledby="varfor-ingen-kod">
          <h2 id="varfor-ingen-kod">Varför du inte kan se vad du röstade på</h2>
          <p className="small" style={{ marginBottom: 0 }}>
            Kunde du visa vad du röstat på kunde någon annan kräva att få se det, till exempel den som
            betalat för din röst. Därför finns ingen kod, och efter stängningen publiceras bara
            summorna. Medan röstningen pågår ser du din röst på röstsidan, på den enhet du röstade från,
            och du kan ändra den fram till stängningen. Mer om hur det fungerar står på sidan{' '}
            <Link href="/architecture">Arkitektur</Link>.
          </p>
        </section>
      </div>
    </main>
  )
}

function Answer({ participation, onOther }: { participation: Participation; onOther: () => void }) {
  const { phase, electionId } = participation
  const open = phase === 'OPEN'
  const published = phase === 'TALLIED' || phase === 'CERTIFIED'

  return (
    <>
      <section className="card" aria-labelledby="ditt-besked">
        <h2 id="ditt-besked">{participation.electionName}</h2>
        <p className="muted">{phaseText(phase)}</p>

        {participation.ballots.length === 0 ? (
          <div className="notice info">Ingen valsedel i omröstningen gäller dig.</div>
        ) : (
          <ul className="verify-ballots" aria-label="Valsedlar">
            {participation.ballots.map((ballot) => (
              <li key={ballot.id} className={`notice ${ballot.voted ? 'success' : 'info'}`}>
                <strong>{ballot.label}</strong>
                <span>{ballot.voted ? 'Du har röstat.' : 'Du har inte röstat.'}</span>
              </li>
            ))}
          </ul>
        )}

        {open && (
          <p className="small">
            Vill du se vad du röstade på, eller ändra din röst, gör du det på röstsidan, på den enhet du
            röstade från.
          </p>
        )}

        <div className="button-row">
          {open && (
            <Link href="/identify">
              <button type="button">Till röstsidan</button>
            </Link>
          )}
          <button type="button" className="secondary" onClick={onOther}>
            Välj en annan omröstning
          </button>
        </div>
      </section>

      <section className="card" aria-labelledby="kontrollera-resultatet">
        <h2 id="kontrollera-resultatet">Kontrollera resultatet själv</h2>
        {published ? (
          <>
            <p>
              Resultatet är publicerat tillsammans med bevisen för hur det räknades fram: summan av
              rösterna i krypterad form, och förtroendepersonernas bidrag till att öppna den. Ingenting
              om en enskild röst är publicerat, utom på en valsedel med en enda röst. Där är summan
              den rösten, och både talet och den krypterade summan visar den.
            </p>
            <p>
              <a href={resultsPath(electionId)}>Det publicerade resultatet</a>
            </p>
          </>
        ) : (
          <p>
            När omröstningen är räknad publiceras resultatet här, tillsammans med bevisen för hur det
            räknades fram. Innan dess publiceras inget resultat. Efter stängningen ser administratören
            varje valsedel när den räknas, och i demon kan den som driver systemet dekryptera.
          </p>
        )}
        <p className="small">
          Vem som helst kan kontrollera bevisen med ett fristående program som inte använder något av
          systemets egen kod. Med projektets källkod och Node.js:
        </p>
        <p className="verify-command">node tools/verify-election.mjs &lt;adressen till resultatet&gt;</p>
        <p className="small" style={{ marginBottom: 0 }}>
          Programmet kontrollerar att resultatet är en riktig öppning av den publicerade summan och att
          två av tre förtroendepersoner bidrog. Det kan inte kontrollera att summan består av exakt de
          giltiga rösterna, eftersom de enskilda rösterna aldrig publiceras. Det vilar på kontrollerna som
          görs innan kopplingen raderas, och på slutkontrollen.
        </p>
      </section>
    </>
  )
}
