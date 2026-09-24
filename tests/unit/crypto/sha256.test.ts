import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Q } from '@/lib/crypto/group'
import { challengeHash } from '@/lib/crypto/proofs'
import { sha256Hex } from '@/lib/crypto/sha256'
import { hashCiphertext } from '@/lib/crypto/verify-ballot'

/**
 * SHA-256 SKRIVEN FÖR HAND MÅSTE VARA EXAKT NODES SHA-256.
 *
 * Bevisens utmaningar och chifferhashen räknades tidigare med `createHash` ur
 * node:crypto. Den modulen finns inte i webbläsaren, och det var där
 * valsedeln ska krypteras. Samma funktion används nu på båda sidorna, och den
 * får inte skilja sig från den gamla med en enda bit: då skulle kuvert som
 * redan ligger i databasen sluta verifiera, och en ny valsedel från
 * webbläsaren se manipulerad ut för servern.
 *
 * Jämförelsen görs mot node:crypto, som är facit här. Testfilen körs bara i
 * Node och är det enda stället där det gamla beroendet finns kvar.
 */

function nodeSha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

describe('SHA-256', () => {
  it('ger standardens testvektorer', () => {
    // FIPS 180-2, bilaga B, och den tomma strängen.
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    )
  })

  it('stämmer med node:crypto för varje längd runt blockgränserna', () => {
    // Utfyllnaden är där en handskriven hash oftast går fel: 55, 56 och 64
    // byte avgör om längden får plats i sista blocket eller kräver ett till.
    for (let length = 0; length <= 300; length += 1) {
      const text = 'x'.repeat(length)
      expect(sha256Hex(text), `längd ${length}`).toBe(nodeSha256(text))
    }
  })

  it('stämmer med node:crypto för slumpade strängar, också utanför ASCII', () => {
    const alphabet = 'abcdef0123456789|\u0000-åäöÅÄÖ€✓𝄞'
    for (let round = 0; round < 500; round += 1) {
      const bytes = randomBytes(1 + (round % 97))
      const text = Array.from(bytes, (byte) => [...alphabet][byte % [...alphabet].length]).join('')
      expect(sha256Hex(text), JSON.stringify(text)).toBe(nodeSha256(text))
    }
  })
})

describe('bevisens och chiffrets hashar är oförändrade', () => {
  /**
   * De två funktionerna så som de såg ut med node:crypto, ordagrant utom
   * importen. Kuvert i databasen har sina hashar räknade så här.
   */
  function oldChallengeHash(context: string, values: bigint[]): bigint {
    const hash = createHash('sha256')
    hash.update('valsystem/bevis/v1\u0000')
    hash.update(context)
    for (const value of values) {
      hash.update('\u0000')
      hash.update(value.toString(16))
    }
    return BigInt('0x' + hash.digest('hex')) % Q
  }

  function oldHashCiphertext(ciphertext: Array<{ c1: string; c2: string }>): string {
    const hash = createHash('sha256')
    hash.update('valsystem/chiffer/v1')
    for (const pair of ciphertext) {
      hash.update('\u0000')
      hash.update(pair.c1)
      hash.update('\u0000')
      hash.update(pair.c2)
    }
    return hash.digest('hex')
  }

  const randomBig = () => BigInt('0x' + randomBytes(256).toString('hex'))

  it('challengeHash ger samma utmaning som förut', () => {
    for (let round = 0; round < 50; round += 1) {
      const context = `val-${round}|valsedel|${round - 1}`
      const values = Array.from({ length: 1 + (round % 7) }, randomBig)
      expect(challengeHash(context, values)).toBe(oldChallengeHash(context, values))
    }
  })

  it('hashCiphertext ger samma hash som förut', () => {
    for (let round = 0; round < 50; round += 1) {
      const ciphertext = Array.from({ length: 1 + (round % 30) }, () => ({
        c1: randomBig().toString(),
        c2: randomBig().toString(),
      }))
      expect(hashCiphertext(ciphertext)).toBe(oldHashCiphertext(ciphertext))
    }
  })
})
