import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { runtimeMode, type RuntimeMode } from '@/lib/mode-flag'
import { bankIdKind, configuredBankIdEnvironment, type BankIdKind } from '@/modules/eligibility/bankid/kind'
import { isMockBankIdRoot, trustedBankIdRoots } from '@/modules/eligibility/bankid/trusted-roots'

/**
 * DEMOLÄGE OCH SKARPT LÄGE (uppgift 17).
 *
 * Läget sätts vid driftsättning, med DEMO_MODE=true, och adminsidan visar det.
 * Ingen knapp eller rutt i appen byter det, eftersom den som kommer åt en
 * adminsession annars kunde slå på attrapp-BankID åt alla. Själva avgörandet
 * står i src/lib/mode-flag.ts, och reglerna där är de här:
 *
 *   1. Skarpt är förvalt, oavsett NODE_ENV. En glömd variabel ger det säkra.
 *   2. Den publika demon är ett produktionsbygge i demoläge, och det är tillåtet.
 *      Att den inte kan förväxlas med ett riktigt val beror därför på
 *      banderollen på varje sida i demoläget, på att omröstningen bär sitt eget
 *      läge och på uppstartsvakten nedan, och inte på att bygget skulle vägra.
 *
 * SKARPT LÄGE ÄR EN CHECKLISTA, INTE EN BOOLEAN
 *
 * Ett läge som bara betyder "inte demo" ger falsk trygghet: appen kan köra med
 * exempelpeppar över http och ändå kalla sig skarp. Kraven räknas därför upp,
 * var och en med en allvarlighetsgrad. Ett STOPPANDE krav som inte är uppfyllt
 * hindrar skarpt läge från att starta, med en lista på vad som saknas så att
 * den som driftsätter slipper gissa. En VARNING stoppar inget men visas på
 * adminsidan och i loggen vid start.
 *
 * Demofraserna för förtroendemännen är inget krav i listan. De är inget
 * konfigurationsvärde utan något en omröstning skapas med, och därför prövas de
 * där: skapandet av en omröstning i skarpt läge vägrar dem, och seedningen
 * vägrar köra, se src/lib/demo-election.ts. Ett krav som läste en miljövariabel
 * hade hängt på att driften kom ihåg att sätta den.
 *
 * Listan beskriver konfigurationen, och är därför inget som visas offentligt.
 * /api/mode ger bara läget. Checklistan går via /api/admin/mode, bakom
 * adminsessionen.
 */

export type { RuntimeMode }
export { runtimeMode }

export type Requirement = {
  id: string
  met: boolean
  detail: string
  /** Sant: ouppfyllt hindrar skarpt läge från att starta. Falskt: en varning. */
  blocking: boolean
}

const EXAMPLE_PEPPER = 'byt-ut-mig-detta-ar-bara-for-lokal-utveckling-0000'

/** BankID:s rotcertifikat är något annat än attrappens, och går att läsa. */
function rootsAreNotTheMock(): boolean {
  // Utan en uttalad fil används i demoläget attrappens egen rot, och i skarpt
  // läge ingen alls. Ingen av dem uppfyller kravet.
  if (env.bankIdRootCertificatesPath === null) return false

  try {
    return trustedBankIdRoots().every((root) => !isMockBankIdRoot(root))
  } catch {
    // En fil som inte går att läsa stoppar. Systemet litar aldrig tyst på något annat.
    return false
  }
}

function pepperIsReal(): boolean {
  const pepper = process.env.IDENTITY_PEPPER ?? ''
  return pepper.length >= 32 && pepper !== EXAMPLE_PEPPER
}

function originsAreHttps(): boolean {
  const origins = (process.env.APP_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)

  return origins.length > 0 && origins.every((origin) => origin.startsWith('https://'))
}

/**
 * Kraven för skarpt läge och hur det står till med dem. Går att läsa i
 * demoläget också, och visar då vad som saknas för att köra skarpt.
 */
export function sharpModeRequirements(): Requirement[] {
  const kind = bankIdKind('SHARP')
  const bankIdEnvironment = configuredBankIdEnvironment()

  return [
    {
      id: 'bankid-real',
      met: kind === 'test' || kind === 'production',
      blocking: true,
      detail:
        'Bygget har ingen klient för riktig BankID. Attrappen används aldrig utanför demoläget, ' +
        'så ingen kan legitimera sig eller skriva under förrän klienten finns.',
    },
    {
      id: 'bankid-env',
      met: bankIdEnvironment !== null,
      blocking: true,
      detail: 'BANKID_ENV måste vara test eller production, så att det är utpekat vilken BankID-miljö som används.',
    },
    {
      id: 'bankid-test-environment',
      met: bankIdEnvironment !== 'test',
      blocking: false,
      detail:
        'BANKID_ENV=test: inloggningarna är riktiga BankID-flöden med test-BankID, inte med riktiga personer.',
    },
    {
      id: 'bankid-root-not-mock',
      met: rootsAreNotTheMock(),
      blocking: true,
      detail:
        'BANKID_ROOT_CERTIFICATES måste peka på en fil med BankID:s egna rotcertifikat. Attrappens rot ' +
        'får aldrig vara en betrodd rot i skarpt läge.',
    },
    {
      id: 'cookie-secure',
      met: process.env.COOKIE_SECURE === 'true',
      blocking: true,
      detail: 'COOKIE_SECURE måste vara true, annars skickas sessionscookien utan Secure-flaggan.',
    },
    {
      id: 'https-origin',
      met: originsAreHttps(),
      blocking: true,
      detail: 'APP_ORIGIN måste vara satt, och varje origin i den måste börja med https://.',
    },
    {
      id: 'pepper-changed',
      met: pepperIsReal(),
      blocking: true,
      detail:
        'IDENTITY_PEPPER är osatt, för kort eller kvar på exempelvärdet. Då går identitetshasharna i ' +
        'röstlängden att räkna ut ur personnummer.',
    },
  ]
}

/**
 * Uppstartsvakten. Kastar om skarpt läge inte får starta.
 *
 * Demoläget behöver inte uppfylla listan: det är en demo, och banderollen säger
 * det på varje sida. Skarpt läge kräver varje stoppande krav, och felet räknar
 * upp vad som saknas.
 */
export function assertBootable(): void {
  if (runtimeMode() === 'DEMO') return

  const unmet = sharpModeRequirements().filter((requirement) => !requirement.met && requirement.blocking)
  if (unmet.length === 0) return

  throw new Error(
    'Skarpt läge kan inte startas. Följande krav är ouppfyllda:\n' +
      unmet.map((requirement) => `  ${requirement.id}: ${requirement.detail}`).join('\n') +
      '\nSätt DEMO_MODE=true för att köra i demoläge, eller åtgärda kraven.',
  )
}

const BANKID_LABELS: Record<BankIdKind, string> = {
  mock: 'attrappen',
  test: 'BankID testmiljö',
  production: 'BankID produktion',
  none: 'ingen BankID-klient',
}

/** Läget som en text för loggen och adminsidan. */
export function describeMode(): {
  mode: RuntimeMode
  title: string
  meaning: string
  bankId: { kind: BankIdKind; label: string }
} {
  const mode = runtimeMode()
  const kind = bankIdKind(mode)

  return {
    mode,
    title: mode === 'DEMO' ? 'Demoläge' : 'Skarpt läge',
    meaning:
      mode === 'DEMO'
        ? 'BankID är en attrapp, och vem som helst kan legitimera sig som en demoperson. Ett demoval är inget riktigt val.'
        : 'Demogenvägarna finns inte och attrappen används aldrig. Legitimering och underskrift kräver en riktig BankID-klient. Skarpt läge är förvalt, och bara DEMO_MODE=true ger demoläge.',
    bankId: { kind, label: BANKID_LABELS[kind] },
  }
}

/**
 * Skriver läget i loggen. Anropas vid varje start, så att den som läser loggen
 * ser i vilket läge processen körde, och vilka varningar skarpt läge hade.
 */
export function logModeAtStartup(): void {
  const { mode, title, bankId } = describeMode()

  if (mode === 'DEMO') {
    logger.info(
      `${title}. BankID är en attrapp, och vem som helst kan legitimera sig som en demoperson. ` +
        'Läget sätts vid driftsättning med DEMO_MODE=true.',
    )
    return
  }

  logger.info(`${title}, ${bankId.label}.`)
  for (const requirement of sharpModeRequirements()) {
    if (!requirement.met && !requirement.blocking) logger.warn(requirement.detail)
  }
}
