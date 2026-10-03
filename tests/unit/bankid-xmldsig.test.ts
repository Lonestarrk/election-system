import { createHash, createSign, type KeyObject, type X509Certificate } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signedAt } from '@/modules/eligibility/bankid/certificate-chain'
import { buildBankIdSignatureXml } from '@/modules/eligibility/bankid/mock-signature'
import {
  BANKID_NAMESPACE,
  canonicalize,
  MAX_SIGNATURE_XML_BYTES,
  parseXml,
  serializeXml,
  verifyBankIdSignature,
  XMLDSIG_NAMESPACE,
  type XmlElement,
} from '@/modules/eligibility/bankid/xmldsig'
import {
  lookalikeHierarchy,
  MOCK_INTERMEDIATE,
  MOCK_ROOT,
  rsaKeys,
  voterLeaf,
} from './bankid/forged-certificates'

/**
 * BANKID:S UNDERSKRIFT PRÖVAS I BANKID:S EGET FORMAT (uppgift 17b).
 *
 * Varje avvisning har ett eget test, och varje test pekar ut skälet. Där det går
 * signeras det ändrade dokumentet om med väljarens egen nyckel (`resign`), så
 * att varken digesten eller underskriften säger nej. Då är det bara den
 * kontroll testet gäller som står emellan, och testet blir rött mot en läsare
 * som saknar just den. Mutanterna som visade det står i rapporten för 17b.
 */

const VOTER = '199001011234'
const voterKeys = rsaKeys('väljaren')
const leaf = voterLeaf(voterKeys, { personalNumber: VOTER })
const chain = [leaf, MOCK_INTERMEDIATE]

const SIGNED = '19:valsystem/kuvert/v2' + '5:val-1' + '4:vs-1' + `64:${'a'.repeat(64)}` + '1:1'
const VISIBLE = 'Jag lägger min röst i Valet 2026, valet till riksdagen.'

function genuine(nonVisible = SIGNED, certificates: X509Certificate[] = chain, key: KeyObject = voterKeys.privateKey) {
  return buildBankIdSignatureXml({
    userVisibleData: VISIBLE,
    userNonVisibleData: nonVisible,
    certificates,
    privateKey: key,
  })
}

function verify(xml: string, roots = [MOCK_ROOT]) {
  return verifyBankIdSignature(Buffer.from(xml, 'utf8'), { roots, signedDuring: signedAt(new Date()) })
}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

/** Byter exakt en förekomst, och kastar om den inte finns, så att ett test aldrig prövar ett oförändrat dokument. */
function replaceOnce(xml: string, from: string, to: string): string {
  const at = xml.indexOf(from)
  if (at === -1) throw new Error(`hittade inte ${from.slice(0, 60)}`)
  if (xml.indexOf(from, at + 1) !== -1) throw new Error(`fler än en förekomst av ${from.slice(0, 60)}`)
  return xml.slice(0, at) + to + xml.slice(at + from.length)
}

function walk(element: XmlElement, visit: (element: XmlElement) => void): void {
  visit(element)
  for (const child of element.children) walk(child, visit)
}

function firstWithId(root: XmlElement, id: string): XmlElement {
  let found: XmlElement | null = null
  walk(root, (element) => {
    if (!found && element.attributes.some(([name, value]) => name === 'Id' && value === id)) found = element
  })
  if (!found) throw new Error(`inget element med Id ${id}`)
  return found
}

function firstNamed(root: XmlElement, name: string): XmlElement {
  let found: XmlElement | null = null
  walk(root, (element) => {
    if (!found && element.name === name) found = element
  })
  if (!found) throw new Error(`inget ${name}`)
  return found
}

/**
 * SIGNERAR OM ETT ÄNDRAT DOKUMENT, SOM EN LÄSARE SOM SAKNAR EN KONTROLL SKULLE PRÖVA DET.
 *
 * Referenserna löses upp mot det första elementet med rätt Id, digesterna räknas
 * om över dem, och SignedInfo signeras med väljarens nyckel. Allt det kan den
 * som har nyckeln, alltså väljaren själv eller den som driver en demo, och det
 * är just därför strukturen måste prövas för sig.
 */
function resign(xml: string, options: { hash?: 'sha256' | 'sha1'; key?: KeyObject } = {}): string {
  const parsed = parseXml(xml)
  if (!parsed.ok) throw new Error(`dokumentet gick inte att läsa: ${parsed.reason}`)
  const root = parsed.root

  const signedInfo = firstNamed(root, 'SignedInfo')
  for (const reference of signedInfo.children.filter((child) => child.name === 'Reference')) {
    const uri = reference.attributes.find(([name]) => name === 'URI')?.[1] ?? ''
    const target = firstWithId(root, uri.slice(1))
    const digest = createHash('sha256').update(canonicalize(target), 'utf8').digest('base64')
    firstNamed(reference, 'DigestValue').text = digest
  }

  const signature = createSign(options.hash ?? 'sha256')
    .update(canonicalize(signedInfo), 'utf8')
    .end()
    .sign(options.key ?? voterKeys.privateKey, 'base64')
  firstNamed(root, 'SignatureValue').text = signature

  return serializeXml(root, parsed.declaration)
}

function usrNonVisible(xml: string): string {
  const match = /<usrNonVisibleData>([^<]*)<\/usrNonVisibleData>/.exec(xml)
  if (!match) throw new Error('inget usrNonVisibleData')
  return match[0]
}

function signedDataElement(xml: string): string {
  const match = /<bankIdSignedData [^>]*>.*<\/bankIdSignedData>/.exec(xml)
  if (!match) throw new Error('inget bankIdSignedData')
  return match[0]
}

describe('attrappens underskrift i BankID:s format', () => {
  it('godtas, och ger det signerade, texten och personnumret ur det prövade elementet', () => {
    const verdict = verify(genuine())

    expect(verdict).toMatchObject({
      ok: true,
      usrNonVisibleData: SIGNED,
      usrVisibleData: VISIBLE,
      personalNumber: VOTER,
    })
  })

  it('har BankID:s struktur: Signature, SignedInfo, SignatureValue, KeyInfo och Object', () => {
    const xml = genuine()

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="no"?>')).toBe(true)
    expect(xml).toContain(`<Signature xmlns="${XMLDSIG_NAMESPACE}"><SignedInfo xmlns="${XMLDSIG_NAMESPACE}">`)
    expect(xml).toContain('<Reference Type="http://www.bankid.com/signature/v1.0.0/types" URI="#bidSignedData">')
    expect(xml).toContain('<Reference URI="#bidKeyInfo">')
    expect(xml).toContain(`<KeyInfo xmlns="${XMLDSIG_NAMESPACE}" Id="bidKeyInfo"><X509Data><X509Certificate>`)
    expect(xml).toContain(`<Object><bankIdSignedData xmlns="${BANKID_NAMESPACE}" Id="bidSignedData">`)
    expect(xml).toContain(`<usrNonVisibleData>${b64(SIGNED)}</usrNonVisibleData>`)
    expect(xml).toContain('<funcId>Signing</funcId>')
    // Inga blanktecken mellan elementen, som BankID:s.
    expect(xml).not.toMatch(/>\s+</)
  })

  it('bär kedjan utan rot, lövet först', () => {
    const certificates = [...genuine().matchAll(/<X509Certificate>([^<]+)<\/X509Certificate>/g)].map((m) => m[1])

    expect(certificates).toEqual([leaf.raw.toString('base64'), MOCK_INTERMEDIATE.raw.toString('base64')])
  })

  it('om-signeringen i testerna ger ett dokument som godtas, så att varje avvisning nedan är kontrollens egen', () => {
    expect(verify(resign(genuine())).ok).toBe(true)
  })
})

describe('kanoniseringen', () => {
  it('skriver namnrymden på toppelementet och stryker den överflödiga under det', () => {
    const parsed = parseXml(
      `<a xmlns="${XMLDSIG_NAMESPACE}"><b xmlns="${XMLDSIG_NAMESPACE}" Id="x"><c xmlns="${XMLDSIG_NAMESPACE}">t</c></b></a>`,
    )
    if (!parsed.ok) throw new Error(parsed.reason)

    expect(canonicalize(parsed.root.children[0]!)).toBe(`<b xmlns="${XMLDSIG_NAMESPACE}" Id="x"><c>t</c></b>`)
  })

  it('skriver en namnrymd som byts under toppelementet', () => {
    const parsed = parseXml(`<a xmlns="${XMLDSIG_NAMESPACE}"><b xmlns="${BANKID_NAMESPACE}"></b></a>`)
    if (!parsed.ok) throw new Error(parsed.reason)

    expect(canonicalize(parsed.root)).toBe(`<a xmlns="${XMLDSIG_NAMESPACE}"><b xmlns="${BANKID_NAMESPACE}"></b></a>`)
  })
})

describe('avvisningarna, en per sort', () => {
  it('ett flyttat Id: Id-värdena har bytt element', () => {
    let xml = replaceOnce(genuine(), 'Id="bidKeyInfo"', 'Id="TILLFÄLLIGT"')
    xml = replaceOnce(xml, 'Id="bidSignedData"', 'Id="bidKeyInfo"')
    xml = replaceOnce(xml, 'Id="TILLFÄLLIGT"', 'Id="bidSignedData"')

    expect(verify(resign(xml))).toEqual({ ok: false, reason: 'reference' })
  })

  it('ett flyttat Id: bidSignedData sitter på Object i stället för på bankIdSignedData', () => {
    let xml = replaceOnce(genuine(), ' Id="bidSignedData"', '')
    xml = replaceOnce(xml, '<Object>', '<Object Id="bidSignedData">')

    expect(verify(resign(xml))).toEqual({ ok: false, reason: 'unexpected_structure' })
  })

  it('ett dubbelt Id: två element har Id="bidSignedData"', () => {
    const xml = genuine()
    const evil = replaceOnce(signedDataElement(xml), usrNonVisible(xml), `<usrNonVisibleData>${b64('falskt')}</usrNonVisibleData>`)
    // Det falska står först, så att en läsare som tar det första elementet med Id:t läser det.
    const doubled = replaceOnce(xml, '<Object>', `<Object>${evil}`)

    expect(verify(resign(doubled))).toEqual({ ok: false, reason: 'duplicate_id' })
  })

  it('ett andra bankIdSignedData utanför referensen, i ett eget Object före det äkta', () => {
    const xml = genuine()
    const evil = replaceOnce(
      replaceOnce(signedDataElement(xml), ' Id="bidSignedData"', ''),
      usrNonVisible(xml),
      `<usrNonVisibleData>${b64('falskt')}</usrNonVisibleData>`,
    )
    const wrapped = replaceOnce(xml, '<Object>', `<Object>${evil}</Object><Object>`)

    expect(verify(resign(wrapped))).toEqual({ ok: false, reason: 'unexpected_structure' })
  })

  it('ett andra bankIdSignedData utanför referensen, bredvid det äkta i samma Object', () => {
    const xml = genuine()
    const evil = replaceOnce(
      replaceOnce(signedDataElement(xml), ' Id="bidSignedData"', ''),
      usrNonVisible(xml),
      `<usrNonVisibleData>${b64('falskt')}</usrNonVisibleData>`,
    )

    expect(verify(resign(replaceOnce(xml, '<Object>', `<Object>${evil}`)))).toEqual({
      ok: false,
      reason: 'unexpected_structure',
    })
  })

  it('ett ändrat usrNonVisibleData', () => {
    const xml = genuine()
    const changed = replaceOnce(xml, usrNonVisible(xml), `<usrNonVisibleData>${b64(SIGNED.replace('1:1', '1:2'))}</usrNonVisibleData>`)

    expect(verify(changed)).toEqual({ ok: false, reason: 'digest' })
  })

  it('en ändrad SignedInfo: digesten räknas om för ett ändrat innehåll, men underskriften kan inte göras om', () => {
    const xml = genuine()
    const changed = replaceOnce(xml, usrNonVisible(xml), `<usrNonVisibleData>${b64(SIGNED.replace('1:1', '1:2'))}</usrNonVisibleData>`)
    const parsed = parseXml(changed)
    if (!parsed.ok) throw new Error(parsed.reason)
    const digest = createHash('sha256')
      .update(canonicalize(firstWithId(parsed.root, 'bidSignedData')), 'utf8')
      .digest('base64')
    firstNamed(firstNamed(parsed.root, 'Reference'), 'DigestValue').text = digest

    expect(verify(serializeXml(parsed.root, parsed.declaration))).toEqual({ ok: false, reason: 'signature' })
  })

  it('fel algoritm: underskriften är RSA-SHA1', () => {
    const xml = replaceOnce(
      genuine(),
      'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    )

    expect(verify(resign(xml, { hash: 'sha1' }))).toEqual({ ok: false, reason: 'algorithm' })
  })

  it('fel algoritm: kanonisering med kommentarer', () => {
    const xml = replaceOnce(
      genuine(),
      '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315">',
      '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315#WithComments">',
    )

    expect(verify(resign(xml))).toEqual({ ok: false, reason: 'algorithm' })
  })

  it('fel algoritm: en annan transform i referensen', () => {
    const xml = genuine().replace(
      '<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315">',
      '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature">',
    )

    expect(verify(resign(xml))).toEqual({ ok: false, reason: 'algorithm' })
  })

  it('fel algoritm: digesten är SHA-1', () => {
    const xml = genuine().replace(
      '<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">',
      '<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1">',
    )

    expect(verify(resign(xml))).toEqual({ ok: false, reason: 'algorithm' })
  })

  it('en inskjuten kommentar, som inte ändrar digesten under kanonisering utan kommentarer', () => {
    const xml = genuine()
    const value = b64(SIGNED)
    const commented = replaceOnce(
      xml,
      `<usrNonVisibleData>${value}</usrNonVisibleData>`,
      `<usrNonVisibleData>${value.slice(0, 8)}<!---->${value.slice(8)}</usrNonVisibleData>`,
    )

    expect(verify(commented)).toEqual({ ok: false, reason: 'comment' })
  })

  it('namnrymdsknep: bankIdSignedData i en annan namnrymd', () => {
    const xml = replaceOnce(
      genuine(),
      `<bankIdSignedData xmlns="${BANKID_NAMESPACE}"`,
      '<bankIdSignedData xmlns="urn:falsk"',
    )

    expect(verify(resign(xml))).toEqual({ ok: false, reason: 'namespace' })
  })

  it('namnrymdsknep: usrNonVisibleData flyttat till ingen namnrymd med xmlns=""', () => {
    const xml = replaceOnce(genuine(), '<usrNonVisibleData>', '<usrNonVisibleData xmlns="">')

    expect(verify(resign(xml))).toEqual({ ok: false, reason: 'namespace' })
  })

  it('namnrymdsknep: ett prefix som pekar ut BankID:s namnrymd', () => {
    const xml = genuine()
    const value = b64(SIGNED)
    const prefixed = replaceOnce(
      xml,
      `<usrNonVisibleData>${value}</usrNonVisibleData>`,
      `<b:usrNonVisibleData xmlns:b="${BANKID_NAMESPACE}">${value}</b:usrNonVisibleData>`,
    )

    expect(verify(prefixed)).toEqual({ ok: false, reason: 'namespace' })
  })

  it('ändrade blanktecken i det signerade: radbrytning mellan elementen, som när XML:en formateras om', () => {
    // Inte om-signerat. En läsare som hoppar över blanktecken mellan element läser samma
    // träd som det signerade, och då stämmer digesten. Det är den läsaren testet fäller.
    const xml = replaceOnce(genuine(), '</usrVisibleData><usrNonVisibleData>', '</usrVisibleData>\n<usrNonVisibleData>')

    expect(verify(xml)).toEqual({ ok: false, reason: 'unexpected_structure' })
  })

  it('ändrade blanktecken i det signerade: mellanslag i base64, som en slapp avkodare hoppar över', () => {
    const xml = genuine()
    const value = b64(SIGNED)
    const spaced = replaceOnce(
      xml,
      `<usrNonVisibleData>${value}</usrNonVisibleData>`,
      `<usrNonVisibleData>${value.slice(0, 8)} ${value.slice(8)}</usrNonVisibleData>`,
    )

    expect(verify(resign(spaced))).toEqual({ ok: false, reason: 'unexpected_structure' })
  })

  it('ändrade blanktecken i det signerade: ett dubbelt mellanslag i texten väljaren såg', () => {
    const xml = genuine()
    const changed = replaceOnce(xml, b64(VISIBLE), b64(VISIBLE.replace('lägger min', 'lägger  min')))

    expect(verify(changed)).toEqual({ ok: false, reason: 'digest' })
  })
})

describe('det läsaren i övrigt avvisar', () => {
  it('DOCTYPE', () => {
    const xml = genuine().replace('?><Signature', '?><!DOCTYPE Signature><Signature')
    expect(verify(xml)).toEqual({ ok: false, reason: 'doctype' })
  })

  it('en entitetsreferens', () => {
    const xml = replaceOnce(genuine(), '<funcId>Signing</funcId>', '<funcId>Sign&#105;ng</funcId>')
    expect(verify(xml)).toEqual({ ok: false, reason: 'entity' })
  })

  it('en bearbetningsinstruktion', () => {
    const xml = genuine().replace('<Object>', '<Object><?php echo 1 ?>')
    expect(verify(xml)).toEqual({ ok: false, reason: 'processing_instruction' })
  })

  it('CDATA', () => {
    const xml = replaceOnce(genuine(), '<funcId>Signing</funcId>', '<funcId><![CDATA[Signing]]></funcId>')
    expect(verify(xml)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('ett okänt element i det signerade', () => {
    const xml = replaceOnce(genuine(), '<funcId>Signing</funcId>', '<funcId>Signing</funcId><extra>x</extra>')
    expect(verify(resign(xml))).toEqual({ ok: false, reason: 'unexpected_structure' })
  })

  it('ett okänt attribut', () => {
    const xml = replaceOnce(genuine(), '<SignatureValue>', '<SignatureValue Id="sv">')
    expect(verify(resign(xml))).toEqual({ ok: false, reason: 'unexpected_structure' })
  })

  it('fler referenser än två', () => {
    const xml = genuine()
    const reference = /<Reference URI="#bidKeyInfo">.*?<\/Reference>/.exec(xml)![0]
    expect(verify(resign(replaceOnce(xml, reference, reference + reference)))).toEqual({
      ok: false,
      reason: 'unexpected_structure',
    })
  })

  it('en legitimering i stället för en underskrift', () => {
    const xml = replaceOnce(genuine(), '<funcId>Signing</funcId>', '<funcId>Identification</funcId>')
    expect(verify(resign(xml))).toEqual({ ok: false, reason: 'unexpected_structure' })
  })

  it('ett självstängande element, som inte är kanonisk form', () => {
    const xml = genuine().replace(
      /<DigestMethod Algorithm="([^"]+)"><\/DigestMethod>/,
      '<DigestMethod Algorithm="$1"/>',
    )
    expect(verify(xml)).toEqual({ ok: false, reason: 'not_canonical' })
  })

  it('attribut i fel ordning, som inte är kanonisk form', () => {
    const xml = replaceOnce(
      genuine(),
      '<Reference Type="http://www.bankid.com/signature/v1.0.0/types" URI="#bidSignedData">',
      '<Reference URI="#bidSignedData" Type="http://www.bankid.com/signature/v1.0.0/types">',
    )
    expect(verify(xml)).toEqual({ ok: false, reason: 'not_canonical' })
  })

  it('ett dokument som är större än taket', () => {
    const xml = replaceOnce(genuine(), '<funcId>Signing</funcId>', `<funcId>Signing</funcId><x>${'a'.repeat(MAX_SIGNATURE_XML_BYTES)}</x>`)
    expect(verify(xml)).toEqual({ ok: false, reason: 'too_large' })
  })

  it('ett dokument som är djupare än taket', () => {
    const deep = '<a>'.repeat(40) + '</a>'.repeat(40)
    const xml = replaceOnce(genuine(), '<funcId>Signing</funcId>', `<funcId>Signing</funcId>${deep}`)
    expect(verify(xml)).toEqual({ ok: false, reason: 'too_large' })
  })

  it('ogiltig UTF-8', () => {
    const bytes = Buffer.concat([Buffer.from(genuine(), 'utf8'), Buffer.from([0xff])])
    expect(verifyBankIdSignature(bytes, { roots: [MOCK_ROOT], signedDuring: signedAt(new Date()) })).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  it('en kedja till en annan rot', () => {
    const fake = lookalikeHierarchy()
    const forgerKeys = rsaKeys('förfalskaren')
    const forgedLeaf = voterLeaf(forgerKeys, { personalNumber: VOTER, issuer: fake.issuer })
    const xml = genuine(SIGNED, [forgedLeaf, fake.intermediate], forgerKeys.privateKey)

    expect(verify(xml)).toEqual({ ok: false, reason: 'untrusted_root' })
  })

  it('en underskrift med en annan nyckel än lövets', () => {
    expect(verify(resign(genuine(), { key: rsaKeys('någon annan').privateKey }))).toEqual({
      ok: false,
      reason: 'signature',
    })
  })
})
