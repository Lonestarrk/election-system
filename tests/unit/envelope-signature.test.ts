import { describe, expect, it } from 'vitest'
import { MockBankIdService, selectDemoIdentity } from '@/modules/eligibility/bankid/MockBankIdService'
import {
  envelopePayload,
  personalNumberFromCertificate,
  publicKeyFromCertificate,
  verifyEnvelopeSignature,
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

describe('signaturen binder rösten till väljaren', () => {
  it('en ärlig signatur går igenom', async () => {
    const data = await signAs('199001011234')

    expect(verifyEnvelopeSignature(data.signature, data.certificate, PAYLOAD, '199001011234')).toBe(
      true,
    )
  })

  it('en signatur från en annan person avvisas', async () => {
    /**
     * HÅLET SOM STÄNGS.
     *
     * Utan den här kontrollen är det SERVERN som påstår att Anna lade rösten.
     * Vem som helst med skrivrättighet till röstlängden kan påstå det om vilken
     * väljare som helst som ännu inte röstat, och den relationella kontrollen i
     * uppgift 10 fångar det inte — väljaren är ju verklig.
     */
    const data = await signAs('198505152345')

    expect(verifyEnvelopeSignature(data.signature, data.certificate, PAYLOAD, '199001011234')).toBe(
      false,
    )
  })

  it('en signatur för en annan valsedel avvisas', async () => {
    const data = await signAs('199001011234')

    expect(
      verifyEnvelopeSignature(
        data.signature,
        data.certificate,
        { ...PAYLOAD, ballotId: 'vs-9' },
        '199001011234',
      ),
    ).toBe(false)
  })

  it('en signatur för ett annat chiffer avvisas', async () => {
    const data = await signAs('199001011234')

    expect(
      verifyEnvelopeSignature(
        data.signature,
        data.certificate,
        { ...PAYLOAD, ciphertextHash: 'b'.repeat(64) },
        '199001011234',
      ),
    ).toBe(false)
  })

  it('en återuppspelad signatur med lägre räknare avvisas', async () => {
    /**
     * ÅTERUPPSPELNINGEN.
     *
     * Den som fångat väljarens FÖRSTA signerade kuvert kan annars skicka in det
     * igen efter att hon ändrat sig, och rösten återgår till den köpta. Det vore
     * ett röstköp som överlever hela ändringsmöjligheten — alltså precis det
     * modellen finns för att förhindra.
     *
     * Räknaren måste ligga INUTI det signerade, annars byts den bara ut.
     */
    const data = await signAs('199001011234', { ...PAYLOAD, castSequence: 1 })

    expect(
      verifyEnvelopeSignature(
        data.signature,
        data.certificate,
        { ...PAYLOAD, castSequence: 2 },
        '199001011234',
      ),
    ).toBe(false)
  })

  it('nyttolasten är entydig och går inte att förväxla', () => {
    // Med enbart avgränsare kan "vs-12" + "abc" och "vs-1" + "2abc" ge samma
    // sträng, och då flyttas en signatur mellan valsedlar utan att något ser
    // fel ut. Längdprefix stänger det.
    const a = envelopePayload({ ...PAYLOAD, ballotId: 'vs-12', ciphertextHash: 'c'.repeat(64) })
    const b = envelopePayload({ ...PAYLOAD, ballotId: 'vs-1', ciphertextHash: '2' + 'c'.repeat(63) })

    expect(a).not.toBe(b)
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
})
