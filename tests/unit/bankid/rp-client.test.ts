import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  BankIdRequestError,
  BankIdRpClient,
  type BankIdRpClientOptions,
  resetBankIdRpOrders,
} from '@/modules/eligibility/bankid/BankIdRpClient'
import { computeQrData } from '@/modules/eligibility/bankid/qr'
import { RFA } from '@/lib/bankid-messages'
import {
  authority,
  encryptedKeyPem,
  rpCredential,
  serverCredential,
  startFakeRpServer,
  type FakeRpServer,
} from './fake-rp-server'

/**
 * KLIENTEN MOT BANKID:S RP API v6.0 (uppgift 17c).
 *
 * Varje test kör klienten mot en falsk RP-server över ömsesidig TLS: servern har
 * ett servercertifikat under en egen SSL-rot och kräver ett klientcertifikat
 * under en egen RP-CA. Förankringen, klientcertifikatet och felkoderna prövas
 * alltså på riktigt, och bara adressen och rötterna är testets.
 */

const SSL_ROOT = authority('ssl', 'Testens SSL-rot')
const OTHER_ROOT = authority('annan-ssl', 'En annan SSL-rot')
const RP_CA = authority('rp-ca', 'Testens RP-CA')
const OTHER_RP_CA = authority('annan-rp-ca', 'En annan RP-CA')
const RP = rpCredential(RP_CA)
const PASSPHRASE = 'qwerty123'

const ORDER = {
  orderRef: '131daac9-16c6-4618-beb0-365768f37288',
  autoStartToken: '7c40b5c9-fa74-49cf-b98c-bfe651f9a7c6',
  qrStartToken: '67df3917-fa0d-44e5-b327-edcc928297f8',
  qrStartSecret: 'd28db9a7-4cde-429e-a983-359be676944c',
}

const COMPLETE = {
  orderRef: ORDER.orderRef,
  status: 'complete',
  completionData: {
    user: { personalNumber: '200001012384', name: 'Alex Johnson', givenName: 'Alex', surname: 'Johnson' },
    device: { ipAddress: '192.0.2.1', uhi: 'OZvYM9VvyiAmG7NA5jU5zqGcVpo=' },
    bankIdIssueDate: '2023-04-01Z',
    signature: Buffer.from('<Signature></Signature>').toString('base64'),
    ocspResponse: Buffer.from('ocsp').toString('base64'),
  },
}

let server: FakeRpServer

function client(overrides: Partial<BankIdRpClientOptions> = {}): BankIdRpClient {
  return new BankIdRpClient({
    baseUrl: server.url,
    serverRoots: [SSL_ROOT.pem],
    credentials: { cert: RP.certPem, key: encryptedKeyPem(RP, PASSPHRASE), passphrase: PASSPHRASE },
    requestTimeoutMs: 2_000,
    retryDelayMs: 10,
    ...overrides,
  })
}

async function failure(promise: Promise<unknown>): Promise<BankIdRequestError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(BankIdRequestError)
    return error as BankIdRequestError
  }
  throw new Error('anropet skulle ha misslyckats')
}

beforeAll(async () => {
  server = await startFakeRpServer({ server: serverCredential(SSL_ROOT), clientAuthorities: [RP_CA] })
})

afterAll(async () => {
  await server.close()
})

beforeEach(() => {
  server.reset()
  resetBankIdRpOrders()
})

describe('auth och sign', () => {
  it('auth skickar endUserIp och texten base64-kodad, som JSON, och lämnar inte ut qrStartSecret', async () => {
    server.reply('auth', { status: 200, body: ORDER })

    const order = await client().auth({ endUserIp: '192.0.2.1', userVisibleData: 'Legitimering för att rösta' })

    expect(order).toEqual({ orderRef: ORDER.orderRef, autoStartToken: ORDER.autoStartToken })
    expect(JSON.stringify(order)).not.toContain(ORDER.qrStartSecret)

    const [request] = server.requests
    expect(request!.method).toBe('POST')
    expect(request!.path).toBe('/rp/v6.0/auth')
    // BankID avvisar charset efter application/json (unsupportedMediaType).
    expect(request!.contentType).toBe('application/json')
    expect(JSON.parse(request!.body)).toEqual({
      endUserIp: '192.0.2.1',
      userVisibleData: Buffer.from('Legitimering för att rösta', 'utf8').toString('base64'),
    })
    expect(request!.clientCertificateFingerprint).toBe(RP.certificate.fingerprint256)
  })

  it('sign base64-kodar båda fälten som UTF-8, och skickar inget annat', async () => {
    server.reply('sign', { status: 200, body: ORDER })

    await client().sign({
      endUserIp: '2001:db8::1',
      userVisibleData: 'Jag lägger min röst i Valet 2026',
      userNonVisibleData: '19:valsystem/kuvert/v2|åäö',
    })

    expect(JSON.parse(server.requests[0]!.body)).toEqual({
      endUserIp: '2001:db8::1',
      userVisibleData: Buffer.from('Jag lägger min röst i Valet 2026', 'utf8').toString('base64'),
      userNonVisibleData: Buffer.from('19:valsystem/kuvert/v2|åäö', 'utf8').toString('base64'),
    })
  })

  it('en endUserIp som inte är en IP-adress går aldrig till BankID', async () => {
    const error = await failure(client().auth({ endUserIp: 'okand' }))

    expect(error.code).toBe('invalid_end_user_ip')
    expect(error.userMessage).toBe(RFA.RFA22)
    expect(server.requests).toHaveLength(0)
  })

  it('QR-koden räknas ur qrStartToken och qrStartSecret, på servern', async () => {
    server.reply('auth', { status: 200, body: ORDER })
    let now = 1_000_000
    const rp = client({ now: () => now })

    await rp.auth({ endUserIp: '192.0.2.1' })
    now += 3_400

    expect(await rp.qrData(ORDER.orderRef)).toEqual({
      qrData: computeQrData(ORDER.qrStartToken, ORDER.qrStartSecret, 3),
      elapsedSeconds: 3,
    })
    expect(await rp.qrData('okänd')).toBeNull()

    now += 60_000
    expect(await rp.qrData(ORDER.orderRef)).toBeNull()
  })

  it('ett svar utan orderRef eller med fel form avvisas', async () => {
    server.reply('auth', { status: 200, body: { ...ORDER, orderRef: undefined } })
    expect((await failure(client().auth({ endUserIp: '192.0.2.1' }))).code).toBe('bad_response')

    server.reply('auth', { status: 200, raw: 'inte json' })
    expect((await failure(client().auth({ endUserIp: '192.0.2.1' }))).code).toBe('bad_response')

    server.reply('auth', { status: 200, body: { ...ORDER, qrStartSecret: 42 } })
    expect((await failure(client().auth({ endUserIp: '192.0.2.1' }))).code).toBe('bad_response')
  })
})

describe('collect och cancel', () => {
  it('collect skickar bara orderRef', async () => {
    server.reply('collect', { status: 200, body: { orderRef: ORDER.orderRef, status: 'pending', hintCode: 'userSign' } })

    expect(await client().collect(ORDER.orderRef)).toEqual({ status: 'pending', hintCode: 'userSign' })
    expect(JSON.parse(server.requests[0]!.body)).toEqual({ orderRef: ORDER.orderRef })
    expect(server.requests[0]!.path).toBe('/rp/v6.0/collect')
  })

  it('complete lämnar personen, underskriften och spärrsvaret, och glömmer QR-hemligheten', async () => {
    server.reply('auth', { status: 200, body: ORDER })
    server.reply('collect', { status: 200, body: COMPLETE })
    const rp = client()

    await rp.auth({ endUserIp: '192.0.2.1' })
    const result = await rp.collect(ORDER.orderRef)

    expect(result).toEqual({
      status: 'complete',
      completionData: {
        personalNumber: '200001012384',
        name: 'Alex Johnson',
        givenName: 'Alex',
        surname: 'Johnson',
        signature: COMPLETE.completionData.signature,
        ocspResponse: COMPLETE.completionData.ocspResponse,
      },
    })
    expect(await rp.qrData(ORDER.orderRef)).toBeNull()
  })

  it('failed lämnar hintCode, och ett svar för en annan order avvisas', async () => {
    server.reply('collect', { status: 200, body: { orderRef: ORDER.orderRef, status: 'failed', hintCode: 'userCancel' } })
    expect(await client().collect(ORDER.orderRef)).toEqual({ status: 'failed', hintCode: 'userCancel' })

    server.reply('collect', { status: 200, body: { orderRef: 'en-annan', status: 'pending', hintCode: 'userSign' } })
    expect((await failure(client().collect(ORDER.orderRef))).code).toBe('bad_response')
  })

  it('ett personnummer som inte är tolv siffror, eller en underskrift som inte är base64, avvisas', async () => {
    const withUser = (user: object) => ({ ...COMPLETE, completionData: { ...COMPLETE.completionData, user } })
    server.reply('collect', { status: 200, body: withUser({ ...COMPLETE.completionData.user, personalNumber: '20000101-2384' }) })
    expect((await failure(client().collect(ORDER.orderRef))).code).toBe('bad_response')

    server.reply('collect', {
      status: 200,
      body: { ...COMPLETE, completionData: { ...COMPLETE.completionData, signature: 'inte base64!' } },
    })
    expect((await failure(client().collect(ORDER.orderRef))).code).toBe('bad_response')
  })

  it('cancel skickar orderRef och glömmer QR-hemligheten', async () => {
    server.reply('auth', { status: 200, body: ORDER })
    server.reply('cancel', { status: 200, body: {} })
    const rp = client()

    await rp.auth({ endUserIp: '192.0.2.1' })
    await rp.cancel(ORDER.orderRef)

    expect(JSON.parse(server.requests[1]!.body)).toEqual({ orderRef: ORDER.orderRef })
    expect(await rp.qrData(ORDER.orderRef)).toBeNull()
  })

  it('en fångad underskrift går bara till den som fångar, aldrig till loggen', async () => {
    server.reply('collect', { status: 200, body: COMPLETE })
    const captured: unknown[] = []

    await client({ onComplete: (completion) => captured.push(completion) }).collect(ORDER.orderRef)

    expect(captured).toEqual([
      { signature: COMPLETE.completionData.signature, ocspResponse: COMPLETE.completionData.ocspResponse },
    ])
  })
})

describe('felkoderna, som BankID rekommenderar', () => {
  const error = (status: number, errorCode: string) => ({ status, body: { errorCode, details: 'från servern' } })

  it.each([
    [400, 'alreadyInProgress', RFA.RFA4],
    [400, 'invalidParameters', RFA.RFA22],
    [401, 'unauthorized', RFA.RFA22],
    [403, 'unauthorized', RFA.RFA22],
    [404, 'notFound', RFA.RFA22],
    [408, 'requestTimeout', RFA.RFA5],
    [500, 'internalError', RFA.RFA5],
    [400, 'enHeltNyKod', RFA.RFA22],
  ])('%i %s ger rätt meddelande och prövas inte igen', async (status, code, message) => {
    server.reply('auth', error(status, code), { status: 200, body: ORDER })

    const failed = await failure(client().auth({ endUserIp: '192.0.2.1' }))

    expect(failed.code).toBe(code)
    expect(failed.httpStatus).toBe(status)
    expect(failed.userMessage).toBe(message)
    // Ingen detalj från BankID når väljaren.
    expect(failed.userMessage).not.toContain('från servern')
    expect(server.requests).toHaveLength(1)
  })

  it('maintenance prövas igen utan att väljaren märker det, och sedan inte mer', async () => {
    server.reply('auth', error(503, 'maintenance'), { status: 200, body: ORDER })
    expect((await client().auth({ endUserIp: '192.0.2.1' })).orderRef).toBe(ORDER.orderRef)
    expect(server.requests).toHaveLength(2)

    server.requests.length = 0
    server.reply('collect', error(503, 'maintenance'), error(503, 'maintenance'), error(503, 'maintenance'), error(503, 'maintenance'))
    const failed = await failure(client({ maintenanceRetries: 2 }).collect(ORDER.orderRef))
    expect(failed.code).toBe('maintenance')
    expect(failed.userMessage).toBe(RFA.RFA5)
    // Ett försök och två omförsök.
    expect(server.requests).toHaveLength(3)
  })

  it('ett svar som aldrig kommer bryts efter tidsgränsen och prövas inte igen', async () => {
    server.reply('auth', { status: 200, hang: true })
    const started = Date.now()

    const failed = await failure(client({ requestTimeoutMs: 300 }).auth({ endUserIp: '192.0.2.1' }))

    expect(failed.code).toBe('timeout')
    expect(failed.userMessage).toBe(RFA.RFA5)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(server.requests).toHaveLength(1)
  })

  it('en anslutning som aldrig blir klar prövas igen, eftersom ingenting har skickats, och sedan inte mer', async () => {
    // En server som tar emot TCP men aldrig svarar i TLS-handskakningen.
    const connections: Socket[] = []
    const silent = createNetServer((socket) => connections.push(socket))
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const { port } = silent.address() as AddressInfo
    try {
      const failed = await failure(
        client({ baseUrl: `https://localhost:${port}/rp/v6.0/`, connectTimeoutMs: 200, connectRetries: 2 }).auth({
          endUserIp: '192.0.2.1',
        }),
      )
      expect(failed.code).toBe('timeout')
      expect(failed.userMessage).toBe(RFA.RFA5)
      expect(connections).toHaveLength(3)
    } finally {
      for (const socket of connections) socket.destroy()
      await new Promise<void>((resolve) => silent.close(() => resolve()))
    }
  })

  it('ett för stort svar avvisas', async () => {
    server.reply('collect', { status: 200, raw: 'x'.repeat(300 * 1024) })
    expect((await failure(client().collect(ORDER.orderRef))).code).toBe('too_large')
  })
})

describe('förankringen och klientcertifikatet', () => {
  it('en server med ett certifikat under en annan rot godtas inte', async () => {
    const impostor = await startFakeRpServer({ server: serverCredential(OTHER_ROOT), clientAuthorities: [RP_CA] })
    try {
      impostor.reply('auth', { status: 200, body: ORDER })
      const failed = await failure(client({ baseUrl: impostor.url }).auth({ endUserIp: '192.0.2.1' }))
      expect(failed.code).toBe('network')
      expect(impostor.requests).toHaveLength(0)
    } finally {
      await impostor.close()
    }
  })

  describe('systemets CA-lager används aldrig', () => {
    const original = getCACertificates('default')
    beforeEach(() => setDefaultCACertificates([...original, OTHER_ROOT.pem]))
    afterEach(() => setDefaultCACertificates(original))

    it('också när den andra roten finns i systemets lager', async () => {
      const impostor = await startFakeRpServer({ server: serverCredential(OTHER_ROOT), clientAuthorities: [RP_CA] })
      try {
        impostor.reply('auth', { status: 200, body: ORDER })
        const failed = await failure(client({ baseUrl: impostor.url }).auth({ endUserIp: '192.0.2.1' }))
        expect(failed.code).toBe('network')
        expect(impostor.requests).toHaveLength(0)
      } finally {
        await impostor.close()
      }
    })
  })

  it('servercertifikatet ska gälla adressen', async () => {
    const wrongHost = await startFakeRpServer({
      server: serverCredential(SSL_ROOT, 'appapi2.bankid.com'),
      clientAuthorities: [RP_CA],
    })
    try {
      wrongHost.reply('auth', { status: 200, body: ORDER })
      expect((await failure(client({ baseUrl: wrongHost.url }).auth({ endUserIp: '192.0.2.1' }))).code).toBe('network')
      expect(wrongHost.requests).toHaveLength(0)
    } finally {
      await wrongHost.close()
    }
  })

  it('ett klientcertifikat som servern inte godtar ger inget svar', async () => {
    const stranger = rpCredential(OTHER_RP_CA, 'främling')
    server.reply('auth', { status: 200, body: ORDER })

    const failed = await failure(
      client({ credentials: { cert: stranger.certPem, key: stranger.keyPem } }).auth({ endUserIp: '192.0.2.1' }),
    )

    expect(failed.code).toBe('network')
    expect(server.requests).toHaveLength(0)
  })

  it('en adress som inte är https vägras redan när klienten skapas', () => {
    expect(() => client({ baseUrl: 'http://localhost:1/rp/v6.0/' })).toThrow(/https/)
  })

  it('klienten kräver minst en förankrad rot', () => {
    expect(() => client({ serverRoots: [] })).toThrow(/rot/)
  })
})
