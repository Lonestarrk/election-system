'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * BANKID-LEGITIMERING ENLIGT V6 (SECURE START)
 *
 * Komponenten används av både väljarens och administratörens flöde. De skiljer
 * sig bara i vilken rutt som pollas och vad som händer efteråt.
 *
 * DET FINNS INGEN RUTA FÖR PERSONNUMMER, OCH DET ÄR HELA POÄNGEN.
 *
 * BankID v6 tillåter inte längre flöden där användaren skriver in sitt
 * personnummer. Legitimeringen startas i stället av väljaren själv, på sin
 * egen enhet:
 *
 *   SAMMA ENHET — en autostart-token öppnar BankID-appen lokalt.
 *   ANNAN ENHET — en animerad QR-kod som skannas med telefonen.
 *
 * Skälet BankID anger är att en illasinnad app annars kan förmå någon att
 * signera genom att mata in ett personnummer den kommit över. Att koden eller
 * autostarten binder ordern till enheten med appen stänger det.
 *
 * TVÅ OLIKA POLLNINGSTAKTER, OCH SKILLNADEN ÄR SPECIFICERAD
 *
 * QR-koden byts varje sekund; statusen frågas var annan sekund. Koden måste
 * bytas så ofta för att en fotograferad kod ska vara död innan den hunnit
 * vidarebefordras till någon som luras att skanna den.
 */

const QR_REFRESH_MS = 1000
const COLLECT_INTERVAL_MS = 2000

export type DemoIdentity = { personalNumber: string; label: string }

type Props = {
  /** Styr texten som visas i BankID-appen. */
  purpose: 'vote' | 'admin'
  /** Rutt som pollas för status. */
  collectPath: string
  /** Extra fält som följer med varje statusanrop, t.ex. omröstningens id. */
  collectBody?: Record<string, unknown>
  /** Anropas när legitimeringen är klar. Får svarskroppen. */
  onComplete: (data: Record<string, unknown>) => void
  /**
   * Demoidentiteter. Står för det steg som i verkligheten sker i väljarens
   * telefon. Tom lista döljer panelen.
   */
  demoIdentities?: DemoIdentity[]
  /** Anropas innan starten, för att avbryta om något saknas. */
  canStart?: () => string | null
}

type Phase = 'idle' | 'choose-device' | 'same-device' | 'other-device' | 'rejected' | 'failed'

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)valcsrf=([^;]+)/)
  return match ? decodeURIComponent(match[1]!) : ''
}

async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
    body: JSON.stringify(body),
  })
  return { ok: response.ok, data: (await response.json()) as Record<string, unknown> }
}

/**
 * iOS kräver universal link-varianten av start-URL:en.
 *
 * Safari följer inte app-schemat `bankid:///` i alla sammanhang. Valet görs på
 * klienten och inte på servern: en user agent går att sätta fritt, och servern
 * ska inte gissa enhet utifrån något anroparen kontrollerar.
 */
function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
}

export function BankIdLogin({
  purpose,
  collectPath,
  collectBody = {},
  onComplete,
  demoIdentities = [],
  canStart,
}: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState('')
  const [qrImage, setQrImage] = useState<string | null>(null)
  const [launchUrls, setLaunchUrls] = useState<{ ios: string; other: string } | null>(null)
  const [scanned, setScanned] = useState(false)

  const orderRef = useRef<string | null>(null)
  const timers = useRef<Array<ReturnType<typeof setInterval>>>([])

  const stopTimers = useCallback(() => {
    for (const timer of timers.current) clearInterval(timer)
    timers.current = []
  }, [])

  useEffect(() => stopTimers, [stopTimers])

  /** Frågar efter status. Startas av båda flödena. */
  const startPolling = useCallback(
    (reference: string) => {
      const collect = setInterval(async () => {
        if (orderRef.current !== reference) return

        const { data } = await post(collectPath, { orderRef: reference, ...collectBody })

        if (data.status === 'pending') {
          // hintCode berättar var i flödet personen är. Att visa det gör
          // väntan begriplig i stället för bara långsam.
          const hints: Record<string, string> = {
            outstandingTransaction: 'Starta BankID-appen och skanna koden.',
            noClient: 'Starta BankID-appen.',
            started: 'Söker efter BankID …',
            userSign: 'Skriv din säkerhetskod i BankID-appen.',
            userMrtd: 'Läs av ditt pass eller nationella id-kort i appen.',
          }
          setMessage(hints[String(data.hintCode)] ?? 'Väntar på BankID …')
          return
        }

        /**
         * KÖ, INTE FEL — OCH DÄRFÖR FÅR POLLNINGEN INTE STOPPAS.
         *
         * Identitetshashningen är minneshård och går genom en antagningskö.
         * Är kön full svarar rutten `queued`, och då ska klienten bete sig
         * precis som vid `pending`: fortsätta fråga.
         *
         * Faller svaret i stället igenom till `failed` nedan får väljaren
         * "Legitimeringen misslyckades" och börjar om — vilket startar en ny
         * BankID-order och ökar lasten precis när den redan är för hög. Kön
         * skulle då göra läget värre än ingen kö alls.
         *
         * BankID-ordern lever kvar under väntan, så det finns ingenting att
         * göra om. Väntan räknas i sekunder, inte minuter: se räkningen i
         * lib/admission-queue.ts.
         */
        if (data.status === 'queued') {
          const wait = Number(data.estimatedWaitSeconds)
          setMessage(
            Number.isFinite(wait) && wait > 0
              ? `Många legitimerar sig samtidigt. Du står i kö, cirka ${wait} sekunder kvar.`
              : String(data.message ?? 'Du står i kö. Sidan försöker igen automatiskt.'),
          )
          return
        }

        stopTimers()
        orderRef.current = null

        if (data.status === 'complete') {
          onComplete(data)
          return
        }

        if (data.status === 'rejected') {
          setPhase('rejected')
          setMessage(String(data.message ?? 'Du kan inte legitimera dig här.'))
          return
        }

        setPhase('failed')
        const failures: Record<string, string> = {
          userCancel: 'Du avbröt legitimeringen.',
          cancelled: 'Legitimeringen avbröts.',
          expiredTransaction: 'Legitimeringen tog för lång tid. Försök igen.',
          certificateErr: 'Ditt BankID gick inte att använda.',
          startFailed: 'BankID-appen kunde inte startas.',
        }
        setMessage(
          failures[String(data.hintCode)] ??
            String(data.message ?? 'Legitimeringen misslyckades.'),
        )
      }, COLLECT_INTERVAL_MS)

      timers.current.push(collect)
    },
    [collectBody, collectPath, onComplete, stopTimers],
  )

  /** Hämtar en ny QR-kod varje sekund. */
  const startQrRefresh = useCallback(
    (reference: string) => {
      const refresh = setInterval(async () => {
        if (orderRef.current !== reference) return

        const { data } = await post('/api/auth/bankid/qr', { orderRef: reference })

        if (data.expired) {
          stopTimers()
          orderRef.current = null
          setPhase('failed')
          setMessage('QR-koden gick ut. Försök igen.')
          return
        }

        setQrImage(String(data.qrImage))
      }, QR_REFRESH_MS)

      timers.current.push(refresh)
    },
    [stopTimers],
  )

  async function start(mode: 'same-device' | 'other-device') {
    const blocked = canStart?.()
    if (blocked) {
      setPhase('failed')
      setMessage(blocked)
      return
    }

    setMessage('Startar BankID …')
    setScanned(false)

    const { ok, data } = await post('/api/auth/bankid/start', { purpose })

    if (!ok) {
      setPhase('failed')
      setMessage(
        String((data.error as { message?: string } | undefined)?.message ?? 'Kunde inte starta BankID.'),
      )
      return
    }

    const reference = String(data.orderRef)
    orderRef.current = reference
    setLaunchUrls(data.launchUrls as { ios: string; other: string })
    setQrImage(data.qrImage ? String(data.qrImage) : null)
    setPhase(mode)

    startPolling(reference)

    if (mode === 'other-device') {
      startQrRefresh(reference)
    } else {
      // Samma enhet: öppna appen direkt. Sker i samma anropsstack som
      // knapptrycket, annars blockerar webbläsaren schemaöppningen som ett
      // popup-försök.
      const urls = data.launchUrls as { ios: string; other: string }
      window.location.href = isIos() ? urls.ios : urls.other
    }
  }

  /** Demogenväg: står för att någon skannar koden med sin BankID-app. */
  async function demoScan(personalNumber: string) {
    if (!orderRef.current) return
    await post('/api/demo/bankid-scan', { orderRef: orderRef.current, personalNumber })
    setScanned(true)
  }

  function reset() {
    stopTimers()
    orderRef.current = null
    setPhase('idle')
    setMessage('')
    setQrImage(null)
    setLaunchUrls(null)
    setScanned(false)
  }

  return (
    <div className="stack">
      {phase === 'idle' && (
        <div className="card">
          <h2>Legitimera dig med BankID</h2>
          <p className="muted small">
            Du skriver inte in något personnummer. BankID v6 tillåter inte det — du startar
            legitimeringen själv, på din egen enhet, och systemet får veta vem du är först när du
            har signerat.
          </p>
          <div className="button-row" style={{ marginTop: '1rem' }}>
            <button type="button" onClick={() => void start('same-device')}>
              BankID på denna enhet
            </button>
            <button type="button" className="secondary" onClick={() => void start('other-device')}>
              BankID på annan enhet
            </button>
          </div>
        </div>
      )}

      {(phase === 'same-device' || phase === 'other-device') && (
        <div className="card">
          <h2>{phase === 'other-device' ? 'Skanna med BankID' : 'Öppna BankID'}</h2>

          {phase === 'other-device' && (
            <>
              <p className="muted small">
                Öppna BankID-appen på din telefon och skanna koden. Den byts varje sekund — en
                fotograferad kod är död innan någon hinner skicka den vidare.
              </p>
              {qrImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qrImage}
                  alt="QR-kod för BankID"
                  width={320}
                  height={320}
                  style={{ display: 'block', margin: '1rem auto', maxWidth: '100%' }}
                />
              ) : (
                <p className="muted">Hämtar QR-kod …</p>
              )}
            </>
          )}

          {phase === 'same-device' && launchUrls && (
            <p className="muted small">
              BankID-appen ska ha öppnats. Händer inget kan du{' '}
              <a href={isIos() ? launchUrls.ios : launchUrls.other}>öppna den manuellt</a>.
            </p>
          )}

          <div className="notice info" role="status" aria-live="polite">
            {message}
          </div>

          {demoIdentities.length > 0 && !scanned && (
            <div className="notice warning" style={{ marginTop: '1rem' }}>
              <strong>Demonstration:</strong> ingen riktig BankID-app finns. Välj vem som
              &quot;skannar koden&quot; — i verkligheten sker det här steget i din telefon.
              <div style={{ marginTop: '0.75rem' }}>
                {demoIdentities.map((identity) => (
                  <button
                    key={identity.personalNumber}
                    type="button"
                    className="secondary"
                    style={{ margin: '0.2rem' }}
                    onClick={() => void demoScan(identity.personalNumber)}
                  >
                    {identity.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="button-row" style={{ marginTop: '1rem' }}>
            <button type="button" className="secondary" onClick={reset}>
              Avbryt
            </button>
          </div>
        </div>
      )}

      {(phase === 'rejected' || phase === 'failed') && (
        <div className="card">
          <div className={phase === 'rejected' ? 'notice warning' : 'notice danger'} role="alert">
            {message}
          </div>
          <div className="button-row" style={{ marginTop: '1rem' }}>
            <button type="button" className="secondary" onClick={reset}>
              Försök igen
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
