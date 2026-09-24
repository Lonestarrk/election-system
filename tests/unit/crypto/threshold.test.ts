import { describe, expect, it } from 'vitest'
import { G, P, Q, modPow, randomScalar } from '@/lib/crypto/group'
import { discreteLog, encrypt, generateKeyPair, multiply } from '@/lib/crypto/elgamal'
import { challengeHash } from '@/lib/crypto/proofs'
import {
  combine,
  partiallyDecrypt,
  publicShare,
  splitSecret,
  verifyPartialDecryption,
  type PartialDecryption,
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

  it('ett värde utanför undergruppen avvisas, också när beviset går ihop', () => {
    /**
     * Granskningen av uppgift 14b, MINDRE 7. Beviset binder värdet bara upp
     * till tecknet: (p − v)^c = (−1)^c · v^c, så för en jämn utmaning håller
     * det också för p − v. En förtroendeman som känner sin andel kan pröva nya
     * åtaganden tills utmaningen blir jämn, och det gör testet här, precis som
     * granskaren, som fick igenom p − v på tredje försöket.
     */
    const keys = generateKeyPair()
    const [share] = splitSecret(keys.privateKey, 3, 2)
    const ciphertext = encrypt(keys.publicKey, 1n, randomScalar())
    const honest = partiallyDecrypt(share!, ciphertext)
    const negated = P - honest.value
    const expectedShare = publicShare(share!)

    let forged: PartialDecryption | null = null
    for (let attempt = 0; attempt < 64 && forged === null; attempt += 1) {
      const commitment = randomScalar()
      const a = modPow(G, commitment, P)
      const b = modPow(ciphertext.c1, commitment, P)
      const challenge = challengeHash('partiell-dekryptering', [
        expectedShare,
        ciphertext.c1,
        negated,
        a,
        b,
      ])
      if (challenge % 2n === 0n) {
        const response = (commitment + challenge * share!.value) % Q
        forged = { trusteeIndex: share!.index, value: negated, proof: { a, b, challenge, response } }
      }
    }

    // Ekvationerna håller verkligen för p − v. Utan det säger testet ingenting.
    const { proof } = forged!
    expect(modPow(ciphertext.c1, proof.response, P)).toBe(
      (proof.b * modPow(negated, proof.challenge, P)) % P,
    )

    expect(verifyPartialDecryption(expectedShare, ciphertext, forged!)).toBe(false)
    // Kontrasten: det ärliga bidraget godkänns fortfarande.
    expect(verifyPartialDecryption(expectedShare, ciphertext, honest)).toBe(true)
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
