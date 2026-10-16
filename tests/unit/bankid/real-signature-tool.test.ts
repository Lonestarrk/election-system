import type { X509Certificate } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { truncateToDay } from '@/lib/time'
import { buildBankIdSignatureXml } from '@/modules/eligibility/bankid/mock-signature'
import {
  acceptedRealFixtures,
  diagnoseRejection,
  parseRealFixture,
  STATED_ASSUMPTIONS,
  verifyRealSignature,
} from '@/modules/eligibility/bankid/real-signature'
import { MOCK_SERVICE_NAME } from '@/modules/eligibility/bankid/service-name'
import { MAX_OCSP_RESPONSE_BYTES } from '@/modules/eligibility/sealed-chain'
import { addRealBankIdSignature } from '../../../scripts/real-bankid-signature/add'
import { customHierarchy, MOCK_INTERMEDIATE, MOCK_ROOT, rsaKeys, voterLeaf } from './forged-certificates'

/**
 * FRÅN FÅNGST TILL FIXTUR (uppgift 17d, punkt 2 och 3).
 *
 * Verktyget tar en fil som fångsten skrev, prövar den mot läsaren med BankID:s
 * förankrade kundrot för testmiljön, och säger vilket antagande från 17b som
 * inte höll när läsaren avvisar den. En riktig underskrift går inte att göra här,
 * så testerna bygger dokument med attrappens byggare och ger verktyget attrappens
 * rot genom funktionens alternativ, som kommandoraden aldrig ger.
 */

const keys = rsaKeys('fixturväljaren')
const leaf = voterLeaf(keys, { personalNumber: '190001019802', name: { givenName: 'Test', surname: 'Testsson' } })
const CHAIN = [leaf, MOCK_INTERMEDIATE]
const TODAY = truncateToDay(new Date()).toISOString().slice(0, 10)

function genuineXml(certificates: readonly X509Certificate[] = CHAIN): string {
  return buildBankIdSignatureXml({
    userVisibleData: 'Jag lägger min röst i Provvalet.',
    userNonVisibleData: '19:valsystem/kuvert/v2' + '5:val-1',
    certificates,
    privateKey: keys.privateKey,
  })
}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

function once(xml: string, from: string | RegExp, to: string): string {
  const changed = xml.replace(from, to)
  if (changed === xml) throw new Error(`hittade inte ${String(from)}`)
  return changed
}

function check(xml: string, options: { roots?: X509Certificate[]; service?: string; ocspResponse?: string } = {}) {
  return verifyRealSignature(
    {
      signature: b64(xml),
      ocspResponse: options.ocspResponse ?? '',
      capturedOn: TODAY,
      service: options.service ?? MOCK_SERVICE_NAME,
    },
    options.roots ?? [MOCK_ROOT],
  )
}

/** Antagandena verktyget pekade ut, som nummer. */
function blamed(xml: string, options: Parameters<typeof check>[1] = {}): (number | null)[] {
  const result = check(xml, options)
  if (result.ok) throw new Error('dokumentet godtogs')
  return result.findings.map((finding) => finding.assumption)
}

describe('läsarens antaganden från 17b, som verktyget pekar ut', () => {
  it('har alla tretton antagandena med en text', () => {
    expect(Object.keys(STATED_ASSUMPTIONS).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    for (const text of Object.values(STATED_ASSUMPTIONS)) expect(text.length).toBeGreaterThan(20)
  })

  it('godtar attrappens dokument mot attrappens rot, och har då inga fynd', () => {
    const result = check(genuineXml())
    expect(result.ok).toBe(true)
  })

  it('1: en annan kanonisering', () => {
    const xml = once(
      genuineXml(),
      /<CanonicalizationMethod Algorithm="[^"]+">/,
      '<CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11">',
    )
    expect(blamed(xml)).toContain(1)
  })

  it('2: RSA-SHA1 eller en annan digest', () => {
    const sha1 = once(
      genuineXml(),
      'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    )
    expect(blamed(sha1)).toContain(2)
    const digest = once(genuineXml(), 'http://www.w3.org/2001/04/xmlenc#sha256', 'http://www.w3.org/2000/09/xmldsig#sha1')
    expect(blamed(digest)).toContain(2)
  })

  it('3: ordningen bland barnen till bankIdSignedData eller referenserna', () => {
    const xml = genuineXml()
    const visible = /<usrVisibleData[^>]*>[^<]*<\/usrVisibleData>/.exec(xml)![0]
    const nonVisible = /<usrNonVisibleData>[^<]*<\/usrNonVisibleData>/.exec(xml)![0]
    const swapped = xml.replace(visible + nonVisible, nonVisible + visible)
    expect(blamed(swapped)).toContain(3)

    const references = /(<Reference Type="[^"]+" URI="#bidSignedData">.*?<\/Reference>)(<Reference URI="#bidKeyInfo">.*?<\/Reference>)/.exec(xml)!
    expect(blamed(xml.replace(references[0], references[2]! + references[1]!))).toContain(3)
  })

  it('4: ett element i srvInfo, clientInfo eller ai som profilen inte räknar upp', () => {
    expect(blamed(once(genuineXml(), '</ai>', '<newField>abc</newField></ai>'))).toContain(4)
    expect(blamed(once(genuineXml(), '</srvInfo>', '<extra>abc</extra></srvInfo>'))).toContain(4)
    expect(blamed(once(genuineXml(), '</clientInfo>', '<extra>abc</extra></clientInfo>'))).toContain(4)
  })

  it('5: en annan XML-deklaration', () => {
    const xml = once(
      genuineXml(),
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
      '<?xml version="1.0" encoding="UTF-8"?>',
    )
    expect(blamed(xml)).toContain(5)
  })

  it('6: base64 med radbrytningar', () => {
    const xml = genuineXml().replace(
      /<SignatureValue>([^<]+)<\/SignatureValue>/,
      (_, value: string) => `<SignatureValue>${value.match(/.{1,76}/g)!.join('\n')}</SignatureValue>`,
    )
    expect(blamed(xml)).toContain(6)
  })

  it('7: usrNonVisibleData som inte är base64 av UTF-8', () => {
    const xml = once(
      genuineXml(),
      /<usrNonVisibleData>[^<]*<\/usrNonVisibleData>/,
      `<usrNonVisibleData>${Buffer.from([0xff, 0xfe, 0x00]).toString('base64')}</usrNonVisibleData>`,
    )
    expect(blamed(xml)).toContain(7)
  })

  it('8: format på usrVisibleData', () => {
    const xml = once(genuineXml(), '<usrVisibleData charset="UTF-8"', '<usrVisibleData charset="UTF-8" format="simpleMarkdownV1"')
    expect(blamed(xml)).toContain(8)
  })

  it('9: en kedja med bara lövet', () => {
    expect(blamed(genuineXml([leaf]))).toContain(9)
  })

  it('10: en kedja som inte går till kundroten', () => {
    const other = customHierarchy('en annan rot', {}, [{}]).root
    expect(blamed(genuineXml(), { roots: [other] })).toContain(10)
  })

  it('11: ett spärrsvar över taket', () => {
    const big = Buffer.alloc(MAX_OCSP_RESPONSE_BYTES + 1, 1).toString('base64')
    expect(blamed(genuineXml(), { ocspResponse: big })).toContain(11)
  })

  it('13: srvInfo/name är inte den egna tjänstens', () => {
    expect(blamed(genuineXml(), { service: 'name=Någon annan,serialNumber=1234567890' })).toContain(13)
  })

  it('ett skäl som inget antagande förklarar sägs med skälet, utan att gissa ett antagande', () => {
    const xml = genuineXml().replace(/<SignatureValue>([A-Za-z0-9+/])/, (_, first: string) =>
      `<SignatureValue>${first === 'A' ? 'B' : 'A'}`,
    )
    const result = check(xml)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('signature')
    expect(result.findings.every((finding) => finding.assumption === null)).toBe(true)
    expect(result.findings.map((finding) => finding.text).join(' ')).toMatch(/signature/)
  })

  it('diagnoseRejection läser bara dokumentet och skälet', () => {
    const findings = diagnoseRejection(genuineXml(), 'service_name')
    expect(findings.map((finding) => finding.assumption)).toEqual([13])
  })
})

describe('kommandot add-real-bankid-signature', () => {
  function captureFile(content: Record<string, unknown>): string {
    const directory = mkdtempSync(join(tmpdir(), 'fangst-'))
    const path = join(directory, 'bankid-signature-0011223344556677.json')
    writeFileSync(path, JSON.stringify(content))
    return path
  }

  const capture = (xml = genuineXml(), environment = 'test') =>
    captureFile({ environment, capturedOn: TODAY, signature: b64(xml), ocspResponse: b64('spärrsvar') })

  const fixtures = () => mkdtempSync(join(tmpdir(), 'fixturer-'))
  const MOCK = ['--service', MOCK_SERVICE_NAME]
  const APP = ['--app', 'BankID för Android 10.4.1 (CUST)']

  it('prövar mot BankID:s förankrade kundrot för testmiljön när inget annat ges, och avvisar då attrappen', () => {
    const directory = fixtures()
    const result = addRealBankIdSignature([capture(), ...MOCK, ...APP, '--confirm-test-identity'], {
      fixturesDirectory: directory,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.written).toBeNull()
    expect(result.lines.join('\n')).toMatch(/Antagande 10/)
    expect(readdirSync(directory)).toEqual([])
  })

  it('vägrar en fångst från en annan miljö än test', () => {
    const directory = fixtures()
    const result = addRealBankIdSignature([capture(genuineXml(), 'production'), ...MOCK, ...APP, '--confirm-test-identity'], {
      fixturesDirectory: directory,
      roots: [MOCK_ROOT],
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.lines.join('\n')).toMatch(/testmiljö/)
    expect(readdirSync(directory)).toEqual([])
  })

  it('vägrar när BANKID_ENV är något annat än test', () => {
    const directory = fixtures()
    const result = addRealBankIdSignature([capture(), ...MOCK, ...APP, '--confirm-test-identity'], {
      fixturesDirectory: directory,
      roots: [MOCK_ROOT],
      bankIdEnv: 'production',
    })
    expect(result.exitCode).not.toBe(0)
    expect(readdirSync(directory)).toEqual([])
  })

  it('kräver --confirm-test-identity, och varnar för personnummer och namn', () => {
    const directory = fixtures()
    const result = addRealBankIdSignature([capture(), ...MOCK, ...APP], { fixturesDirectory: directory, roots: [MOCK_ROOT] })
    const text = result.lines.join('\n')
    expect(result.exitCode).not.toBe(0)
    expect(text).toMatch(/--confirm-test-identity/)
    expect(text).toMatch(/190001019802/)
    expect(text).toMatch(/Test Testsson/)
    expect(readdirSync(directory)).toEqual([])
  })

  it('kräver --app med BankID-appen', () => {
    const directory = fixtures()
    const result = addRealBankIdSignature([capture(), ...MOCK, '--confirm-test-identity'], {
      fixturesDirectory: directory,
      roots: [MOCK_ROOT],
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.lines.join('\n')).toMatch(/--app/)
    expect(readdirSync(directory)).toEqual([])
  })

  it('avvisar en underskrift som läsaren inte godtar, säger antagandet och skriver ingen fixtur', () => {
    const directory = fixtures()
    const xml = once(genuineXml(), '</ai>', '<newField>abc</newField></ai>')
    const result = addRealBankIdSignature([capture(xml), ...MOCK, ...APP, '--confirm-test-identity'], {
      fixturesDirectory: directory,
      roots: [MOCK_ROOT],
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.lines.join('\n')).toMatch(/Antagande 4/)
    expect(result.lines.join('\n')).toMatch(/newField/)
    expect(readdirSync(directory)).toEqual([])
  })

  it('lägger en godtagen underskrift som fixtur med dag, miljö och app, och säger vad som återstår', () => {
    const directory = fixtures()
    const path = capture()
    const result = addRealBankIdSignature([path, ...MOCK, ...APP, '--confirm-test-identity'], {
      fixturesDirectory: directory,
      roots: [MOCK_ROOT],
    })
    expect(result.exitCode).toBe(0)
    expect(result.written).not.toBeNull()
    expect(existsSync(result.written!)).toBe(true)

    const fixture = JSON.parse(readFileSync(result.written!, 'utf8'))
    const original = JSON.parse(readFileSync(path, 'utf8'))
    expect(fixture).toEqual({
      environment: 'test',
      capturedOn: TODAY,
      bankIdApp: 'BankID för Android 10.4.1 (CUST)',
      service: MOCK_SERVICE_NAME,
      signature: original.signature,
      ocspResponse: original.ocspResponse,
    })

    const text = result.lines.join('\n')
    expect(text).toMatch(/READER_TESTED_AGAINST_REAL_SIGNATURE/)
    expect(text).toMatch(/bankid-reader-untested-against-bankid/)
    expect(text).toMatch(/real-signature\.test\.ts/)

    const again = addRealBankIdSignature([path, ...MOCK, ...APP, '--confirm-test-identity'], {
      fixturesDirectory: directory,
      roots: [MOCK_ROOT],
    })
    expect(again.exitCode).not.toBe(0)
    expect(readdirSync(directory)).toHaveLength(1)
  })
})

describe('vilka fixturer som räknas för kravet bankid-reader-tested', () => {
  function fixtureDirectory(entries: Record<string, unknown>[]): string {
    const directory = mkdtempSync(join(tmpdir(), 'fixturer-'))
    entries.forEach((entry, index) => writeFileSync(join(directory, `f${index}.json`), JSON.stringify(entry)))
    return directory
  }

  const fixture = (overrides: Record<string, unknown> = {}) => ({
    environment: 'test',
    capturedOn: TODAY,
    bankIdApp: 'BankID för iOS',
    service: MOCK_SERVICE_NAME,
    signature: b64(genuineXml()),
    ocspResponse: '',
    ...overrides,
  })

  it('räknar ingen tom katalog och ingen katalog som saknas', () => {
    expect(acceptedRealFixtures(fixtureDirectory([]))).toEqual([])
    expect(acceptedRealFixtures(join(tmpdir(), 'finns-inte-17d'))).toEqual([])
  })

  it('räknar inte attrappens underskrift, eftersom den inte går till BankID:s förankrade kundrot', () => {
    const directory = fixtureDirectory([fixture()])
    expect(acceptedRealFixtures(directory)).toEqual([])
    // Mot attrappens rot, som bara testerna kan ge, godtas samma fixtur. Det är rötterna som skiljer.
    expect(acceptedRealFixtures(directory, [MOCK_ROOT])).toEqual(['f0.json'])
  })

  it('räknar inte en fixtur från en annan miljö eller utan metadata, också när läsaren godtar underskriften', () => {
    // Attrappens rot, så att bara miljön eller metadatan står emellan.
    expect(acceptedRealFixtures(fixtureDirectory([fixture({ environment: 'production' })]), [MOCK_ROOT])).toEqual([])
    expect(acceptedRealFixtures(fixtureDirectory([fixture({ bankIdApp: undefined })]), [MOCK_ROOT])).toEqual([])
    expect(acceptedRealFixtures(fixtureDirectory([fixture({ extra: 'x' })]), [MOCK_ROOT])).toEqual([])
    expect(parseRealFixture(fixture({ environment: 'production' }))).toMatchObject({ ok: false })
    expect(parseRealFixture(fixture())).toMatchObject({ ok: true })
  })
})
