import { X509Certificate } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { signedAt } from '@/modules/eligibility/bankid/certificate-chain'
import { buildBankIdSignatureXml } from '@/modules/eligibility/bankid/mock-signature'
import {
  formatServiceName,
  MOCK_SERVICE_NAME,
  parseServiceName,
  sameServiceName,
  serviceNameOf,
} from '@/modules/eligibility/bankid/service-name'
import { parseXml, serializeXml, verifyBankIdSignature, type XmlElement } from '@/modules/eligibility/bankid/xmldsig'
import { authority, encodeOrderedName, leafUnder, rpCredential } from './fake-rp-server'
import { customHierarchy, lookalikeHierarchy, MOCK_INTERMEDIATE, MOCK_ROOT, rsaKeys, voterLeaf } from './forged-certificates'
import { createHash, createSign } from 'node:crypto'
import { canonicalize } from '@/modules/eligibility/bankid/xmldsig'

/**
 * VEM BAD OM UNDERSKRIFTEN, OCH KEDJANS ROT (uppgift 17c, antagande 9 och 13 från 17b).
 *
 * srvInfo/name är, enligt BankID:s signaturprofil, base64 av RP-certifikatets
 * subject som en sträng enligt RFC 4514, med attributnamnen "name" och
 * "serialNumber" ur RFC 4519. Läsaren kräver att det är den egna tjänstens namn,
 * ur det egna RP-certifikatet. En underskrift som någon annan tjänst bett om
 * godtas inte, också om allt annat i den är äkta.
 */

const RP_CA = authority('rp-ca-namn', 'RP-CA för namnet')
const RP = rpCredential(RP_CA, 'rp-namn')

describe('namnet ur RP-certifikatet', () => {
  it('blir RFC 4514, med den sista RDN först och name och serialNumber vid namn', () => {
    expect(formatServiceName(serviceNameOf(RP.certificate)!)).toBe(
      'CN=FP Testcert 5,name=Test av BankID,serialNumber=5566304928,O=Testbank A AB (publ),C=SE',
    )
  })

  it('tecken som RFC 4514 kräver skyddas, och läses tillbaka', () => {
    const odd = leafUnder(RP_CA, 'udda namn', encodeOrderedName([['2.5.4.10', 'A, B + "C" <D>;\\E'], ['2.5.4.3', ' F#']]))
    const name = serviceNameOf(odd.certificate)!
    const text = formatServiceName(name)

    expect(text).toBe('CN=\\ F#,O=A\\, B \\+ \\"C\\" \\<D\\>\\;\\\\E')
    expect(sameServiceName(parseServiceName(text)!, name)).toBe(true)
  })
})

describe('jämförelsen', () => {
  const ours = serviceNameOf(RP.certificate)!

  it('attributnamnen jämförs utan hänsyn till skiftläge, som i RFC 4514', () => {
    const text = 'cn=FP Testcert 5,NAME=Test av BankID,serialnumber=5566304928,o=Testbank A AB (publ),c=SE'
    expect(sameServiceName(parseServiceName(text)!, ours)).toBe(true)
  })

  it('värdena jämförs exakt', () => {
    const text = 'CN=FP Testcert 5,name=test av bankid,serialNumber=5566304928,O=Testbank A AB (publ),C=SE'
    expect(sameServiceName(parseServiceName(text)!, ours)).toBe(false)
  })

  it('ordningen spelar roll, och inget attribut får saknas eller tillkomma', () => {
    const swapped = 'name=Test av BankID,CN=FP Testcert 5,serialNumber=5566304928,O=Testbank A AB (publ),C=SE'
    const missing = 'CN=FP Testcert 5,name=Test av BankID,serialNumber=5566304928,O=Testbank A AB (publ)'
    const extra = `${formatServiceName(ours)},C=SE`
    for (const text of [swapped, missing, extra]) expect(sameServiceName(parseServiceName(text)!, ours), text).toBe(false)
  })

  it('hexkodade escape-sekvenser läses som UTF-8', () => {
    expect(parseServiceName('CN=Valsystemet \\C3\\A5')).toEqual([{ type: 'CN', value: 'Valsystemet å' }])
  })

  it('det som inte är ett namn i RFC 4514 avvisas', () => {
    for (const text of ['', 'CN', '=x', 'CN=a+O=b', 'CN=#0403616263', 'CN=a\\', 'CN=a\\zz', 'CN=a,,O=b', 'CN=a"b']) {
      expect(parseServiceName(text), text).toBeNull()
    }
  })
})

const VOTER = '199001011234'
const voterKeys = rsaKeys('väljaren för namnet')
const leaf = voterLeaf(voterKeys, { personalNumber: VOTER })

function document(certificates: X509Certificate[] = [leaf, MOCK_INTERMEDIATE], key = voterKeys.privateKey) {
  return buildBankIdSignatureXml({
    userVisibleData: 'Rösta',
    userNonVisibleData: 'innehåll',
    certificates,
    privateKey: key,
  })
}

function verify(xml: string, service = parseServiceName(MOCK_SERVICE_NAME)!, roots = [MOCK_ROOT]) {
  return verifyBankIdSignature(Buffer.from(xml, 'utf8'), { roots, signedDuring: signedAt(new Date()), service })
}

function firstNamed(root: XmlElement, name: string): XmlElement {
  const stack = [root]
  while (stack.length > 0) {
    const element = stack.shift()!
    if (element.name === name) return element
    stack.push(...element.children)
  }
  throw new Error(`inget ${name}`)
}

/** Byter srvInfo/name och signerar om dokumentet, så att bara namnkontrollen står emellan. */
function withServiceName(xml: string, text: string): string {
  const parsed = parseXml(xml)
  if (!parsed.ok) throw new Error(parsed.reason)
  const root = parsed.root
  firstNamed(firstNamed(root, 'srvInfo'), 'name').text = Buffer.from(text, 'utf8').toString('base64')
  const signedData = firstNamed(root, 'bankIdSignedData')
  const reference = firstNamed(root, 'SignedInfo').children.find((child) => child.name === 'Reference')!
  firstNamed(reference, 'DigestValue').text = createHash('sha256').update(canonicalize(signedData), 'utf8').digest('base64')
  const signedInfo = firstNamed(root, 'SignedInfo')
  firstNamed(root, 'SignatureValue').text = createSign('sha256')
    .update(canonicalize(signedInfo), 'utf8')
    .end()
    .sign(voterKeys.privateKey, 'base64')
  return serializeXml(root, parsed.declaration)
}

describe('läsaren prövar srvInfo/name', () => {
  it('attrappens dokument bär attrappens namn och godtas med det', () => {
    expect(verify(document()).ok).toBe(true)
  })

  it('en underskrift som en annan tjänst bad om avvisas, också när allt annat är äkta', () => {
    expect(verify(document(), serviceNameOf(RP.certificate)!)).toEqual({ ok: false, reason: 'service_name' })

    const other = withServiceName(document(), 'name=En annan tjänst,serialNumber=0000000000')
    expect(verify(other)).toEqual({ ok: false, reason: 'service_name' })
  })

  it('ett namn som inte går att läsa avvisas', () => {
    expect(verify(withServiceName(document(), 'inget namn'))).toEqual({ ok: false, reason: 'service_name' })
  })

  it('samma namn med attributnamnen i annat skiftläge godtas', () => {
    expect(verify(withServiceName(document(), 'NAME=Valsystemet (attrapp),SERIALNUMBER=0000000000')).ok).toBe(true)
  })
})

describe('en rot i kedjan (antagande 9)', () => {
  it('tas bort när den är identisk med en betrodd rot', () => {
    expect(verify(document([leaf, MOCK_INTERMEDIATE, MOCK_ROOT])).ok).toBe(true)
  })

  it('tas inte bort när den bara liknar en betrodd rot, och kedjan underkänns', () => {
    // Samma namn som attrappens rot, men en annan nyckel. Bara fingeravtrycket skiljer dem åt.
    const lookalike = lookalikeHierarchy().root
    const verdict = verify(document([leaf, MOCK_INTERMEDIATE, lookalike]))
    expect(verdict.ok).toBe(false)
  })

  it('en kedja med tre mellannivåer och roten sist godtas, men inte fem certifikat utan rot', () => {
    const hierarchy = customHierarchy('lång kedja', {}, [{}, {}, {}])
    const deep = voterLeaf(voterKeys, { personalNumber: VOTER, issuer: hierarchy.issuer })
    const roots = [hierarchy.root]

    expect(verify(document([deep, ...hierarchy.intermediates, hierarchy.root]), undefined, roots).ok).toBe(true)

    const four = customHierarchy('fyra nivåer', {}, [{}, {}, {}, {}])
    const deeper = voterLeaf(voterKeys, { personalNumber: VOTER, issuer: four.issuer })
    expect(verify(document([deeper, ...four.intermediates]), undefined, [four.root]).ok).toBe(false)
  })

  it('en betrodd rot mitt i kedjan tas inte bort', () => {
    expect(verify(document([leaf, MOCK_ROOT, MOCK_INTERMEDIATE])).ok).toBe(false)
  })
})

describe('det förväntade namnet', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('är attrappens i demoläget', async () => {
    vi.resetModules()
    vi.stubEnv('DEMO_MODE', 'true')
    const { expectedServiceName } = await import('@/modules/eligibility/bankid/service-name')
    expect(formatServiceName(expectedServiceName())).toBe(MOCK_SERVICE_NAME)
  })

  it('kastar i skarpt läge utan RP-certifikat, i stället för att godta något', async () => {
    vi.resetModules()
    vi.stubEnv('DEMO_MODE', '')
    vi.stubEnv('BANKID_CERT_PATH', '')
    const { expectedServiceName } = await import('@/modules/eligibility/bankid/service-name')
    expect(() => expectedServiceName()).toThrow(/BANKID_CERT_PATH/)
  })
})
