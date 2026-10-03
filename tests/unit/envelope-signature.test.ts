import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORDER_LIFETIME_MS } from '@/lib/order-state'
import {
  MockBankIdService,
  resetMockBankIdOrders,
  selectDemoIdentity,
} from '@/modules/eligibility/bankid/MockBankIdService'
import {
  parseCertificateChain,
  signedAt,
  verifyCertificateChain,
} from '@/modules/eligibility/bankid/certificate-chain'
import {
  ciphertextCommitment,
  envelopePayload,
  legacyEnvelopePayload,
  newCommitmentSalt,
  parseEnvelopePayload,
  signingText,
  verifySignedPayload,
} from '@/modules/eligibility/bankid/envelope-signature'
import { MOCK_ROOT } from './bankid/forged-certificates'

const PAYLOAD = {
  electionId: 'val-1',
  ballotId: 'vs-1',
  ciphertextCommitment: 'a'.repeat(64),
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
        envelopePayload({ ...PAYLOAD, ciphertextCommitment: 'b'.repeat(64) }),
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
    const a = envelopePayload({ ...PAYLOAD, ballotId: 'vs-12', ciphertextCommitment: 'c'.repeat(64) })
    const b = envelopePayload({ ...PAYLOAD, ballotId: 'vs-1', ciphertextCommitment: '2' + 'c'.repeat(63) })

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

/**
 * DET SIGNERADE BÄR ETT ÅTAGANDE, INTE CHIFFERHASHEN (uppgift 11e).
 *
 * BankID sparar det väljaren skriver under, med hennes identitet. Bar det
 * chifferhashen fanns kopplingen mellan väljaren och chiffret kvar hos BankID
 * efter raderingen här. Åtagandet är en hash av chifferhashen och ett salt som
 * bara finns i PendingVote och raderas med raden.
 */
describe('åtagandet över chifferhashen', () => {
  const HASH = 'ab'.repeat(32)
  const SALT = '01'.repeat(32)

  it('följer kodningen exakt: SHA-256 över domänen, 0x00, hashens 32 byte och saltets 32 byte', () => {
    const expected = createHash('sha256')
      .update(
        Buffer.concat([
          Buffer.from('valsystem/bankid-atagande/v1', 'utf8'),
          Buffer.from([0]),
          Buffer.from(HASH, 'hex'),
          Buffer.from(SALT, 'hex'),
        ]),
      )
      .digest('hex')

    expect(ciphertextCommitment(HASH, SALT)).toBe(expected)
    // Testvektorn, räknad fristående med node:crypto innan koden skrevs.
    expect(ciphertextCommitment(HASH, SALT)).toBe(
      '2f7ba812e6a265664730d4ebc3c28d02f96efd37e8072d1d9e154dc5e0199ae5',
    )
  })

  it('ett annat salt ger ett annat åtagande, och hashen och saltet byter inte plats', () => {
    expect(ciphertextCommitment(HASH, '02'.repeat(32))).not.toBe(ciphertextCommitment(HASH, SALT))
    expect(ciphertextCommitment(SALT, HASH)).not.toBe(ciphertextCommitment(HASH, SALT))
  })

  it('tar bara 64 gemena hextecken för hashen och saltet, och kastar aldrig', () => {
    for (const bad of ['', 'ab', 'AB'.repeat(32), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      expect(ciphertextCommitment(bad, SALT), bad).toBeNull()
      expect(ciphertextCommitment(HASH, bad), bad).toBeNull()
    }
  })

  it('saltet är 32 slumpbyte som 64 gemena hextecken, nytt varje gång', () => {
    const salts = new Set(Array.from({ length: 20 }, () => newCommitmentSalt()))
    expect(salts.size).toBe(20)
    for (const salt of salts) expect(salt).toMatch(/^[0-9a-f]{64}$/)
  })

  it('nyttolasten bär åtagandet och inte chifferhashen', () => {
    const commitment = ciphertextCommitment(HASH, SALT)!
    const payload = envelopePayload({
      electionId: 'val-1',
      ballotId: 'vs-1',
      ciphertextCommitment: commitment,
      castSequence: 1,
    })

    expect(payload).toContain(commitment)
    expect(payload).not.toContain(HASH)
    expect(payload).not.toContain(SALT)
    expect(payload.startsWith('19:valsystem/kuvert/v2')).toBe(true)
  })

  it('det gamla formatet, med chifferhashen, går inte att läsa som det nya', () => {
    /**
     * Kuvert som lades före uppgift 11e är underskrivna över chifferhashen.
     * Läggningen ska inte ta emot en sådan underskrift, och valideringen känner
     * igen dem med `legacyEnvelopePayload`, som bara finns för det.
     */
    const legacy = legacyEnvelopePayload({
      electionId: 'val-1',
      ballotId: 'vs-1',
      ciphertextHash: HASH,
      castSequence: 1,
    })

    expect(legacy).toBe(`19:valsystem/kuvert/v15:val-14:vs-164:${HASH}1:1`)
    expect(parseEnvelopePayload(legacy)).toBeNull()
  })
})

describe('texten väljaren ser i BankID-appen', () => {
  it('säger på svenska vad som skrivs under, och bär varken hashen eller åtagandet', () => {
    const text = signingText('Valet 2026', 'RIKSDAG')

    expect(text).toContain('Valet 2026')
    expect(text).toMatch(/riksdagen/i)
    expect(text).toMatch(/krypterad/)
    expect(text).not.toMatch(/[0-9a-f]{16}/)
  })

  it('namnger valsedelns slag, inte kommunen eller regionen', () => {
    expect(signingText('Valet 2026', 'KOMMUN')).toMatch(/kommunfullmäktige/)
    expect(signingText('Valet 2026', 'LANDSTING')).toMatch(/regionfullmäktige/)
  })
})

/**
 * ATTRAPPENS ORDRAR FÖRFALLER (uppgift 11e, punkt 4).
 *
 * En signeringsorder bär det signerade och, när den skannats, personnumret.
 * Förut låg en övergiven order kvar tills servern startades om, eftersom den
 * bara togs bort när collect hämtade den.
 */
describe('attrappens ordrar förfaller efter orderns livslängd', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetMockBankIdOrders()
  })

  const mockOrders = () =>
    (globalThis as unknown as { mockBankIdOrders: Map<string, unknown> }).mockBankIdOrders

  async function startSign(service: MockBankIdService) {
    return service.sign({
      endUserIp: '127.0.0.1',
      userVisibleData: 'text',
      userNonVisibleData: envelopePayload(PAYLOAD),
    })
  }

  it('en övergiven order är borta efter livslängden, också utan collect', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const service = new MockBankIdService()
    const abandoned = await startSign(service)
    selectDemoIdentity(abandoned.orderRef, '199001011234')
    expect(mockOrders().has(abandoned.orderRef)).toBe(true)

    vi.setSystemTime(Date.now() + ORDER_LIFETIME_MS + 1)
    // Någon annan startar en order. Den övergivna ska vara bortstädad.
    await service.auth({ endUserIp: '127.0.0.1' })

    expect(mockOrders().has(abandoned.orderRef)).toBe(false)
    expect(JSON.stringify([...mockOrders().values()])).not.toContain('199001011234')
  })

  it('collect på en förfallen order svarar som BankID, expiredTransaction', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const service = new MockBankIdService()
    const order = await startSign(service)
    selectDemoIdentity(order.orderRef, '199001011234')

    vi.setSystemTime(Date.now() + ORDER_LIFETIME_MS + 1)

    expect(await service.collect(order.orderRef)).toEqual({
      status: 'failed',
      hintCode: 'expiredTransaction',
    })
    expect(selectDemoIdentity(order.orderRef, '199001011234')).toBe(false)
  })

  it('kontrasten: en order inom livslängden går att slutföra', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const service = new MockBankIdService()
    const order = await startSign(service)
    selectDemoIdentity(order.orderRef, '199001011234')
    vi.setSystemTime(Date.now() + ORDER_LIFETIME_MS - 1000)

    let result = await service.collect(order.orderRef)
    while (result.status === 'pending') result = await service.collect(order.orderRef)
    expect(result.status).toBe('complete')
  })
})
