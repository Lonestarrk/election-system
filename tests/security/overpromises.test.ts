import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CURRENTLY } from '@/app/architecture/code-facts'
import { KNOWN_LIMITATIONS } from '@/lib/known-limitations'

/**
 * TEXTERNA FÖR ALLA LOVAR INTE MER ÄN KODEN HÅLLER (helgrensgranskningen, B2–B4 och B7).
 *
 * Granskningen hittade fyra överlöften i texter som riktar sig till alla, och
 * ingen markör vaktade dem. Varje text prövas här mot det den måste säga, och
 * det påstående den avgränsas mot prövas mot koden, så att en text och koden
 * inte kan glida isär utan att ett test går rött.
 */

/** Filens text med radbrytningar och indrag ihopslagna, som en läsare ser den. */
function prose(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf8').replace(/\s+/g, ' ')
}

function code(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf8')
}

/** Samma förbehåll som tests/security/bankid-copy-texts.test.ts kräver (ruling 138). */
const QUALIFIER = 'utom när valsedeln har så få röster att summan visar dem'

describe('inloggningssidan om personnumret (B2)', () => {
  const page = prose('src/app/identify/page.tsx')

  it('säger inte att personnumret aldrig lagras', () => {
    expect(page).not.toContain('Ditt personnummer lagras aldrig.')
    expect(page).not.toMatch(/oåterkalleligt värde/)
  })

  it('säger att det inte lagras i klartext, och nämner underskriften och hemligheten', () => {
    expect(page).toContain('Ditt personnummer lagras aldrig i klartext.')
    expect(page).toMatch(/underskrift från BankID, med ditt namn och personnummer/)
    expect(page).toMatch(/den som har hemligheten kan låsa upp den/)
    expect(page).toMatch(/pröva sig fram till numret/)
  })

  it('påståendena den avgränsas mot håller i koden', () => {
    // Fingeravtrycket görs med pepparn, och underskriften låses in med en nyckel ur den.
    expect(code('src/modules/eligibility/identity.ts')).toContain('scryptHex(normalised, env.identityPepper)')
    expect(code('src/modules/eligibility/sealed-chain.ts')).toContain("hkdfSync('sha256', env.identityPepper,")
    expect(code('src/modules/eligibility/pending-vote.service.ts')).toContain(
      'const bankIdCertificateChain = sealBankIdSignature({ xml: signatureXml, ocspResponse }, { voterStatusId, ballotId })',
    )
    // Underskriften raderas med kuvertet vid stängningen.
    expect(code('src/modules/eligibility/pending-vote.service.ts')).toContain('client.pendingVote.deleteMany(')
  })
})

describe('summorna efter stängningen (B4)', () => {
  it('Före och efter stängningen avgränsar båda påståendena till valsedlar med tillräckligt många röster', () => {
    const section = prose('src/app/architecture/sections/BeforeAndAfterClose.tsx')

    expect(section).toContain(`Aldrig något per röst, varken chiffer eller hashar, ${QUALIFIER}.`)
    expect(section).toContain(`Efter stängningen finns ingenting publicerat att matcha mot, ${QUALIFIER}.`)
  })

  it('kuvertmodellen på Tekniska detaljer gör det också', () => {
    expect(prose('src/app/architecture/sections/EnvelopeModel.tsx')).toContain(`ingenting per röst, ${QUALIFIER}`)
  })

  it('förbehållet är posten om valsedlar med en enda röst, och den står kvar', () => {
    expect(KNOWN_LIMITATIONS.some((entry) => entry.id === 'single-row-ballot-publishes-the-vote')).toBe(true)
  })
})

describe('IP-adressen (B7)', () => {
  it('texten nämner att adressen går till BankID som endUserIp', () => {
    expect(CURRENTLY.ipAddresses.text).toMatch(/BankID som endUserIp/)
    expect(CURRENTLY.ipAddresses.text).not.toMatch(/^Används till hastighetsbegränsning och hålls hashad i processminnet\. Lagras aldrig i en databas\.$/)
  })

  it('och det håller i koden: legitimeringens start och underskriftens start skickar den', () => {
    expect(code('src/app/api/vote/sign-start/route.ts')).toContain('endUserIp: clientIp,')
    expect(code('src/app/api/auth/bankid/start/route.ts')).toMatch(/endUserIp: clientIp/)
  })
})

describe('resterna av det gamla flödet (B9)', () => {
  it('BankID-gränssnittet beskriver kuvertmodellen, inte röstintyget', () => {
    const source = prose('src/modules/eligibility/bankid/IBankIdService.ts')
    expect(source).not.toMatch(/röstintyg/)
    expect(source).toMatch(/möts först i det yttre kuvertet/)
  })

  it('testernas namn talar om kuvert, inte om kvitton eller verifikationskoder', () => {
    expect(code('tests/integration/pending-vote.test.ts')).not.toMatch(/it\('[^']*verifikationskod/)
    expect(code('tests/e2e/voting-flow.spec.ts')).not.toMatch(/verifiesReceipt/)
  })
})
