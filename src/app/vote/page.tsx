'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { canonicalOptions, type BallotOption } from '@/lib/crypto/ballot-encoding'
import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { encryptBallotInSteps } from '@/lib/encrypt-client'
import { DEMO_IDENTITIES } from '../_components/demo-identities'
import { BankIdSigning, type RecordedVote } from './BankIdSigning'
import {
  ballotStatus,
  browserStorage,
  forgetDeviceVote,
  forgetElectionsNotOpen,
  forgetIfVotingEnded,
  hashesToCompare,
  readDeviceVotes,
  rememberDeviceVote,
  staleDeviceVotes,
  storedElectionIds,
  type BallotStatus,
  type DeviceComparison,
  type DeviceStorage,
  type DeviceVote,
  type ServerBallot,
} from './device-vote'

/**
 * RÖSTSIDAN: LÄGG EN RÖST, SE DEN, ÄNDRA DEN.
 *
 * Alla röster är förtidsröster (spec 3.1, användarens beslut 2026-09-23).
 * Fram till stängningen kan väljaren se, kontrollera och ändra sin röst.
 * Efter stängningen kan ingen se eller ändra något. Sidan visar fyra saker:
 *
 *   1. Att rösten går att ändra, och ändringen är lika lätt som första gången.
 *      Det är skyddet mot röstköp: allt före den sista läggningen kan ändras.
 *   2. Den nuvarande rösten, men bara på enheten som lade den, och bara när
 *      servern bekräftat att den håller exakt den rösten.
 *   3. Att det enheten visar inte är ett bevis. Slumptalet sparas aldrig.
 *   4. Ingen kod. En kod på skärmen är det handtag en köpare antecknar.
 *
 * FLÖDET PER VALSEDEL
 *
 *   /api/vote/ballot         alternativen och valets publika nyckel
 *   canonicalOptions         samma alternativlista som servern bygger
 *   encryptBallotInSteps     chiffer, bevis och hash, här i webbläsaren
 *   /api/vote/sign-start     BankID-underskrift över hashen, som servern bygger
 *   /api/vote/encrypted      pollas tills underskriften finns och rösten ligger
 *
 * Det gamla flödets rutter, röstintyg och kvittokoder används inte längre.
 * De finns kvar på servern tills flödet tas bort, men den här sidan anropar
 * dem inte, och e2e-testerna kontrollerar det.
 *
 * NÄR SIDAN LADDAS
 *
 * Sessionen säger vilka valsedlar som gäller, om ett kuvert ligger på var och
 * en, och valets fas. Har fasen lämnat OPEN raderar sidan det enheten sparat.
 * Annars skickar den sina sparade hashar till /api/vote/compare och får bara
 * lika, olika eller ingen röst tillbaka. Servern lämnar aldrig ut sin hash;
 * se rutten för varför.
 *
 * En post vars röst ändrats från en annan enhet raderas direkt, samma gång som
 * sidan visar att rösten ändrats. Nästa gång visar enheten bara att en röst
 * finns. Posten sa annars fortfarande två saker om väljaren: vad hon en gång
 * röstade på, och att hon sedan ändrat sig.
 */

type Election = {
  id: string
  name: string
  phase: string | null
  closesAt: string | null
  acceptsVotes: boolean
}

type PartyChoice = {
  ballotPartyId: string
  name: string
  abbreviation: string
  color: string
  displayOrder: number
  candidates: Array<{ id: string; name: string; displayOrder: number }>
}

type PartyBallot = { kind: 'PARTY'; allowsCandidateVote: boolean; parties: PartyChoice[] }

type Encryption = { publicKey: string; optionCount: number }

/** Den valsedel väljaren håller på med, från valet till underskriften. */
type Active = {
  ballotId: string
  step: 'loading' | 'choosing' | 'sealing' | 'signing'
  choices: PartyBallot | null
  encryption: Encryption | null
  party: string
  candidate: string
  progress: { done: number; total: number } | null
  sealed: { ballot: EncryptedBallot; choice: BallotOption; label: string } | null
  error: string
}

type Load =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'no-session'; message: string }
  | { kind: 'error'; message: string }

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)valcsrf=([^;]+)/)
  return match ? decodeURIComponent(match[1]!) : ''
}

/**
 * Släpper fram webbläsaren mellan krypteringens steg.
 *
 * `requestAnimationFrame` väntar tills sidan ritats om, så att förloppet syns.
 * Tidsgränsen finns för en flik i bakgrunden, där ingen omritning sker: då
 * fortsätter krypteringen ändå i stället för att stå still.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0))
    setTimeout(resolve, 50)
  })
}

const closingTime = new Intl.DateTimeFormat('sv-SE', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'Europe/Stockholm',
})

/**
 * Glömmer det enheten sparat om omröstningar som inte längre är öppna.
 *
 * Den offentliga listan över öppna omröstningar frågas utan att berätta vilka
 * omröstningar enheten har uppgifter om. `keep` är omröstningen sessionen
 * gäller, vars fas sessionen själv har svarat på.
 */
async function forgetClosedElections(storage: DeviceStorage, keep?: string): Promise<void> {
  try {
    const response = await fetch('/api/elections')
    if (!response.ok) return
    const data = (await response.json()) as { elections?: Array<{ id: string }> }
    const open = (data.elections ?? []).map((election) => election.id)
    forgetElectionsNotOpen(storage, keep ? [...open, keep] : open)
  } catch {
    // Utan svar raderas ingenting. Uppgifterna bevisar ändå ingenting (spec 3.1 punkt 2).
  }
}

function VoteContent() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [election, setElection] = useState<Election | null>(null)
  const [ballots, setBallots] = useState<ServerBallot[]>([])
  const [deviceVotes, setDeviceVotes] = useState<Record<string, DeviceVote>>({})
  const [comparisons, setComparisons] = useState<Record<string, DeviceComparison>>({})
  const [active, setActive] = useState<Active | null>(null)
  const [notice, setNotice] = useState('')

  const loadDone = useRef(false)

  const loadPage = useCallback(async () => {
    const storage = browserStorage()

    let response: Response
    let data: Record<string, unknown>
    try {
      response = await fetch('/api/vote/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      data = (await response.json()) as Record<string, unknown>
    } catch {
      setLoad({ kind: 'error', message: 'Kunde inte hämta dina valsedlar. Ladda om sidan.' })
      return
    }

    if (!response.ok) {
      const error = data.error as { message?: string } | undefined
      setLoad({
        kind: 'no-session',
        message: error?.message ?? 'Din röstsession har upphört. Legitimera dig igen.',
      })
      // Utan session kan sidan inte fråga om fasen. Den offentliga listan
      // räcker för att se vilka omröstningar som stängt; se device-vote.ts.
      if (storage && storedElectionIds(storage).length > 0) await forgetClosedElections(storage)
      return
    }

    const current: Election = {
      id: String(data.electionId),
      name: typeof data.electionName === 'string' ? data.electionName : '',
      phase: typeof data.phase === 'string' ? data.phase : null,
      closesAt: typeof data.closesAt === 'string' ? data.closesAt : null,
      acceptsVotes: data.acceptsVotes === true,
    }
    const serverBallots = (data.ballots ?? []) as ServerBallot[]

    // Spec 3.1 punkt 4: när fasen lämnat OPEN raderar enheten sina uppgifter.
    if (storage) forgetIfVotingEnded(storage, current.id, current)
    if (storage && storedElectionIds(storage).some((id) => id !== current.id)) {
      await forgetClosedElections(storage, current.id)
    }

    const device = storage && current.acceptsVotes ? readDeviceVotes(storage, current.id) : {}
    const found: Record<string, DeviceComparison> = {}
    const toCompare = hashesToCompare(device, serverBallots)

    if (toCompare.length > 0) {
      try {
        const reply = await fetch('/api/vote/compare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
          body: JSON.stringify({ ballots: toCompare }),
        })
        if (reply.ok) {
          const body = (await reply.json()) as {
            ballots?: Array<{ ballotId: string; result: DeviceComparison }>
          }
          for (const entry of body.ballots ?? []) found[entry.ballotId] = entry.result
        }
      } catch {
        // Utan svar visar sidan bara att en röst finns, aldrig innehållet.
      }
    }

    if (storage) {
      for (const ballotId of staleDeviceVotes(device, serverBallots, found)) {
        forgetDeviceVote(storage, current.id, ballotId)
      }
    }

    setElection(current)
    setBallots(serverBallots)
    setDeviceVotes(device)
    setComparisons(found)
    setLoad({ kind: 'ready' })
  }, [])

  useEffect(() => {
    /**
     * EN GÅNG PER SIDVISNING, OCKSÅ I UTVECKLINGSLÄGE.
     *
     * React kör effekter två gånger i utvecklingsläge. Laddningen raderar
     * poster som inte längre stämmer, så en andra körning hade inte längre
     * hittat posten för en röst som ändrats från en annan enhet, och visat
     * "Du har en röst registrerad" i stället för att rösten ändrats. Refen
     * överlever Reacts provomstart, tillståndet också.
     */
    if (loadDone.current) return
    loadDone.current = true
    void loadPage()
  }, [loadPage])

  async function openBallot(ballot: ServerBallot) {
    setNotice('')
    setActive({
      ballotId: ballot.id,
      step: 'loading',
      choices: null,
      encryption: null,
      party: '',
      candidate: '',
      progress: null,
      sealed: null,
      error: '',
    })

    try {
      const response = await fetch('/api/vote/ballot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ballotId: ballot.id }),
      })
      const data = (await response.json()) as {
        choices?: PartyBallot | { kind: 'QUESTION' }
        encryption?: Encryption | null
        error?: { message?: string }
      }

      if (!response.ok || !data.choices) {
        setActive(null)
        setNotice(data.error?.message ?? 'Kunde inte hämta valsedeln.')
        return
      }

      if (data.choices.kind !== 'PARTY' || !data.encryption) {
        setActive(null)
        setNotice('Den här valsedeln kan inte ta emot en röst här än.')
        return
      }

      const choices = data.choices
      const encryption = data.encryption
      setActive((current) =>
        current && current.ballotId === ballot.id
          ? { ...current, step: 'choosing', choices, encryption }
          : current,
      )
    } catch {
      setActive(null)
      setNotice('Kunde inte hämta valsedeln.')
    }
  }

  /**
   * Låser valet i webbläsaren och går vidare till underskriften.
   *
   * Alternativlistan byggs med `canonicalOptions` ur partiernas och
   * kandidaternas ordning, och längden jämförs med serverns innan något
   * krypteras. Skiljer de sig åt skulle rösten räknas på fel alternativ.
   */
  async function seal() {
    if (!active || !active.choices || !active.encryption || !active.party || !election) return

    const { choices, encryption, ballotId } = active
    const party = choices.parties.find((entry) => entry.ballotPartyId === active.party)
    if (!party) return
    const candidate = party.candidates.find((entry) => entry.id === active.candidate)

    const options = canonicalOptions({
      allowsCandidateVote: choices.allowsCandidateVote,
      parties: choices.parties.map((entry) => ({
        id: entry.ballotPartyId,
        displayOrder: entry.displayOrder,
        candidates: entry.candidates.map((person) => ({
          id: person.id,
          displayOrder: person.displayOrder,
        })),
      })),
    })

    if (options.length !== encryption.optionCount) {
      setActive({
        ...active,
        error: 'Valsedeln stämmer inte med den servern har. Ladda om sidan. Rösten lades inte.',
      })
      return
    }

    const choice: BallotOption =
      candidate && choices.allowsCandidateVote
        ? { kind: 'CANDIDATE', ballotPartyId: party.ballotPartyId, candidateId: candidate.id }
        : { kind: 'PARTY', ballotPartyId: party.ballotPartyId }
    const label = candidate ? `${party.name}, personröst på ${candidate.name}` : party.name

    setActive({ ...active, step: 'sealing', progress: { done: 0, total: options.length + 1 }, error: '' })

    try {
      const sealed = await encryptBallotInSteps(
        encryption.publicKey,
        election.id,
        ballotId,
        options,
        choice,
        (done, total) =>
          setActive((current) =>
            current && current.ballotId === ballotId ? { ...current, progress: { done, total } } : current,
          ),
        nextFrame,
      )

      setActive((current) =>
        current && current.ballotId === ballotId
          ? { ...current, step: 'signing', sealed: { ballot: sealed, choice, label } }
          : current,
      )
    } catch {
      setActive((current) =>
        current && current.ballotId === ballotId
          ? { ...current, step: 'choosing', error: 'Rösten kunde inte låsas. Försök igen.' }
          : current,
      )
    }
  }

  function recorded(vote: RecordedVote) {
    if (!active || !active.sealed || !election) return
    const { ballotId, sealed } = active

    // Servern svarar med hashen den lagrade. Den ska vara just den här
    // enhetens, annars visas ingenting som om det vore bekräftat.
    const confirmed = vote.ciphertextHash === sealed.ballot.ciphertextHash
    const storage = browserStorage()

    if (confirmed && storage) {
      rememberDeviceVote(storage, election.id, ballotId, {
        ciphertextHash: sealed.ballot.ciphertextHash,
        choice: sealed.choice,
        label: sealed.label,
      })
    }

    setBallots((current) =>
      current.map((ballot) => (ballot.id === ballotId ? { ...ballot, hasPendingVote: true } : ballot)),
    )
    // Visningen gäller också när lagringen inte går att nå, till exempel i
    // ett privat fönster. Då finns rösten bara i minnet tills sidan laddas om.
    if (confirmed) {
      setDeviceVotes((current) => ({
        ...current,
        [ballotId]: {
          ciphertextHash: sealed.ballot.ciphertextHash,
          choice: sealed.choice,
          label: sealed.label,
        },
      }))
      setComparisons((current) => ({ ...current, [ballotId]: 'same' }))
    } else {
      setComparisons((current) => {
        const next = { ...current }
        delete next[ballotId]
        return next
      })
    }

    setActive(null)
    setNotice(vote.replaced ? 'Rösten är lagd och har ersatt den förra.' : 'Rösten är lagd.')
  }

  function sessionExpired() {
    setActive(null)
    setLoad({ kind: 'no-session', message: 'Din röstsession har upphört. Legitimera dig igen.' })
  }

  if (load.kind === 'loading') {
    return (
      <div className="card" role="status" aria-live="polite">
        <p className="muted" style={{ margin: 0 }}>
          Hämtar dina valsedlar …
        </p>
      </div>
    )
  }

  if (load.kind !== 'ready' || !election) {
    return (
      <div className="stack">
        <h1>Rösta</h1>
        <div className={load.kind === 'error' ? 'notice danger' : 'notice warning'} role="alert">
          {'message' in load ? load.message : 'Något gick fel. Ladda om sidan.'}
        </div>
        <div>
          <Link href="/identify">
            <button type="button">Legitimera dig</button>
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="stack">
      <div>
        <h1>{election.name || 'Rösta'}</h1>
        <p className="muted">
          Du röstar på en valsedel i taget. Fram till att röstningen stänger
          {election.closesAt ? ` den ${closingTime.format(new Date(election.closesAt))}` : ''} går det
          att rösta om så många gånger du vill, och det är den senaste rösten som räknas. Rösten
          låses på den här enheten innan den skickas, och du skriver under den med BankID.
        </p>
      </div>

      {notice && (
        <div className="notice info" role="status" aria-live="polite">
          {notice}
        </div>
      )}

      {ballots.map((ballot) => (
        <BallotCard
          key={ballot.id}
          ballot={ballot}
          status={ballotStatus({
            ballot,
            acceptsVotes: election.acceptsVotes,
            deviceVote: deviceVotes[ballot.id],
            comparison: comparisons[ballot.id],
          })}
          active={active?.ballotId === ballot.id ? active : null}
          busy={active !== null && active.ballotId !== ballot.id}
          onOpen={() => void openBallot(ballot)}
          onSelectParty={(party) =>
            setActive((current) => (current ? { ...current, party, candidate: '', error: '' } : current))
          }
          onSelectCandidate={(candidate) =>
            setActive((current) => (current ? { ...current, candidate } : current))
          }
          onSeal={() => void seal()}
          onCancel={() => setActive(null)}
          onBackToChoice={() =>
            setActive((current) =>
              current ? { ...current, step: 'choosing', sealed: null, progress: null } : current,
            )
          }
          onRecorded={recorded}
          onSessionExpired={sessionExpired}
        />
      ))}

      <section className="card" aria-labelledby="inget-kvitto">
        <h2 id="inget-kvitto">Det här är inget kvitto</h2>
        <p className="small">
          Enheten sparar vad du röstade på och ett slags fingeravtryck av rösten, så att den kan
          visa din röst när du kommer tillbaka. Den sparar inte slumptalet som rösten låstes med,
          och utan slumptalet går det inte att bevisa för någon annan vad rösten innehåller. Det
          som står här kan du dessutom skriva om själv.
        </p>
        <p className="small">
          Ingen kan alltså kräva ett bevis av dig, och ingen kan få ett. Du får ingen kod att spara
          heller: en kod på skärmen vore just det som en köpare skulle be att få se.
        </p>
        <p className="muted small" style={{ marginBottom: 0 }}>
          När röstningen har stängt raderar sidan det enheten har sparat, första gången den öppnas
          efter stängningen. Öppnas den aldrig mer ligger uppgifterna kvar, men de bevisar
          ingenting. Mer om hur det fungerar står på sidan{' '}
          <Link href="/architecture">Arkitektur</Link>.
        </p>
      </section>
    </div>
  )
}

type BallotCardProps = {
  ballot: ServerBallot
  status: BallotStatus
  active: Active | null
  busy: boolean
  onOpen: () => void
  onSelectParty: (ballotPartyId: string) => void
  onSelectCandidate: (candidateId: string) => void
  onSeal: () => void
  onCancel: () => void
  onBackToChoice: () => void
  onRecorded: (vote: RecordedVote) => void
  onSessionExpired: () => void
}

/**
 * En valsedel: vad som ligger, och vägen till en ny röst.
 *
 * Texterna står i var sitt element, och "Din nuvarande röst" delar element med
 * valet. Det är också så e2e-testerna läser sidan.
 */
function BallotCard({
  ballot,
  status,
  active,
  busy,
  onOpen,
  onSelectParty,
  onSelectCandidate,
  onSeal,
  onCancel,
  onBackToChoice,
  onRecorded,
  onSessionExpired,
}: BallotCardProps) {
  const headingId = `valsedel-${ballot.id}`
  const canVote = status.kind === 'not-voted' || status.kind === 'current' ||
    status.kind === 'changed-elsewhere' || status.kind === 'registered'

  return (
    <section className="card vote-ballot" aria-labelledby={headingId}>
      <h2 id={headingId}>{ballot.label}</h2>

      <BallotStatusText status={status} />

      {canVote && !active && (
        <div className="button-row" style={{ marginTop: '1rem' }}>
          <button type="button" onClick={onOpen} disabled={busy}>
            {status.kind === 'not-voted' ? 'Rösta' : 'Ändra din röst'}
          </button>
        </div>
      )}

      {active && (
        <div className="vote-active">
          {active.step === 'loading' && (
            <p className="muted small" role="status">
              Hämtar valsedeln …
            </p>
          )}

          {active.step === 'choosing' && active.choices && (
            <ChoiceForm
              ballotId={ballot.id}
              choices={active.choices}
              party={active.party}
              candidate={active.candidate}
              error={active.error}
              onSelectParty={onSelectParty}
              onSelectCandidate={onSelectCandidate}
              onSeal={onSeal}
              onCancel={onCancel}
            />
          )}

          {active.step === 'sealing' && active.progress && (
            <div role="status" aria-live="polite">
              <p className="small">
                Rösten låses på den här enheten innan något skickas. Det tar några sekunder, och
                längre på en valsedel med många namn.
              </p>
              <progress
                className="vote-progress"
                max={active.progress.total}
                value={active.progress.done}
                aria-label="Hur långt låsningen har kommit"
              />
              <p className="muted small" style={{ marginBottom: 0 }}>
                {active.progress.done} av {active.progress.total} delar klara
              </p>
            </div>
          )}

          {active.step === 'signing' && active.sealed && (
            <>
              <p className="small">
                Du lägger rösten: <strong>{active.sealed.label}</strong>
              </p>
              <BankIdSigning
                ballotId={ballot.id}
                ballot={active.sealed.ballot}
                demoIdentities={DEMO_IDENTITIES}
                onRecorded={onRecorded}
                onCancel={onBackToChoice}
                onSessionExpired={onSessionExpired}
              />
            </>
          )}
        </div>
      )}
    </section>
  )
}

/** Vad som ligger på valsedeln, i ett av de sju lägena. */
function BallotStatusText({ status }: { status: BallotStatus }) {
  switch (status.kind) {
    case 'current':
      return (
        <>
          <p className="vote-current">
            Din nuvarande röst: <strong>{status.label}</strong>
          </p>
          <p className="muted small">Servern har exakt den röst som lades från den här enheten.</p>
          <p className="small" style={{ marginBottom: 0 }}>
            Du kan ändra din röst fram till stängningen. Det är den senaste som räknas.
          </p>
        </>
      )
    case 'changed-elsewhere':
      return (
        <>
          <p>Din röst har ändrats från en annan enhet. Innehållet visas bara där rösten lades.</p>
          <p className="small" style={{ marginBottom: 0 }}>
            Du kan ändra din röst igen, härifrån eller därifrån, fram till stängningen.
          </p>
        </>
      )
    case 'registered':
      return (
        <>
          <p>Du har en röst registrerad.</p>
          <p className="muted small">Vad den innehåller visas bara på enheten där den lades.</p>
          <p className="small" style={{ marginBottom: 0 }}>
            Du kan ändra din röst fram till stängningen.
          </p>
        </>
      )
    case 'not-voted':
      return <p style={{ marginBottom: 0 }}>Du har inte röstat på den här valsedeln.</p>
    case 'old-flow':
      return (
        <p style={{ marginBottom: 0 }}>
          Du röstade på den här valsedeln i det gamla röstflödet. Den rösten går inte att byta ut.
        </p>
      )
    case 'unsupported':
      return (
        <p style={{ marginBottom: 0 }}>
          Den här valsedeln kan inte ta emot en röst här än. Kuvertmodellen hanterar ännu inte
          frågor i en allmän omröstning.
        </p>
      )
    case 'closed':
      return (
        <p style={{ marginBottom: 0 }}>
          Röstningen har stängt, och ingen röst går längre att lägga eller byta ut.
          {status.hasPendingVote ? ' Du har en röst registrerad.' : ''} Vad den innehåller visas
          inte längre.
        </p>
      )
  }
}

type ChoiceFormProps = {
  ballotId: string
  choices: PartyBallot
  party: string
  candidate: string
  error: string
  onSelectParty: (ballotPartyId: string) => void
  onSelectCandidate: (candidateId: string) => void
  onSeal: () => void
  onCancel: () => void
}

function ChoiceForm({
  ballotId,
  choices,
  party,
  candidate,
  error,
  onSelectParty,
  onSelectCandidate,
  onSeal,
  onCancel,
}: ChoiceFormProps) {
  const selected = choices.parties.find((entry) => entry.ballotPartyId === party)

  return (
    <>
      <fieldset className="vote-choices">
        <legend>Välj parti</legend>
        {choices.parties.map((entry) => (
          <label key={entry.ballotPartyId} className="vote-option">
            <input
              type="radio"
              name={`parti-${ballotId}`}
              value={entry.ballotPartyId}
              checked={party === entry.ballotPartyId}
              onChange={() => onSelectParty(entry.ballotPartyId)}
            />
            <span className="vote-swatch" style={{ background: entry.color }} aria-hidden="true" />
            <span>
              {entry.name} <span className="muted">({entry.abbreviation})</span>
            </span>
          </label>
        ))}
      </fieldset>

      {choices.allowsCandidateVote && selected && selected.candidates.length > 0 && (
        <fieldset className="vote-choices">
          <legend>Personröst, om du vill</legend>
          <label className="vote-option">
            <input
              type="radio"
              name={`kandidat-${ballotId}`}
              value=""
              checked={candidate === ''}
              onChange={() => onSelectCandidate('')}
            />
            <span>Ingen personröst</span>
          </label>
          {selected.candidates.map((person) => (
            <label key={person.id} className="vote-option">
              <input
                type="radio"
                name={`kandidat-${ballotId}`}
                value={person.id}
                checked={candidate === person.id}
                onChange={() => onSelectCandidate(person.id)}
              />
              <span>{person.name}</span>
            </label>
          ))}
        </fieldset>
      )}

      {error && (
        <div className="notice danger" role="alert" style={{ marginTop: '0.75rem' }}>
          {error}
        </div>
      )}

      <div className="button-row" style={{ marginTop: '1rem' }}>
        <button type="button" disabled={!party} onClick={onSeal}>
          Lägg rösten
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Avbryt
        </button>
      </div>
    </>
  )
}

export default function VotePage() {
  return (
    <main className="narrow">
      <VoteContent />
    </main>
  )
}
