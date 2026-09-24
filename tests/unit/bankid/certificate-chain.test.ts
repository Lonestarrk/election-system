import { createVerify, X509Certificate } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  parseCertificateChain,
  signedAt,
  signedOnDay,
  verifyCertificateChain,
  type ChainVerdict,
} from '@/modules/eligibility/bankid/certificate-chain'
import {
  lookalikeHierarchy,
  MOCK_INTERMEDIATE,
  MOCK_ROOT,
  pemChain,
  rsaKeys,
  selfSignedLeaf,
  signPayload,
  voterLeaf,
} from './forged-certificates'

/**
 * KEDJAN PRÖVAS MOT EN FAST ROT, OCH VARJE KONTROLL HAR SITT EGET FALL.
 *
 * Före uppgift 14f prövades underskriften mot den nyckel raden själv bar, och
 * den som kunde skriva i databasen kunde lägga in ett eget nyckelpar. Nu måste
 * nyckeln sitta i ett löv som en betrodd rot står för, genom en mellannivå med
 * CA-rätt. Testerna nedan bygger varje förfalskning så nära en äkta kedja som
 * det går, och varje test kräver att just dess kontroll säger nej, med sitt
 * eget skäl.
 */

const voter = rsaKeys('väljaren')
const other = rsaKeys('någon annan')
const DAY = 86_400_000
const now = () => signedAt(new Date())

function verify(chain: X509Certificate[], roots: X509Certificate[] = [MOCK_ROOT], window = now()) {
  return verifyCertificateChain(chain, { roots, signedDuring: window })
}

function reasonOf(verdict: ChainVerdict): string {
  return verdict.ok ? 'godkänd' : verdict.reason
}

describe('en kedja som attrappen utfärdar', () => {
  it('godkänns, med personnumret och nyckeln ur lövet', () => {
    const verdict = verify([voterLeaf(voter), MOCK_INTERMEDIATE])

    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.personalNumber).toBe('199001011234')

    // Nyckeln är lövets: en underskrift med väljarens nyckel håller mot den.
    const signature = signPayload(voter.privateKey, 'innehåll')
    expect(createVerify('sha256').update('innehåll').verify(verdict.signingKey, signature, 'base64')).toBe(
      true,
    )
  })
})

describe('varje kontroll underkänner sitt eget fall', () => {
  it('en kedja till en annan rot, med samma namn som attrappens', () => {
    const lookalike = lookalikeHierarchy()
    const leaf = voterLeaf(voter, { issuer: lookalike.issuer })

    expect(reasonOf(verify([leaf, lookalike.intermediate]))).toBe('untrusted_root')
  })

  it('kontrasten: samma kedja godkänns när dess rot är betrodd', () => {
    // Utan den här kunde testet ovan ha fallit på något annat än roten.
    const lookalike = lookalikeHierarchy()
    const leaf = voterLeaf(voter, { issuer: lookalike.issuer })

    expect(reasonOf(verify([leaf, lookalike.intermediate], [MOCK_ROOT, lookalike.root]))).toBe(
      'godkänd',
    )
  })

  it('en mellannivå utan CA-rätt, under en betrodd rot', () => {
    const lookalike = lookalikeHierarchy({ intermediateIsCa: false })
    const leaf = voterLeaf(voter, { issuer: lookalike.issuer })

    expect(reasonOf(verify([leaf, lookalike.intermediate], [MOCK_ROOT, lookalike.root]))).toBe(
      'intermediate_not_ca',
    )
  })

  it('ett självsignerat löv bredvid den äkta mellannivån', () => {
    expect(reasonOf(verify([selfSignedLeaf(other, '199001011234'), MOCK_INTERMEDIATE]))).toBe(
      'not_issued_by_intermediate',
    )
  })

  it('ett löv som bär mellannivåns namn men är signerat med en annan nyckel', () => {
    // Namnet stämmer, så OpenSSL hittar utfärdaren. Bara signaturen avslöjar det.
    const lookalike = lookalikeHierarchy()
    const leaf = voterLeaf(voter, { issuer: lookalike.issuer })

    expect(reasonOf(verify([leaf, MOCK_INTERMEDIATE]))).toBe('not_issued_by_intermediate')
  })

  it('ett löv med CA-rätt', () => {
    // Med bara digitalSignature säger OpenSSL:s `ca` nej, eftersom lövet inte
    // får signera certifikat. CA-rätten står ändå i basicConstraints.
    const signingOnly = voterLeaf(voter, { ca: true })
    const signingAndIssuing = voterLeaf(voter, { ca: true, keyUsage: ['digitalSignature', 'keyCertSign'] })

    expect(signingOnly.ca).toBe(false)
    expect(reasonOf(verify([signingOnly, MOCK_INTERMEDIATE]))).toBe('leaf_is_ca')
    expect(reasonOf(verify([signingAndIssuing, MOCK_INTERMEDIATE]))).toBe('leaf_is_ca')
  })

  it('ett löv som inte får användas till underskrifter', () => {
    const encipherOnly = voterLeaf(voter, { keyUsage: ['keyEncipherment'] })
    const withoutKeyUsage = voterLeaf(voter, { keyUsage: null })

    expect(reasonOf(verify([encipherOnly, MOCK_INTERMEDIATE]))).toBe('no_digital_signature')
    // Utan tillägget får nyckeln enligt RFC 5280 användas till allt. Ett
    // BankID-certifikat har alltid tillägget, och ett som saknar det godtas inte.
    expect(reasonOf(verify([withoutKeyUsage, MOCK_INTERMEDIATE]))).toBe('no_digital_signature')
  })

  it('ett löv som har gått ut', () => {
    const expired = voterLeaf(voter, {
      notBefore: new Date(Date.now() - 30 * DAY),
      notAfter: new Date(Date.now() - DAY),
    })

    expect(reasonOf(verify([expired, MOCK_INTERMEDIATE]))).toBe('not_valid_when_signed')
  })

  it('ett löv som ännu inte gäller', () => {
    const early = voterLeaf(voter, {
      notBefore: new Date(Date.now() + DAY),
      notAfter: new Date(Date.now() + 30 * DAY),
    })

    expect(reasonOf(verify([early, MOCK_INTERMEDIATE]))).toBe('not_valid_when_signed')
  })

  it('ett löv utan personnummer, med två eller med fel form', () => {
    const without = voterLeaf(voter, { personalNumber: null })
    const tooShort = voterLeaf(voter, { personalNumber: '9001011234' })
    const withDash = voterLeaf(voter, { personalNumber: '19900101-1234' })

    for (const leaf of [without, tooShort, withDash]) {
      expect(reasonOf(verify([leaf, MOCK_INTERMEDIATE]))).toBe('no_personal_number')
    }
  })

  it('en kedja med fel antal certifikat', () => {
    const leaf = voterLeaf(voter)

    expect(reasonOf(verify([leaf]))).toBe('malformed')
    expect(reasonOf(verify([leaf, MOCK_INTERMEDIATE, MOCK_ROOT]))).toBe('malformed')
  })
})

describe('giltighetstiden prövas vid underskriften, inte vid prövningen', () => {
  /**
   * Attrappens mellannivå gäller från när skriptet kördes, så en underskrift
   * i det förflutna prövas här mot en egen kedja som gällt sedan 2020. Annars
   * vore det mellannivån som underkände, och inte lövet.
   */
  const since2020 = lookalikeHierarchy()
  const within = (leaf: X509Certificate, window: ReturnType<typeof signedAt>) =>
    reasonOf(verify([leaf, since2020.intermediate], [since2020.root], window))

  it('ett löv som gick ut efter underskriften godkänns', () => {
    /**
     * Spec 7.4 i en annan form: det som gällde när väljaren skrev under är det
     * som avgör. Ett certifikat som gått ut sedan dess ska inte fälla en röst
     * som lades medan det gällde.
     */
    const lapsed = voterLeaf(voter, {
      issuer: since2020.issuer,
      notBefore: new Date(Date.now() - 30 * DAY),
      notAfter: new Date(Date.now() - DAY),
    })

    expect(within(lapsed, signedAt(new Date(Date.now() - 2 * DAY)))).toBe('godkänd')
    expect(within(lapsed, now())).toBe('not_valid_when_signed')
  })

  it('underskriftens dag räcker: lövet ska ha gällt någon gång under den', () => {
    // Giltigt till 10.00 den 1 mars, och underskriften gjordes den 1 mars.
    const leaf = voterLeaf(voter, {
      issuer: since2020.issuer,
      notBefore: new Date('2026-02-01T00:00:00Z'),
      notAfter: new Date('2026-03-01T10:00:00Z'),
    })

    expect(within(leaf, signedOnDay(new Date('2026-03-01T15:00:00Z')))).toBe('godkänd')
    expect(within(leaf, signedOnDay(new Date('2026-03-02T00:00:00Z')))).toBe('not_valid_when_signed')
  })

  it('också mellannivån ska ha gällt vid underskriften', () => {
    // Lövet gällde i fjol, men attrappens mellannivå fanns inte då.
    const leaf = voterLeaf(voter, {
      notBefore: new Date(Date.now() - 400 * DAY),
      notAfter: new Date(Date.now() + DAY),
    })

    expect(reasonOf(verify([leaf, MOCK_INTERMEDIATE], [MOCK_ROOT], signedAt(new Date(Date.now() - 365 * DAY))))).toBe(
      'not_valid_when_signed',
    )
  })

  it('dagen är ett dygn i UTC, från midnatt till sista millisekunden', () => {
    expect(signedOnDay(new Date('2026-03-01T15:30:00.123Z'))).toEqual({
      from: new Date('2026-03-01T00:00:00.000Z'),
      until: new Date('2026-03-01T23:59:59.999Z'),
    })
  })
})

describe('tolkningen av kedjan ur BankID:s svar', () => {
  it('läser certifikaten i PEM, lövet först', () => {
    const leaf = voterLeaf(voter)
    const chain = parseCertificateChain(pemChain(leaf, MOCK_INTERMEDIATE))

    expect(chain?.map((certificate) => certificate.fingerprint256)).toEqual([
      leaf.fingerprint256,
      MOCK_INTERMEDIATE.fingerprint256,
    ])
  })

  it('avvisar två certifikat i samma PEM, i stället för att tyst läsa det första', () => {
    const [leafPem, intermediatePem] = pemChain(voterLeaf(voter), MOCK_INTERMEDIATE)

    expect(parseCertificateChain([leafPem! + intermediatePem!])).toBeNull()
  })

  it('avvisar text runt certifikatet och trasig base64', () => {
    const [leafPem] = pemChain(voterLeaf(voter))

    expect(parseCertificateChain([`personnummer:199001011234\n${leafPem!}`])).toBeNull()
    expect(parseCertificateChain([leafPem!.replace('-----END', '*-----END')])).toBeNull()
    expect(parseCertificateChain(['inte ett certifikat'])).toBeNull()
  })

  it('avvisar något som inte är en lista av strängar', () => {
    expect(parseCertificateChain('-----BEGIN CERTIFICATE-----')).toBeNull()
    expect(parseCertificateChain([42])).toBeNull()
    expect(parseCertificateChain([])).toBeNull()
  })
})
