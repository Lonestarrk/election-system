import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalOptions,
  indexOfChoice,
  type BallotOption,
  type BallotShape,
} from '@/lib/crypto/ballot-encoding'
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
import fixture from './fixtures/ballot-26-14d.json'
import before14d from './fixtures/ballot-26-before-14b.json'
import { legacyEncryptBallot, legacyVerifyEncryptedBallot } from './legacy-ballot'
import { seededRandomValues } from './seeded-random'

/**
 * BEVISENS FORMAT, MED EN FIXTUR FÖR VARDERA FORMATET.
 *
 * Uppgift 14b ändrade hur varje potens räknas men inte vad som hashas, och
 * fixturen ballot-26-before-14b.json visade det: den krypterades med koden
 * före 14b och en känd slumpkälla (se seeded-random.ts), och samma frö gav
 * samma valsedel byte för byte efteråt.
 *
 * Uppgift 14d ändrar vad som hashas. Varje utmaning binder nu hela
 * chifferlistan, genom valsedelns chifferhash (se proofs.ts). Samma fixtur är
 * därför nu en valsedel i det gamla formatet, och den ska underkännas. Så ser
 * vart och ett av kuverten ut som lades före ändringen.
 *
 * ballot-26-14d.json är en valsedel i det nya formatet, krypterad på samma
 * sätt med ett eget frö. Den håller formatet fast: samma frö ska ge samma
 * valsedel byte för byte, så att en ändring av vad som hashas, i vilken
 * ordning eller hur det kodas syns här innan den når den oberoende
 * verifieraren i uppgift 13. transcript.test.ts räknar om varje utmaning i
 * den ur beskrivningen i proofs.ts.
 */

afterEach(() => registerGroupExponentiation(null))

/** Krypterar om med en fixturs frö: nyckelparet först, sedan valsedeln, som när fixturen skapades. */
function withSeed<T>(seed: string, run: () => T): T {
  const spy = vi
    .spyOn(globalThis.crypto, 'getRandomValues')
    .mockImplementation(seededRandomValues(seed) as typeof crypto.getRandomValues)
  try {
    return run()
  } finally {
    spy.mockRestore()
  }
}

describe('formatet före uppgift 14d', () => {
  const ballot = before14d.ballot as EncryptedBallot
  const options = canonicalOptions(before14d.shape as BallotShape)
  const choice = before14d.choice as BallotOption

  it('fixturen är en valsedel med 26 alternativ', () => {
    expect(options).toHaveLength(26)
    expect(ballot.ciphertext).toHaveLength(26)
    expect(ballot.proofs.components).toHaveLength(26)
  })

  it('är exakt det gamla formatet: den gamla krypteringen med fixturens frö ger fixturen byte för byte', () => {
    // Det här visar att tests/unit/crypto/legacy-ballot.ts är den gamla koden
    // och inte en gissning om den, så att testerna som bygger gamla kuvert med
    // den bygger sådana som verkligen låg i databaserna.
    registerGroupExponentiation(nativeModPow)
    const again = withSeed(before14d.seed, () => {
      const keys = generateKeyPair()
      const publicKey = keys.publicKey.toString()
      return {
        publicKey,
        ballot: legacyEncryptBallot(publicKey, before14d.electionId, before14d.ballotId, options, choice),
      }
    })

    expect(again.publicKey).toBe(before14d.publicKey)
    expect(again.ballot).toEqual(ballot)
  })

  it('och den gamla verifieringen godkänner den', () => {
    registerGroupExponentiation(nativeModPow)
    expect(
      legacyVerifyEncryptedBallot(before14d.publicKey, before14d.electionId, before14d.ballotId, 26, ballot),
    ).toBe(true)
  })

  it('samma frö genom den nya koden ändrar bara utmaningarna och de svar som beror på dem', () => {
    /**
     * Uppgift 14d ändrar vad utmaningen binder och ingenting annat. Slumptalen
     * dras i samma ordning som förut, så nyckeln, chiffren, hashen och varje
     * åtagande blir desamma, liksom den simulerade grenen, vars utmaning och
     * svar dras innan utmaningen räknas. Det som skiljer är den ärliga grenens
     * utmaning och svar, och summabevisets.
     */
    registerGroupExponentiation(nativeModPow)
    const again = withSeed(before14d.seed, () => {
      const keys = generateKeyPair()
      const publicKey = keys.publicKey.toString()
      return {
        publicKey,
        ballot: encryptBallot(publicKey, before14d.electionId, before14d.ballotId, options, choice),
      }
    })

    expect(again.publicKey).toBe(before14d.publicKey)
    expect(again.ballot.ciphertext).toEqual(ballot.ciphertext)
    expect(again.ballot.ciphertextHash).toBe(ballot.ciphertextHash)

    const chosen = indexOfChoice(options, choice)
    for (const [index, proof] of again.ballot.proofs.components.entries()) {
      const old = ballot.proofs.components[index]!
      const [honest, simulated] = index === chosen ? (['1', '0'] as const) : (['0', '1'] as const)

      expect([proof.a0, proof.b0, proof.a1, proof.b1], `åtagandena, alternativ ${index}`).toEqual([
        old.a0,
        old.b0,
        old.a1,
        old.b1,
      ])
      expect(proof[`challenge${simulated}`]).toBe(old[`challenge${simulated}`])
      expect(proof[`response${simulated}`]).toBe(old[`response${simulated}`])
      expect(proof[`challenge${honest}`]).not.toBe(old[`challenge${honest}`])
      expect(proof[`response${honest}`]).not.toBe(old[`response${honest}`])
    }

    const { sum } = again.ballot.proofs
    expect([sum.a, sum.b]).toEqual([ballot.proofs.sum.a, ballot.proofs.sum.b])
    expect(sum.challenge).not.toBe(ballot.proofs.sum.challenge)
    expect(sum.response).not.toBe(ballot.proofs.sum.response)

    // Och den nya valsedeln godkänns, där den gamla underkänns nedan.
    expect(
      verifyEncryptedBallot(before14d.publicKey, before14d.electionId, before14d.ballotId, 26, again.ballot),
    ).toBe(true)
  })

  it('trådschemat godtar den fortfarande, eftersom formen är densamma', () => {
    // Fälten och talens form har inte ändrats, bara vad utmaningarna binder.
    // Ett gammalt kuvert syns alltså inte på formen, bara när bevisen prövas.
    expect(encryptedBallotSchema.safeParse(ballot).success).toBe(true)
  })

  it('underkänns nu, i BigInt', () => {
    expect(
      verifyEncryptedBallot(before14d.publicKey, before14d.electionId, before14d.ballotId, 26, ballot),
    ).toBe(false)
  }, 60_000)

  it('och i OpenSSL, i steg, som servern prövar den, vid det första 0-eller-1-beviset', async () => {
    registerGroupExponentiation(nativeModPow)
    let pauses = 0
    const verdict = await verifyEncryptedBallotInSteps(
      before14d.publicKey,
      before14d.electionId,
      before14d.ballotId,
      26,
      ballot,
      async () => {
        pauses += 1
      },
    )

    expect(verdict).toBe(false)
    // En paus efter varje undergruppskontroll, och ingen efter något bevis:
    // talen och chiffren håller, och det första beviset säger nej.
    expect(pauses).toBe(26)
  })
})

describe('formatet sedan uppgift 14d', () => {
  const ballot = fixture.ballot as EncryptedBallot
  const options = canonicalOptions(fixture.shape as BallotShape)
  const choice = fixture.choice as BallotOption

  const verify = (candidate: EncryptedBallot) =>
    verifyEncryptedBallot(fixture.publicKey, fixture.electionId, fixture.ballotId, options.length, candidate)

  const encryptWithFixtureSeed = () =>
    withSeed(fixture.seed, () => {
      const keys = generateKeyPair()
      const publicKey = keys.publicKey.toString()
      return { publicKey, ballot: encryptBallot(publicKey, fixture.electionId, fixture.ballotId, options, choice) }
    })

  it('fixturen är en valsedel med 26 alternativ, och valets id har ett tecken utanför ASCII', () => {
    expect(options).toHaveLength(26)
    expect(ballot.ciphertext).toHaveLength(26)
    expect(ballot.proofs.components).toHaveLength(26)
    // Tecknen och byten skiljer sig, så att längdprefixen prövas i byte.
    expect(new TextEncoder().encode(fixture.electionId).length).toBeGreaterThan(fixture.electionId.length)
  })

  it('godkänns i BigInt', () => {
    expect(verify(ballot)).toBe(true)
  }, 60_000)

  it('och i OpenSSL, i steg, som servern prövar den', async () => {
    registerGroupExponentiation(nativeModPow)
    let pauses = 0
    const verdict = await verifyEncryptedBallotInSteps(
      fixture.publicKey,
      fixture.electionId,
      fixture.ballotId,
      options.length,
      ballot,
      async () => {
        pauses += 1
      },
    )

    expect(verdict).toBe(true)
    // En paus efter varje alternativs undergruppskontroll och en efter varje bevis.
    expect(pauses).toBe(2 * options.length)
  })

  it('och av trådschemat', () => {
    expect(encryptedBallotSchema.safeParse(ballot).success).toBe(true)
  })

  it('samma slumptal ger byte för byte samma valsedel, med tabellerna', () => {
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

  it('den gamla verifieringen underkänner den, så de två formaten godkänner aldrig varandra', () => {
    // En klient och en server med olika format underkänner varandras
    // valsedlar, åt båda hållen. Klienten och servern byggs därför i samma
    // commit och driftsätts i samma image.
    registerGroupExponentiation(nativeModPow)
    expect(
      legacyVerifyEncryptedBallot(fixture.publicKey, fixture.electionId, fixture.ballotId, 26, ballot),
    ).toBe(false)
  })
})
