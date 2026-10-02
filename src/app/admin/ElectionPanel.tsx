'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { messageOf, post, type ApiResult } from './api'
import { CertifyStep } from './CertifyStep'
import { CloseStep } from './CloseStep'
import { DemoReset } from './DemoReset'
import { PhaseSteps } from './PhaseSteps'
import { Results } from './Results'
import { TallyStep } from './TallyStep'
import type {
  CloseView,
  ContributionResult,
  ElectionOverview,
  FinalCheckReport,
  FinalCheckView,
  Notice,
  ResultsView,
  ValidationSummary,
} from './types'

/** Hur ofta sidan frågar efter slutkontrollens resultat medan den pågår. */
const POLL_MS = 2000

/**
 * Avslutningen av en omröstning, från stängningen till fastställandet
 * (uppgift 12c).
 *
 * SERVERN ÄR AUKTORITETEN. Sidan läser omröstningens fas från servern vid
 * start och efter varje åtgärd, och visar bara det den fick. Den drar aldrig
 * slutsatsen att ett steg är klart av att ett klick gick bra: svaret på
 * klicket visas som det är, och fasen läses om.
 *
 * Ingenting här är per väljare. Sidan får bara antal, rötter och summor.
 */
export function ElectionPanel({ electionId }: { electionId: string }) {
  const [overview, setOverview] = useState<ElectionOverview | null>(null)
  const [demoMode, setDemoMode] = useState(false)
  const [demoReset, setDemoReset] = useState(false)
  const [notices, setNotices] = useState<Notice[]>([])
  const [busy, setBusy] = useState(false)
  const [closeView, setCloseView] = useState<CloseView | null>(null)
  const [contributions, setContributions] = useState<Record<number, ContributionResult[]>>({})
  const [tallyMessages, setTallyMessages] = useState<ContributionResult[]>([])
  const [resultsView, setResultsView] = useState<ResultsView | null>(null)
  const [job, setJob] = useState<FinalCheckView>({ status: 'none' })
  const demoPhrases = useRef<string[] | null>(null)
  // Svar som kommer efter ett byte av omröstning hör till den förra och släpps.
  const current = useRef(electionId)
  current.current = electionId

  const say = useCallback((...next: Notice[]) => setNotices(next), [])

  const loadResults = useCallback(async (id: string) => {
    const result = await post('/api/admin/elections/results', { electionId: id })
    if (current.current !== id) return
    if (result.ok && result.data.status === 'ok') {
      setResultsView({
        phase: String(result.data.phase),
        ballots: result.data.ballots as ResultsView['ballots'],
      })
    } else {
      setResultsView(null)
    }
  }, [])

  const refresh = useCallback(async (): Promise<ElectionOverview | null> => {
    const id = electionId
    const result = await post('/api/admin/elections/state', { electionId: id })
    if (current.current !== id) return null

    if (!result.ok) {
      setOverview(null)
      say({ tone: 'danger', text: messageOf(result, 'Omröstningens läge kunde inte läsas.') })
      return null
    }

    const next = result.data.overview as ElectionOverview
    setOverview(next)
    setDemoMode(result.data.demoMode === true)
    setDemoReset(result.data.demoReset === true)

    if (next.phase === 'TALLIED' || next.phase === 'CERTIFIED') await loadResults(id)
    else setResultsView(null)
    return next
  }, [electionId, loadResults, say])

  const readJob = useCallback(async (): Promise<FinalCheckView> => {
    const id = electionId
    const result = await post('/api/admin/elections/check-status', { electionId: id })
    if (current.current !== id) return { status: 'none' }

    const view = toJobView(result)
    setJob(view)
    return view
  }, [electionId])

  // Vid start och vid byte av omröstning: läs fasen och ett eventuellt pågående jobb.
  useEffect(() => {
    setOverview(null)
    setCloseView(null)
    setContributions({})
    setTallyMessages([])
    setResultsView(null)
    setJob({ status: 'none' })
    setNotices([])
    if (!electionId) return
    void refresh()
    void readJob()
  }, [electionId, refresh, readJob])

  // Medan slutkontrollen pågår: fråga om resultatet tills den är klar.
  const running = job.status === 'running'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      void readJob().then((view) => {
        if (view.status === 'none') {
          say({
            tone: 'warning',
            text:
              'Slutkontrollen finns inte kvar i servern. Den kan ha startats om, och resultatet ligger bara ' +
              'i minnet. Kör slutkontrollen igen.',
          })
        } else if (view.status === 'done') {
          say({ tone: 'success', text: 'Slutkontrollen är klar. Läs rapporten nedan.' })
        } else if (view.status === 'failed') {
          say({ tone: 'danger', text: view.message })
        }
      })
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [running, readJob, say])

  // --- Åtgärderna ------------------------------------------------------------

  async function run<T>(action: () => Promise<T>): Promise<T> {
    setBusy(true)
    try {
      return await action()
    } finally {
      setBusy(false)
    }
  }

  async function close() {
    await run(async () => {
      const result = await post('/api/admin/elections/close', { electionId })
      const view = toCloseView(result)
      setCloseView(view)

      const tone = view.status === 'closed' || view.status === 'already_closed' ? 'success' : 'warning'
      say({ tone: result.httpStatus === 0 ? 'danger' : tone, text: view.message })
      // Fasen läses om oavsett utfall, också vid in_progress och aborted.
      await refresh()
    })
  }

  async function submitContribution(trusteeIndex: number, passphrase: string) {
    if (!overview) return
    await run(async () => {
      const results: ContributionResult[] = []
      setContributions((all) => ({ ...all, [trusteeIndex]: [] }))

      for (const ballot of overview.ballots) {
        if (ballot.contributedBy.includes(trusteeIndex)) {
          results.push({
            ballotLabel: ballot.label,
            status: 'duplicate',
            message: 'Förtroendepersonen har redan lämnat sitt bidrag för valsedeln. Ingenting nytt sparades.',
          })
          continue
        }

        const result = await post('/api/admin/elections/decrypt', {
          ballotId: ballot.id,
          trusteeIndex,
          passphrase,
        })
        const status = typeof result.data.status === 'string' ? result.data.status : 'error'
        results.push({
          ballotLabel: ballot.label,
          status,
          message: messageOf(result, 'Bidraget kunde inte lämnas.'),
        })
        setContributions((all) => ({ ...all, [trusteeIndex]: [...results] }))

        // Ett bidrag som inte gick igenom stoppar resten. En fel fras ska inte prövas tre gånger.
        if (status !== 'accepted' && status !== 'duplicate') break
      }

      setContributions((all) => ({ ...all, [trusteeIndex]: results }))
      const last = results[results.length - 1]
      say({
        tone: results.every((entry) => entry.status === 'accepted' || entry.status === 'duplicate') ? 'success' : 'warning',
        text: `Förtroendeperson ${trusteeIndex}: ${last ? `${last.ballotLabel}: ${last.message}` : 'inga valsedlar att lämna bidrag för.'}`,
      })
      await refresh()
    })
  }

  async function tally() {
    if (!overview) return
    await run(async () => {
      const results: ContributionResult[] = []
      setTallyMessages([])

      for (const ballot of overview.ballots) {
        if (ballot.tallied) {
          results.push({ ballotLabel: ballot.label, status: 'tallied', message: 'Valsedeln är redan räknad.' })
          continue
        }
        const result = await post('/api/admin/elections/tally', { ballotId: ballot.id })
        const status = typeof result.data.status === 'string' ? result.data.status : 'error'
        results.push({ ballotLabel: ballot.label, status, message: messageOf(result, 'Räkningen kunde inte slutföras.') })
        setTallyMessages([...results])
        if (status !== 'tallied') break
      }

      const failed = results.find((entry) => entry.status !== 'tallied')
      say(
        failed
          ? { tone: 'warning', text: `${failed.ballotLabel}: ${failed.message}` }
          : { tone: 'success', text: 'Servern har räknat valsedlarna. Fasen läses nu om.' },
      )
      await refresh()
    })
  }

  async function fillDemoPhrase(trusteeIndex: number): Promise<string | null> {
    if (!demoPhrases.current) {
      const result = await post('/api/demo/trustee-passphrases', {})
      const phrases = result.data.passphrases
      if (!result.ok || !Array.isArray(phrases)) {
        say({ tone: 'danger', text: messageOf(result, 'Demofrasen kunde inte hämtas.') })
        return null
      }
      demoPhrases.current = phrases as string[]
    }
    return demoPhrases.current[trusteeIndex - 1] ?? null
  }

  async function runCheck() {
    await run(async () => {
      const result = await post('/api/admin/elections/check', { electionId })
      const status = result.data.status
      if (result.httpStatus === 202 && (status === 'started' || status === 'already_running')) {
        setJob({ status: 'running', startedAt: new Date().toISOString() })
        say({ tone: 'info', text: messageOf(result, 'Slutkontrollen har startat.') })
      } else {
        say({ tone: 'danger', text: messageOf(result, 'Slutkontrollen kunde inte startas.') })
      }
    })
  }

  async function certify() {
    await run(async () => {
      const result = await post('/api/admin/elections/certify', { electionId })
      const report = result.data.report as FinalCheckReport | undefined
      if (report) setJob({ status: 'done', report })

      const status = result.data.status
      const tone = status === 'certified' || status === 'already_certified' ? 'success' : status === 'blocked' ? 'danger' : 'warning'
      say({ tone: result.httpStatus === 0 || result.httpStatus === 500 ? 'danger' : tone, text: messageOf(result, 'Fastställandet kunde inte slutföras.') })
      // Fasen läses om. Sidan säger aldrig själv att resultatet blev fastställt.
      await refresh()
    })
  }

  async function resetDemo() {
    await run(async () => {
      const result = await post('/api/demo/reset-election', { electionId })
      say({ tone: result.ok ? 'success' : 'danger', text: messageOf(result, 'Demovalet kunde inte återställas.') })
      if (result.ok) {
        setCloseView(null)
        setContributions({})
        setTallyMessages([])
        setJob({ status: 'none' })
      }
      await refresh()
    })
  }

  if (!overview) {
    return (
      <div role="status" aria-live="polite" className="stack">
        {notices.length === 0 && <p className="muted">Läser omröstningens läge från servern …</p>}
        {notices.map((notice, index) => (
          <div key={index} className={`notice ${notice.tone}`}>{notice.text}</div>
        ))}
      </div>
    )
  }

  return (
    <div className="stack">
      <section className="card" aria-labelledby="phase-heading">
        <h2 id="phase-heading">{overview.name}</h2>
        <PhaseSteps phase={overview.phase} />
        <p className="muted small" style={{ marginTop: '0.75rem' }}>
          Fasen läses från servern vid start och efter varje åtgärd. Bara nästa tillåtna steg har en aktiv knapp.
        </p>
        {overview.underReview && (
          <div className="notice danger" style={{ marginTop: '0.75rem' }}>
            <strong>Omröstningen är markerad som avvikande (UNDER_REVIEW). Fastställandet är stoppat.</strong>{' '}
            Avvikelsen kräver granskning.
          </div>
        )}
        {!['OPEN', 'CLOSED', 'VALIDATED', 'STRIPPED', 'TALLIED', 'CERTIFIED'].includes(overview.phase) && (
          <div className="notice danger" style={{ marginTop: '0.75rem' }}>
            Fasen {overview.phase} är ingen av specens faser. Ingenting kan göras härifrån.
          </div>
        )}
      </section>

      {/* Alla besked kommer hit. Regionen finns alltid, så att en skärmläsare hör ändringen. */}
      <div role="status" aria-live="polite" className="stack" style={{ gap: '0.5rem' }}>
        {notices.map((notice, index) => (
          <div key={index} className={`notice ${notice.tone}`}>{notice.text}</div>
        ))}
      </div>

      <CloseStep overview={overview} closeView={closeView} busy={busy} onClose={() => void close()} />

      <TallyStep
        overview={overview}
        demoMode={demoMode}
        busy={busy}
        results={contributions}
        tallyMessages={tallyMessages}
        onSubmit={submitContribution}
        onTally={() => void tally()}
        onFillDemo={fillDemoPhrase}
      />

      {resultsView && <Results view={resultsView} certified={overview.phase === 'CERTIFIED'} />}

      <CertifyStep
        overview={overview}
        job={job}
        busy={busy}
        onRunCheck={() => void runCheck()}
        onCertify={() => void certify()}
      />

      {demoReset && <DemoReset busy={busy} onReset={() => void resetDemo()} />}
    </div>
  )
}

/** Stängningens svar som sidan visar det. Serverns `message` används ordagrant. */
function toCloseView(result: ApiResult): CloseView {
  const data = result.data
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
  const list = (value: unknown) => (Array.isArray(value) ? (value as string[]) : undefined)

  return {
    status: text(data.status) ?? 'error',
    httpStatus: result.httpStatus,
    message: messageOf(result, 'Stängningen gav inget besked.'),
    moved: typeof data.moved === 'number' ? data.moved : undefined,
    cleared: typeof data.cleared === 'number' ? data.cleared : undefined,
    envelopeRoot: text(data.envelopeRoot),
    urnRoot: text(data.urnRoot),
    residueRemoved: list(data.residueRemoved),
    urnRowsReplaced: list(data.urnRowsReplaced),
    summary: data.summary as ValidationSummary | undefined,
    ciphertextHash: text(data.ciphertextHash),
  }
}

function toJobView(result: ApiResult): FinalCheckView {
  const data = result.data
  if (!result.ok) return { status: 'none' }
  if (data.status === 'running') return { status: 'running', startedAt: String(data.startedAt ?? '') }
  if (data.status === 'done') return { status: 'done', report: data.report as FinalCheckReport }
  if (data.status === 'failed') return { status: 'failed', message: String(data.message ?? 'Slutkontrollen misslyckades.') }
  return { status: 'none' }
}
