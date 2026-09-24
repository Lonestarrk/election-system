'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DemoIdentity } from '../_components/BankIdLogin'
import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'

/**
 * BANKID-UNDERSKRIFT AV EN RÖST, INTE EN LEGITIMERING.
 *
 * Väljaren är redan inloggad. Här skriver hon under det yttre kuvertet för en
 * valsedel (spec 4.6), och det ska kännas igen från legitimeringen: samma två
 * vägar, samma QR-kod som byts varje sekund, samma knapp för att öppna appen
 * på samma enhet. Mönstret är lånat från src/app/_components/BankIdLogin.tsx,
 * men komponenten är en egen, eftersom den startar en signering mot
 * /api/vote/sign-start och frågar /api/vote/encrypted i stället för att logga
 * in. Legitimeringens komponent är orörd.
 *
 * SIDAN BYGGER INTE DET SOM SIGNERAS.
 *
 * Till /api/vote/sign-start går bara valsedelns id och chifferhashen. Servern
 * räknar själv fram räknaren och bygger texten BankID signerar. Till
 * /api/vote/encrypted går valsedeln och orderreferensen, men aldrig någon
 * signatur, något certifikat eller någon räknare: dem hämtar servern ur
 * BankID:s eget svar. Allt som ändras i det signerade ändras därför på
 * serversidan, och den här filen behöver inte följa med.
 *
 * TRE RÄTTELSER FRÅN LEGITIMERINGEN SOM MÅSTE FINNAS HÄR OCKSÅ.
 *
 *   1. `queued` är kö, inte fel. Pollningen fortsätter som vid `pending`.
 *   2. BankID-appen öppnas från en egen knapp. Efter ett `await` är gesten
 *      förbrukad, och en navigering till app-schemat blockeras då tyst.
 *   3. En fråga i taget. En överlappande pollning kan annars få "failed" för
 *      en order den första frågan redan förbrukat, och skriva över ett
 *      korrekt svar.
 *
 * Den tredje väger tyngre här än vid legitimeringen. Frågan som hämtar den
 * färdiga underskriften är också den som låter servern kontrollera varje bevis
 * i valsedeln, och det tar flera sekunder. Under den tiden får ingen ny fråga
 * gå iväg, och QR-kodens "utgången" betyder bara att ordern är förbrukad.
 */

const QR_REFRESH_MS = 1000
const COLLECT_INTERVAL_MS = 2000

type Phase = 'choose-device' | 'starting' | 'same-device' | 'other-device' | 'failed'

export type RecordedVote = { ciphertextHash: string; replaced: boolean }

type Props = {
  ballotId: string
  /** Den krypterade valsedeln, med chiffer, bevis och hash. Slumptalen finns inte kvar. */
  ballot: EncryptedBallot
  /** Demoidentiteter. Står för steget som i verkligheten sker i telefonen. */
  demoIdentities: DemoIdentity[]
  onRecorded: (vote: RecordedVote) => void
  onCancel: () => void
  onSessionExpired: () => void
  /**
   * Servern har slutat ta emot röster. Sidan raderar då det enheten sparat om
   * omröstningen, eftersom svaret är ett av de ställen där den ser att fasen
   * lämnat OPEN (spec 3.1 punkt 4).
   */
  onClosed: () => void
}

type Reply = { ok: boolean; status: number; data: Record<string, unknown> }

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)valcsrf=([^;]+)/)
  return match ? decodeURIComponent(match[1]!) : ''
}

async function post(path: string, body: unknown): Promise<Reply> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
    body: JSON.stringify(body),
  })
  let data: Record<string, unknown> = {}
  try {
    data = (await response.json()) as Record<string, unknown>
  } catch {
    // Ett svar utan kropp behandlas som ett fel nedan, efter statuskoden.
  }
  return { ok: response.ok, status: response.status, data }
}

/** Samma val som i BankIdLogin: iOS behöver universal link-varianten. */
function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
}

/**
 * Varför rösten inte lades, med serverns utfall i klartext.
 *
 * Varje besked säger att rösten INTE lades. En väljare som är osäker på om
 * hennes röst gick in ska kunna läsa det direkt, och inte behöva gissa.
 *
 * `closed` står inte här. Det lämnas till sidan, som raderar det enheten
 * sparat och säger att röstningen har stängt; se `onClosed`.
 */
const OUTCOMES: Record<string, string> = {
  stale_sequence:
    'En nyare röst har redan lagts på den här valsedeln, kanske från en annan flik. Den här ' +
    'lades inte. Ladda om sidan för att se läget.',
  invalid_proof: 'Servern kunde inte kontrollera rösten, och den lades inte. Försök igen.',
  invalid_signature:
    'Underskriften kom inte från den som är inloggad, så rösten lades inte. Bara du kan skriva ' +
    'under din röst.',
  not_eligible: 'Den här valsedeln kan inte ta emot din röst. Rösten lades inte.',
}

export function BankIdSigning({
  ballotId,
  ballot,
  demoIdentities,
  onRecorded,
  onCancel,
  onSessionExpired,
  onClosed,
}: Props) {
  const [phase, setPhase] = useState<Phase>('choose-device')
  const [message, setMessage] = useState('')
  const [qrImage, setQrImage] = useState<string | null>(null)
  const [launchUrls, setLaunchUrls] = useState<{ ios: string; other: string } | null>(null)
  const [scanned, setScanned] = useState(false)

  const orderRef = useRef<string | null>(null)
  const timers = useRef<Array<ReturnType<typeof setInterval>>>([])
  /** Om en fråga till /api/vote/encrypted är på väg. Läses också av QR-uppdateringen. */
  const collecting = useRef(false)
  /** QR-koden behövs inte när den väl är skannad. */
  const qrDone = useRef(false)
  /**
   * Om demoidentiteten valts, läst av pollningen.
   *
   * En ref och inte bara tillstånd, eftersom pollningens intervall skapades
   * före skanningen och annars bara ser värdet från då.
   */
  const scannedRef = useRef(false)

  const stopTimers = useCallback(() => {
    for (const timer of timers.current) clearInterval(timer)
    timers.current = []
  }, [])

  useEffect(() => stopTimers, [stopTimers])

  const fail = useCallback(
    (text: string) => {
      stopTimers()
      orderRef.current = null
      setPhase('failed')
      setMessage(text)
    },
    [stopTimers],
  )

  const startPolling = useCallback(
    (reference: string) => {
      // Rättelse 3: en fråga i taget. Se BankIdLogin för hur felet såg ut.
      let inFlight = false

      const collect = setInterval(async () => {
        if (orderRef.current !== reference || inFlight) return

        inFlight = true
        collecting.current = true
        let reply: Reply | null = null
        try {
          reply = await post('/api/vote/encrypted', { ballotId, orderRef: reference, ballot })
        } catch {
          // Nätet svarade inte. Ordern lever kvar hos BankID, så nästa varv
          // frågar igen, precis som vid `pending`.
          reply = null
        } finally {
          inFlight = false
          collecting.current = false
        }

        // Avbruten medan frågan var på väg.
        if (orderRef.current !== reference || !reply) return

        const { status, data } = reply

        if (status === 401) {
          stopTimers()
          orderRef.current = null
          onSessionExpired()
          return
        }

        // Hastighetsgränsen: vänta ett varv, som vid kö.
        if (status === 429) return

        // Rättelse 1: kö är inte fel, och pollningen får inte stoppas.
        if (data.status === 'pending' || data.status === 'queued') {
          setMessage(
            scannedRef.current
              ? 'Väntar på din underskrift i BankID-appen …'
              : String(data.message ?? 'Väntar på BankID …'),
          )
          return
        }

        if (data.status === 'recorded' && typeof data.ciphertextHash === 'string') {
          stopTimers()
          orderRef.current = null
          onRecorded({ ciphertextHash: data.ciphertextHash, replaced: data.replaced === true })
          return
        }

        if (data.status === 'failed') {
          fail(String(data.message ?? 'Underskriften misslyckades. Försök igen.'))
          return
        }

        // Servern tar inte emot röster längre. Det är ett besked om fasen,
        // inte bara om den här rösten, och sidan ska radera det enheten
        // sparat.
        if (data.status === 'closed') {
          stopTimers()
          orderRef.current = null
          onClosed()
          return
        }

        const outcome = typeof data.status === 'string' ? OUTCOMES[data.status] : undefined
        const error = data.error as { message?: string } | undefined
        fail(outcome ?? error?.message ?? 'Något gick fel. Din röst lades inte.')
      }, COLLECT_INTERVAL_MS)

      timers.current.push(collect)
    },
    [ballot, ballotId, fail, onClosed, onRecorded, onSessionExpired, stopTimers],
  )

  const startQrRefresh = useCallback(
    (reference: string) => {
      const refresh = setInterval(async () => {
        if (orderRef.current !== reference || qrDone.current) return

        let data: Record<string, unknown>
        try {
          ;({ data } = await post('/api/auth/bankid/qr', { orderRef: reference }))
        } catch {
          // En missad uppdatering: nästa sekund hämtas en ny kod.
          return
        }

        if (orderRef.current !== reference || qrDone.current) return

        if (data.expired) {
          /**
           * "Utgången" medan en fråga om underskriften är på väg betyder att
           * den frågan har förbrukat ordern, inte att väljaren väntat för
           * länge. Servern kontrollerar då valsedeln, och svaret kommer från
           * pollningen. Att visa "QR-koden gick ut" här hade sagt att rösten
           * misslyckats när den i själva verket höll på att läggas.
           */
          if (collecting.current) {
            qrDone.current = true
            return
          }
          fail('QR-koden gick ut innan den skannades. Försök igen.')
          return
        }

        if (typeof data.qrImage === 'string') setQrImage(data.qrImage)
      }, QR_REFRESH_MS)

      timers.current.push(refresh)
    },
    [fail],
  )

  async function start(mode: 'same-device' | 'other-device') {
    setPhase('starting')
    setMessage('Startar BankID …')
    setScanned(false)
    scannedRef.current = false
    qrDone.current = false
    setQrImage(null)

    let reply: Reply
    try {
      // Bara valsedeln och hashen. Servern bygger det som signeras.
      reply = await post('/api/vote/sign-start', { ballotId, ciphertextHash: ballot.ciphertextHash })
    } catch {
      fail('Kunde inte nå tjänsten. Din röst lades inte. Försök igen.')
      return
    }

    if (reply.status === 401) {
      onSessionExpired()
      return
    }

    if (!reply.ok) {
      const error = reply.data.error as { message?: string } | undefined
      fail(error?.message ?? 'Kunde inte starta BankID. Din röst lades inte.')
      return
    }

    const reference = String(reply.data.orderRef)
    orderRef.current = reference
    setLaunchUrls(reply.data.launchUrls as { ios: string; other: string })
    setQrImage(typeof reply.data.qrImage === 'string' ? reply.data.qrImage : null)
    setMessage('Väntar på BankID …')
    setPhase(mode)

    startPolling(reference)
    if (mode === 'other-device') startQrRefresh(reference)

    // Rättelse 2: appen öppnas inte härifrån. Gesten tog slut vid `await`
    // ovan; knappen "Öppna BankID" nedan är en ny gest.
  }

  /** Demogenväg: står för att väljaren skannar koden och skriver under i appen. */
  async function demoScan(personalNumber: string) {
    const reference = orderRef.current
    if (!reference) return
    let ok = false
    try {
      ;({ ok } = await post('/api/demo/bankid-scan', { orderRef: reference, personalNumber }))
    } catch {
      ok = false
    }
    if (!ok) return
    setScanned(true)
    scannedRef.current = true
    qrDone.current = true
    setMessage('Väntar på din underskrift i BankID-appen …')
  }

  function cancel() {
    stopTimers()
    orderRef.current = null
    onCancel()
  }

  function retry() {
    stopTimers()
    orderRef.current = null
    setPhase('choose-device')
    setMessage('')
  }

  return (
    <div className="vote-signing">
      {phase === 'choose-device' && (
        <>
          <h3>Skriv under med BankID</h3>
          <p className="small">
            Rösten är låst och klar. Den läggs när du har skrivit under. I BankID-appen står det
            &quot;Bekräfta din röst&quot;.
          </p>
          <div className="button-row">
            <button type="button" onClick={() => void start('same-device')}>
              BankID på denna enhet
            </button>
            <button type="button" className="secondary" onClick={() => void start('other-device')}>
              BankID på annan enhet
            </button>
            <button type="button" className="secondary" onClick={cancel}>
              Avbryt
            </button>
          </div>
        </>
      )}

      {phase === 'starting' && (
        <p className="muted small" role="status" aria-live="polite">
          {message}
        </p>
      )}

      {(phase === 'same-device' || phase === 'other-device') && (
        <>
          <h3>{phase === 'other-device' ? 'Skanna med BankID' : 'Öppna BankID'}</h3>

          {phase === 'other-device' && (
            <>
              <p className="muted small">
                Öppna BankID-appen på din telefon och skanna koden. Den byts varje sekund, så en
                fotograferad kod går inte att använda.
              </p>
              {qrImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qrImage}
                  alt="QR-kod för BankID"
                  width={260}
                  height={260}
                  className="vote-qr"
                />
              ) : (
                <p className="muted small">Hämtar QR-kod …</p>
              )}
            </>
          )}

          {phase === 'same-device' && launchUrls && (
            <div style={{ margin: '0.75rem 0' }}>
              <button
                type="button"
                onClick={() => {
                  // I klickhanteraren, eftersom tryckningen är gesten som låter
                  // webbläsaren öppna appen. Se rättelse 2 ovan.
                  window.location.href = isIos() ? launchUrls.ios : launchUrls.other
                }}
              >
                Öppna BankID
              </button>
            </div>
          )}

          <div className="notice info" role="status" aria-live="polite">
            {message}
          </div>

          {demoIdentities.length > 0 && !scanned && (
            <div className="notice warning" style={{ marginTop: '0.75rem' }}>
              <strong>Demonstration:</strong> ingen riktig BankID-app finns. Välj vem som skriver
              under. I verkligheten sker det här steget i din telefon, och bara du kan skriva under
              med ditt BankID. Väljer du någon annan än den som är inloggad avvisas rösten.
              <div style={{ marginTop: '0.6rem' }}>
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

          <div className="button-row" style={{ marginTop: '0.75rem' }}>
            <button type="button" className="secondary" onClick={cancel}>
              Avbryt
            </button>
          </div>
        </>
      )}

      {phase === 'failed' && (
        <>
          <div className="notice danger" role="alert">
            {message}
          </div>
          <div className="button-row" style={{ marginTop: '0.75rem' }}>
            <button type="button" onClick={retry}>
              Försök igen
            </button>
            <button type="button" className="secondary" onClick={cancel}>
              Avbryt
            </button>
          </div>
        </>
      )}
    </div>
  )
}
