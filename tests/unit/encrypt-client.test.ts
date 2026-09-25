import { describe, expect, it } from 'vitest'
import { generateKeyPair } from '@/lib/crypto/elgamal'
import { canonicalOptions } from '@/lib/crypto/ballot-encoding'
import { encryptBallot, encryptBallotInSteps, hashCiphertext } from '@/lib/encrypt-client'
import { verifyEncryptedBallot } from '@/lib/crypto/verify-ballot'

const SHAPE = {
  allowsCandidateVote: false,
  parties: [
    { id: 'bp-s', displayOrder: 1, candidates: [] },
    { id: 'bp-m', displayOrder: 2, candidates: [] },
  ],
}

describe('krypterad valsedel', () => {
  it('servern accepterar en ärligt krypterad valsedel', () => {
    const keys = generateKeyPair()
    const options = canonicalOptions(SHAPE)
    const ballot = encryptBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options, {
      kind: 'PARTY',
      ballotPartyId: 'bp-m',
    })

    expect(
      verifyEncryptedBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options.length, ballot),
    ).toBe(true)
  })

  it('blank röst är ett giltigt val', () => {
    const keys = generateKeyPair()
    const options = canonicalOptions(SHAPE)
    const ballot = encryptBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options, {
      kind: 'BLANK',
    })

    expect(
      verifyEncryptedBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options.length, ballot),
    ).toBe(true)
  })

  it('två val på samma valsedel ger olika chiffer och olika hash', () => {
    const keys = generateKeyPair()
    const options = canonicalOptions(SHAPE)
    const first = encryptBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options, {
      kind: 'PARTY',
      ballotPartyId: 'bp-s',
    })
    const second = encryptBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options, {
      kind: 'PARTY',
      ballotPartyId: 'bp-s',
    })

    // Samma val, olika slumptal: chiffren får inte gå att jämföra.
    expect(first.ciphertextHash).not.toBe(second.ciphertextHash)
  })

  it('returnerar inget slumptal — det är hela kvittofriheten', () => {
    /**
     * Skulle slumptalet följa med kunde väljaren bevisa vad chiffret
     * innehåller, och då är kvittot ett bevis igen och röstköp möjligt.
     * Väljaren får bara hashen, som visar ATT rösten räknats, inte VAD.
     */
    const keys = generateKeyPair()
    const ballot = encryptBallot(
      keys.publicKey.toString(),
      'val-1',
      'vs-1',
      canonicalOptions(SHAPE),
      { kind: 'BLANK' },
    )

    expect(Object.keys(ballot).sort()).toEqual(['ciphertext', 'ciphertextHash', 'proofs'])
    expect(JSON.stringify(ballot)).not.toContain('nonce')
  })

  it('en pahittad hash avvisas', async () => {
    /**
     * Klienten far inte kunna pasta vad som helst om sitt eget chiffer.
     * Godtas hashen pa ord letar väljarens inklusionskontroll senare efter ett
     * värde som inte finns i den publicerade mangden — och felet syns forst
     * efter att kopplingen raderats.
     */
    const keys = generateKeyPair()
    const options = canonicalOptions(SHAPE)
    const ballot = encryptBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options, {
      kind: 'BLANK',
    })

    const tampered = { ...ballot, ciphertextHash: 'f'.repeat(64) }

    expect(
      verifyEncryptedBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options.length, tampered),
    ).toBe(false)
  })

  it('hashen beror på hela chifferlistan', () => {
    const a = hashCiphertext([{ c1: '2', c2: '3' }])
    const b = hashCiphertext([{ c1: '2', c2: '4' }])
    const c = hashCiphertext([{ c1: '3', c2: '2' }])

    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(a).toHaveLength(64)
  })
})

describe('krypteringen i steg, som röstsidan kör den', () => {
  /**
   * Röstsidan krypterar en komponent i taget och släpper fram webbläsaren
   * däremellan, så att den kan visa hur långt den kommit. Resultatet måste
   * vara en lika giltig valsedel som den som krypteras i ett svep, och det
   * enda som lämnar ett steg får vara hur långt krypteringen kommit.
   */
  it('ger en valsedel som servern accepterar', async () => {
    const keys = generateKeyPair()
    const options = canonicalOptions(SHAPE)
    const ballot = await encryptBallotInSteps(keys.publicKey.toString(), 'val-1', 'vs-1', options, {
      kind: 'PARTY',
      ballotPartyId: 'bp-s',
    })

    expect(
      verifyEncryptedBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options.length, ballot),
    ).toBe(true)
    expect(Object.keys(ballot).sort()).toEqual(['ciphertext', 'ciphertextHash', 'proofs'])
  })

  it('rapporterar bara antal, från noll till alla, och pausar mellan stegen', async () => {
    const keys = generateKeyPair()
    const options = canonicalOptions(SHAPE)
    const reported: unknown[][] = []
    let pauses = 0

    await encryptBallotInSteps(
      keys.publicKey.toString(),
      'val-1',
      'vs-1',
      options,
      { kind: 'BLANK' },
      (...args) => reported.push(args),
      async () => {
        pauses += 1
      },
    )

    // En komponent per alternativ, och sist ett steg där bevisen görs färdiga
    // och summabeviset räknas (uppgift 14d).
    const total = options.length + 1
    expect(reported).toEqual(
      Array.from({ length: total + 1 }, (_, done) => [done, total]),
    )
    expect(pauses).toBe(options.length + 1)
    expect(JSON.stringify(reported)).toMatch(/^[[\],\d]+$/)
  })
})
