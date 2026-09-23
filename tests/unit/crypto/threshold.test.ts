import { describe, expect, it } from 'vitest'
import { G, P, modPow, randomScalar } from '@/lib/crypto/group'
import { discreteLog, encrypt, generateKeyPair, multiply } from '@/lib/crypto/elgamal'
import {
  combine,
  partiallyDecrypt,
  publicShare,
  splitSecret,
  verifyPartialDecryption,
} from '@/lib/crypto/threshold'

describe('delning av nyckeln', () => {
  it('två av tre räcker för att öppna summan', () => {
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const sum = [1n, 1n, 0n, 1n]
      .map((m) => encrypt(keys.publicKey, m, randomScalar()))
      .reduce((a, b) => multiply(a, b))

    const partials = [shares[0]!, shares[2]!].map((share) => partiallyDecrypt(share, sum))

    expect(discreteLog(combine(sum, partials), 100)).toBe(3)
  })

  it('vilka två som helst ger samma svar', () => {
    // Lagrange-koefficienterna beror på vilka index som deltar. Räknas de fel
    // blir resultatet fel bara för vissa kombinationer — alltså ett fel som
    // uppträder på valnatten och inte i utvecklingen.
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const sum = encrypt(keys.publicKey, 5n, randomScalar())

    for (const pair of [[0, 1], [0, 2], [1, 2]]) {
      const partials = pair.map((i) => partiallyDecrypt(shares[i]!, sum))
      expect(discreteLog(combine(sum, partials), 100)).toBe(5)
    }
  })

  it('en ensam förtroendeman kan inte öppna någonting', () => {
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const sum = encrypt(keys.publicKey, 5n, randomScalar())

    expect(() => discreteLog(combine(sum, [partiallyDecrypt(shares[0]!, sum)]), 100)).toThrow()
  })
})

describe('bevis för partiell dekryptering', () => {
  it('ett ärligt bidrag går igenom', () => {
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const ciphertext = encrypt(keys.publicKey, 1n, randomScalar())
    const partial = partiallyDecrypt(shares[0]!, ciphertext)

    expect(verifyPartialDecryption(publicShare(shares[0]!), ciphertext, partial)).toBe(true)
  })

  it('ett påhittat värde avvisas', () => {
    // Utan beviset kan en förtroendeman skeva resultatet obemärkt: summan blir
    // fel och ingen kan peka ut vem som orsakade det.
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const ciphertext = encrypt(keys.publicKey, 1n, randomScalar())
    const partial = partiallyDecrypt(shares[0]!, ciphertext)

    const tampered = { ...partial, value: (partial.value * G) % P }

    expect(verifyPartialDecryption(publicShare(shares[0]!), ciphertext, tampered)).toBe(false)
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
    const partial = partiallyDecrypt(shares[0]!, first)

    expect(verifyPartialDecryption(publicShare(shares[0]!), second, partial)).toBe(false)
  })
})
