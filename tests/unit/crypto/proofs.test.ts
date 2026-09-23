import { describe, expect, it } from 'vitest'
import { P, randomScalar } from '@/lib/crypto/group'
import { encrypt, generateKeyPair, multiply, type Ciphertext } from '@/lib/crypto/elgamal'
import {
  challengeHash,
  proveSumIsOne,
  proveZeroOrOne,
  verifySumIsOne,
  verifyZeroOrOne,
} from '@/lib/crypto/proofs'

const CONTEXT = 'val-1|valsedel-2|index-0'

describe('0-eller-1-bevis', () => {
  it('ett ärligt bevis för 0 går igenom', () => {
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const ciphertext = encrypt(keys.publicKey, 0n, nonce)
    const proof = proveZeroOrOne(keys.publicKey, ciphertext, 0, nonce, CONTEXT)

    expect(verifyZeroOrOne(keys.publicKey, ciphertext, proof, CONTEXT)).toBe(true)
  })

  it('ett ärligt bevis för 1 går igenom', () => {
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const ciphertext = encrypt(keys.publicKey, 1n, nonce)
    const proof = proveZeroOrOne(keys.publicKey, ciphertext, 1, nonce, CONTEXT)

    expect(verifyZeroOrOne(keys.publicKey, ciphertext, proof, CONTEXT)).toBe(true)
  })

  it('avslöjar inte vilket av de två det var', () => {
    // Beviset är disjunktivt: verifieraren lär sig "0 eller 1", ingenting mer.
    // Skulle strukturen skilja sig åt vore varje röst läsbar ur sitt bevis.
    const keys = generateKeyPair()
    const zero = proveZeroOrOne(keys.publicKey, encrypt(keys.publicKey, 0n, 7n), 0, 7n, CONTEXT)
    const one = proveZeroOrOne(keys.publicKey, encrypt(keys.publicKey, 1n, 7n), 1, 7n, CONTEXT)

    expect(Object.keys(zero).sort()).toEqual(Object.keys(one).sort())
  })

  it('ett bevis för 2 går inte att framställa', () => {
    // Utan detta kan en väljare lägga hur många röster som helst på sin kandidat.
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const ciphertext = encrypt(keys.publicKey, 2n, nonce)

    // Den ärliga bevisaren kan bara påstå 0 eller 1, och båda blir falska.
    for (const claim of [0, 1] as const) {
      const proof = proveZeroOrOne(keys.publicKey, ciphertext, claim, nonce, CONTEXT)
      expect(verifyZeroOrOne(keys.publicKey, ciphertext, proof, CONTEXT)).toBe(false)
    }
  })

  it('ett bevis går inte att flytta till ett annat chiffer', () => {
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const mine = encrypt(keys.publicKey, 1n, nonce)
    const other = encrypt(keys.publicKey, 1n, randomScalar())
    const proof = proveZeroOrOne(keys.publicKey, mine, 1, nonce, CONTEXT)

    expect(verifyZeroOrOne(keys.publicKey, other, proof, CONTEXT)).toBe(false)
  })

  it('ett bevis går inte att flytta till en annan valsedel', () => {
    // Fiat–Shamir-utmaningen binder kontexten. Utan bindningen kunde ett giltigt
    // bevis klippas ut ur en valsedel och klistras in i en annan.
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const ciphertext = encrypt(keys.publicKey, 1n, nonce)
    const proof = proveZeroOrOne(keys.publicKey, ciphertext, 1, nonce, CONTEXT)

    expect(verifyZeroOrOne(keys.publicKey, ciphertext, proof, 'val-1|valsedel-9|index-0')).toBe(
      false,
    )
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
    const proof = proveSumIsOne(keys.publicKey, product, nonceSum, CONTEXT)

    expect(verifySumIsOne(keys.publicKey, product, proof, CONTEXT)).toBe(true)
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
      CONTEXT,
    )

    expect(verifySumIsOne(keys.publicKey, product, proof, CONTEXT)).toBe(false)
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
      CONTEXT,
    )

    expect(verifySumIsOne(keys.publicKey, product, proof, CONTEXT)).toBe(false)
  })
})

describe('utmaningen', () => {
  it('är deterministisk och beror på allt som matas in', () => {
    expect(challengeHash('a', [1n, 2n])).toBe(challengeHash('a', [1n, 2n]))
    expect(challengeHash('a', [1n, 2n])).not.toBe(challengeHash('b', [1n, 2n]))
    expect(challengeHash('a', [1n, 2n])).not.toBe(challengeHash('a', [1n, 3n]))
    expect(challengeHash('a', [1n, 2n])).not.toBe(challengeHash('a', [2n, 1n]))
  })
})
