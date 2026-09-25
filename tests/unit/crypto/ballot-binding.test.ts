import { describe, expect, it } from 'vitest'
import type { BallotOption } from '@/lib/crypto/ballot-encoding'
import { decryptWithSecret, encrypt, generateKeyPair, multiply, type Ciphertext } from '@/lib/crypto/elgamal'
import { G, G_INVERSE, P, Q, modPow, randomScalar } from '@/lib/crypto/group'
import {
  proveSumIsOne,
  startZeroOrOne,
  sumChallenge,
  verifySumIsOne,
  verifyZeroOrOne,
  zeroOrOneChallenge,
  type BallotBinding,
  type EqualityProof,
  type ZeroOrOneProof,
} from '@/lib/crypto/proofs'
// Serverns ingång registrerar OpenSSL, så att varje godkänt bevis räknas fort.
import '@/lib/crypto/server'
import {
  hashCiphertext,
  serialiseEqualityProof,
  serialiseZeroOrOneProof,
  verifyEncryptedBallotInSteps,
  type EncryptedBallot,
} from '@/lib/crypto/verify-ballot'
import { encryptBallot } from '@/lib/encrypt-client'

/**
 * UTMANINGEN BINDER HELA VALSEDELN (uppgift 14d, spec 4.4).
 *
 * Före uppgift 14d band ett 0-eller-1-bevis av chifferlistan bara sitt eget
 * chiffer, och summabeviset bara produkten av chiffren. Båda band valets och
 * valsedelns id, och 0-eller-1-beviset sitt index. Ett giltigt bevis kunde
 * därför, i princip, klippas ut ur en valsedel och sättas in i en annan. Nu
 * binder varje utmaning dessutom hela chifferlistan, genom valsedelns
 * chifferhash.
 *
 * Filen har två delar. Den första klipper ut ett bevis ur en valsedel och
 * sätter in det i en annan, och visar var verifieringen stoppar det. Den andra
 * prövar varje bundet fält för sig, ett i taget, direkt mot bevisen.
 */

const keys = generateKeyPair()
const publicKey = keys.publicKey.toString()
const ELECTION = 'val-bindning'
const BALLOT = 'valsedel-bindning'

const options: BallotOption[] = [
  { kind: 'BLANK' },
  { kind: 'PARTY', ballotPartyId: 'parti-a' },
  { kind: 'PARTY', ballotPartyId: 'parti-b' },
  { kind: 'PARTY', ballotPartyId: 'parti-c' },
]
const COUNT = options.length

/**
 * Var verifieringen underkände valsedeln.
 *
 * Verifieringen i steg pausar en gång efter varje alternativs
 * undergruppskontroll och en gång efter varje godkänt 0-eller-1-bevis (se
 * `ballotVerification` i verify-ballot.ts). Antalet pauser före svaret säger
 * därför vilken kontroll som sa nej.
 */
async function whereRejected(ballot: EncryptedBallot): Promise<string> {
  let pauses = 0
  const verdict = await verifyEncryptedBallotInSteps(publicKey, ELECTION, BALLOT, COUNT, ballot, async () => {
    pauses += 1
  })

  if (verdict) return 'godkänd'
  if (pauses < COUNT) return 'före bevisen'
  if (pauses < 2 * COUNT) return `0-eller-1-beviset för alternativ ${pauses - COUNT}`
  return 'summabeviset'
}

/** B med alternativ `index` ur A, chiffret och dess bevis tillsammans, och hashen omräknad. */
function splice(into: EncryptedBallot, from: EncryptedBallot, index: number): EncryptedBallot {
  const spliced = structuredClone(into)
  spliced.ciphertext[index] = structuredClone(from.ciphertext[index]!)
  spliced.proofs.components[index] = structuredClone(from.proofs.components[index]!)
  spliced.ciphertextHash = hashCiphertext(spliced.ciphertext)
  return spliced
}

function toCiphertext(pair: { c1: string; c2: string }): Ciphertext {
  return { c1: BigInt(pair.c1), c2: BigInt(pair.c2) }
}

describe('ett OR-bevis som klipps ut ur en valsedel och sätts in i en annan', () => {
  /**
   * Två väljare röstar i samma val på samma valsedel, på olika partier. Båda
   * valsedlarna har 0 i blankalternativet och i det sista alternativet, så en
   * valsedel med ett av de alternativen utbytt mot den andras är fortfarande
   * en giltig röst till innehållet. Bara bevisens bindning kan fälla den.
   */
  const first = encryptBallot(publicKey, ELECTION, BALLOT, options, options[1]!)
  const second = encryptBallot(publicKey, ELECTION, BALLOT, options, options[2]!)

  it('kontrasten: båda valsedlarna godkänns som de är', async () => {
    expect(await whereRejected(first)).toBe('godkänd')
    expect(await whereRejected(second)).toBe('godkänd')
  })

  it('den ihopklippta valsedeln är en giltig röst till innehållet', () => {
    // Utan det här säger testerna nedan inte att bindningen gör något: en
    // valsedel med två ettor fälls av summabeviset oavsett.
    const spliced = splice(second, first, 0)
    const plaintexts = spliced.ciphertext.map((pair) => decryptWithSecret(keys.privateKey, toCiphertext(pair)))
    expect(plaintexts).toEqual([0, 0, 1, 0])
  })

  it('underkänns vid det inklippta beviset och inte först vid summabeviset', async () => {
    /**
     * Före uppgift 14d gick det inklippta beviset igenom på sin nya plats,
     * eftersom det bara band sitt eget chiffer, valet, valsedeln och sitt
     * index, och alla fyra var desamma. Valsedeln underkändes ändå, men först
     * av summabeviset: det binder produkten av alla chiffer, produkten ändrades
     * av bytet, och ett nytt summabevis kräver summan av alla slumptal, också
     * den andra väljarens. Attacken fungerade alltså inte, men av det skälet.
     */
    expect(await whereRejected(splice(second, first, 0))).toBe('0-eller-1-beviset för alternativ 0')
  })

  it('och ett bevis som klipps in sist fäller redan det första, som binder hela listan', async () => {
    // Bytet sist i listan ändrar listan som valsedelns eget första bevis är
    // bundet till. Före uppgift 14d gick de tre första igenom, och det var
    // återigen summabeviset som sa nej.
    expect(await whereRejected(splice(second, first, COUNT - 1))).toBe('0-eller-1-beviset för alternativ 0')
  })
})

/**
 * VARJE FÄLT FÖR SIG.
 *
 * En ärlig valsedel och dess bevis, prövade direkt med verifyZeroOrOne och
 * verifySumIsOne. Varje test ändrar ett enda fält i bindningen och ingenting
 * annat, och varje test ska bli rött mot en utmaning som saknar just det
 * fältet. Rapporten för uppgift 14d visar körningarna mot sådana utmaningar.
 */
describe('utmaningen binder varje fält', () => {
  const honest = encryptBallot(publicKey, ELECTION, BALLOT, options, options[3]!)
  const ciphertexts = honest.ciphertext.map(toCiphertext)
  const components: ZeroOrOneProof[] = honest.proofs.components.map((proof) => ({
    a0: BigInt(proof.a0),
    b0: BigInt(proof.b0),
    a1: BigInt(proof.a1),
    b1: BigInt(proof.b1),
    challenge0: BigInt(proof.challenge0),
    challenge1: BigInt(proof.challenge1),
    response0: BigInt(proof.response0),
    response1: BigInt(proof.response1),
  }))
  const sum: EqualityProof = {
    a: BigInt(honest.proofs.sum.a),
    b: BigInt(honest.proofs.sum.b),
    challenge: BigInt(honest.proofs.sum.challenge),
    response: BigInt(honest.proofs.sum.response),
  }
  const product = ciphertexts.reduce((a, b) => multiply(a, b))
  const binding: BallotBinding = {
    electionId: ELECTION,
    ballotId: BALLOT,
    ciphertextHash: honest.ciphertextHash,
  }

  /** Bindningen för en annan chifferlista. */
  const bindingFor = (list: Ciphertext[]): BallotBinding => ({
    ...binding,
    ciphertextHash: hashCiphertext(list.map(({ c1, c2 }) => ({ c1: c1.toString(), c2: c2.toString() }))),
  })

  /** Vilka 0-eller-1-bevis som godkänns med den här bindningen, på sina egna platser. */
  const acceptedWith = (candidate: BallotBinding, list: Ciphertext[] = ciphertexts): number[] =>
    list.flatMap((ciphertext, index) =>
      verifyZeroOrOne(keys.publicKey, ciphertext, components[index]!, candidate, index) ? [index] : [],
    )

  it('kontrasten: med valsedelns egen bindning godkänns varje bevis', () => {
    expect(acceptedWith(binding)).toEqual([0, 1, 2, 3])
    expect(verifySumIsOne(keys.publicKey, product, sum, binding)).toBe(true)
  })

  it('valets id: varje bevis underkänns i ett annat val', () => {
    const other = { ...binding, electionId: 'val-annat' }
    expect(acceptedWith(other)).toEqual([])
    expect(verifySumIsOne(keys.publicKey, product, sum, other)).toBe(false)
  })

  it('valsedelns id: varje bevis underkänns på en annan valsedel i samma val', () => {
    const other = { ...binding, ballotId: 'valsedel-annan' }
    expect(acceptedWith(other)).toEqual([])
    expect(verifySumIsOne(keys.publicKey, product, sum, other)).toBe(false)
  })

  it('alternativets index: ett 0-eller-1-bevis underkänns på varje annan plats, med samma chiffer', () => {
    // Chiffret och bindningen är desamma. Det enda som skiljer är platsen.
    const movedAndAccepted: string[] = []
    for (const [index, ciphertext] of ciphertexts.entries()) {
      for (let place = 0; place < COUNT; place += 1) {
        if (place === index) continue
        if (verifyZeroOrOne(keys.publicKey, ciphertext, components[index]!, binding, place)) {
          movedAndAccepted.push(`beviset för ${index} på plats ${place}`)
        }
      }
    }
    expect(movedAndAccepted).toEqual([])
  })

  it('varje chiffer i listan: varje 0-eller-1-bevis underkänns när ett enda chiffer i listan byts', () => {
    /**
     * Chiffret på plats `changed` byts mot ett annat, och varje bevis prövas
     * med den nya listans hash och med chiffret på sin egen plats. Före
     * uppgift 14d gick varje bevis utom det för det bytta chiffret igenom.
     */
    const stillAccepted: string[] = []
    for (let changed = 0; changed < COUNT; changed += 1) {
      const list = ciphertexts.map((ciphertext, index) =>
        index === changed ? encrypt(keys.publicKey, 0n, randomScalar()) : ciphertext,
      )
      for (const index of acceptedWith(bindingFor(list), list)) {
        stillAccepted.push(`beviset för ${index}, när chiffret på plats ${changed} byttes`)
      }
    }
    expect(stillAccepted).toEqual([])
  })

  it('varje chiffer i listan: summabeviset underkänns när listan ändras men produkten står kvar', () => {
    /**
     * Två chiffer ändras så att produkten blir densamma: det ena gånger ett
     * chiffer av 0, det andra gånger dess invers. Före uppgift 14d band
     * summabeviset bara produkten och gick igenom för varje sådan lista.
     */
    const stillAccepted: number[] = []
    for (let changed = 0; changed < COUNT; changed += 1) {
      const partner = (changed + 1) % COUNT
      const shift = randomScalar()
      const zero = encrypt(keys.publicKey, 0n, shift)
      const inverse = { c1: modPow(zero.c1, Q - 1n, P), c2: modPow(zero.c2, Q - 1n, P) }

      const list = ciphertexts.map((ciphertext, index) =>
        index === changed ? multiply(ciphertext, zero) : index === partner ? multiply(ciphertext, inverse) : ciphertext,
      )
      const sameProduct = list.reduce((a, b) => multiply(a, b))
      expect(sameProduct).toEqual(product)

      if (verifySumIsOne(keys.publicKey, sameProduct, sum, bindingFor(list))) stillAccepted.push(changed)
    }
    expect(stillAccepted).toEqual([])
  })

  it('det inklippta beviset underkänns på sin nya plats, och godkänns på sin gamla', () => {
    // Samma sak som klipptestet ovan, direkt mot beviset.
    const other = encryptBallot(publicKey, ELECTION, BALLOT, options, options[1]!)
    const moved = toCiphertext(other.ciphertext[0]!)
    const movedProof = other.proofs.components[0]!
    const proof: ZeroOrOneProof = {
      a0: BigInt(movedProof.a0),
      b0: BigInt(movedProof.b0),
      a1: BigInt(movedProof.a1),
      b1: BigInt(movedProof.b1),
      challenge0: BigInt(movedProof.challenge0),
      challenge1: BigInt(movedProof.challenge1),
      response0: BigInt(movedProof.response0),
      response1: BigInt(movedProof.response1),
    }
    const newPlace = bindingFor([moved, ...ciphertexts.slice(1)])
    const oldPlace = { ...binding, ciphertextHash: other.ciphertextHash }

    expect(verifyZeroOrOne(keys.publicKey, moved, proof, newPlace, 0)).toBe(false)
    expect(verifyZeroOrOne(keys.publicKey, moved, proof, oldPlace, 0)).toBe(true)
  })
})

/**
 * UTMANINGEN BINDER VALETS PUBLIKA NYCKEL (ruling 132, fixrunda 1 av uppgift 14d).
 *
 * Granskaren av uppgift 14d visade det med prob 4. Utan h i transkriptet kan
 * den som väljer nyckeln efter utmaningen få ett bevis godkänt för ett
 * chiffer som inte krypterar det beviset påstår. Utmaningen räknas först, och
 * sedan väljs x ur verifieringens egna ekvationer och h = g^x.
 *
 * Ett fälttest som byter nyckeln säger ingenting här. En annan nyckel fäller
 * redan ekvationerna, med h i transkriptet eller utan. Testerna nedan bygger
 * därför själva förfalskningen. Angriparen måste lägga en nyckel i
 * transkriptet innan utmaningen finns, och den enda han kan lägga dit är en
 * han har valt före utmaningen. Här är det valets egen nyckel.
 */
describe('utmaningen binder valets publika nyckel', () => {
  const mod = (a: bigint) => ((a % Q) + Q) % Q
  const inverse = (a: bigint) => modPow(mod(a), Q - 2n, Q)
  const gPow = (e: bigint) => modPow(G, mod(e), P)

  it('ett 0-eller-1-bevis för ett chiffer utanför {0, 1} underkänns under en nyckel vald efter utmaningen', () => {
    /**
     * Ekvationerna, med c1 = g^r, c2 = g^β, a0 = g^w0, b0 = g^γ0, a1 = g^w1 och
     * b1 = g^γ1, där angriparen känner alla exponenter:
     *
     *   s0 = w0 + r·e0,  s1 = w1 + r·e1,  e0 + e1 = e
     *   x·s0 = γ0 + β·e0,  x·s1 = γ1 + (β − 1)·e1
     *
     * x elimineras, och kvar blir en andragradsekvation i e0. Den har en
     * lösning ungefär varannan gång, så försöket görs om med nya slumptal tills
     * den har det. Klartexten blir β − x·r, ett tal på omkring 2 047 bitar.
     */
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const [r, w0, w1, beta, gamma0, gamma1] = Array.from({ length: 6 }, () => randomScalar()) as [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ]
      const ciphertext = { c1: gPow(r), c2: gPow(beta) }
      const [a0, b0, a1, b1] = [gPow(w0), gPow(gamma0), gPow(w1), gPow(gamma1)]
      const binding: BallotBinding = {
        electionId: ELECTION,
        ballotId: BALLOT,
        ciphertextHash: hashCiphertext([{ c1: ciphertext.c1.toString(), c2: ciphertext.c2.toString() }]),
      }

      const e = zeroOrOneChallenge(keys.publicKey, binding, 0, [ciphertext.c1, ciphertext.c2, a0, b0, a1, b1])

      const A = mod(w1 + r * e)
      const B = mod(gamma1 + (beta - 1n) * e)
      const qa = mod(-r)
      const qb = mod(beta * A - gamma0 * r - B * r + (beta - 1n) * w0)
      const qc = mod(gamma0 * A - B * w0)
      const discriminant = mod(qb * qb - 4n * qa * qc)
      // q ≡ 3 (mod 4), så en kvadratrot är en enda exponentiering.
      const root = modPow(discriminant, (Q + 1n) / 4n, Q)
      if (mod(root * root) !== discriminant) continue

      const e0 = mod((mod(-qb) + root) * inverse(2n * qa))
      const e1 = mod(e - e0)
      const s0 = mod(w0 + r * e0)
      const s1 = mod(w1 + r * e1)
      const x = mod((gamma0 + beta * e0) * inverse(s0))
      const h = gPow(x)
      const proof: ZeroOrOneProof = { a0, b0, a1, b1, challenge0: e0, challenge1: e1, response0: s0, response1: s1 }

      // Förfalskningen håller: klartexten är varken 0 eller 1, och alla fyra
      // ekvationerna gäller under h. Utan det här säger testet ingenting.
      const plaintext = mod(beta - x * r)
      expect(plaintext === 0n || plaintext === 1n).toBe(false)
      const shifted = (ciphertext.c2 * G_INVERSE) % P
      expect([
        modPow(G, s0, P) === (a0 * modPow(ciphertext.c1, e0, P)) % P,
        modPow(h, s0, P) === (b0 * modPow(ciphertext.c2, e0, P)) % P,
        modPow(G, s1, P) === (a1 * modPow(ciphertext.c1, e1, P)) % P,
        modPow(h, s1, P) === (b1 * modPow(shifted, e1, P)) % P,
        mod(e0 + e1) === e,
      ]).toEqual([true, true, true, true, true])

      // Verifieraren räknar utmaningen med h och får en annan. Före rättelsen
      // var den densamma, och beviset godkändes.
      expect(verifyZeroOrOne(h, ciphertext, proof, binding, 0)).toBe(false)
      return
    }
    throw new Error('Andragradsekvationen saknade lösning i 64 försök.')
  })

  it('ett summabevis för en produkt som inte krypterar 1 underkänns under en nyckel vald efter utmaningen', () => {
    /**
     * Här räcker en linjär ekvation. Med C1 = g^R, C2 = g^β, a = g^w och b = g^γ
     * ger g^s = a·C1^e att s = w + R·e, och h^s = b·(C2/g)^e ger
     * x = (γ + (β − 1)·e) / s. Produkten krypterar då g^(β − x·R), inte g.
     */
    const [R, beta, w, gamma] = Array.from({ length: 4 }, () => randomScalar()) as [bigint, bigint, bigint, bigint]
    const product = { c1: gPow(R), c2: gPow(beta) }
    const [a, b] = [gPow(w), gPow(gamma)]
    const binding: BallotBinding = { electionId: ELECTION, ballotId: BALLOT, ciphertextHash: 'cd'.repeat(32) }

    const e = sumChallenge(keys.publicKey, binding, [product.c1, product.c2, a, b])
    const s = mod(w + R * e)
    const x = mod((gamma + (beta - 1n) * e) * inverse(s))
    const h = gPow(x)
    const proof: EqualityProof = { a, b, challenge: e, response: s }

    expect(mod(beta - x * R)).not.toBe(1n)
    const shifted = (product.c2 * G_INVERSE) % P
    expect([
      modPow(G, s, P) === (a * modPow(product.c1, e, P)) % P,
      modPow(h, s, P) === (b * modPow(shifted, e, P)) % P,
    ]).toEqual([true, true])

    expect(verifySumIsOne(h, product, proof, binding)).toBe(false)
  })
})

/**
 * SERVERN BINDER BEVISEN TILL HASHEN DEN SJÄLV RÄKNAR (fixrunda 1 av uppgift
 * 14d, granskarens prob 3).
 *
 * Sedan uppgift 14d binder bevisen chifferhashen, och det bjuder in till en
 * förenkling: att hoppa över jämförelsen mellan valsedelns hash och den
 * omräknade, eftersom bevisen ju binder hashen. Med klientens hash i
 * bindningen håller då en valsedel vars bevis och hash båda är en påhittad
 * hash X. Den underskrivna hashen och kuvertroten stämmer sedan inte med
 * chiffren. Testet i encrypt-client.test.ts byter bara hashen och fångar inte
 * det, eftersom bevisen där är bundna till den riktiga.
 */
describe('servern binder bevisen till hashen den själv räknar', () => {
  it('en valsedel vars bevis och hash båda är en påhittad hash underkänns', async () => {
    const vector = [0n, 1n, 0n, 0n]
    const nonces = vector.map(() => randomScalar())
    const ciphertexts = vector.map((message, index) => encrypt(keys.publicKey, message, nonces[index]!))
    const fake = 'f'.repeat(64)
    const binding: BallotBinding = { electionId: ELECTION, ballotId: BALLOT, ciphertextHash: fake }

    const components = ciphertexts.map((ciphertext, index) =>
      serialiseZeroOrOneProof(
        startZeroOrOne(keys.publicKey, ciphertext, vector[index] === 1n ? 1 : 0, nonces[index]!)(binding, index),
      ),
    )
    const sum = serialiseEqualityProof(
      proveSumIsOne(
        keys.publicKey,
        ciphertexts.reduce((a, b) => multiply(a, b)),
        nonces.reduce((a, b) => a + b, 0n),
        binding,
      ),
    )
    const ciphertext = ciphertexts.map(({ c1, c2 }) => ({ c1: c1.toString(), c2: c2.toString() }))
    const ballot = { ciphertext, proofs: { format: 2, components, sum }, ciphertextHash: fake } as EncryptedBallot

    // Chiffren är ärliga, och hashen är inte deras.
    expect(hashCiphertext(ciphertext)).not.toBe(fake)
    expect(await whereRejected(ballot)).toBe('före bevisen')
  })
})
