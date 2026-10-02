'use client'

import { useCallback, useState } from 'react'
import { BankIdLogin, type DemoIdentity } from '../_components/BankIdLogin'
import { post } from './api'
import { ElectionPanel } from './ElectionPanel'

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
 * SIDAN LEDER GENOM HELA AVSLUTNINGEN (uppgift 12c): stäng och validera, radera
 * kopplingen, räkna med förtroendepersonernas fraser, kör slutkontrollen och
 * fastställ. Stegen och deras knappar ligger i komponenterna bredvid, och fasen
 * läses från servern efter varje åtgärd, se `ElectionPanel`.
 *
 * Notera vad vyn INTE kan visa, oavsett behörighet: vem som röstat, när eller på
 * vad. Den får bara antal, rötter och summor per valsedel.
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

export default function AdminPage() {
  const [phase, setPhase] = useState<Phase>('login')
  const [message, setMessage] = useState('')
  const [elections, setElections] = useState<ElectionSummary[]>([])
  const [selected, setSelected] = useState('')

  const loadElections = useCallback(async () => {
    const { ok, data } = await post('/api/admin/stats', {})
    if (ok) {
      const list = (data.elections ?? []) as ElectionSummary[]
      setElections(list)
      setSelected(list[0]?.id ?? '')
    }
  }, [])

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

        {phase === 'ready' && message && (
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
              <label htmlFor="election-select">Vilken omröstning gäller det?</label>
              <select
                id="election-select"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                {elections.length === 0 && <option value="">Ingen omröstning finns</option>}
                {elections.map((election) => (
                  <option key={election.id} value={election.id}>
                    {election.name}
                  </option>
                ))}
              </select>
            </div>

            {selected && <ElectionPanel electionId={selected} />}

            <div className="card">
              <h2>Oberoende granskning</h2>
              <p className="muted small">
                Publiceringen av summorna med bevis, så att vem som helst kan kontrollera räkningen, är
                nästa steg i bygget (uppgift 13). Tills dess lämnar appen inte ut resultatet till någon
                annan än den inloggade administratören.
              </p>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
