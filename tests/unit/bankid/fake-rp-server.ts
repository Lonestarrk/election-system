import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { createPrivateKey, type KeyObject, type X509Certificate } from 'node:crypto'
import { issueCertificate, issuerFrom } from '@/modules/eligibility/bankid/mock-ca/issue-certificate'
import {
  derOid,
  derPrintableString,
  derSequence,
  derSet,
  derUtf8String,
} from '@/modules/eligibility/bankid/mock-ca/der-encoder'
import { rsaKeys } from './forged-certificates'

/**
 * EN FALSK RP-SERVER FÖR BANKID:S API, MED ÖMSESIDIG TLS (uppgift 17c).
 *
 * Servern har ett eget servercertifikat under en egen "SSL-rot", och kräver ett
 * klientcertifikat under en egen "RP-CA", som BankID:s server gör. Klienten
 * prövas alltså över riktig TLS, med förankringen och klientcertifikatet på
 * riktigt, och bara adressen och rötterna är testets.
 */

const VALIDITY = { notBefore: new Date('2020-01-01T00:00:00Z'), notAfter: new Date('2046-01-01T00:00:00Z') }

/** Ett namn med attributen i den ordning de står i certifikatet, som BankID:s RP-certifikat. */
export function encodeOrderedName(attributes: Array<[oid: string, value: string, printable?: boolean]>): Buffer {
  return derSequence(
    ...attributes.map(([oid, value, printable]) =>
      derSet(derSequence(derOid(oid), printable ? derPrintableString(value) : derUtf8String(value))),
    ),
  )
}

export type Authority = { certificate: X509Certificate; privateKey: KeyObject; pem: string }

/** En självsignerad CA. */
export function authority(label: string, commonName: string): Authority {
  const keys = rsaKeys(`ca ${label}`)
  const name = encodeOrderedName([
    ['2.5.4.10', 'Testens utfärdare'],
    ['2.5.4.3', commonName],
  ])
  const certificate = issueCertificate({
    subject: name,
    publicKey: keys.publicKey,
    issuer: { name, privateKey: keys.privateKey },
    ...VALIDITY,
    ca: true,
    keyUsage: ['keyCertSign', 'cRLSign'],
  })
  return { certificate, privateKey: keys.privateKey, pem: certificate.toString() }
}

export type Credential = { certificate: X509Certificate; keyPem: string; certPem: string }

/** Ett löv under `issuer`, med ett färdigkodat namn. */
export function leafUnder(
  issuer: Authority,
  label: string,
  subject: Buffer,
  options: { notAfter?: Date } = {},
): Credential {
  const keys = rsaKeys(`löv ${label}`)
  const certificate = issueCertificate({
    subject,
    publicKey: keys.publicKey,
    issuer: issuerFrom(issuer.certificate, issuer.privateKey),
    notBefore: VALIDITY.notBefore,
    notAfter: options.notAfter ?? VALIDITY.notAfter,
    ca: false,
    keyUsage: ['digitalSignature', 'keyEncipherment'],
  })
  return {
    certificate,
    certPem: certificate.toString(),
    keyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/** Servercertifikatet för localhost. Node prövar CN när certifikatet saknar subjectAltName. */
export function serverCredential(issuer: Authority, host = 'localhost'): Credential {
  return leafUnder(issuer, `server ${host} ${issuer.certificate.fingerprint256}`, encodeOrderedName([['2.5.4.3', host]]))
}

/** RP-certifikatets namn, som BankID:s testcertifikat: C, O, serialNumber, name, CN. */
export const RP_SUBJECT = encodeOrderedName([
  ['2.5.4.6', 'SE', true],
  ['2.5.4.10', 'Testbank A AB (publ)'],
  ['2.5.4.5', '5566304928', true],
  ['2.5.4.41', 'Test av BankID'],
  ['2.5.4.3', 'FP Testcert 5'],
])

export function rpCredential(issuer: Authority, label = 'rp'): Credential {
  return leafUnder(issuer, label, RP_SUBJECT)
}

/** Den privata nyckeln krypterad med en fras, som i BankID:s PEM-fil för test. */
export function encryptedKeyPem(credential: Credential, passphrase: string): string {
  return createPrivateKey(credential.keyPem)
    .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase })
    .toString()
}

export type RecordedRequest = {
  method: string
  path: string
  contentType: string | undefined
  body: string
  clientCertificateFingerprint: string | null
}

export type Reply = { status: number; body?: unknown; raw?: string | Buffer; delayMs?: number; hang?: boolean }

export type FakeRpServer = {
  url: string
  requests: RecordedRequest[]
  /** Svaret på nästa anrop till en metod. Står det flera i kön tas de i tur och ordning. */
  reply(method: string, ...replies: Reply[]): void
  /** Tömmer köerna och listan över anrop, så att inget svar läcker till nästa test. */
  reset(): void
  close(): Promise<void>
}

/**
 * Startar servern på en slumpad port. `clientAuthorities` är de RP-CA som servern
 * godtar klientcertifikat från.
 */
export async function startFakeRpServer(options: {
  server: Credential
  clientAuthorities: Authority[]
}): Promise<FakeRpServer> {
  const queues = new Map<string, Reply[]>()
  const requests: RecordedRequest[] = []
  const hanging = new Set<ServerResponse>()

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const socket = request.socket as TLSSocket
      const peer = socket.getPeerCertificate()
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
        clientCertificateFingerprint: peer && 'fingerprint256' in peer ? peer.fingerprint256 : null,
      })

      const method = (request.url ?? '').replace(/^\/rp\/v6\.0\//, '')
      const reply = queues.get(method)?.shift() ?? { status: 404, raw: '' }

      const send = () => {
        if (reply.hang) {
          hanging.add(response)
          return
        }
        const payload = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body))
        response.writeHead(reply.status, { 'Content-Type': 'application/json' })
        response.end(payload)
      }
      if (reply.delayMs) setTimeout(send, reply.delayMs)
      else send()
    })
  }

  const server: Server = createServer(
    {
      key: options.server.keyPem,
      cert: options.server.certPem,
      ca: options.clientAuthorities.map((entry) => entry.pem),
      requestCert: true,
      rejectUnauthorized: true,
    },
    handle,
  )

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `https://localhost:${port}/rp/v6.0/`,
    requests,
    reply(method, ...replies) {
      queues.set(method, [...(queues.get(method) ?? []), ...replies])
    },
    reset() {
      queues.clear()
      requests.length = 0
    },
    async close() {
      for (const response of hanging) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
