import { logger } from '@/lib/logger'
import { runtimeMode } from '@/lib/mode-flag'
import type { IBankIdService } from './IBankIdService'
import { BankIdRpClient } from './BankIdRpClient'
import { BANKID_ENVIRONMENTS, serverRootFor } from './bankid-environment'
import { configuredBankIdEnvironment } from './kind'
import { MockBankIdService } from './MockBankIdService'
import { rpCredentialsFromEnv } from './rp-certificate'
import { captureSignature, signatureCaptureDirectory } from './signature-capture'
import { UnavailableBankIdService } from './UnavailableBankIdService'

/**
 * Enda stället där implementationen väljs.
 *
 *   demoläge                     attrappen
 *   skarpt läge med BANKID_ENV   klienten mot BankID:s RP API v6.0 (uppgift 17c), mot
 *                                testmiljön eller produktionen, med miljöns förankrade
 *                                serverrot och RP-certifikatet ur BANKID_CERT_PATH
 *   skarpt läge utan BANKID_ENV  en tjänst som vägrar varje anrop
 *
 * Läget läses en gång, när modulen laddas: en process byter aldrig läge, och en
 * tjänst som valdes i ett läge ska inte kunna bli en annan av att variabeln
 * ändras. Klienten skapas däremot först vid det första anropet, så att en modul
 * som bara importerar tjänsten inte läser certifikatet. Uppstartsvakten har då
 * redan prövat att certifikatet går att läsa (`bankid-client-certificate`).
 *
 * Resten av systemet är beroende av gränssnittet, inte av implementationen.
 */
function realBankIdService(): IBankIdService {
  const environment = configuredBankIdEnvironment()
  if (environment === null) return new UnavailableBankIdService()

  let client: BankIdRpClient | null = null
  const instance = (): BankIdRpClient => {
    if (client) return client
    const capture = signatureCaptureDirectory()
    client = new BankIdRpClient({
      baseUrl: BANKID_ENVIRONMENTS[environment].baseUrl,
      // Rotens fingeravtryck prövas mot det låsta för miljön. Kastar annars.
      serverRoots: [serverRootFor(environment).toString()],
      credentials: rpCredentialsFromEnv().tls,
      ...(capture ? { onComplete: (completion) => captureQuietly(capture, completion) } : {}),
    })
    return client
  }

  return {
    auth: (request) => instance().auth(request),
    sign: (request) => instance().sign(request),
    qrData: (orderRef) => instance().qrData(orderRef),
    collect: (orderRef) => instance().collect(orderRef),
    cancel: (orderRef) => instance().cancel(orderRef),
  }
}

/**
 * En fångst som misslyckas får inte fälla väljarens underskrift. Loggen säger att
 * den misslyckades, men ingenting om underskriften eller filen.
 */
function captureQuietly(directory: string, completion: { signature: string; ocspResponse: string }): void {
  try {
    captureSignature(directory, completion)
  } catch {
    logger.warn('En BankID-underskrift kunde inte fångas till BANKID_CAPTURE_SIGNATURES_DIR.')
  }
}

export const bankIdService: IBankIdService =
  runtimeMode() === 'DEMO' ? new MockBankIdService() : realBankIdService()

export type * from './IBankIdService'
