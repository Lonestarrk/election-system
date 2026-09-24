import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { canonicalOptions, type BallotShape } from '@/lib/crypto/ballot-encoding'
import { encrypt } from '@/lib/crypto/elgamal'
import { G, P, Q, isInSubgroup, modPow } from '@/lib/crypto/group'
import {
  MAX_CONCURRENT_VERIFICATIONS,
  generateKeyPair,
  inVerificationTurn,
  partiallyDecrypt,
  publicShare,
  splitSecret,
  verificationQueueState,
  verifyEncryptedBallotOnServer,
  verifyPartialDecryption,
} from '@/lib/crypto/server'
import {
  hashCiphertext,
  verifyEncryptedBallot,
  verifyEncryptedBallotInSteps,
  type EncryptedBallot,
} from '@/lib/crypto/verify-ballot'
import fixture from './fixtures/ballot-26-before-14b.json'

/**
 * SERVERNS INGÅNG TILL KRYPTOT, src/lib/crypto/server.ts.
 *
 * Tre saker ska gälla på servern, och de prövas här:
 *
 *   – varje exponentiering modulo p går i OpenSSL, också den med en hemlig
 *     exponent, så fort modulen är importerad;
 *   – en annan begäran besvaras medan en valsedel verifieras;
 *   – högst två verifieringar pågår samtidigt, i tur och ordning.
 */

// Varje exponent som når OpenSSL, så att testet kan se att en hemlig exponent
// faktiskt räknades där och inte i BigInt.
const seen = vi.hoisted(() => ({ exponents: [] as bigint[] }))

vi.mock('@/lib/crypto/native-exponentiation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crypto/native-exponentiation')>()
  return {
    nativeModPow: (base: bigint, exponent: bigint) => {
      seen.exponents.push(exponent)
      return actual.nativeModPow(base, exponent)
    },
  }
})

const ballot = fixture.ballot as EncryptedBallot
const optionCount = canonicalOptions(fixture.shape as BallotShape).length

describe('OpenSSL är registrerat så fort serverns ingång är importerad', () => {
  it('varje exponentiering modulo p går dit, också undergruppskontrollen', () => {
    seen.exponents.length = 0
    const element = modPow(G, 123_456_789n, P)

    expect(seen.exponents).toEqual([123_456_789n])
    expect(isInSubgroup(element)).toBe(true)
    expect(seen.exponents).toEqual([123_456_789n, Q - 1n])
  })

  it('valets privata nyckel och andelarna exponentieras där', () => {
    seen.exponents.length = 0
    const keys = generateKeyPair()
    expect(seen.exponents).toContain(keys.privateKey)

    const shares = splitSecret(keys.privateKey, 3, 2)
    seen.exponents.length = 0
    publicShare(shares[0]!)
    expect(seen.exponents).toEqual([shares[0]!.value])
  })

  it('förtroendemannens andel i den partiella dekrypteringen exponentieras där', () => {
    // Uppgift 12 bygger på partiallyDecrypt. Den som hämtar funktionen härifrån
    // får andelen räknad i OpenSSL, i konstant tid, och inte i BigInt.
    const keys = generateKeyPair()
    const [share] = splitSecret(keys.privateKey, 3, 2)
    const ciphertext = encrypt(keys.publicKey, 1n, 42n)

    seen.exponents.length = 0
    const partial = partiallyDecrypt(share!, ciphertext)

    expect(seen.exponents).toContain(share!.value)
    expect(partial.value).toBe(modPow(ciphertext.c1, share!.value, P))
    expect(verifyPartialDecryption(publicShare(share!), ciphertext, partial)).toBe(true)
  })
})

describe('en annan begäran besvaras medan en valsedel verifieras', () => {
  let server: Server
  let address: string

  beforeAll(async () => {
    server = createServer((_request, response) => response.end('svar'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /** Ordningen mellan svaret på en annan begäran och en verifiering som startar samtidigt. */
  async function race(verification: () => Promise<boolean>): Promise<string[]> {
    const events: string[] = []

    const verified = verification().then((verdict) => {
      events.push(`verifieringen klar: ${verdict}`)
    })
    const answered = fetch(address)
      .then((response) => response.text())
      .then((text) => {
        events.push(`den andra begäran besvarad: ${text}`)
      })

    await Promise.all([verified, answered])
    return events
  }

  it('servern svarar innan riksdagsvalsedeln med 26 alternativ är färdigprövad', async () => {
    const events = await race(() =>
      verifyEncryptedBallotOnServer(
        fixture.publicKey,
        fixture.electionId,
        fixture.ballotId,
        optionCount,
        ballot,
      ),
    )

    expect(events).toEqual(['den andra begäran besvarad: svar', 'verifieringen klar: true'])
  })

  it('kontrasten: med en paus som inte släpper fram I/O får begäran vänta till slutet', async () => {
    // Samma steg, men pausen är ett löfte som redan är uppfyllt. Det körs före
    // all I/O, så verifieringen kör klart i ett svep, precis som före uppgift
    // 14b. Det är setImmediate i server.ts som gör skillnaden, inte att
    // funktionen är asynkron.
    const events = await race(() =>
      verifyEncryptedBallotInSteps(
        fixture.publicKey,
        fixture.electionId,
        fixture.ballotId,
        optionCount,
        ballot,
        async () => {},
      ),
    )

    expect(events).toEqual(['verifieringen klar: true', 'den andra begäran besvarad: svar'])
  })
})

describe('verifieringarna går i tur och ordning', () => {
  /** En uppgift som håller sin plats tills testet släpper den. */
  function heldTask(log: string[], name: string) {
    let release!: () => void
    const done = new Promise<void>((resolve) => (release = resolve))
    const promise = inVerificationTurn(async () => {
      log.push(`start ${name}`)
      await done
      log.push(`slut ${name}`)
      return name
    })
    return { promise, release }
  }

  const settle = () => new Promise((resolve) => setImmediate(resolve))

  it('högst två samtidigt, och de väntande i den ordning de kom', async () => {
    expect(MAX_CONCURRENT_VERIFICATIONS).toBe(2)

    const log: string[] = []
    const tasks = ['a', 'b', 'c', 'd'].map((name) => heldTask(log, name))
    await settle()

    expect(log).toEqual(['start a', 'start b'])
    expect(verificationQueueState()).toEqual({ running: 2, waiting: 2 })

    tasks[1]!.release()
    await settle()
    expect(log).toEqual(['start a', 'start b', 'slut b', 'start c'])

    tasks[0]!.release()
    await settle()
    expect(log.slice(4)).toEqual(['slut a', 'start d'])

    tasks[2]!.release()
    tasks[3]!.release()
    expect(await Promise.all(tasks.map((task) => task.promise))).toEqual(['a', 'b', 'c', 'd'])
    expect(verificationQueueState()).toEqual({ running: 0, waiting: 0 })
  })

  it('en verifiering som kastar lämnar tillbaka sin plats', async () => {
    // Ett missformat tal i en databasrad kastar inne i verifieringen, och
    // anroparna gör det till BAD_PROOF. Utan finally hade varje sådan rad
    // minskat kapaciteten permanent, och efter två vore servern låst.
    const ciphertext = [{ c1: 'inte ett tal', c2: '1' }]
    const malformed: EncryptedBallot = {
      ciphertext,
      proofs: { components: [ballot.proofs.components[0]!], sum: ballot.proofs.sum },
      // Rätt hash, så att kastet kommer från BigInt och inte stoppas av hashkontrollen.
      ciphertextHash: hashCiphertext(ciphertext),
    }

    for (let round = 0; round < MAX_CONCURRENT_VERIFICATIONS + 1; round += 1) {
      await expect(
        verifyEncryptedBallotOnServer(fixture.publicKey, 'val', 'valsedel', 1, malformed),
      ).rejects.toThrow()
    }
    expect(verificationQueueState()).toEqual({ running: 0, waiting: 0 })
  })

  it('en valsedel som kommer när båda platserna är upptagna väntar, och prövas sedan', async () => {
    const log: string[] = []
    const holders = [heldTask(log, 'a'), heldTask(log, 'b')]
    await settle()

    let finished = false
    const waiting = verifyEncryptedBallotOnServer(
      fixture.publicKey,
      fixture.electionId,
      fixture.ballotId,
      optionCount,
      ballot,
    ).then((verdict) => {
      finished = true
      return verdict
    })
    await settle()

    expect(verificationQueueState()).toEqual({ running: 2, waiting: 1 })
    expect(finished).toBe(false)

    holders.forEach((holder) => holder.release())
    expect(await waiting).toBe(true)
    await Promise.all(holders.map((holder) => holder.promise))
    expect(verificationQueueState()).toEqual({ running: 0, waiting: 0 })
  })

  it('ger samma svar som verifieringen i ett svep', async () => {
    const tampered = structuredClone(ballot)
    tampered.proofs.sum.response = (BigInt(tampered.proofs.sum.response) + 1n).toString()

    for (const candidate of [ballot, tampered]) {
      expect(
        await verifyEncryptedBallotOnServer(
          fixture.publicKey,
          fixture.electionId,
          fixture.ballotId,
          optionCount,
          candidate,
        ),
      ).toBe(
        verifyEncryptedBallot(
          fixture.publicKey,
          fixture.electionId,
          fixture.ballotId,
          optionCount,
          candidate,
        ),
      )
    }
  })
})
