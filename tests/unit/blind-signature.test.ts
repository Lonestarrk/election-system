import { describe, expect, it } from 'vitest'
import {
  blind,
  fullDomainHash,
  generateElectionKeyPair,
  publicNumbers,
  signBlinded,
  unblind,
  verify,
  verifyViaNodeRsa,
} from '@/lib/blind-signature'

/**
 * Blinda signaturer är den mekanism som bär både valets riktighet och
 * valhemligheten. Ett tyst fel här skulle antingen släppa igenom påhittade
 * röster eller göra det möjligt att koppla en väljare till sin röst — och
 * ingetdera skulle synas i ett vanligt funktionstest.
 *
 * Testerna nedan prövar därför inte bara att det fungerar, utan att det
 * fortsätter att INTE fungera när någon försöker fuska.
 */

// Ett nyckelpar räcker för de flesta fallen. RSA-generering är dyrt och
// behöver inte upprepas per test.
const authority = generateElectionKeyPair()

/** Hela flödet, som det ser ut i verkligheten. */
function issueCredential(message: string, keys = authority): string {
  const blinded = blind(message, keys.publicKeyPem)
  const blindSignature = signBlinded(blinded.blinded, keys.privateKeyPem)
  return unblind(blindSignature, blinded.blindingFactor, keys.publicKeyPem)
}

describe('blinda signaturer — grundflödet', () => {
  it('ett blindat och signerat intyg verifierar efter avblindning', () => {
    const message = 'rostintyg-abc123'
    const signature = issueCredential(message)

    expect(verify(message, signature, authority.publicKeyPem)).toBe(true)
  })

  it('de två oberoende verifieringsvägarna är eniga', () => {
    // verify() räknar s^e med egen bigint-aritmetik, verifyViaNodeRsa() låter
    // Node göra samma sak. En egen modulär exponentiering som tyst räknar fel
    // vore annars svår att upptäcka: den skulle avvisa giltiga röster, inte
    // släppa igenom ogiltiga.
    const message = 'rostintyg-def456'
    const signature = issueCredential(message)

    expect(verify(message, signature, authority.publicKeyPem)).toBe(true)
    expect(verifyViaNodeRsa(message, signature, authority.publicKeyPem)).toBe(true)
  })

  it('signaturen är giltig för exakt det meddelande den utfärdades för', () => {
    const signature = issueCredential('rostintyg-ghi789')

    expect(verify('rostintyg-ghi790', signature, authority.publicKeyPem)).toBe(false)
    expect(verify('', signature, authority.publicKeyPem)).toBe(false)
  })
})

describe('blinda signaturer — obundenhet', () => {
  it('samma meddelande blindas till olika värden varje gång', () => {
    /**
     * Detta är kärnan i valhemligheten. Blindade myndigheten samma meddelande
     * till samma värde skulle den kunna känna igen intyget när det löses in,
     * och därmed koppla ihop väljaren med rösten.
     */
    const message = 'samma-meddelande'

    const first = blind(message, authority.publicKeyPem)
    const second = blind(message, authority.publicKeyPem)

    expect(first.blinded).not.toEqual(second.blinded)
    expect(first.blindingFactor).not.toEqual(second.blindingFactor)
  })

  it('det blindade värdet avslöjar inte meddelandets hash', () => {
    // Myndigheten ser bara `blinded`. Skulle den kunna räknas tillbaka till
    // meddelandets hash utan blindningsfaktorn vore blindningen verkningslös.
    const message = 'hemligt-intyg'
    const blinded = blind(message, authority.publicKeyPem)

    const hashHex = fullDomainHash(message, authority.publicKeyPem).toString(16)

    expect(blinded.blinded).not.toContain(hashHex)
    expect(blinded.blinded).not.toEqual(hashHex)
  })

  it('båda blindningarna av samma meddelande ger samma slutliga signatur', () => {
    /**
     * Blindningen ska vara osynlig i slutresultatet. Två väljare som råkat
     * begära intyg för samma meddelande får identiska signaturer — signaturen
     * bär alltså inget spår av vilken blindningsfaktor som användes, och kan
     * därför inte kopplas till ett visst utfärdandetillfälle.
     */
    const message = 'deterministiskt-resultat'

    expect(issueCredential(message)).toEqual(issueCredential(message))
  })
})

describe('blinda signaturer — förfalskningsförsök', () => {
  it('en signatur från en annan omröstnings nyckel avvisas', () => {
    // Eget nyckelpar per omröstning är det som hindrar att ett oanvänt intyg
    // från ett tidigare val löses in i nästa.
    const otherElection = generateElectionKeyPair()
    const message = 'intyg-fran-annat-val'

    const signature = issueCredential(message, otherElection)

    expect(verify(message, signature, otherElection.publicKeyPem)).toBe(true)
    expect(verify(message, signature, authority.publicKeyPem)).toBe(false)
  })

  it('en manipulerad signatur avvisas', () => {
    const message = 'intyg-att-manipulera'
    const signature = issueCredential(message)

    // Ändra en enda byte.
    const tampered =
      signature.slice(0, -2) + (signature.slice(-2) === '00' ? '01' : '00')

    expect(verify(message, tampered, authority.publicKeyPem)).toBe(false)
  })

  it('en påhittad signatur utan privat nyckel avvisas', () => {
    const message = 'intyg-utan-nyckel'
    const { byteLength } = publicNumbers(authority.publicKeyPem)

    expect(verify(message, 'ab'.repeat(byteLength), authority.publicKeyPem)).toBe(false)
    expect(verify(message, '00'.repeat(byteLength), authority.publicKeyPem)).toBe(false)
  })

  it('signaturer går inte att multiplicera ihop till en ny giltig signatur', () => {
    /**
     * RÅ RSA ÄR MULTIPLIKATIV: sig(a) * sig(b) mod n = sig(a*b mod n).
     *
     * Det är den klassiska attacken mot blinda signaturer, och skälet till att
     * meddelandet hashas över hela domänen innan det signeras. Utan
     * full-domain-hashning kunde en väljare med två utfärdade intyg räkna fram
     * ett tredje som aldrig utfärdats — alltså lägga en extra röst som ser
     * fullt auktoriserad ut.
     *
     * Med hashningen på plats är produkten med överväldigande sannolikhet inte
     * en giltig hash för något meddelande alls.
     */
    const { n } = publicNumbers(authority.publicKeyPem)

    const signatureA = BigInt('0x' + issueCredential('intyg-a'))
    const signatureB = BigInt('0x' + issueCredential('intyg-b'))

    const product = ((signatureA * signatureB) % n).toString(16).padStart(512, '0')

    for (const message of ['intyg-a', 'intyg-b', 'intyg-ab', 'intyg-a intyg-b']) {
      expect(verify(message, product, authority.publicKeyPem)).toBe(false)
    }
  })

  it('en signatur utanför modulusens intervall avvisas', () => {
    // s >= n är aldrig en giltig signatur. Utan kontrollen skulle s och s + n
    // vara utbytbara, vilket gör att samma intyg kan se ut som två olika.
    const { n, byteLength } = publicNumbers(authority.publicKeyPem)
    const message = 'intyg-utanfor-intervall'

    const signature = BigInt('0x' + issueCredential(message))
    const shifted = (signature + n).toString(16).padStart((byteLength + 1) * 2, '0')

    expect(verify(message, shifted, authority.publicKeyPem)).toBe(false)
  })
})
