import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalOptions, type BallotOption, type BallotShape } from '@/lib/crypto/ballot-encoding'
import { generateKeyPair } from '@/lib/crypto/elgamal'
import { registerGroupExponentiation } from '@/lib/crypto/group'
import { nativeModPow } from '@/lib/crypto/native-exponentiation'
import {
  verifyEncryptedBallot,
  verifyEncryptedBallotInSteps,
  type EncryptedBallot,
} from '@/lib/crypto/verify-ballot'
import { encryptBallot } from '@/lib/encrypt-client'
import { encryptedBallotSchema } from '@/lib/validation'
import fixture from './fixtures/ballot-26-before-14b.json'
import { seededRandomValues } from './seeded-random'

/**
 * BEVISEN ÄR DESAMMA SOM FÖRE UPPGIFT 14b, TAL FÖR TAL.
 *
 * Uppgift 14b ändrar hur varje potens räknas: med tabeller i webbläsaren och i
 * OpenSSL på servern. Den ändrar inte vad som räknas, vad som hashas, i vilken
 * ordning eller hur något kodas. Det är uppgift 14d:s sak, och den oberoende
 * verifieraren i uppgift 13 skrivs mot formatet.
 *
 * Fixturen krypterades med koden före ändringen och en känd slumpkälla (se
 * seeded-random.ts). Två riktningar prövas:
 *
 *   – den gamla valsedeln godkänns av den nya verifieringen, på båda vägarna;
 *   – den nya krypteringen, med samma slumptal, ger exakt den gamla valsedeln.
 *
 * Den andra riktningen är starkare än att nya bevis godkänns av den gamla
 * verifieringen: bevisen är identiska, så varje verifierare som godkände de
 * gamla godkänner de nya.
 */

const ballot = fixture.ballot as EncryptedBallot
const options = canonicalOptions(fixture.shape as BallotShape)
const choice = fixture.choice as BallotOption

function verify(candidate: EncryptedBallot): boolean {
  return verifyEncryptedBallot(
    fixture.publicKey,
    fixture.electionId,
    fixture.ballotId,
    options.length,
    candidate,
  )
}

/** Krypterar om fixturens val med fixturens slumpkälla, i samma ordning som när den skapades. */
function encryptWithFixtureSeed(): { publicKey: string; ballot: EncryptedBallot } {
  const spy = vi
    .spyOn(globalThis.crypto, 'getRandomValues')
    .mockImplementation(seededRandomValues(fixture.seed) as typeof crypto.getRandomValues)

  try {
    const keys = generateKeyPair()
    const publicKey = keys.publicKey.toString()
    return {
      publicKey,
      ballot: encryptBallot(publicKey, fixture.electionId, fixture.ballotId, options, choice),
    }
  } finally {
    spy.mockRestore()
  }
}

afterEach(() => registerGroupExponentiation(null))

describe('bevisens format före och efter uppgift 14b', () => {
  it('fixturen är en valsedel med 26 alternativ', () => {
    expect(options).toHaveLength(26)
    expect(ballot.ciphertext).toHaveLength(26)
    expect(ballot.proofs.components).toHaveLength(26)
  })

  it('en valsedel krypterad före ändringen godkänns efter den, i BigInt', () => {
    expect(verify(ballot)).toBe(true)
  }, 60_000)

  it('och i OpenSSL, i steg, som servern prövar den', async () => {
    registerGroupExponentiation(nativeModPow)
    const pauses: number[] = []
    const verdict = await verifyEncryptedBallotInSteps(
      fixture.publicKey,
      fixture.electionId,
      fixture.ballotId,
      options.length,
      ballot,
      async () => {
        pauses.push(pauses.length)
      },
    )

    expect(verdict).toBe(true)
    // En paus efter varje alternativs undergruppskontroll och en efter varje bevis.
    expect(pauses).toHaveLength(2 * options.length)
  })

  it('och av trådschemat, som sedan fixrunda 1 tolkar varje tal lika strikt som verifieringen', () => {
    // Formatet är oförändrat. Bara tolkningen är strängare: kanoniska tal,
    // högst 617 siffror, utmaningar och svar under q. Ett ärligt bevis har
    // alltid sådana tal, också ett från före uppgift 14b.
    expect(encryptedBallotSchema.safeParse(ballot).success).toBe(true)
  })

  it('samma slumptal ger byte för byte samma valsedel som före ändringen, med tabellerna', () => {
    const again = encryptWithFixtureSeed()

    // Nyckeln först: är den inte densamma har slumpströmmen hamnat i otakt, och
    // jämförelsen nedan säger ingenting om bevisen.
    expect(again.publicKey).toBe(fixture.publicKey)
    expect(again.ballot).toEqual(ballot)
  }, 60_000)

  it('och med OpenSSL registrerat', () => {
    registerGroupExponentiation(nativeModPow)
    const again = encryptWithFixtureSeed()

    expect(again.publicKey).toBe(fixture.publicKey)
    expect(again.ballot).toEqual(ballot)
  })

  it('en enda ändrad siffra underkänns, på båda vägarna', async () => {
    // Kontrasten. Utan den kunde en verifiering som godkände allt ha gett
    // gröna tester ovan.
    const tampered = structuredClone(ballot)
    const proof = tampered.proofs.components[1]!
    proof.response1 = (BigInt(proof.response1) + 1n).toString()

    expect(verify(tampered)).toBe(false)

    registerGroupExponentiation(nativeModPow)
    expect(
      await verifyEncryptedBallotInSteps(
        fixture.publicKey,
        fixture.electionId,
        fixture.ballotId,
        options.length,
        tampered,
        async () => {},
      ),
    ).toBe(false)
  }, 60_000)
})
