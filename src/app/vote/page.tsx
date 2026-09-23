'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createBlindedCredential, unblindSignature, verifySignature } from '@/lib/blind-client'

/**
 * Röstningssidan.
 *
 * DEN HÄR SIDAN GÖR NÅGOT OVANLIGT: DEN UTFÖR KRYPTOGRAFI.
 *
 * Röstintyget skapas och blindas här, i väljarens webbläsare, och
 * blindningsfaktorn lämnar aldrig enheten. Det är det enda som hindrar
 * valmyndigheten från att koppla ihop ett utfärdat intyg med en inlämnad röst.
 * Gjordes blindningen på servern skulle den ha sett båda sidorna, och hela
 * mekanismen vore verkningslös.
 *
 * Flödet per valsedel:
 *
 *   1. Hämta valsedelns alternativ och dess publika nyckel.
 *   2. Skapa ett hemligt röstintyg och blinda det.
 *   3. Skicka det blindade värdet med sessionen. Servern markerar rösträtten
 *      som använd och signerar — utan att se vad den signerar.
 *   4. Avblinda signaturen och kontrollera att den faktiskt är giltig.
 *   5. Skicka rösten UTAN session. Bara intyget auktoriserar den.
 *   6. Visa kvittokoden. En per valsedel.
 */

type Ballot = {
  id: string
  kind: string
  label: string
  hasVoted: boolean
}

type PartyChoice = {
  ballotPartyId: string
  name: string
  abbreviation: string
  color: string
  candidates: Array<{ id: string; name: string }>
}

type BallotChoices =
  | { kind: 'PARTY'; allowsCandidateVote: boolean; parties: PartyChoice[] }
  | { kind: 'QUESTION'; options: Array<{ id: string; label: string }> }

type Receipt = { ballot: string; token: string }

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)valcsrf=([^;]+)/)
  return match ? decodeURIComponent(match[1]!) : ''
}

function RostaContent() {
  const params = useSearchParams()

  /**
   * Omröstningen kommer från sessionen, inte från URL:en.
   *
   * Parametern i URL:en finns kvar som en bekvämlighet vid felsökning men
   * styr ingenting: sessionen avgör vilken omröstning väljaren legitimerat sig
   * för, och ett annat värde i adressfältet ska inte kunna flytta rösten.
   */
  const [electionId, setElectionId] = useState(
    // `val` läses kvar som reserv: /rosta?val=... omdirigeras hit med
    // frågesträngen oförändrad (se next.config.ts), så en gammal länk eller
    // en webbläsare som redan cachat den gamla vägen ska fortfarande landa
    // rätt. Reserven kan tas bort samma dag som de svenska omdirigeringarna
    // tas bort.
    params.get('election') ?? params.get('val') ?? '',
  )
  const [electionName, setElectionName] = useState('')
  const [ballots, setBallots] = useState<Ballot[]>([])
  const [activeBallot, setActiveBallot] = useState<Ballot | null>(null)
  const [choices, setChoices] = useState<BallotChoices | null>(null)
  const [selectedChoice, setSelectedChoice] = useState<string>('')
  const [selectedCandidate, setSelectedCandidate] = useState<string>('')
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'working' | 'done' | 'error'>('loading')
  const [message, setMessage] = useState('')

  /**
   * Hämtar de valsedlar som gäller JUST DEN HÄR väljaren.
   *
   * Går mot /api/vote/session och inte mot den publika omröstningslistan. Den
   * publika listan innehåller alla valsedlar i omröstningen, inte de som
   * gäller en viss person — en väljare folkbokförd i Falun skulle då se
   * Stockholms kommunvalsedel och få ett felmeddelande först när hon försökte
   * rösta på den.
   *
   * Svaret bär också status per valsedel, så en omladdning mitt i röstningen
   * visar rätt: de redan lagda rösterna är markerade i stället för att se
   * olagda ut.
   */
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/vote/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await response.json()

      if (!response.ok) {
        setStatus('error')
        setMessage(data.error?.message ?? 'Din röstsession har upphört. Legitimera dig igen.')
        return
      }

      setElectionId(String(data.electionId))
      setElectionName(data.electionName ?? '')
      setBallots(data.ballots ?? [])
      setStatus('ready')
    } catch {
      setStatus('error')
      setMessage('Kunde inte hämta dina valsedlar.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function openBallot(ballot: Ballot) {
    setActiveBallot(ballot)
    setChoices(null)
    setSelectedChoice('')
    setSelectedCandidate('')
    setMessage('')

    const response = await fetch('/api/vote/ballot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ballotId: ballot.id }),
    })

    const data = await response.json()

    if (!response.ok) {
      setMessage(data.error?.message ?? 'Kunde inte hämta valsedeln.')
      return
    }

    setChoices(data.choices)
  }

  async function castVote() {
    if (!activeBallot || !selectedChoice) return

    setStatus('working')
    setMessage('Skapar röstintyg …')

    try {
      // --- 1. Valsedelns publika nyckel -----------------------------------
      const keyResponse = await fetch('/api/observer/election', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ electionId }),
      })
      const keyData = await keyResponse.json()

      const publicKeyPem: string | undefined = keyData.ballots?.find(
        (ballot: { id: string }) => ballot.id === activeBallot.id,
      )?.signingPublicKeyPem

      if (!publicKeyPem) throw new Error('Valsedelns nyckel saknas.')

      // --- 2. Skapa och blinda intyget, här på enheten --------------------
      const credential = await createBlindedCredential(publicKeyPem)

      setMessage('Hämtar signatur …')

      // --- 3. Låt myndigheten signera det blindade värdet -----------------
      const issueResponse = await fetch('/api/vote/credential', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify({ ballotId: activeBallot.id, blinded: credential.blinded }),
      })
      const issued = await issueResponse.json()

      if (!issueResponse.ok) {
        setStatus('ready')
        setMessage(issued.error?.message ?? 'Kunde inte hämta röstintyg.')
        return
      }

      // --- 4. Avblinda och kontrollera ------------------------------------
      const signature = await unblindSignature(
        issued.blindSignature,
        credential.blindingFactor,
        publicKeyPem,
      )

      // Kontrolleras HÄR, innan rösten lämnas in. Utan det skulle en server
      // kunna svara med skräp, och felet upptäckas först när rösträtten redan
      // är förbrukad.
      if (!(await verifySignature(credential.credentialId, signature, publicKeyPem))) {
        setStatus('error')
        setMessage(
          'Röstintyget som utfärdades är inte giltigt. Rösten har inte lagts. ' +
            'Kontakta valmyndigheten.',
        )
        return
      }

      setMessage('Lägger rösten …')

      // --- 5. Lägg rösten, utan session -----------------------------------
      const isQuestion = choices?.kind === 'QUESTION'

      const castResponse = await fetch('/api/vote/cast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ballotId: activeBallot.id,
          ...(isQuestion
            ? { optionId: selectedChoice }
            : { ballotPartyId: selectedChoice, ...(selectedCandidate ? { candidateId: selectedCandidate } : {}) }),
          credentialId: credential.credentialId,
          credentialSignature: signature,
        }),
      })

      const cast = await castResponse.json()

      if (!castResponse.ok) {
        setStatus('error')
        setMessage(cast.error?.message ?? 'Rösten kunde inte registreras.')
        return
      }

      // --- 6. Kvittot -----------------------------------------------------
      setReceipts((current) => [...current, { ballot: activeBallot.label, token: cast.token }])
      setBallots((current) =>
        current.map((ballot) =>
          ballot.id === activeBallot.id ? { ...ballot, hasVoted: true } : ballot,
        ),
      )

      setActiveBallot(null)
      setChoices(null)
      setSelectedChoice('')
      setSelectedCandidate('')
      setStatus('ready')
      setMessage('')
    } catch {
      setStatus('error')
      setMessage('Något gick fel. Din röst lades inte.')
    }
  }

  const remaining = ballots.filter((ballot) => !ballot.hasVoted)

  /**
   * Kopierar samtliga kvittokoder.
   *
   * EN ENDA funktion, anropad bara från väljarens eget klick. Ett
   * säkerhetstest låser fast att `clipboard.writeText` förekommer exakt en
   * gång i filen och bara härifrån — annars vore det lätt att av misstag lägga
   * in en automatisk kopiering, och då hamnar kvittot i urklipp utan att
   * väljaren bett om det.
   *
   * Att den kopierar alla koder på en gång i stället för en i taget är också
   * skälet till att den kan vara en enda funktion: väljaren i ett riksdagsval
   * har tre koder, och tre knappar hade krävt tre anropsställen.
   */
  async function copyToken() {
    const text = receipts
      .map((receipt) => `${receipt.ballot}: ${receipt.token}`)
      .join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setMessage('Koderna är kopierade.')
    } catch {
      setMessage('Kunde inte kopiera. Markera och kopiera manuellt.')
    }
  }

  return (
    <main className="narrow">
      <div className="stack">
        <div>
          <h1>{electionName || 'Rösta'}</h1>
          <p className="muted">
            Ditt röstintyg skapas och blindas i din webbläsare. Valmyndigheten signerar det utan
            att se vad den signerar, vilket gör att din röst inte kan kopplas till dig — inte ens
            av den som driver systemet.
          </p>
        </div>

        {message && status !== 'error' && (
          <div className="notice info" role="status" aria-live="polite">
            {message}
          </div>
        )}

        {status === 'error' && (
          <div className="notice danger" role="alert">
            {message}
          </div>
        )}

        {receipts.length > 0 && (
          <div className="card">
            <h2>Dina kvittokoder</h2>
            <div className="notice warning">
              Detta är enda gången din token visas. Spara den om du vill kunna kontrollera din
              röst senare. Har du röstat på flera valsedlar gäller det varje kod.
            </div>
            <p className="muted small">
              En kod per valsedel. De är medvetet åtskilda: en gemensam kod skulle binda ihop dina
              val till en profil, och en kombination av flera partival är betydligt mer
              identifierande än ett enskilt.
            </p>
            {receipts.map((receipt) => (
              <div key={receipt.token} style={{ marginTop: '1rem' }}>
                <strong>{receipt.ballot}</strong>
                <div className="mono" style={{ wordBreak: 'break-all' }}>
                  {receipt.token}
                </div>
              </div>
            ))}

            <div className="button-row" style={{ marginTop: '1rem' }}>
              <button type="button" className="secondary" onClick={copyToken}>
                Kopiera koderna
              </button>
            </div>
          </div>
        )}

        {!activeBallot && remaining.length > 0 && status !== 'working' && (
          <div className="card">
            <h2>Valsedlar</h2>
            <p className="muted small">Du röstar på en valsedel i taget.</p>
            {ballots.map((ballot) => (
              <div key={ballot.id} className="button-row" style={{ marginTop: '0.75rem' }}>
                <button
                  type="button"
                  disabled={ballot.hasVoted}
                  onClick={() => void openBallot(ballot)}
                >
                  {ballot.hasVoted ? `${ballot.label} — röstad` : ballot.label}
                </button>
              </div>
            ))}
          </div>
        )}

        {!activeBallot && remaining.length === 0 && ballots.length > 0 && (
          <div className="card">
            <h2>Klart</h2>
            <p>Du har röstat på samtliga valsedlar som gäller dig.</p>
            <p className="muted small">
              Din röstsession är avslutad och raderad. Det finns nu ingen rad någonstans som kopplar
              dig till dina röster.
            </p>
          </div>
        )}

        {activeBallot && choices && (
          <div className="card">
            <h2>{activeBallot.label}</h2>

            {choices.kind === 'PARTY' && (
              <>
                {choices.parties.map((party) => (
                  <div key={party.ballotPartyId} style={{ marginTop: '0.5rem' }}>
                    <label>
                      <input
                        type="radio"
                        name="val"
                        value={party.ballotPartyId}
                        checked={selectedChoice === party.ballotPartyId}
                        onChange={() => {
                          setSelectedChoice(party.ballotPartyId)
                          setSelectedCandidate('')
                        }}
                      />{' '}
                      <span style={{ color: party.color }}>■</span> {party.name} (
                      {party.abbreviation})
                    </label>

                    {choices.allowsCandidateVote &&
                      selectedChoice === party.ballotPartyId &&
                      party.candidates.length > 0 && (
                        <div style={{ marginLeft: '1.5rem', marginTop: '0.5rem' }}>
                          {/*
                            HÄR STOD EN VARNING OM ATT PERSONRÖST ÄR KÄNSLIGT. DEN VAR FELAKTIG.

                            Resonemanget var att en kandidat med få röster ger en liten
                            anonymitetsmängd. Men systemet kan inte koppla en röst till en
                            person över huvud taget — blindsigneringen bryr sig inte om hur
                            många som valde samma sak, och en kandidat med en röst är exakt
                            lika olänkbar som ett parti med en miljon.

                            Det som återstod av oron var inte personröstens, utan kvittots:
                            `verifyToken` returnerar kandidatens namn, så kvittot bevisar vad
                            väljaren valde. Det gäller partivalet också. Varningen hörde alltså
                            aldrig hemma på just det här stället, och en varning på fel plats
                            gör två saker samtidigt — den oroar i onödan och den drar
                            uppmärksamheten från det verkliga problemet.

                            Kvittofriheten hör hemma där kvittot lämnas ut. Se
                            `receipt-proves-choice` i lib/known-limitations.ts.
                          */}
                          {party.candidates.map((candidate) => (
                            <label key={candidate.id} style={{ display: 'block' }}>
                              <input
                                type="radio"
                                name="kandidat"
                                value={candidate.id}
                                checked={selectedCandidate === candidate.id}
                                onChange={() => setSelectedCandidate(candidate.id)}
                              />{' '}
                              {candidate.name}
                            </label>
                          ))}
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setSelectedCandidate('')}
                            style={{ marginTop: '0.5rem' }}
                          >
                            Ingen personröst
                          </button>
                        </div>
                      )}
                  </div>
                ))}
              </>
            )}

            {choices.kind === 'QUESTION' && (
              <>
                {choices.options.map((option) => (
                  <label key={option.id} style={{ display: 'block', marginTop: '0.5rem' }}>
                    <input
                      type="radio"
                      name="val"
                      value={option.id}
                      checked={selectedChoice === option.id}
                      onChange={() => setSelectedChoice(option.id)}
                    />{' '}
                    {option.label}
                  </label>
                ))}
              </>
            )}

            <div className="button-row" style={{ marginTop: '1rem' }}>
              <button
                type="button"
                disabled={!selectedChoice || status === 'working'}
                onClick={() => void castVote()}
              >
                {status === 'working' ? 'Arbetar …' : 'Lägg röst'}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setActiveBallot(null)
                  setChoices(null)
                }}
              >
                Tillbaka
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}

export default function RostaPage() {
  return (
    <Suspense fallback={<main className="narrow"><p className="muted">Laddar …</p></main>}>
      <RostaContent />
    </Suspense>
  )
}
