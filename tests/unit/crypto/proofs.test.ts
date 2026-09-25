import { describe, expect, it, vi } from 'vitest'
import { Q, modPow, randomScalar } from '@/lib/crypto/group'
import { encrypt, generateKeyPair, multiply } from '@/lib/crypto/elgamal'
import {
  challengeHash,
  proveSumIsOne,
  proveZeroOrOne,
  startZeroOrOne,
  verifySumIsOne,
  verifyZeroOrOne,
  type BallotBinding,
} from '@/lib/crypto/proofs'
import { seededRandomValues } from './seeded-random'

/**
 * Bevisen var för sig. Vad utmaningen binder prövas fält för fält i
 * ballot-binding.test.ts, och transkriptet byte för byte i transcript.test.ts.
 * Hashen här står för en chifferlista som testerna inte behöver bygga.
 */
const BINDING: BallotBinding = {
  electionId: 'val-1',
  ballotId: 'valsedel-2',
  ciphertextHash: 'ab'.repeat(32),
}

describe('0-eller-1-bevis', () => {
  it('ett ärligt bevis för 0 går igenom', () => {
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const ciphertext = encrypt(keys.publicKey, 0n, nonce)
    const proof = proveZeroOrOne(keys.publicKey, ciphertext, 0, nonce, BINDING, 0)

    expect(verifyZeroOrOne(keys.publicKey, ciphertext, proof, BINDING, 0)).toBe(true)
  })

  it('ett ärligt bevis för 1 går igenom', () => {
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const ciphertext = encrypt(keys.publicKey, 1n, nonce)
    const proof = proveZeroOrOne(keys.publicKey, ciphertext, 1, nonce, BINDING, 0)

    expect(verifyZeroOrOne(keys.publicKey, ciphertext, proof, BINDING, 0)).toBe(true)
  })

  it('avslöjar inte vilket av de två det var', () => {
    // Beviset är disjunktivt: verifieraren lär sig "0 eller 1", ingenting mer.
    // Skulle strukturen skilja sig åt vore varje röst läsbar ur sitt bevis.
    const keys = generateKeyPair()
    const zero = proveZeroOrOne(keys.publicKey, encrypt(keys.publicKey, 0n, 7n), 0, 7n, BINDING, 0)
    const one = proveZeroOrOne(keys.publicKey, encrypt(keys.publicKey, 1n, 7n), 1, 7n, BINDING, 0)

    expect(Object.keys(zero).sort()).toEqual(Object.keys(one).sort())
  })

  it('ett bevis för 2 går inte att framställa', () => {
    // Utan detta kan en väljare lägga hur många röster som helst på sin kandidat.
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const ciphertext = encrypt(keys.publicKey, 2n, nonce)

    // Den ärliga bevisaren kan bara påstå 0 eller 1, och båda blir falska.
    for (const claim of [0, 1] as const) {
      const proof = proveZeroOrOne(keys.publicKey, ciphertext, claim, nonce, BINDING, 0)
      expect(verifyZeroOrOne(keys.publicKey, ciphertext, proof, BINDING, 0)).toBe(false)
    }
  })

  it('ett bevis går inte att flytta till ett annat chiffer', () => {
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const mine = encrypt(keys.publicKey, 1n, nonce)
    const other = encrypt(keys.publicKey, 1n, randomScalar())
    const proof = proveZeroOrOne(keys.publicKey, mine, 1, nonce, BINDING, 0)

    expect(verifyZeroOrOne(keys.publicKey, other, proof, BINDING, 0)).toBe(false)
  })

  it('ett påbörjat bevis görs färdigt en gång, och ett andra försök kastar', () => {
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const ciphertext = encrypt(keys.publicKey, 1n, nonce)
    const pending = startZeroOrOne(keys.publicKey, ciphertext, 1, nonce)

    const proof = pending(BINDING, 0)
    expect(verifyZeroOrOne(keys.publicKey, ciphertext, proof, BINDING, 0)).toBe(true)
    expect(() => pending({ ...BINDING, ballotId: 'valsedel-9' }, 0)).toThrow()
    // Inte heller med samma bindning: spärren frågar inte vad som skickas in.
    expect(() => pending(BINDING, 0)).toThrow()
  })

  it('kontrasten till spärren: två svar mot samma åtagande avslöjar slumptalet', () => {
    /**
     * Varför ett påbörjat bevis bara får göras färdigt en gång. Två påbörjade
     * bevis med samma slumpkälla har samma åtaganden, som ett och samma bevis
     * som görs färdigt två gånger. Med två olika bindningar blir utmaningarna
     * olika, och slumptalet faller ut ur de två ärliga svaren.
     */
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const ciphertext = encrypt(keys.publicKey, 1n, nonce)

    const startWithSeed = () => {
      const spy = vi
        .spyOn(globalThis.crypto, 'getRandomValues')
        .mockImplementation(seededRandomValues('samma-åtagande') as typeof crypto.getRandomValues)
      try {
        return startZeroOrOne(keys.publicKey, ciphertext, 1, nonce)
      } finally {
        spy.mockRestore()
      }
    }

    const first = startWithSeed()(BINDING, 0)
    const second = startWithSeed()({ ...BINDING, ballotId: 'valsedel-9' }, 0)
    expect(second.a1).toBe(first.a1)
    expect(second.challenge1).not.toBe(first.challenge1)

    // Gren 1 är den ärliga: svaret är w + c · r, för samma w.
    const difference = (first.challenge1 - second.challenge1 + Q) % Q
    const recovered = (((first.response1 - second.response1 + Q) % Q) * modPow(difference, Q - 2n, Q)) % Q
    expect(recovered).toBe(nonce)
  })

  it('ett bevis går inte att flytta till en annan valsedel', () => {
    // Fiat–Shamir-utmaningen binder valsedeln. Utan bindningen kunde ett giltigt
    // bevis klippas ut ur en valsedel och klistras in i en annan.
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const ciphertext = encrypt(keys.publicKey, 1n, nonce)
    const proof = proveZeroOrOne(keys.publicKey, ciphertext, 1, nonce, BINDING, 0)

    expect(
      verifyZeroOrOne(keys.publicKey, ciphertext, proof, { ...BINDING, ballotId: 'valsedel-9' }, 0),
    ).toBe(false)
  })
})

describe('summabevis', () => {
  const buildBallot = (publicKey: bigint, choiceIndex: number, length: number) => {
    const nonces = Array.from({ length }, () => randomScalar())
    const ciphertexts = nonces.map((nonce, index) =>
      encrypt(publicKey, index === choiceIndex ? 1n : 0n, nonce),
    )
    const nonceSum = nonces.reduce((a, b) => a + b, 0n)
    return { ciphertexts, nonceSum }
  }

  it('en giltig enhetsvektor går igenom', () => {
    const keys = generateKeyPair()
    const { ciphertexts, nonceSum } = buildBallot(keys.publicKey, 3, 8)
    const product = ciphertexts.reduce((a, b) => multiply(a, b))
    const proof = proveSumIsOne(keys.publicKey, product, nonceSum, BINDING)

    expect(verifySumIsOne(keys.publicKey, product, proof, BINDING)).toBe(true)
  })

  it('två ettor fångas trots att varje komponent är giltig', () => {
    /**
     * REVIEW FOCUS 5.
     *
     * Det farligaste felet i hela konstruktionen. Varje komponent kan bära ett
     * korrekt 0-eller-1-bevis och vektorn ändå innehålla två ettor — väljaren
     * har då lagt två röster. Bara summabeviset ser det.
     */
    const keys = generateKeyPair()
    const nonces = Array.from({ length: 8 }, () => randomScalar())
    const ciphertexts = nonces.map((nonce, index) =>
      encrypt(keys.publicKey, index === 2 || index === 5 ? 1n : 0n, nonce),
    )
    const product = ciphertexts.reduce((a, b) => multiply(a, b))
    const proof = proveSumIsOne(
      keys.publicKey,
      product,
      nonces.reduce((a, b) => a + b, 0n),
      BINDING,
    )

    expect(verifySumIsOne(keys.publicKey, product, proof, BINDING)).toBe(false)
  })

  it('en tom vektor fångas', () => {
    const keys = generateKeyPair()
    const nonces = Array.from({ length: 8 }, () => randomScalar())
    const ciphertexts = nonces.map((nonce) => encrypt(keys.publicKey, 0n, nonce))
    const product = ciphertexts.reduce((a, b) => multiply(a, b))
    const proof = proveSumIsOne(
      keys.publicKey,
      product,
      nonces.reduce((a, b) => a + b, 0n),
      BINDING,
    )

    expect(verifySumIsOne(keys.publicKey, product, proof, BINDING)).toBe(false)
  })
})

describe('utmaningen i formatet v1, som den partiella dekrypteringen använder', () => {
  it('är deterministisk och beror på allt som matas in', () => {
    expect(challengeHash('a', [1n, 2n])).toBe(challengeHash('a', [1n, 2n]))
    expect(challengeHash('a', [1n, 2n])).not.toBe(challengeHash('b', [1n, 2n]))
    expect(challengeHash('a', [1n, 2n])).not.toBe(challengeHash('a', [1n, 3n]))
    expect(challengeHash('a', [1n, 2n])).not.toBe(challengeHash('a', [2n, 1n]))
  })
})
