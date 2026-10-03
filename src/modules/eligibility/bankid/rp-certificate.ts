import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createSecureContext } from 'node:tls'
import { env } from '@/lib/env'
import { PUBLIC_TEST_RP_CERTIFICATE_SHA256, type BankIdEnvironment } from './bankid-environment'

/**
 * RP-CERTIFIKATET, SOM KLIENTEN LEGITIMERAR SIG MED HOS BANKID (uppgift 17c).
 *
 * BankID känner igen tjänsten på klientcertifikatet i TLS. Det läses ur
 * BANKID_CERT_PATH, låst med BANKID_CERT_PASSPHRASE, i ett av två format:
 *
 *   PKCS #12 (.p12 eller .pfx)  det BankID Keygen skapar för produktion, och
 *                               FPTestcert5_20240610.p12 för testmiljön
 *   PEM                         certifikatet och den krypterade nyckeln i samma
 *                               fil, som FPTestcert5_20240610.pem
 *
 * Certifikatets subject är också det namn som BankID skriver i srvInfo/name i
 * varje underskrift, och läsaren kräver att det är det här, se ./service-name.ts.
 *
 * Nyckeln och frasen lämnar aldrig processen och loggas inte. Ett fel säger vad
 * som är fel med filen, aldrig vad frasen är.
 */

export type RpTlsCredentials = { pfx: Buffer; passphrase: string } | { cert: string; key: string; passphrase?: string }

export type RpCredentials = {
  tls: RpTlsCredentials
  certificate: X509Certificate
}

function configurationError(problem: string): Error {
  return new Error(`BANKID_CERT_PATH: ${problem}`)
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g
const PEM_KEY = /-----BEGIN (ENCRYPTED PRIVATE KEY|PRIVATE KEY|RSA PRIVATE KEY)-----\r?\n[A-Za-z0-9+/=:,\-\s]+?-----END \1-----/g

function fromPem(text: string, passphrase: string): RpCredentials {
  const certificates = text.match(PEM_CERTIFICATE) ?? []
  const keys = text.match(PEM_KEY) ?? []
  if (certificates.length === 0) throw configurationError('filen innehåller inget certifikat.')
  if (keys.length !== 1) throw configurationError('filen ska innehålla exakt en privat nyckel.')

  let certificate: X509Certificate
  try {
    certificate = new X509Certificate(certificates[0]!)
  } catch {
    throw configurationError('certifikatet går inte att läsa.')
  }

  let privateKey
  try {
    privateKey = createPrivateKey({ key: keys[0]!, format: 'pem', passphrase })
  } catch {
    throw configurationError('nyckeln går inte att låsa upp. Kontrollera BANKID_CERT_PASSPHRASE.')
  }

  // Certifikatet och nyckeln ska höra ihop. Annars misslyckas varje anrop i TLS, med ett fel som inte säger varför.
  const fromKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const fromCertificate = certificate.publicKey.export({ type: 'spki', format: 'der' })
  if (!fromKey.equals(fromCertificate)) throw configurationError('nyckeln hör inte till certifikatet.')

  return {
    tls: { cert: certificates.join('\n'), key: keys[0]!, ...(passphrase ? { passphrase } : {}) },
    certificate,
  }
}

function fromPkcs12(pfx: Buffer, passphrase: string): RpCredentials {
  let context
  try {
    context = createSecureContext({ pfx, passphrase })
  } catch {
    throw configurationError(
      'PKCS #12-filen går inte att öppna. Kontrollera BANKID_CERT_PASSPHRASE, och att filen inte är ' +
        'den äldre -legacy.pfx, som använder algoritmer OpenSSL 3 inte läser.',
    )
  }

  /**
   * Certifikatet läses ur den TLS-kontext som OpenSSL byggde av filen, så att det
   * är samma certifikat som klienten sedan visar BankID. node:crypto har ingen
   * egen läsare för PKCS #12. `getCertificate` är inte dokumenterad, och saknas den
   * stoppar det i stället för att gissa.
   */
  const native = (context as unknown as { context?: { getCertificate?: () => Buffer | null } }).context
  const der = native?.getCertificate?.()
  if (!der) throw configurationError('certifikatet i PKCS #12-filen går inte att läsa ut. Använd PEM-filen i stället.')

  return { tls: { pfx, passphrase }, certificate: new X509Certificate(der) }
}

/** Läser certifikatet och nyckeln. Kastar ett fel som säger vad som är fel. */
export function loadRpCredentials(path: string, passphrase: string): RpCredentials {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch (error) {
    throw configurationError(`filen ${path} går inte att läsa (${(error as NodeJS.ErrnoException).code ?? 'okänt fel'}).`)
  }

  const text = bytes.toString('latin1')
  return text.includes('-----BEGIN ') ? fromPem(text, passphrase) : fromPkcs12(bytes, passphrase)
}

/**
 * Vad som gör certifikatet olämpligt för miljön, eller null.
 *
 * Ett certifikat som inte gäller nu ger ett fel i varje TLS-handskakning. I
 * produktion vägras dessutom BankID:s publika testcertifikat: med det kan vem som
 * helst utge sig för att vara tjänsten, och BankID:s produktion godtar det inte.
 */
export function rpCredentialProblem(
  environment: BankIdEnvironment,
  certificate: Pick<X509Certificate, 'fingerprint256' | 'validFromDate' | 'validToDate'>,
  now: Date = new Date(),
): string | null {
  if (certificate.validToDate.getTime() <= now.getTime()) return 'RP-certifikatet har gått ut.'
  if (certificate.validFromDate.getTime() > now.getTime()) return 'RP-certifikatet gäller inte än.'
  if (environment === 'production' && certificate.fingerprint256 === PUBLIC_TEST_RP_CERTIFICATE_SHA256) {
    return 'BANKID_ENV=production med BankID:s publika testcertifikat. Produktion kräver ett eget certifikat.'
  }
  return null
}

const loaded = new Map<string, RpCredentials>()

/**
 * Certifikatet ur BANKID_CERT_PATH och BANKID_CERT_PASSPHRASE. Läses en gång per
 * process och sökväg. Kastar när variabeln saknas eller filen inte går att läsa.
 */
export function rpCredentialsFromEnv(): RpCredentials {
  const path = env.bankIdCertPath
  if (path === null) {
    throw configurationError('saknas. Klienten mot BankID behöver ett RP-certifikat i skarpt läge.')
  }
  const passphrase = env.bankIdCertPassphrase
  const key = `${path}\u0000${passphrase}`
  let credentials = loaded.get(key)
  if (!credentials) {
    credentials = loadRpCredentials(path, passphrase)
    loaded.set(key, credentials)
  }
  return credentials
}
