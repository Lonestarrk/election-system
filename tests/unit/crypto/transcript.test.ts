import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { BallotOption } from '@/lib/crypto/ballot-encoding'
import { generateKeyPair } from '@/lib/crypto/elgamal'
import { P, Q } from '@/lib/crypto/group'
import {
  sumChallenge,
  sumTranscript,
  verifyZeroOrOne,
  zeroOrOneChallenge,
  zeroOrOneTranscript,
  type BallotBinding,
  type ZeroOrOneProof,
} from '@/lib/crypto/proofs'
// Serverns ingång registrerar OpenSSL, så att valsedlarna nedan prövas fort.
import '@/lib/crypto/server'
import { hashCiphertext, verifyEncryptedBallot, type EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { encryptBallot } from '@/lib/encrypt-client'
import fixture from './fixtures/ballot-26-14d.json'

/**
 * TRANSKRIPTET, SKRIVET EN GÅNG TILL UR BESKRIVNINGEN I proofs.ts.
 *
 * Uppgift 13 ska skriva en oberoende verifierare ur beskrivningen, utan att
 * läsa koden. Det här testet gör samma sak i liten skala: det bygger varje
 * transkript med node:crypto och Buffer, fält för fält så som kommentaren i
 * proofs.ts beskriver dem, och kräver samma byte och samma utmaning som
 * koden. Skiljer sig beskrivningen och koden åt blir testet rött, och en
 * verifierare skriven ur beskrivningen skulle ha underkänt varje valsedel.
 *
 * Ingenting här importerar kodningen ur src. Bara talen, gruppen och
 * funktionerna som prövas kommer därifrån.
 */

const OR_DOMAIN = 'valsystem/bevis/v2/noll-eller-ett'
const SUM_DOMAIN = 'valsystem/bevis/v2/summa'

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}

/** Längden i byte som fyra byte big-endian, och sedan texten som UTF-8. */
function lengthPrefixed(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8')
  return Buffer.concat([u32(bytes.length), bytes])
}

/** Ett tal i [0, p) som 256 byte big-endian, med inledande nollor. */
function element(value: bigint): Buffer {
  return Buffer.from(value.toString(16).padStart(512, '0'), 'hex')
}

/** Chifferlistans hash, som 32 byte: SHA-256 över "valsystem/chiffer/v1" och varje par, decimalt, med NUL före varje tal. */
function listDigest(list: Array<{ c1: string; c2: string }>): Buffer {
  const text = 'valsystem/chiffer/v1' + list.map(({ c1, c2 }) => `\u0000${c1}\u0000${c2}`).join('')
  return createHash('sha256').update(text, 'utf8').digest()
}

function independentOrTranscript(
  electionId: string,
  ballotId: string,
  key: bigint,
  index: number,
  digest: Buffer,
  values: bigint[],
): Buffer {
  return Buffer.concat([
    Buffer.from(OR_DOMAIN + '\u0000', 'ascii'),
    lengthPrefixed(electionId),
    lengthPrefixed(ballotId),
    element(key),
    u32(index),
    digest,
    ...values.map(element),
  ])
}

function independentSumTranscript(
  electionId: string,
  ballotId: string,
  key: bigint,
  digest: Buffer,
  values: bigint[],
): Buffer {
  return Buffer.concat([
    Buffer.from(SUM_DOMAIN + '\u0000', 'ascii'),
    lengthPrefixed(electionId),
    lengthPrefixed(ballotId),
    element(key),
    digest,
    ...values.map(element),
  ])
}

/** Utmaningen: SHA-256 över transkriptet, läst som ett tal big-endian, mod q. */
function independentChallenge(transcript: Buffer): bigint {
  return BigInt('0x' + createHash('sha256').update(transcript).digest('hex')) % Q
}

const randomElement = () => BigInt('0x' + randomBytes(256).toString('hex')) % P

function randomBinding(electionId: string, ballotId: string): BallotBinding {
  return { electionId, ballotId, ciphertextHash: randomBytes(32).toString('hex') }
}

/** En nyckel för proven av kodningen. Bevisens ekvationer räknas inte här. */
const KEY = randomElement()

describe('transkriptet är det som beskrivningen i proofs.ts säger', () => {
  it('0-eller-1-beviset, byte för byte, och utmaningen ur det', () => {
    for (let round = 0; round < 20; round += 1) {
      const binding = randomBinding(`val-${round}`, `valsedel-${round}`)
      const index = round * 7
      const values = [0, 1, 2, 3, 4, 5].map(randomElement) as [bigint, bigint, bigint, bigint, bigint, bigint]
      const key = randomElement()
      const expected = independentOrTranscript(
        binding.electionId,
        binding.ballotId,
        key,
        index,
        Buffer.from(binding.ciphertextHash, 'hex'),
        values,
      )

      expect(Buffer.from(zeroOrOneTranscript(key, binding, index, values)).equals(expected)).toBe(true)
      expect(zeroOrOneChallenge(key, binding, index, values)).toBe(independentChallenge(expected))
    }
  })

  it('summabeviset, byte för byte, och utmaningen ur det', () => {
    for (let round = 0; round < 20; round += 1) {
      const binding = randomBinding(`val-${round}`, `valsedel-${round}`)
      const values = [0, 1, 2, 3].map(randomElement) as [bigint, bigint, bigint, bigint]
      const key = randomElement()
      const expected = independentSumTranscript(
        binding.electionId,
        binding.ballotId,
        key,
        Buffer.from(binding.ciphertextHash, 'hex'),
        values,
      )

      expect(Buffer.from(sumTranscript(key, binding, values)).equals(expected)).toBe(true)
      expect(sumChallenge(key, binding, values)).toBe(independentChallenge(expected))
    }
  })

  it('har en fast längd för givna id:n, och talen 0 och p − 1 tar lika mycket plats som andra', () => {
    const binding = randomBinding('e', 'bb')
    const small = [0n, 1n, 2n, 3n, 4n, P - 1n] as const
    // Prefixet, två id:n med längdprefix, h, indexet, H och talen.
    expect(zeroOrOneTranscript(1n, binding, 0, small)).toHaveLength(34 + 5 + 6 + 256 + 4 + 32 + 6 * 256)
    expect(sumTranscript(P - 1n, binding, [0n, 1n, P - 1n, 5n])).toHaveLength(25 + 5 + 6 + 256 + 32 + 4 * 256)
  })

  it('med UUID som id är ett 0-eller-1-transkript 1 942 byte och ett summatranskript 1 417 byte', () => {
    const binding = randomBinding(randomUUID(), randomUUID())
    expect(zeroOrOneTranscript(KEY, binding, 0, [1n, 2n, 3n, 4n, 5n, 6n])).toHaveLength(1942)
    expect(sumTranscript(KEY, binding, [1n, 2n, 3n, 4n])).toHaveLength(1417)
  })

  it('valets publika nyckel står direkt efter valsedelns id, som 256 byte', () => {
    const binding = randomBinding('val', 'valsedel')
    const afterIds = OR_DOMAIN.length + 1 + (4 + 3) + (4 + 8)
    const or = Buffer.from(zeroOrOneTranscript(KEY, binding, 0, [1n, 2n, 3n, 4n, 5n, 6n]))
    const sum = Buffer.from(sumTranscript(KEY, binding, [1n, 2n, 3n, 4n]))

    expect(or.subarray(afterIds, afterIds + 256).equals(element(KEY))).toBe(true)
    const afterSumIds = SUM_DOMAIN.length + 1 + (4 + 3) + (4 + 8)
    expect(sum.subarray(afterSumIds, afterSumIds + 256).equals(element(KEY))).toBe(true)
  })

  it('ett id längdprefixas med antalet byte i UTF-8, inte antalet tecken', () => {
    // "å" är två byte. En verifierare som räknar tecken får fel längd och
    // underkänner varje valsedel i ett val vars id har ett sådant tecken.
    const binding = randomBinding('val-å', 'valsedel')
    const transcript = Buffer.from(zeroOrOneTranscript(KEY, binding, 0, [1n, 2n, 3n, 4n, 5n, 6n]))
    const afterDomain = OR_DOMAIN.length + 1

    expect(transcript.readUInt32BE(afterDomain)).toBe(6)
    expect(transcript.subarray(afterDomain + 4, afterDomain + 10).toString('utf8')).toBe('val-å')
  })
})

describe('ingenting i transkriptet kan läsas på två sätt', () => {
  const values = [1n, 2n, 3n, 4n, 5n, 6n] as const

  it('två id:n som gav samma kontext i det gamla formatet ger olika transkript nu', () => {
    // Förut var kontexten `${electionId}|${ballotId}|${index}`, och ett
    // lodstreck i ett id flyttade gränsen mellan fälten utan att strängen
    // ändrades. Id:n är UUID i dag, men formatet ska inte hänga på det.
    expect(`${'val|a'}|${'b'}|0`).toBe(`${'val'}|${'a|b'}|0`)

    const digest = randomBytes(32).toString('hex')
    const first = zeroOrOneTranscript(KEY, { electionId: 'val|a', ballotId: 'b', ciphertextHash: digest }, 0, values)
    const second = zeroOrOneTranscript(KEY, { electionId: 'val', ballotId: 'a|b', ciphertextHash: digest }, 0, values)
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false)
  })

  it('valets och valsedelns id kan inte byta innehåll med varandra', () => {
    const digest = randomBytes(32).toString('hex')
    const first = zeroOrOneTranscript(KEY, { electionId: 'ab', ballotId: 'c', ciphertextHash: digest }, 0, values)
    const second = zeroOrOneTranscript(KEY, { electionId: 'a', ballotId: 'bc', ciphertextHash: digest }, 0, values)
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false)
  })

  it('domänprefixen skiljer de två bevisen åt, och skiljer dem från det gamla formatet och chifferhashen', () => {
    const binding = randomBinding('val', 'valsedel')
    const or = Buffer.from(zeroOrOneTranscript(KEY, binding, 0, values))
    const sum = Buffer.from(sumTranscript(KEY, binding, [1n, 2n, 3n, 4n]))

    expect(or.subarray(0, OR_DOMAIN.length + 1).toString('latin1')).toBe(OR_DOMAIN + '\u0000')
    expect(sum.subarray(0, SUM_DOMAIN.length + 1).toString('latin1')).toBe(SUM_DOMAIN + '\u0000')
    // Inget av prefixen är början på ett annat, så inget transkript av det ena
    // slaget kan vara ett av det andra, och inget kan vara indata till de
    // gamla bevisen eller till chifferhashen.
    const prefixes = [OR_DOMAIN + '\u0000', SUM_DOMAIN + '\u0000', 'valsystem/bevis/v1\u0000', 'valsystem/chiffer/v1']
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a !== b) expect(b.startsWith(a), `${JSON.stringify(a)} börjar ${JSON.stringify(b)}`).toBe(false)
      }
    }
  })

  it('ett tal utanför [0, p) och en hash som inte är 64 små hextecken går inte in i transkriptet', () => {
    const binding = randomBinding('val', 'valsedel')
    expect(() => zeroOrOneTranscript(KEY, binding, 0, [P, 2n, 3n, 4n, 5n, 6n])).toThrow(RangeError)
    expect(() => zeroOrOneTranscript(KEY, binding, 0, [-1n, 2n, 3n, 4n, 5n, 6n])).toThrow(RangeError)
    expect(() => sumTranscript(KEY, binding, [1n, 2n, 3n, P + 5n])).toThrow(RangeError)
    // Nyckeln kodas som vilket tal som helst i transkriptet.
    expect(() => zeroOrOneTranscript(P, binding, 0, values)).toThrow(RangeError)
    expect(() => sumTranscript(-2n, binding, [1n, 2n, 3n, 4n])).toThrow(RangeError)
    expect(() => zeroOrOneTranscript(KEY, binding, -1, values)).toThrow(RangeError)
    expect(() => zeroOrOneTranscript(KEY, binding, 1.5, values)).toThrow(RangeError)

    for (const ciphertextHash of ['ab', binding.ciphertextHash.toUpperCase(), binding.ciphertextHash + '0']) {
      expect(() => zeroOrOneTranscript(KEY, { ...binding, ciphertextHash }, 0, values)).toThrow()
    }
  })

  it('ett id som inte är giltig Unicode går inte in i transkriptet', () => {
    // En ensam surrogathalva blir U+FFFD i UTF-8, och då hade de två id:na
    // nedan gett samma byte. Ett giltigt surrogatpar går igenom, som kontrast.
    expect(Buffer.from('val-\uD800', 'utf8').equals(Buffer.from('val-\uFFFD', 'utf8'))).toBe(true)

    const binding = randomBinding('val', 'valsedel')
    expect(() => zeroOrOneTranscript(KEY, { ...binding, electionId: 'val-\uD800' }, 0, values)).toThrow()
    expect(() => sumTranscript(KEY, { ...binding, ballotId: 'valsedel-\uDC00' }, [1n, 2n, 3n, 4n])).toThrow()
    expect(() => zeroOrOneTranscript(KEY, { ...binding, electionId: 'val-\uFFFD' }, 0, values)).not.toThrow()
    expect(() => zeroOrOneTranscript(KEY, { ...binding, electionId: 'val-\uD834\uDD1E' }, 0, values)).not.toThrow()
  })
})

/** Varje utmaning i en valsedel, räknad om ur beskrivningen och jämförd med den som står i valsedeln. */
function expectEveryChallengeAsDescribed(
  electionId: string,
  ballotId: string,
  key: bigint,
  ballot: EncryptedBallot,
): void {
  const digest = listDigest(ballot.ciphertext)
  expect(ballot.ciphertextHash).toBe(digest.toString('hex'))

  for (const [index, proof] of ballot.proofs.components.entries()) {
    const { c1, c2 } = ballot.ciphertext[index]!
    const transcript = independentOrTranscript(electionId, ballotId, key, index, digest, [
      BigInt(c1),
      BigInt(c2),
      BigInt(proof.a0),
      BigInt(proof.b0),
      BigInt(proof.a1),
      BigInt(proof.b1),
    ])
    expect((BigInt(proof.challenge0) + BigInt(proof.challenge1)) % Q, `alternativ ${index}`).toBe(
      independentChallenge(transcript),
    )
  }

  const product = ballot.ciphertext.reduce(
    (acc, { c1, c2 }) => ({ c1: (acc.c1 * BigInt(c1)) % P, c2: (acc.c2 * BigInt(c2)) % P }),
    { c1: 1n, c2: 1n },
  )
  const { sum } = ballot.proofs
  const transcript = independentSumTranscript(electionId, ballotId, key, digest, [
    product.c1,
    product.c2,
    BigInt(sum.a),
    BigInt(sum.b),
  ])
  expect(BigInt(sum.challenge), 'summabeviset').toBe(independentChallenge(transcript))
}

describe('fixturen i det nya formatet', () => {
  it('varje utmaning i den är den som beskrivningen ger', () => {
    // Den oberoende verifieraren i uppgift 13 kan pröva sig mot fixturen och
    // veta att den följer beskrivningen, inte bara koden.
    expectEveryChallengeAsDescribed(
      fixture.electionId,
      fixture.ballotId,
      BigInt(fixture.publicKey),
      fixture.ballot as EncryptedBallot,
    )
  })
})

describe('en riktig valsedel', () => {
  const keys = generateKeyPair()
  const publicKey = keys.publicKey.toString()
  // Ett id med ett tecken utanför ASCII, så att längdprefixet prövas på riktigt.
  const ELECTION = 'val-transkript-å'
  const BALLOT = 'valsedel-transkript'
  const options: BallotOption[] = [
    { kind: 'BLANK' },
    { kind: 'PARTY', ballotPartyId: 'parti-a' },
    { kind: 'PARTY', ballotPartyId: 'parti-b' },
  ]
  const ballot = encryptBallot(publicKey, ELECTION, BALLOT, options, options[2]!)

  it('godkänns', () => {
    expect(verifyEncryptedBallot(publicKey, ELECTION, BALLOT, options.length, ballot)).toBe(true)
  })

  it('valsedelns hash är den som beskrivningen ger, och den som går in i varje utmaning', () => {
    expect(ballot.ciphertextHash).toBe(listDigest(ballot.ciphertext).toString('hex'))
    expect(ballot.ciphertextHash).toBe(hashCiphertext(ballot.ciphertext))
  })

  it('varje utmaning i den är den som beskrivningen ger', () => {
    expectEveryChallengeAsDescribed(ELECTION, BALLOT, keys.publicKey, ballot)
  })

  it('ett bevis som prövas mot ett annat transkript underkänns, som kontrast', () => {
    const proof = ballot.proofs.components[0]!
    const parsed: ZeroOrOneProof = {
      a0: BigInt(proof.a0),
      b0: BigInt(proof.b0),
      a1: BigInt(proof.a1),
      b1: BigInt(proof.b1),
      challenge0: BigInt(proof.challenge0),
      challenge1: BigInt(proof.challenge1),
      response0: BigInt(proof.response0),
      response1: BigInt(proof.response1),
    }
    const ciphertext = { c1: BigInt(ballot.ciphertext[0]!.c1), c2: BigInt(ballot.ciphertext[0]!.c2) }
    const binding = { electionId: ELECTION, ballotId: BALLOT, ciphertextHash: ballot.ciphertextHash }

    expect(verifyZeroOrOne(keys.publicKey, ciphertext, parsed, binding, 0)).toBe(true)
    // Samma id med "a" i stället för "å": tre tecken lika, en byte kortare.
    expect(verifyZeroOrOne(keys.publicKey, ciphertext, parsed, { ...binding, electionId: 'val-transkript-a' }, 0)).toBe(
      false,
    )
  })
})
