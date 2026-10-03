import { Agent, request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { X509Certificate } from 'node:crypto'
import { requestErrorMessage } from '@/lib/bankid-messages'
import { ORDER_LIFETIME_MS } from '@/lib/order-state'
import { computeQrData, QR_ORDER_LIFETIME_SECONDS } from './qr'
import type { RpTlsCredentials } from './rp-certificate'
import type {
  BankIdAuthOrder,
  BankIdAuthRequest,
  BankIdCollectResult,
  BankIdQrData,
  IBankIdService,
  SignRequest,
} from './IBankIdService'

/**
 * KLIENTEN MOT BANKID:S RP API v6.0 (uppgift 17c).
 *
 * Källa: developers.bankid.com/api-references/auth--sign (auth, sign, collect,
 * cancel) och /api-references/errors, hämtade 2026-10-03.
 *
 * ÖMSESIDIG TLS MED FÖRANKRAD SERVERROT. Klienten legitimerar sig med
 * RP-certifikatet (./rp-certificate.ts) och litar bara på de serverrötter den får,
 * i drift BankID:s egen rot för BANKID_ENV (./bankid-environment.ts). När `ca`
 * anges i Node ersätter den systemets CA-lager helt, så en server med ett
 * certifikat från en vanlig webb-CA godtas inte, och inte heller BankID:s andra
 * miljö. Servernamnet prövas mot certifikatet som vanligt, och TLS 1.2 är golvet.
 *
 * VAD SOM SKICKAS. auth och sign bär `endUserIp` och texterna, base64 av UTF-8,
 * som BankID kräver. `collect` och `cancel` bär bara `orderRef` (14e). Inget
 * personnummer skickas någonsin (Secure Start).
 *
 * VAD SOM SPARAS. `qrStartToken` och `qrStartSecret` hålls i processens minne,
 * per order, så att QR-koden kan räknas fram varje sekund på servern. Hemligheten
 * lämnar aldrig servern, se ./qr.ts. Ordern glöms när collect ger ett slutligt
 * svar, när den avbryts och när orderns livslängd har gått.
 *
 * FELKODERNA, SOM BANKID REKOMMENDERAR (errors-sidan):
 *   maintenance (503)                prövas igen, högst `maintenanceRetries` gånger,
 *                                    utan att väljaren märker det, sedan RFA5
 *   requestTimeout, internalError    inget automatiskt omförsök, RFA5
 *   alreadyInProgress                RFA4
 *   invalidParameters, unauthorized, ett fel i systemet och inget BankID-fel: RFA22,
 *   notFound, okänd kod              inget omförsök
 * Ett nätverksfel eller en tidsgräns efter att anslutningen var klar prövas inte
 * igen: en auth eller sign som gick fram men vars svar försvann hade annars blivit
 * två ordrar. En anslutning som aldrig blev klar inom `connectTimeoutMs` prövas
 * däremot igen, högst `connectRetries` gånger, eftersom ingenting har skickats.
 * Det syntes mot testmiljön 2026-10-04, där ungefär var tredje första anslutning
 * från en ny process hängde sig i handskakningen.
 * BankID:s `details` når aldrig väljaren och loggas inte.
 */

export type BankIdRpClientOptions = {
  /** RP API:ets bas, med avslutande snedstreck, till exempel https://appapi2.test.bankid.com/rp/v6.0/. */
  baseUrl: string
  /** Serverrötterna klienten litar på, i PEM. Systemets CA-lager används aldrig. */
  serverRoots: string[]
  /** RP-certifikatet, se ./rp-certificate.ts. */
  credentials: RpTlsCredentials
  /** Tidsgräns per anrop. */
  requestTimeoutMs?: number
  /** Tidsgräns för att få en färdig TLS-anslutning. Ingenting har skickats innan den. */
  connectTimeoutMs?: number
  /** Hur många gånger en anslutning som aldrig blev klar prövas igen. */
  connectRetries?: number
  /** Hur många gånger ett maintenance-svar prövas igen. */
  maintenanceRetries?: number
  retryDelayMs?: number
  /** Största svar som läses. Ett svar med underskrift och spärrsvar är omkring 40 KiB. */
  maxResponseBytes?: number
  now?: () => number
  /**
   * Anropas med underskriften när collect ger `complete`. Bara för att fånga en
   * riktig underskrift som testfall i BankID:s testmiljö, se ./signature-capture.ts.
   */
  onComplete?: (completion: { signature: string; ocspResponse: string }) => void
}

/** Ett anrop till BankID som misslyckades. `userMessage` är BankID:s rekommenderade text, och inget annat. */
export class BankIdRequestError extends Error {
  constructor(
    /** BankID:s errorCode, eller network, timeout, too_large, bad_response eller invalid_end_user_ip. */
    readonly code: string,
    readonly httpStatus: number | null,
  ) {
    super(`BankID-anropet misslyckades: ${code}${httpStatus === null ? '' : ` (HTTP ${httpStatus})`}.`)
    this.name = 'BankIdRequestError'
  }

  get userMessage(): string {
    return requestErrorMessage(this.code)
  }
}

type RpOrder = { qrStartToken: string; qrStartSecret: string; startedAt: number; expiresAt: number }

/**
 * Ordrarna ligger på globalThis, som attrappens (se mock-orders.ts): dev-servern
 * laddar om modulerna, och en tabell i modulen fanns då i flera upplagor.
 */
const globalForRp = globalThis as unknown as { bankIdRpOrders?: Map<string, RpOrder> }
const orders: Map<string, RpOrder> = globalForRp.bankIdRpOrders ?? new Map<string, RpOrder>()
globalForRp.bankIdRpOrders = orders

/** Endast för tester. */
export function resetBankIdRpOrders(): void {
  orders.clear()
}

/** Ett anrop till BankID som lyckades: status 200 och en JSON-kropp. */
type Reply = Record<string, unknown>

/** BankID:s orderRef, autoStartToken och qrStartToken är UUID. Ett fält i någon annan form avvisas. */
const TOKEN = /^[0-9A-Za-z-]{1,64}$/
const PERSONAL_NUMBER = /^[0-9]{12}$/
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export class BankIdRpClient implements IBankIdService {
  private readonly base: URL
  private readonly agent: Agent
  private readonly timeoutMs: number
  private readonly maintenanceRetries: number
  private readonly connectTimeoutMs: number
  private readonly connectRetries: number
  private readonly retryDelayMs: number
  private readonly maxResponseBytes: number
  private readonly now: () => number
  private readonly onComplete: BankIdRpClientOptions['onComplete']

  constructor(options: BankIdRpClientOptions) {
    this.base = new URL(options.baseUrl)
    if (this.base.protocol !== 'https:') throw new Error('BankID:s adress måste vara https.')
    if (!this.base.pathname.endsWith('/')) throw new Error('BankID:s adress måste sluta med /.')
    if (options.serverRoots.length === 0) throw new Error('Klienten mot BankID behöver minst en förankrad rot.')
    for (const pem of options.serverRoots) {
      // En rot som inte går att läsa ska stoppa här, och inte bli en tom förankring.
      if (!new X509Certificate(pem).ca) throw new Error('En förankrad rot för BankID är ingen CA.')
    }

    this.agent = new Agent({
      ...options.credentials,
      // Ersätter systemets CA-lager. Det är förankringen.
      ca: options.serverRoots,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      keepAlive: true,
      maxSockets: 32,
    })
    this.timeoutMs = options.requestTimeoutMs ?? 10_000
    this.maintenanceRetries = options.maintenanceRetries ?? 2
    this.connectTimeoutMs = Math.min(options.connectTimeoutMs ?? 3_000, this.timeoutMs)
    this.connectRetries = options.connectRetries ?? 2
    this.retryDelayMs = options.retryDelayMs ?? 1_000
    this.maxResponseBytes = options.maxResponseBytes ?? 256 * 1024
    this.now = options.now ?? Date.now
    this.onComplete = options.onComplete
  }

  async auth(request: BankIdAuthRequest): Promise<BankIdAuthOrder> {
    return this.startOrder('auth', {
      endUserIp: this.endUserIp(request.endUserIp),
      ...(request.userVisibleData ? { userVisibleData: base64(request.userVisibleData) } : {}),
    })
  }

  async sign(request: SignRequest): Promise<BankIdAuthOrder> {
    return this.startOrder('sign', {
      endUserIp: this.endUserIp(request.endUserIp),
      userVisibleData: base64(request.userVisibleData),
      userNonVisibleData: base64(request.userNonVisibleData),
    })
  }

  async qrData(orderRef: string): Promise<BankIdQrData | null> {
    const order = this.liveOrder(orderRef)
    if (!order) return null
    const elapsedSeconds = Math.floor((this.now() - order.startedAt) / 1000)
    if (elapsedSeconds > QR_ORDER_LIFETIME_SECONDS) return null
    return { qrData: computeQrData(order.qrStartToken, order.qrStartSecret, elapsedSeconds), elapsedSeconds }
  }

  async collect(orderRef: string): Promise<BankIdCollectResult> {
    const reply = await this.call('collect', { orderRef })
    if (reply.orderRef !== orderRef) throw new BankIdRequestError('bad_response', 200)

    if (reply.status === 'pending') {
      return { status: 'pending', hintCode: hintCodeOf(reply) }
    }

    if (reply.status === 'failed') {
      orders.delete(orderRef)
      return { status: 'failed', hintCode: hintCodeOf(reply) }
    }

    if (reply.status !== 'complete') throw new BankIdRequestError('bad_response', 200)
    const completion = completionOf(reply.completionData)
    orders.delete(orderRef)

    this.onComplete?.({ signature: completion.signature, ocspResponse: completion.ocspResponse })
    return { status: 'complete', completionData: completion }
  }

  async cancel(orderRef: string): Promise<void> {
    orders.delete(orderRef)
    await this.call('cancel', { orderRef })
  }

  /**
   * endUserIp kommer från de betrodda proxyleden (src/lib/client-address.ts).
   * Utan en betrodd proxy kan det bli "okand", och BankID avvisar allt som inte är
   * en IP-adress. Då går ingenting till BankID.
   */
  private endUserIp(address: string): string {
    if (isIP(address) === 0) throw new BankIdRequestError('invalid_end_user_ip', null)
    return address
  }

  private async startOrder(method: 'auth' | 'sign', body: Record<string, string>): Promise<BankIdAuthOrder> {
    const reply = await this.call(method, body)
    const { orderRef, autoStartToken, qrStartToken, qrStartSecret } = reply
    for (const value of [orderRef, autoStartToken, qrStartToken, qrStartSecret]) {
      if (typeof value !== 'string' || !TOKEN.test(value)) throw new BankIdRequestError('bad_response', 200)
    }

    const startedAt = this.now()
    this.sweep(startedAt)
    orders.set(orderRef as string, {
      qrStartToken: qrStartToken as string,
      qrStartSecret: qrStartSecret as string,
      startedAt,
      expiresAt: startedAt + ORDER_LIFETIME_MS,
    })
    return { orderRef: orderRef as string, autoStartToken: autoStartToken as string }
  }

  private liveOrder(orderRef: string): RpOrder | undefined {
    this.sweep(this.now())
    return orders.get(orderRef)
  }

  private sweep(now: number): void {
    for (const [orderRef, order] of orders) if (order.expiresAt <= now) orders.delete(orderRef)
  }

  /** Ett anrop, med omförsök bara för maintenance och för en anslutning som aldrig blev klar. */
  private async call(method: string, body: Record<string, string>): Promise<Reply> {
    let maintenance = 0
    let connects = 0
    for (;;) {
      try {
        return await this.once(method, body)
      } catch (error) {
        if (!(error instanceof BankIdRequestError)) throw error
        if (error.code === 'connect_timeout') {
          if (connects >= this.connectRetries) throw new BankIdRequestError('timeout', null)
          connects += 1
          continue
        }
        if (error.code !== 'maintenance' || maintenance >= this.maintenanceRetries) throw error
        maintenance += 1
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * maintenance))
      }
    }
  }

  private once(method: string, body: Record<string, string>): Promise<Reply> {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const url = new URL(method, this.base)

    return new Promise<Reply>((resolve, reject) => {
      let settled = false
      const fail = (error: BankIdRequestError) => {
        if (settled) return
        settled = true
        reject(error)
      }

      const request = httpsRequest(
        url,
        {
          method: 'POST',
          agent: this.agent,
          // Exakt så: BankID svarar unsupportedMediaType på en charset efter application/json.
          headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
          timeout: this.timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > this.maxResponseBytes) {
              fail(new BankIdRequestError('too_large', response.statusCode ?? null))
              request.destroy()
              return
            }
            chunks.push(chunk)
          })
          response.on('error', () => fail(new BankIdRequestError('network', null)))
          response.on('end', () => {
            if (settled) return
            const status = response.statusCode ?? 0
            const parsed = parseJson(Buffer.concat(chunks).toString('utf8'))
            if (status === 200) {
              if (parsed === null) return fail(new BankIdRequestError('bad_response', status))
              settled = true
              return resolve(parsed)
            }
            // Felkroppen är {errorCode, details}. Utan en kod ger statusen koden, som errors-sidan.
            const code = typeof parsed?.errorCode === 'string' && /^[A-Za-z]{1,64}$/.test(parsed.errorCode)
              ? parsed.errorCode
              : codeForStatus(status)
            fail(new BankIdRequestError(code, status))
          })
        },
      )

      /**
       * Anslutningen är klar när TLS-handskakningen är det. Ett uttag som agenten
       * återanvänder är redan klart. Före det har ingenting skickats.
       */
      let connected = false
      request.on('socket', (socket) => {
        const tlsSocket = socket as TLSSocket
        if (!tlsSocket.connecting && tlsSocket.encrypted && tlsSocket.authorized) connected = true
        else tlsSocket.once('secureConnect', () => (connected = true))
      })
      const connectDeadline = setTimeout(() => {
        if (connected) return
        fail(new BankIdRequestError('connect_timeout', null))
        request.destroy()
      }, this.connectTimeoutMs)
      connectDeadline.unref?.()

      // Tidsgränsen gäller hela anropet, inte bara tystnad på uttaget.
      const deadline = setTimeout(() => {
        fail(new BankIdRequestError(connected ? 'timeout' : 'connect_timeout', null))
        request.destroy()
      }, this.timeoutMs)
      deadline.unref?.()

      request.on('timeout', () => {
        fail(new BankIdRequestError(connected ? 'timeout' : 'connect_timeout', null))
        request.destroy()
      })
      request.on('error', () => fail(new BankIdRequestError('network', null)))
      request.on('close', () => {
        clearTimeout(deadline)
        clearTimeout(connectDeadline)
      })
      request.end(payload)
    })
  }
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function parseJson(text: string): Reply | null {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Reply) : null
  } catch {
    return null
  }
}

function codeForStatus(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return 'unauthorized'
    case 404:
      return 'notFound'
    case 405:
      return 'methodNotAllowed'
    case 408:
      return 'requestTimeout'
    case 415:
      return 'unsupportedMediaType'
    case 500:
      return 'internalError'
    case 503:
      return 'maintenance'
    default:
      return 'unknown'
  }
}

function hintCodeOf(reply: Reply): string {
  // En kod i en annan form blir en okänd kod, som får BankID:s text för okända koder.
  return typeof reply.hintCode === 'string' && /^[A-Za-z]{1,64}$/.test(reply.hintCode) ? reply.hintCode : 'unknown'
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new BankIdRequestError('bad_response', 200)
  return value
}

function strictBase64Text(value: unknown, max: number, allowEmpty: boolean): string {
  const text = boundedString(value, max)
  if ((!allowEmpty && text.length === 0) || !BASE64.test(text)) throw new BankIdRequestError('bad_response', 200)
  return text
}

function completionOf(value: unknown): Extract<BankIdCollectResult, { status: 'complete' }>['completionData'] {
  if (value === null || typeof value !== 'object') throw new BankIdRequestError('bad_response', 200)
  const data = value as Record<string, unknown>
  const user = data.user
  if (user === null || typeof user !== 'object') throw new BankIdRequestError('bad_response', 200)
  const person = user as Record<string, unknown>

  const personalNumber = boundedString(person.personalNumber, 12)
  if (!PERSONAL_NUMBER.test(personalNumber)) throw new BankIdRequestError('bad_response', 200)

  return {
    personalNumber,
    name: boundedString(person.name, 256),
    givenName: boundedString(person.givenName, 256),
    surname: boundedString(person.surname, 256),
    // Taken i läggningen gäller det avkodade, se pending-vote.service.ts. Här räcker ett tak mot orimligt.
    signature: strictBase64Text(data.signature, 128 * 1024, false),
    ocspResponse: strictBase64Text(data.ocspResponse, 64 * 1024, true),
  }
}
