import { G, P, Q, modPow, randomScalar } from './group'
import type { Ciphertext } from './elgamal'
import { sha256Hex } from './sha256'

/**
 * BEVISEN ÄR INTE VALFRIA.
 *
 * En krypterad valsedel utan bevis är ogranskbar: en klient kan lägga 1000
 * röster på en kandidat, och ingenting syns förrän slutsumman är orimlig — då
 * är kopplingen till väljaren redan raderad och felet omöjligt att spåra.
 *
 * Två bevis behövs, och båda krävs:
 *   – varje komponent krypterar 0 eller 1
 *   – hela vektorn summerar till exakt 1
 *
 * Det andra är inte överflödigt. Varje komponent kan vara giltig och vektorn
 * ändå innehålla två ettor.
 */

export type ZeroOrOneProof = {
  a0: bigint
  b0: bigint
  a1: bigint
  b1: bigint
  challenge0: bigint
  challenge1: bigint
  response0: bigint
  response1: bigint
}

export type EqualityProof = { a: bigint; b: bigint; challenge: bigint; response: bigint }

/**
 * Fiat–Shamir: utmaningen härleds ur allt som ska bindas.
 *
 * `context` bär valets och valsedelns id samt komponentens index. Utan det kan
 * ett giltigt bevis klippas ut ur en valsedel och återanvändas i en annan.
 *
 * Hashen är `sha256Hex` och inte Nodes `createHash`, eftersom bevisen byggs i
 * väljarens webbläsare, där node:crypto inte finns. Indatan är densamma som
 * förut, byte för byte, och därmed också utmaningen. Se ./sha256.ts.
 */
export function challengeHash(context: string, values: bigint[]): bigint {
  const parts = ['valsystem/bevis/v1\u0000', context]
  for (const value of values) {
    parts.push('\u0000', value.toString(16))
  }
  return BigInt('0x' + sha256Hex(parts.join(''))) % Q
}

export function proveZeroOrOne(
  publicKey: bigint,
  ciphertext: Ciphertext,
  message: 0 | 1,
  nonce: bigint,
  context: string,
): ZeroOrOneProof {
  // Den gren som är sann bevisas ärligt; den falska simuleras baklänges med en
  // på förhand vald utmaning. Verifieraren kan inte skilja dem åt.
  const fakeChallenge = randomScalar()
  const fakeResponse = randomScalar()
  const honestCommitment = randomScalar()

  /**
   * DE TVA GRENARNAS MAL, UTSKRIVNA VAR FOR SIG.
   *
   * Gren 0 pastar att chiffret kodar 0, alltsa att c2 = h^r. Malet ar c2.
   * Gren 1 pastar 1, alltsa att c2 = h^r * g. Malet ar c2 / g.
   *
   * Den SIMULERADE grenen ar den vi inte kan bevisa arligt, alltsa motsatsen
   * till `message`. Tas fel mal har blir simuleringen ogiltig, och verifieraren
   * underkanner ett arligt bevis — ett fel som bara syns som att giltiga roster
   * avvisas.
   */
  const target0 = ciphertext.c2
  const target1 = (ciphertext.c2 * modPow(G, Q - 1n, P)) % P
  const simulatedTarget = message === 0 ? target1 : target0

  const simulated = {
    a: (modPow(G, fakeResponse, P) * modPow(ciphertext.c1, Q - fakeChallenge, P)) % P,
    b:
      (modPow(publicKey, fakeResponse, P) * modPow(simulatedTarget, Q - fakeChallenge, P)) % P,
  }

  const honest = { a: modPow(G, honestCommitment, P), b: modPow(publicKey, honestCommitment, P) }

  const [first, second] = message === 0 ? [honest, simulated] : [simulated, honest]

  const challenge = challengeHash(context, [
    ciphertext.c1,
    ciphertext.c2,
    first.a,
    first.b,
    second.a,
    second.b,
  ])

  const honestChallenge = (Q + challenge - fakeChallenge) % Q
  const honestResponse = (honestCommitment + honestChallenge * nonce) % Q

  return message === 0
    ? {
        a0: honest.a,
        b0: honest.b,
        a1: simulated.a,
        b1: simulated.b,
        challenge0: honestChallenge,
        challenge1: fakeChallenge,
        response0: honestResponse,
        response1: fakeResponse,
      }
    : {
        a0: simulated.a,
        b0: simulated.b,
        a1: honest.a,
        b1: honest.b,
        challenge0: fakeChallenge,
        challenge1: honestChallenge,
        response0: fakeResponse,
        response1: honestResponse,
      }
}

export function verifyZeroOrOne(
  publicKey: bigint,
  ciphertext: Ciphertext,
  proof: ZeroOrOneProof,
  context: string,
): boolean {
  const challenge = challengeHash(context, [
    ciphertext.c1,
    ciphertext.c2,
    proof.a0,
    proof.b0,
    proof.a1,
    proof.b1,
  ])

  if ((proof.challenge0 + proof.challenge1) % Q !== challenge) return false

  const zeroBranch =
    modPow(G, proof.response0, P) === (proof.a0 * modPow(ciphertext.c1, proof.challenge0, P)) % P &&
    modPow(publicKey, proof.response0, P) ===
      (proof.b0 * modPow(ciphertext.c2, proof.challenge0, P)) % P

  const shifted = (ciphertext.c2 * modPow(G, Q - 1n, P)) % P

  const oneBranch =
    modPow(G, proof.response1, P) === (proof.a1 * modPow(ciphertext.c1, proof.challenge1, P)) % P &&
    modPow(publicKey, proof.response1, P) === (proof.b1 * modPow(shifted, proof.challenge1, P)) % P

  return zeroBranch && oneBranch
}

export function proveSumIsOne(
  publicKey: bigint,
  product: Ciphertext,
  nonceSum: bigint,
  context: string,
): EqualityProof {
  const commitment = randomScalar()
  const a = modPow(G, commitment, P)
  const b = modPow(publicKey, commitment, P)
  const challenge = challengeHash(context + '|summa', [product.c1, product.c2, a, b])

  return { a, b, challenge, response: (commitment + challenge * (nonceSum % Q)) % Q }
}

export function verifySumIsOne(
  publicKey: bigint,
  product: Ciphertext,
  proof: EqualityProof,
  context: string,
): boolean {
  if (proof.challenge !== challengeHash(context + '|summa', [product.c1, product.c2, proof.a, proof.b]))
    return false

  // Produkten ska kryptera exakt g^1, alltså c2 delat med g.
  const shifted = (product.c2 * modPow(G, Q - 1n, P)) % P

  return (
    modPow(G, proof.response, P) === (proof.a * modPow(product.c1, proof.challenge, P)) % P &&
    modPow(publicKey, proof.response, P) === (proof.b * modPow(shifted, proof.challenge, P)) % P
  )
}
