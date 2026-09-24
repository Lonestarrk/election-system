import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDemoMode } from '@/lib/demo-mode'
import { env } from '@/lib/env'
import { certificateFromPem, hasReadableConstraints } from './certificate-chain'
import { MOCK_BANKID_ROOT_CERTIFICATE } from './mock-ca/root-certificate'

/**
 * DE ROTCERTIFIKAT SOM VARJE BANKID-KEDJA PRÖVAS MOT.
 *
 * Rötterna är konfiguration och aldrig data. De lagras inte med kuvertet och
 * kan inte komma ur BankID:s svar: en rot som följde med kedjan vore en rot
 * som den som skrev kedjan själv valt. De läses ur den fil som
 * BANKID_ROOT_CERTIFICATES pekar ut, och bara i demoläget finns ett förval,
 * attrappens egen rot.
 *
 * VARFÖR EN FIL SOM INTE HÅLLER STOPPAR ALLT
 *
 * Här finns två sorters fel, och de behandlas olika. Ett trasigt certifikat i
 * en rad är en avvikelse, och valideringen före stängningen rapporterar den och
 * fortsätter. En trasig rotfil är ett fel i driftsättningen, och då kastar den
 * här modulen: läggningen svarar med ett serverfel och stängningen avbryts med
 * kopplingen orörd. Att i stället lita på färre rötter, eller på attrappens,
 * vore att tyst pröva mot något annat än det som konfigurerats.
 *
 * Varje rot måste vara en självsignerad CA. En mellannivå eller ett löv som
 * lades i filen av misstag hade annars blivit en rot, och kedjan hade kunnat
 * hoppa över ett led. Rotens basicConstraints ska dessutom gå att läsa med
 * kedjeprövningens strikta läsare, eftersom prövningen läser rotens pathLen.
 * En rot som OpenSSL godtar men som prövningen inte kan läsa hade annars fällt
 * varje kedja under sig, och det hade sett ut som ett angrepp på varje väljare.
 *
 * ROTENS TID PRÖVAS INTE HÄR, UTAN NÄR KEDJAN PRÖVAS (granskningen av uppgift
 * 14f, M2). Förut prövades den ingenstans, och en betrodd rot som gått ut
 * godkändes. Nu ska roten ha gällt vid underskriften, precis som lövet och
 * mellannivåerna, se `verifyCertificateChain`. Att i stället vägra läsa in en
 * utgången rot hade gjort stängningen omöjlig för röster som lades medan roten
 * gällde, och det som gällde när väljaren skrev under är det som avgör.
 */

/** Filen läses en gång per process och sökväg. En ny rot kräver att servern startas om. */
const loaded = new Map<string, X509Certificate[]>()

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----(?:\r?\n)?/g

function configurationError(path: string, problem: string): Error {
  return new Error(`BANKID_ROOT_CERTIFICATES (${path}): ${problem}`)
}

function isSelfSignedCa(certificate: X509Certificate): boolean {
  try {
    return (
      certificate.ca && certificate.checkIssued(certificate) && certificate.verify(certificate.publicKey)
    )
  } catch {
    return false
  }
}

function loadRoots(path: string): X509Certificate[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw configurationError(path, `filen går inte att läsa (${(error as Error).message}).`)
  }

  const blocks = text.match(PEM_BLOCK) ?? []
  if (blocks.length === 0) throw configurationError(path, 'filen innehåller inget certifikat.')
  if (text.replace(PEM_BLOCK, '').trim() !== '') {
    throw configurationError(path, 'filen innehåller något annat än certifikat i PEM.')
  }

  return blocks.map((block, index) => {
    const root = certificateFromPem(block)
    if (!root) throw configurationError(path, `certifikat ${index + 1} går inte att läsa.`)
    if (!isSelfSignedCa(root)) {
      throw configurationError(
        path,
        `certifikat ${index + 1} (${root.subject.replace(/\n/g, ', ')}) är ingen självsignerad CA ` +
          'och kan inte vara en rot.',
      )
    }
    if (!hasReadableConstraints(root)) {
      throw configurationError(
        path,
        `certifikat ${index + 1} (${root.subject.replace(/\n/g, ', ')}) har ett basicConstraints ` +
          'som kedjeprövningen inte kan läsa, och då går inget pathLen att pröva.',
      )
    }
    return root
  })
}

let mockRoot: X509Certificate | null = null

/** Attrappens rot, ur testfixturen. */
function mockBankIdRoot(): X509Certificate {
  mockRoot ??= new X509Certificate(MOCK_BANKID_ROOT_CERTIFICATE)
  return mockRoot
}

/**
 * Är certifikatet attrappens rot? Jämförs på fingeravtrycket, alltså på hela
 * certifikatet: en rot med samma namn men en annan nyckel är inte attrappens,
 * och attrappens rot är det oavsett vad någon döper den till.
 */
export function isMockBankIdRoot(certificate: X509Certificate): boolean {
  return certificate.fingerprint256 === mockBankIdRoot().fingerprint256
}

/**
 * Rötterna, som varje kedja prövas mot när rösten läggs och i valideringen
 * före stängningen.
 *
 * Kastar när rötterna inte går att fastställa, se modulens dokumentation.
 */
export function trustedBankIdRoots(): X509Certificate[] {
  const path = env.bankIdRootCertificatesPath

  if (path !== null) {
    let roots = loaded.get(path)
    if (!roots) {
      roots = loadRoots(path)
      loaded.set(path, roots)
    }
    return roots
  }

  /**
   * UPPGIFT 17: SKARPT LÄGE SKA VÄGRA STARTA MED ATTRAPPENS ROT.
   *
   * Förvalet nedan gäller bara i demoläget, och i dag är demoläget detsamma som
   * att BankID är en attrapp, så skarpt läge har ingen rot att falla tillbaka
   * på. Två vägar finns ändå kvar till attrappens rot i skarpt läge, och båda
   * ska stängas av uppgift 17: lägesväxeln gör att demoläget inte längre följer
   * av implementationen, och BANKID_ROOT_CERTIFICATES kan peka ut attrappens rot
   * uttryckligen. Lägg därför ett krav i `sharpModeRequirements()` i
   * src/lib/runtime-mode.ts, till exempel `bankid-root-not-mock`, som läser
   * `trustedBankIdRoots()` och är uppfyllt bara om `isMockBankIdRoot` svarar nej
   * för varenda rot, så att `assertBootable()` kastar annars.
   */
  if (isDemoMode()) return [mockBankIdRoot()]

  throw new Error(
    'BANKID_ROOT_CERTIFICATES saknas. Utanför demoläget finns ingen rot att pröva BankID-kedjan ' +
      'mot, och en underskrift som inte kan prövas godtas inte.',
  )
}
