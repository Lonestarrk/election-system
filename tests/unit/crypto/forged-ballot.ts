import { encrypt, multiply, type Ciphertext } from '@/lib/crypto/elgamal'
import { G, G_INVERSE, P, Q, modPow, randomScalar } from '@/lib/crypto/group'
import { challengeHash, proveSumIsOne, type ZeroOrOneProof } from '@/lib/crypto/proofs'
import {
  hashCiphertext,
  proofContext,
  serialiseEqualityProof,
  serialiseZeroOrOneProof,
  type EncryptedBallot,
} from '@/lib/crypto/verify-ballot'

/**
 * EN FÖRFALSKAD VALSEDEL, BYGGD SÅ SOM GRANSKAREN AV UPPGIFT 14b BYGGDE DEN.
 *
 * Felet var äldre än 14b: en negativ exponent räknades som 1, och ingen
 * tolkning prövade att utmaningarna låg i [0, q). Då blir nollgrenen i ett
 * 0-eller-1-bevis gratis för vilket chiffer som helst. Välj ettgrenens
 * utmaning X ≥ q, så blir nollgrenens utmaning `challenge − X` negativ, och
 * c1^(challenge − X) räknades som 1. Nollgrenens ekvationer blir då g^s0 = a0
 * och h^s0 = b0, som vem som helst uppfyller. Ettgrenen simuleras som vanligt,
 * med den positiva utmaningen X.
 *
 * Summabeviset är ärligt: +1000 och −999 summerar till 1. Valsedeln lägger
 * alltså tusen röster på ett parti, och alla bevis i den höll mot koden före
 * fixrunda 1, både i BigInt och i OpenSSL.
 *
 * Bara för tester. Varje test som använder den ska visa att den underkänns.
 */

/** Gruppens egen räkning: exponenten reduceras mod q först, vilket är rätt för element i undergruppen. */
function groupPow(base: bigint, exponent: bigint): bigint {
  return modPow(base, ((exponent % Q) + Q) % Q, P)
}

/** Ett 0-eller-1-bevis för ett godtyckligt chiffer, med en negativ utmaning i nollgrenen. */
export function forgeZeroOrOneProof(
  publicKey: bigint,
  ciphertext: Ciphertext,
  context: string,
): ZeroOrOneProof {
  const response0 = randomScalar()
  const response1 = randomScalar()
  const challenge1 = Q + randomScalar()

  const shifted = (ciphertext.c2 * G_INVERSE) % P
  const a0 = groupPow(G, response0)
  const b0 = groupPow(publicKey, response0)
  const a1 = (groupPow(G, response1) * groupPow(ciphertext.c1, -challenge1)) % P
  const b1 = (groupPow(publicKey, response1) * groupPow(shifted, -challenge1)) % P

  const challenge = challengeHash(context, [ciphertext.c1, ciphertext.c2, a0, b0, a1, b1])

  return {
    a0,
    b0,
    a1,
    b1,
    challenge0: challenge - challenge1,
    challenge1,
    response0,
    response1,
  }
}

/**
 * En valsedel där alternativ i krypterar `messages[i]`, med förfalskade
 * 0-eller-1-bevis och ett ärligt summabevis. Summan av `messages` måste vara 1.
 */
export function forgeBallot(
  publicKey: bigint,
  electionId: string,
  ballotId: string,
  messages: bigint[],
): { ballot: EncryptedBallot; ciphertexts: Ciphertext[] } {
  const nonces = messages.map(() => randomScalar())
  const ciphertexts = messages.map((message, index) =>
    encrypt(publicKey, ((message % Q) + Q) % Q, nonces[index]!),
  )

  const components = ciphertexts.map((ciphertext, index) =>
    serialiseZeroOrOneProof(
      forgeZeroOrOneProof(publicKey, ciphertext, proofContext(electionId, ballotId, index)),
    ),
  )

  const product = ciphertexts.reduce((a, b) => multiply(a, b))
  const nonceSum = nonces.reduce((a, b) => a + b, 0n)
  const sum = serialiseEqualityProof(
    proveSumIsOne(publicKey, product, nonceSum, proofContext(electionId, ballotId, -1)),
  )

  const ciphertext = ciphertexts.map((pair) => ({ c1: pair.c1.toString(), c2: pair.c2.toString() }))

  return {
    ballot: { ciphertext, proofs: { components, sum }, ciphertextHash: hashCiphertext(ciphertext) },
    ciphertexts,
  }
}
