import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { canonicalOptions, type BallotShape } from '@/lib/crypto/ballot-encoding'
import { encrypt } from '@/lib/crypto/elgamal'
import { G, P, Q, isInSubgroup, modPow } from '@/lib/crypto/group'
import {
  MAX_CONCURRENT_VERIFICATIONS,
  MAX_WAITING_VERIFICATIONS,
  VerificationAborted,
  VerificationQueueFull,
  generateKeyPair,
  inVerificationTurn,
  partiallyDecrypt,
  publicShare,
  splitSecret,
  verificationQueueIsFull,
  verificationQueueState,
  verifyEncryptedBallotOnServer,
  verifyPartialDecryption,
  type VerificationRequest,
} from '@/lib/crypto/server'
import {
  hashCiphertext,
  verifyEncryptedBallot,
  verifyEncryptedBallotInSteps,
  type EncryptedBallot,
} from '@/lib/crypto/verify-ballot'
import fixture from './fixtures/ballot-26-14d.json'

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
  function heldTask(log: string[], name: string, request?: VerificationRequest) {
    let release!: () => void
    const done = new Promise<void>((resolve) => (release = resolve))
    const promise = inVerificationTurn(async () => {
      log.push(`start ${name}`)
      await done
      log.push(`slut ${name}`)
      return name
    }, request)
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
    // Ett missformat tal i en databasrad kastade förut inne i verifieringen.
    // Sedan fixrunda 1 av uppgift 14b underkänner tolkningen det i stället,
    // men verifieringen kastar fortfarande på en trasig nyckel, som är
    // serverns egen. Utan finally hade varje sådant kast minskat kapaciteten
    // permanent, och efter två vore servern låst.
    for (let round = 0; round < MAX_CONCURRENT_VERIFICATIONS + 1; round += 1) {
      await expect(
        verifyEncryptedBallotOnServer('inte en nyckel', 'val', 'valsedel', optionCount, ballot),
      ).rejects.toThrow()
    }
    expect(verificationQueueState()).toEqual({ running: 0, waiting: 0 })

    // Kontrasten: ett tal som inte går att tolka underkänner valsedeln utan
    // att kasta, och lämnar också tillbaka sin plats.
    const ciphertext = [{ c1: 'inte ett tal', c2: '1' }]
    const malformed: EncryptedBallot = {
      ciphertext,
      // Formatmarkören och rätt hash, så att det är tolkningen av talet som
      // säger nej och inte markören eller hashkontrollen.
      proofs: { format: 2, components: [ballot.proofs.components[0]!], sum: ballot.proofs.sum },
      ciphertextHash: hashCiphertext(ciphertext),
    }
    expect(await verifyEncryptedBallotOnServer(fixture.publicKey, 'val', 'valsedel', 1, malformed)).toBe(
      false,
    )
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

  it('taket gäller besökare: den som kommer när kön är full avvisas och prövas inte', async () => {
    // Granskningen av uppgift 14b, MINDRE 3. Utan tak växte kön utan gräns,
    // med en valsedel i minnet för varje väntande och 0,4 s väntan per plats.
    const log: string[] = []
    const visitor = { signal: new AbortController().signal }
    const holders = Array.from(
      { length: MAX_CONCURRENT_VERIFICATIONS + MAX_WAITING_VERIFICATIONS },
      (_, index) => heldTask(log, `besökare ${index}`, visitor),
    )
    await settle()

    expect(verificationQueueState()).toEqual({
      running: MAX_CONCURRENT_VERIFICATIONS,
      waiting: MAX_WAITING_VERIFICATIONS,
    })
    expect(verificationQueueIsFull()).toBe(true)

    await expect(heldTask(log, 'en till', visitor).promise).rejects.toBeInstanceOf(
      VerificationQueueFull,
    )
    seen.exponents.length = 0
    await expect(
      verifyEncryptedBallotOnServer(
        fixture.publicKey,
        fixture.electionId,
        fixture.ballotId,
        optionCount,
        ballot,
        visitor,
      ),
    ).rejects.toBeInstanceOf(VerificationQueueFull)
    expect(seen.exponents).toHaveLength(0)

    // Valideringen före stängningen skickar ingen begäran och får alltid vänta.
    // En full kö får inte göra en giltig röst till BAD_PROOF.
    const validation = heldTask(log, 'validering')
    await settle()
    expect(verificationQueueState().waiting).toBe(MAX_WAITING_VERIFICATIONS + 1)

    holders.forEach((holder) => holder.release())
    validation.release()
    await Promise.all([...holders.map((holder) => holder.promise), validation.promise])

    expect(log).not.toContain('start en till')
    expect(log).toContain('slut validering')
    expect(verificationQueueState()).toEqual({ running: 0, waiting: 0 })
    expect(verificationQueueIsFull()).toBe(false)
  })

  it('en besökare som ger upp i kön lämnar den och prövas aldrig, och de efter flyttar fram', async () => {
    const log: string[] = []
    const holders = [heldTask(log, 'a'), heldTask(log, 'b')]
    await settle()

    const controller = new AbortController()
    const gaveUp = heldTask(log, 'ger upp', { signal: controller.signal })
    const after = heldTask(log, 'efter')
    await settle()
    expect(verificationQueueState()).toEqual({ running: 2, waiting: 2 })

    controller.abort()
    await expect(gaveUp.promise).rejects.toBeInstanceOf(VerificationAborted)
    expect(verificationQueueState()).toEqual({ running: 2, waiting: 1 })

    holders[0]!.release()
    await settle()
    expect(log).toContain('start efter')
    expect(log).not.toContain('start ger upp')

    holders[1]!.release()
    after.release()
    await Promise.all([...holders.map((holder) => holder.promise), after.promise])
    expect(verificationQueueState()).toEqual({ running: 0, waiting: 0 })
  })

  it('en besökare som redan har gett upp prövas inte alls', async () => {
    seen.exponents.length = 0
    await expect(
      verifyEncryptedBallotOnServer(
        fixture.publicKey,
        fixture.electionId,
        fixture.ballotId,
        optionCount,
        ballot,
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toBeInstanceOf(VerificationAborted)

    expect(seen.exponents).toHaveLength(0)
    expect(verificationQueueState()).toEqual({ running: 0, waiting: 0 })
  })

  it('en besökare som ger upp mitt i verifieringen stoppas vid nästa steg', async () => {
    const controller = new AbortController()
    seen.exponents.length = 0
    const verification = verifyEncryptedBallotOnServer(
      fixture.publicKey,
      fixture.electionId,
      fixture.ballotId,
      optionCount,
      ballot,
      { signal: controller.signal },
    )

    // Ett par steg hinner köras, sedan går anslutningen.
    await settle()
    controller.abort()

    await expect(verification).rejects.toBeInstanceOf(VerificationAborted)
    // Hela riksdagsvalsedeln är 264 exponentieringar.
    expect(seen.exponents.length).toBeGreaterThan(0)
    expect(seen.exponents.length).toBeLessThan(20)
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
