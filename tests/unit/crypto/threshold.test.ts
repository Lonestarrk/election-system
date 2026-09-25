import { describe, expect, it } from 'vitest'
import { G, P, Q, modPow, randomScalar } from '@/lib/crypto/group'
import { discreteLog, encrypt, generateKeyPair, multiply, type Ciphertext } from '@/lib/crypto/elgamal'
import { partialDecryptionChallenge } from '@/lib/crypto/proofs'
import {
  combine,
  parsePartialDecryptionProof,
  partiallyDecrypt,
  publicShare,
  serialisePartialDecryptionProof,
  splitSecret,
  TRUSTEE_COUNT,
  TRUSTEE_THRESHOLD,
  verifyPartialDecryption,
  type PartialDecryption,
  type PartialDecryptionBinding,
} from '@/lib/crypto/threshold'

/** Valet, valsedeln och alternativet som bidragen i testerna gäller. */
const BINDING: PartialDecryptionBinding = {
  electionId: '6b1f2c3d-0000-4000-8000-000000000001',
  ballotId: '6b1f2c3d-0000-4000-8000-000000000002',
  optionIndex: 0,
}

/** Summan av inga röster: produkten av noll chiffer är ett i båda komponenterna. */
const NO_VOTES: Ciphertext = { c1: 1n, c2: 1n }

describe('delning av nyckeln', () => {
  it('valets tröskel är två av tre', () => {
    expect([TRUSTEE_THRESHOLD, TRUSTEE_COUNT]).toEqual([2, 3])
  })

  it('två av tre räcker för att öppna summan', () => {
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const sum = [1n, 1n, 0n, 1n]
      .map((m) => encrypt(keys.publicKey, m, randomScalar()))
      .reduce((a, b) => multiply(a, b))

    const partials = [shares[0]!, shares[2]!].map((share) => partiallyDecrypt(share, sum, BINDING))

    expect(discreteLog(combine(sum, partials), 100)).toBe(3)
  })

  it('vilka två som helst ger samma svar, och alla tre också', () => {
    // Lagrange-koefficienterna beror på vilka index som deltar. Räknas de fel
    // blir resultatet fel bara för vissa kombinationer — alltså ett fel som
    // uppträder på valnatten och inte i utvecklingen.
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const sum = encrypt(keys.publicKey, 5n, randomScalar())

    for (const group of [[0, 1], [0, 2], [1, 2], [0, 1, 2]]) {
      const partials = group.map((i) => partiallyDecrypt(shares[i]!, sum, BINDING))
      expect(discreteLog(combine(sum, partials), 100)).toBe(5)
    }
  })

  it('en ensam förtroendeman kan inte öppna någonting', () => {
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const sum = encrypt(keys.publicKey, 5n, randomScalar())

    expect(() => discreteLog(combine(sum, [partiallyDecrypt(shares[0]!, sum, BINDING)]), 100)).toThrow()
  })

  it('en summa av inga röster öppnas till noll', () => {
    // REVIEW FOCUS 6. Produkten av noll chiffer är (1, 1). Varje partiellt
    // värde är då 1, och den diskreta logaritmen ska svara 0, inte leta.
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const partials = [shares[1]!, shares[2]!].map((share) => partiallyDecrypt(share, NO_VOTES, BINDING))

    expect(partials.map((partial) => partial.value)).toEqual([1n, 1n])
    for (const [index, partial] of partials.entries()) {
      expect(verifyPartialDecryption(publicShare(shares[index + 1]!), NO_VOTES, partial, BINDING)).toBe(true)
    }
    expect(combine(NO_VOTES, partials)).toBe(1n)
    expect(discreteLog(combine(NO_VOTES, partials), 0)).toBe(0)
  })
})

describe('kombinationen vägrar det som annars blir tyst fel', () => {
  const keys = generateKeyPair()
  const shares = splitSecret(keys.privateKey, 3, 2)
  const sum = encrypt(keys.publicKey, 4n, randomScalar())
  const first = partiallyDecrypt(shares[0]!, sum, BINDING)
  const second = partiallyDecrypt(shares[1]!, sum, BINDING)

  it('samma förtroendeman två gånger kastar', () => {
    /**
     * Utan vakten utesluter den inre slingans `j === i` även dubblettens eget
     * index ur produkten, och Lagrange-koefficienten blir fel utan att något
     * kastar. Det unika indexet i databasen hindrar det i praktiken, men ett
     * felaktigt röstetal som inte kastar är den värsta felklassen i ett
     * räkneverk.
     */
    expect(() => combine(sum, [first, first])).toThrow('Samma förtroendeman bidrog två gånger.')
    expect(() => combine(sum, [first, second, { ...first }])).toThrow('Samma förtroendeman bidrog två gånger.')
  })

  it('ett index som inte är en förtroendepersons kastar', () => {
    // Index 0 är hemligheten själv, och ett index som inte är ett heltal
    // från 1 ger en koefficient som inte betyder något.
    for (const trusteeIndex of [0, -1, 1.5, Number.NaN]) {
      expect(() => combine(sum, [{ ...first, trusteeIndex }, second])).toThrow(RangeError)
    }
  })

  it('kontrasten: två olika förtroendepersoner öppnar summan', () => {
    expect(discreteLog(combine(sum, [first, second]), 10)).toBe(4)
  })
})

describe('bevis för partiell dekryptering', () => {
  it('ett ärligt bidrag går igenom', () => {
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const ciphertext = encrypt(keys.publicKey, 1n, randomScalar())
    const partial = partiallyDecrypt(shares[0]!, ciphertext, BINDING)

    expect(verifyPartialDecryption(publicShare(shares[0]!), ciphertext, partial, BINDING)).toBe(true)
  })

  it('ett påhittat värde avvisas', () => {
    // Utan beviset kan en förtroendeman skeva resultatet obemärkt: summan blir
    // fel och ingen kan peka ut vem som orsakade det.
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const ciphertext = encrypt(keys.publicKey, 1n, randomScalar())
    const partial = partiallyDecrypt(shares[0]!, ciphertext, BINDING)

    const tampered = { ...partial, value: (partial.value * G) % P }

    expect(verifyPartialDecryption(publicShare(shares[0]!), ciphertext, tampered, BINDING)).toBe(false)
  })

  it('ett värde utanför undergruppen avvisas, också när beviset går ihop', () => {
    /**
     * Granskningen av uppgift 14b, MINDRE 7. Beviset binder värdet bara upp
     * till tecknet: (p − v)^c = (−1)^c · v^c, så för en jämn utmaning håller
     * det också för p − v. En förtroendeman som känner sin andel kan pröva nya
     * åtaganden tills utmaningen blir jämn, och det gör testet här, precis som
     * granskaren, som fick igenom p − v på tredje försöket.
     */
    const keys = generateKeyPair()
    const [share] = splitSecret(keys.privateKey, 3, 2)
    const ciphertext = encrypt(keys.publicKey, 1n, randomScalar())
    const honest = partiallyDecrypt(share!, ciphertext, BINDING)
    const negated = P - honest.value
    const expectedShare = publicShare(share!)
    const transcriptBinding = { ...BINDING, trusteeIndex: share!.index }

    let forged: PartialDecryption | null = null
    for (let attempt = 0; attempt < 64 && forged === null; attempt += 1) {
      const commitment = randomScalar()
      const a = modPow(G, commitment, P)
      const b = modPow(ciphertext.c1, commitment, P)
      const challenge = partialDecryptionChallenge(transcriptBinding, [
        expectedShare,
        ciphertext.c1,
        ciphertext.c2,
        negated,
        a,
        b,
      ])
      if (challenge % 2n === 0n) {
        const response = (commitment + challenge * share!.value) % Q
        forged = { trusteeIndex: share!.index, value: negated, proof: { a, b, challenge, response } }
      }
    }

    // Ekvationerna håller verkligen för p − v. Utan det säger testet ingenting.
    const { proof } = forged!
    expect(modPow(ciphertext.c1, proof.response, P)).toBe((proof.b * modPow(negated, proof.challenge, P)) % P)
    expect(modPow(G, proof.response, P)).toBe((proof.a * modPow(expectedShare, proof.challenge, P)) % P)

    expect(verifyPartialDecryption(expectedShare, ciphertext, forged!, BINDING)).toBe(false)
    // Kontrasten: det ärliga bidraget godkänns fortfarande.
    expect(verifyPartialDecryption(expectedShare, ciphertext, honest, BINDING)).toBe(true)
  })

  it('ett bevis från ett annat chiffer avvisas', () => {
    /**
     * REVIEW FOCUS 4.
     *
     * En förtroendeman som återanvänder ett tidigare bevis kan annars bidra med
     * ett värde som inte hör till det chiffer som räknas, och k-1 ärliga
     * bidrag räcker då inte för att upptäcka det.
     */
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const first = encrypt(keys.publicKey, 1n, randomScalar())
    const second = encrypt(keys.publicKey, 1n, randomScalar())
    const partial = partiallyDecrypt(shares[0]!, first, BINDING)

    expect(verifyPartialDecryption(publicShare(shares[0]!), second, partial, BINDING)).toBe(false)
  })

  it('ett bevis binder chiffrets andra komponent, fast c2 inte ingår i ekvationerna', () => {
    // Ruling 133: utmaningen binder hela det aggregerade chiffret. Samma c1
    // med ett annat c2 är en annan summa, och beviset hör inte till den.
    const keys = generateKeyPair()
    const [share] = splitSecret(keys.privateKey, 3, 2)
    const ciphertext = encrypt(keys.publicKey, 2n, randomScalar())
    const partial = partiallyDecrypt(share!, ciphertext, BINDING)
    const otherSum = { c1: ciphertext.c1, c2: (ciphertext.c2 * G) % P }

    expect(verifyPartialDecryption(publicShare(share!), otherSum, partial, BINDING)).toBe(false)
  })
})

describe('beviset binder sitt sammanhang (ruling 133)', () => {
  /**
   * Två summor utan röster är samma chiffer, (1, 1), på varje valsedel och
   * för varje alternativ. Bara bindningen skiljer bidragen åt. Utan den hade
   * ett bevis kunnat flyttas mellan valsedlar, alternativ och val.
   */
  const keys = generateKeyPair()
  const shares = splitSecret(keys.privateKey, 3, 2)
  const share = shares[0]!
  const expected = publicShare(share)
  const partial = partiallyDecrypt(share, NO_VOTES, BINDING)

  it('kontrasten: bidraget håller för sin egen bindning', () => {
    expect(verifyPartialDecryption(expected, NO_VOTES, partial, BINDING)).toBe(true)
  })

  it.each([
    ['en annan valsedel', { ...BINDING, ballotId: '6b1f2c3d-0000-4000-8000-000000000003' }],
    ['ett annat val', { ...BINDING, electionId: '6b1f2c3d-0000-4000-8000-000000000004' }],
    ['ett annat alternativ', { ...BINDING, optionIndex: 1 }],
  ])('%s: samma bidrag avvisas', (_label, binding) => {
    expect(verifyPartialDecryption(expected, NO_VOTES, partial, binding)).toBe(false)
  })

  it('ett bidrag som lämnas i en annan förtroendepersons namn avvisas', () => {
    // Förtroendepersonens index står i utmaningen. Här prövas det mot samma
    // publika andel, så att det är indexet och inte andelen som fäller det.
    expect(verifyPartialDecryption(expected, NO_VOTES, { ...partial, trusteeIndex: 2 }, BINDING)).toBe(false)
  })
})

describe('primitiven försvarar sig själv', () => {
  const keys = generateKeyPair()
  const [share] = splitSecret(keys.privateKey, 3, 2)
  const expected = publicShare(share!)
  const ciphertext = encrypt(keys.publicKey, 1n, randomScalar())
  const partial = partiallyDecrypt(share!, ciphertext, BINDING)

  it('en partiell dekryptering av ett c1 utanför undergruppen kastar innan andelen används', () => {
    // REVIEW FOCUS 1. Ett element av ordning 2 läcker en bit av andelen.
    for (const c1 of [P - 1n, P - 4n, 0n, P]) {
      expect(() => partiallyDecrypt(share!, { c1, c2: ciphertext.c2 }, BINDING)).toThrow(RangeError)
    }
  })

  it('ett värde på ett när c1 inte är ett avvisas', () => {
    // Ett är det partiella värdet bara för summan av inga röster.
    expect(verifyPartialDecryption(expected, ciphertext, { ...partial, value: 1n }, BINDING)).toBe(false)
  })

  it('tal utanför sina intervall avvisas, utan att kasta (granskningen av uppgift 3)', () => {
    const { proof } = partial
    for (const forged of [
      { a: 0n },
      { a: P },
      { b: -1n },
      { challenge: Q },
      { challenge: -1n },
      { response: Q },
      { response: -1n },
    ]) {
      const candidate = { ...partial, proof: { ...proof, ...forged } }
      expect(verifyPartialDecryption(expected, ciphertext, candidate, BINDING)).toBe(false)
    }
    expect(verifyPartialDecryption(expected, ciphertext, { ...partial, value: P + partial.value }, BINDING)).toBe(false)
    expect(verifyPartialDecryption(1n, ciphertext, partial, BINDING)).toBe(false)
    expect(verifyPartialDecryption(expected, { c1: P - 1n, c2: ciphertext.c2 }, partial, BINDING)).toBe(false)
  })
})

describe('bevisets form i databasen och på tråden', () => {
  const keys = generateKeyPair()
  const [share] = splitSecret(keys.privateKey, 3, 2)
  const ciphertext = encrypt(keys.publicKey, 1n, randomScalar())
  const partial = partiallyDecrypt(share!, ciphertext, BINDING)

  it('rundgången ger samma bevis, och formatet står med', () => {
    const serialised = serialisePartialDecryptionProof(partial.proof)
    expect(serialised.format).toBe(2)
    expect(parsePartialDecryptionProof(JSON.parse(JSON.stringify(serialised)))).toEqual(partial.proof)
  })

  it('ett bevis i ett annat format, eller med ett tal som inte går att tolka, blir null', () => {
    const serialised = serialisePartialDecryptionProof(partial.proof)
    for (const broken of [
      { ...serialised, format: 1 },
      { ...serialised, format: undefined },
      { ...serialised, a: '0' },
      { ...serialised, b: P.toString() },
      { ...serialised, challenge: '-1' },
      { ...serialised, response: Q.toString() },
      { ...serialised, a: '07' },
      { ...serialised, challenge: 7 },
      null,
      'bevis',
      [],
    ]) {
      expect(parsePartialDecryptionProof(broken)).toBeNull()
    }
  })
})
