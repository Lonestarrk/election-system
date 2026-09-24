import { describe, expect, it } from 'vitest'
import { MockBankIdService, selectDemoIdentity } from '@/modules/eligibility/bankid/MockBankIdService'
import {
  parseCertificateChain,
  signedAt,
  verifyCertificateChain,
} from '@/modules/eligibility/bankid/certificate-chain'
import {
  envelopePayload,
  parseEnvelopePayload,
  verifySignedPayload,
} from '@/modules/eligibility/bankid/envelope-signature'
import { MOCK_ROOT } from './bankid/forged-certificates'

const PAYLOAD = {
  electionId: 'val-1',
  ballotId: 'vs-1',
  ciphertextHash: 'a'.repeat(64),
  castSequence: 1,
}

async function signAs(personalNumber: string, payload = PAYLOAD) {
  const service = new MockBankIdService()
  const order = await service.sign({
    endUserIp: '127.0.0.1',
    userVisibleData: 'Rösta i Valet 2026',
    userNonVisibleData: envelopePayload(payload),
  })
  // Motsvarar att någon skannar QR-koden med sin BankID-app. Ligger medvetet
  // utanför `MockBankIdService` som en fristående funktion — se klassens
  // dokumentation för varför.
  selectDemoIdentity(order.orderRef, personalNumber)

  let result = await service.collect(order.orderRef)
  while (result.status === 'pending') result = await service.collect(order.orderRef)
  if (result.status !== 'complete') throw new Error('signeringen blev inte klar')

  return result.completionData
}

/** Lövets nyckel, ur en kedja som prövats mot attrappens rot. */
function signingKeyOf(certificateChain: readonly string[]) {
  const chain = parseCertificateChain(certificateChain)
  if (!chain) throw new Error('kedjan gick inte att läsa')

  const verdict = verifyCertificateChain(chain, { roots: [MOCK_ROOT], signedDuring: signedAt(new Date()) })
  if (!verdict.ok) throw new Error(`kedjan underkändes: ${verdict.reason}`)
  return verdict
}

describe('attrappen är en certifikatutfärdare', () => {
  it('ger varje underskrift en kedja till attrappens rot, med väljarens personnummer', async () => {
    const data = await signAs('199001011234')

    expect(data.certificateChain).toHaveLength(2)
    expect(signingKeyOf(data.certificateChain).personalNumber).toBe('199001011234')
  })

  it('skriver väljarens namn i certifikatet, som BankID gör', async () => {
    /**
     * Namnet och personnumret i klartext är skälet till att kedjan lagras
     * krypterad (src/modules/eligibility/sealed-chain.ts). Attrappen ska bära
     * dem som ett riktigt BankID-certifikat gör, annars prövas inte det skälet.
     */
    const data = await signAs('199001011234')
    const [leaf] = parseCertificateChain(data.certificateChain)!

    expect(leaf!.toLegacyObject().subject).toMatchObject({
      C: 'SE',
      CN: 'Anna Lindqvist',
      GN: 'Anna',
      SN: 'Lindqvist',
      serialNumber: '199001011234',
    })
  })

  it('certifikatets giltighetstid säger vilken dag, men inte när, väljaren skrev under', async () => {
    /**
     * Attrappen utfärdar ett certifikat per underskrift, och kedjan lagras i
     * röstlängden, där all tidsdata är avrundad till dygn. En giltighetstid från
     * sekunden för utfärdandet hade varit underskriftens tidpunkt.
     */
    const data = await signAs('199001011234')
    const [leaf] = parseCertificateChain(data.certificateChain)!
    const validFrom = leaf!.validFromDate

    expect([validFrom.getUTCHours(), validFrom.getUTCMinutes(), validFrom.getUTCSeconds()]).toEqual([0, 0, 0])
    expect(Date.now() - validFrom.getTime()).toBeLessThan(86_400_000)
  })

  it('en legitimering bär ingen kedja, eftersom ingenting skrivs under', async () => {
    const service = new MockBankIdService()
    const order = await service.auth({ endUserIp: '127.0.0.1' })
    selectDemoIdentity(order.orderRef, '199001011234')

    let result = await service.collect(order.orderRef)
    while (result.status === 'pending') result = await service.collect(order.orderRef)
    if (result.status !== 'complete') throw new Error('legitimeringen blev inte klar')

    expect(result.completionData.certificateChain).toEqual([])
    expect(result.completionData.signature).toBe('')
  })
})

/**
 * `verifySignedPayload` prövar bara att signaturen håller ihop med nyckeln,
 * för exakt det innehåll som påstås signerat. Att nyckeln är BankID:s prövas
 * av kedjan, och att den tillhör rätt väljare av identitetshashen, var för sig.
 */
describe('verifySignedPayload — den rena kryptografiska kontrollen', () => {
  it('en ärlig signatur håller mot sitt eget innehåll', async () => {
    const data = await signAs('199001011234')
    const { signingKey } = signingKeyOf(data.certificateChain)

    expect(verifySignedPayload(data.signature, signingKey, envelopePayload(PAYLOAD))).toBe(true)
  })

  it('en signatur håller kryptografiskt även när certifikatet tillhör fel person', async () => {
    /**
     * Poängen med uppdelningen: den här funktionen kontrollerar bara att
     * signaturen och innehållet hör ihop, aldrig vem. Kims signatur över exakt
     * samma innehåll är fullt giltig kryptografiskt. Vem certifikatet tillhör
     * avgör identitetshashen, i pending-vote.service.ts och i valideringen.
     */
    const data = await signAs('198505152345')
    const { signingKey } = signingKeyOf(data.certificateChain)

    expect(verifySignedPayload(data.signature, signingKey, envelopePayload(PAYLOAD))).toBe(true)
  })

  it('en signatur håller inte mot en annan väljares nyckel', async () => {
    const anna = await signAs('199001011234')
    const kim = await signAs('198505152345')

    expect(
      verifySignedPayload(anna.signature, signingKeyOf(kim.certificateChain).signingKey, envelopePayload(PAYLOAD)),
    ).toBe(false)
  })

  it('en signatur för ett annat innehåll avvisas', async () => {
    const data = await signAs('199001011234')
    const { signingKey } = signingKeyOf(data.certificateChain)

    expect(
      verifySignedPayload(data.signature, signingKey, envelopePayload({ ...PAYLOAD, ballotId: 'vs-9' })),
    ).toBe(false)
  })

  it('en signatur för ett annat chiffer avvisas', async () => {
    const data = await signAs('199001011234')
    const { signingKey } = signingKeyOf(data.certificateChain)

    expect(
      verifySignedPayload(
        data.signature,
        signingKey,
        envelopePayload({ ...PAYLOAD, ciphertextHash: 'b'.repeat(64) }),
      ),
    ).toBe(false)
  })

  it('en signatur för en annan räknare avvisas', async () => {
    /**
     * ÅTERUPPSPELNINGEN.
     *
     * Den som fångat väljarens FÖRSTA signerade kuvert kan annars skicka in
     * det igen efter att hon ändrat sig, och rösten återgår till den köpta.
     * Räknaren måste ligga INUTI det signerade — annars byts den bara ut.
     */
    const data = await signAs('199001011234', { ...PAYLOAD, castSequence: 1 })
    const { signingKey } = signingKeyOf(data.certificateChain)

    expect(
      verifySignedPayload(data.signature, signingKey, envelopePayload({ ...PAYLOAD, castSequence: 2 })),
    ).toBe(false)
  })

  it('en trasig signatur avvisas utan att kasta', async () => {
    const data = await signAs('199001011234')
    const { signingKey } = signingKeyOf(data.certificateChain)

    expect(verifySignedPayload('inte-base64!!', signingKey, envelopePayload(PAYLOAD))).toBe(false)
  })
})

describe('envelopePayload / parseEnvelopePayload', () => {
  it('nyttolasten är entydig och går inte att förväxla', () => {
    // Med enbart avgränsare kan "vs-12" + "abc" och "vs-1" + "2abc" ge samma
    // sträng, och då flyttas en signatur mellan valsedlar utan att något ser
    // fel ut. Längdprefix stänger det.
    const a = envelopePayload({ ...PAYLOAD, ballotId: 'vs-12', ciphertextHash: 'c'.repeat(64) })
    const b = envelopePayload({ ...PAYLOAD, ballotId: 'vs-1', ciphertextHash: '2' + 'c'.repeat(63) })

    expect(a).not.toBe(b)
  })

  it('läser tillbaka exakt de fält som kodades', () => {
    const payload = { ...PAYLOAD, ballotId: 'vs-42', castSequence: 7 }

    expect(parseEnvelopePayload(envelopePayload(payload))).toEqual(payload)
  })

  it('avvisar trasig indata i stället för att gissa', () => {
    expect(parseEnvelopePayload('skräp')).toBeNull()
    expect(parseEnvelopePayload('')).toBeNull()
    // Extra data efter sista fältet.
    expect(parseEnvelopePayload(envelopePayload(PAYLOAD) + 'extra')).toBeNull()
    // Ett fält avklippt mitt i.
    expect(parseEnvelopePayload(envelopePayload(PAYLOAD).slice(0, -5))).toBeNull()
  })
})

describe('BankID:s eget signerade innehåll', () => {
  it('completionData.signedData är exakt det som skickades in', async () => {
    /**
     * Grunden för fixrunda 1:s fix. `/api/vote/encrypted` litar på att det
     * här fältet är ordagrant — inte en approximation — annars vore hela
     * poängen med att sluta räkna om `castSequence` meningslös.
     */
    const data = await signAs('199001011234')

    expect(data.signedData).toBe(envelopePayload(PAYLOAD))
  })
})
