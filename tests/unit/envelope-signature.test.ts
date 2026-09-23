import { describe, expect, it } from 'vitest'
import { MockBankIdService, selectDemoIdentity } from '@/modules/eligibility/bankid/MockBankIdService'
import {
  certificateBelongsTo,
  envelopePayload,
  parseEnvelopePayload,
  personalNumberFromCertificate,
  publicKeyFromCertificate,
  verifySignedPayload,
} from '@/modules/eligibility/bankid/envelope-signature'

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

/**
 * Uppdelningen nedan i två describe-block (`verifySignedPayload` och
 * `certificateBelongsTo`) ersätter den tidigare `verifyEnvelopeSignature`,
 * som slog ihop dem till en enda funktion. Fixrunda 1 av uppgift 9:s
 * granskning fångade att ett anropsställe hade blivit tautologiskt —
 * `certificateBelongsTo(certificate, personalNumberFromCertificate(certificate))`
 * är alltid sant — och att den kombinerade funktionens egen dokumentation då
 * gav en falsk trygghet om att "rätt person" verkligen kontrollerats. Genom
 * att dela upp dem kan den kryptografiska kontrollen (håller signaturen ihop
 * med certifikatet?) aldrig av misstag ersätta identitetskontrollen (är det
 * RÄTT certifikat, jämfört med något utifrån?) — se
 * `pending-vote.service.ts` för hur de två används tillsammans.
 */
describe('verifySignedPayload — den rena kryptografiska kontrollen', () => {
  it('en ärlig signatur håller mot sitt eget innehåll', async () => {
    const data = await signAs('199001011234')

    expect(verifySignedPayload(data.signature, data.certificate, envelopePayload(PAYLOAD))).toBe(
      true,
    )
  })

  it('en signatur håller kryptografiskt även när certifikatet tillhör fel person', async () => {
    /**
     * Poängen med uppdelningen: den här funktionen kontrollerar bara att
     * signaturen och innehållet hör ihop, aldrig vem. Kims signatur över
     * exakt samma innehåll är fullt giltig kryptografiskt — vem certifikatet
     * tillhör är `certificateBelongsTo`s jobb, prövat i egen describe nedan.
     */
    const data = await signAs('198505152345')

    expect(verifySignedPayload(data.signature, data.certificate, envelopePayload(PAYLOAD))).toBe(
      true,
    )
  })

  it('en signatur för ett annat innehåll avvisas', async () => {
    const data = await signAs('199001011234')

    expect(
      verifySignedPayload(
        data.signature,
        data.certificate,
        envelopePayload({ ...PAYLOAD, ballotId: 'vs-9' }),
      ),
    ).toBe(false)
  })

  it('en signatur för ett annat chiffer avvisas', async () => {
    const data = await signAs('199001011234')

    expect(
      verifySignedPayload(
        data.signature,
        data.certificate,
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

    expect(
      verifySignedPayload(
        data.signature,
        data.certificate,
        envelopePayload({ ...PAYLOAD, castSequence: 2 }),
      ),
    ).toBe(false)
  })

  it('en trasig signatur avvisas utan att kasta', async () => {
    const data = await signAs('199001011234')

    expect(verifySignedPayload('inte-base64!!', data.certificate, envelopePayload(PAYLOAD))).toBe(
      false,
    )
  })
})

describe('certificateBelongsTo — bara ett påstående, ingen kryptografi', () => {
  it('stämmer när personnumret matchar', async () => {
    const data = await signAs('199001011234')

    expect(certificateBelongsTo(data.certificate, '199001011234')).toBe(true)
  })

  it('stämmer inte för fel personnummer', async () => {
    /**
     * HÅLET SOM STÄNGS.
     *
     * Utan den här kontrollen är det SERVERN som påstår att Anna lade
     * rösten. Vem som helst med skrivrättighet till röstlängden kan påstå
     * det om vilken väljare som helst som ännu inte röstat, och den
     * relationella kontrollen i uppgift 10 fångar det inte — väljaren är ju
     * verklig.
     */
    const data = await signAs('198505152345')

    expect(certificateBelongsTo(data.certificate, '199001011234')).toBe(false)
  })

  it('jämförelsen mot certifikatet självt vore alltid sann — precis felet som stängdes', async () => {
    // Vaktar mot att det tautologiska anropet från fixrunda 1, fynd 2
    // (jämföra certifikatet mot sitt eget påstående) av misstag återinförs
    // någonstans och tas för en riktig kontroll.
    const data = await signAs('198505152345')

    expect(certificateBelongsTo(data.certificate, personalNumberFromCertificate(data.certificate)!)).toBe(
      true,
    )
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

it('nyckel och personnummer läses ur samma certifikat utan att störa varandra', async () => {
  /**
   * Uppgift 9 lagrar nyckeln (via `publicKeyFromCertificate`) och en HASH av
   * personnumret `personalNumberFromCertificate` läser — aldrig
   * certifikatet i sin helhet. Vaktar att de två funktionerna, som tolkar
   * samma radprefix var för sig, fortsätter vara konsekventa med varandra.
   */
  const data = await signAs('199001011234')

  expect(personalNumberFromCertificate(data.certificate)).toBe('199001011234')
  expect(publicKeyFromCertificate(data.certificate)).toMatch(/^-----BEGIN PUBLIC KEY-----/)
  expect(publicKeyFromCertificate(data.certificate)).not.toContain('personnummer:')
})
