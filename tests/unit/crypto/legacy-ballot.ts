import { indexOfChoice, unitVector, type BallotOption } from '@/lib/crypto/ballot-encoding'
import { encrypt, multiply, type Ciphertext } from '@/lib/crypto/elgamal'
import {
  G,
  G_INVERSE,
  P,
  Q,
  isInSubgroup,
  modPow,
  parseElement,
  parseScalar,
  randomScalar,
  useFixedBase,
} from '@/lib/crypto/group'
import { challengeHash, type EqualityProof, type ZeroOrOneProof } from '@/lib/crypto/proofs'
import {
  hashCiphertext,
  serialiseEqualityProof,
  serialiseZeroOrOneProof,
  type EncryptedBallot,
} from '@/lib/crypto/verify-ballot'

/**
 * EN VALSEDEL I BEVISFORMATET FÖRE UPPGIFT 14d, BARA FÖR TESTER.
 *
 * Fram till uppgift 14d band varje 0-eller-1-bevis sitt eget chiffer och
 * strängen `${electionId}|${ballotId}|${index}`, och summabeviset produkten
 * och samma sträng med index −1 och `|summa` efter. Övriga chiffer i listan
 * ingick inte. Utmaningen var `challengeHash(kontext, tal)`, som finns kvar i
 * proofs.ts för förtroendemännens partiella dekryptering.
 *
 * Varje kuvert som lades före ändringen har sådana bevis, i demons databaser
 * lokalt och i Azure. Den här filen bygger och prövar dem som koden i 99bfb49
 * gjorde, rad för rad och med slumptalen i samma ordning, så att testerna kan
 * visa två saker: att ett kuvert i det gamla formatet var giltigt då, och att
 * det är formatet och inget annat som fäller det nu.
 * tests/unit/crypto/proof-format.test.ts visar att den här krypteringen med
 * fixturens frö ger fixturen från före uppgift 14b, byte för byte.
 */

function legacyContext(electionId: string, ballotId: string, index: number): string {
  return `${electionId}|${ballotId}|${index}`
}

/** proveZeroOrOne i 99bfb49, med den gamla utmaningen. */
function legacyProveZeroOrOne(
  publicKey: bigint,
  ciphertext: Ciphertext,
  message: 0 | 1,
  nonce: bigint,
  context: string,
): ZeroOrOneProof {
  const fakeChallenge = randomScalar()
  const fakeResponse = randomScalar()
  const honestCommitment = randomScalar()

  const target0 = ciphertext.c2
  const target1 = (ciphertext.c2 * G_INVERSE) % P
  const simulatedTarget = message === 0 ? target1 : target0

  const simulated = {
    a: (modPow(G, fakeResponse, P) * modPow(ciphertext.c1, Q - fakeChallenge, P)) % P,
    b: (modPow(publicKey, fakeResponse, P) * modPow(simulatedTarget, Q - fakeChallenge, P)) % P,
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

/** proveSumIsOne i 99bfb49. */
function legacyProveSumIsOne(
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

/**
 * Krypteringen i src/lib/encrypt-client.ts i 99bfb49: ett alternativ i taget,
 * slumptalet och sedan beviset, och summabeviset sist.
 */
export function legacyEncryptBallot(
  publicKey: string,
  electionId: string,
  ballotId: string,
  options: BallotOption[],
  choice: BallotOption,
): EncryptedBallot {
  const key = BigInt(publicKey)
  const vector = unitVector(options.length, indexOfChoice(options, choice))
  useFixedBase(key)

  const nonces: bigint[] = []
  const ciphertexts: Ciphertext[] = []
  const components = []

  for (const [index, message] of vector.entries()) {
    const nonce = randomScalar()
    const ciphertext = encrypt(key, message, nonce)
    components.push(
      serialiseZeroOrOneProof(
        legacyProveZeroOrOne(
          key,
          ciphertext,
          message === 1n ? 1 : 0,
          nonce,
          legacyContext(electionId, ballotId, index),
        ),
      ),
    )
    ciphertexts.push(ciphertext)
    nonces.push(nonce)
  }

  const sum = serialiseEqualityProof(
    legacyProveSumIsOne(
      key,
      ciphertexts.reduce((a, b) => multiply(a, b)),
      nonces.reduce((a, b) => a + b, 0n),
      legacyContext(electionId, ballotId, -1),
    ),
  )

  const serialised = ciphertexts.map((c) => ({ c1: c.c1.toString(), c2: c.c2.toString() }))
  return { ciphertext: serialised, proofs: { components, sum }, ciphertextHash: hashCiphertext(serialised) }
}

/** verifyZeroOrOne i 99bfb49. */
function legacyVerifyZeroOrOne(
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
    modPow(publicKey, proof.response0, P) === (proof.b0 * modPow(ciphertext.c2, proof.challenge0, P)) % P
  const shifted = (ciphertext.c2 * G_INVERSE) % P
  const oneBranch =
    modPow(G, proof.response1, P) === (proof.a1 * modPow(ciphertext.c1, proof.challenge1, P)) % P &&
    modPow(publicKey, proof.response1, P) === (proof.b1 * modPow(shifted, proof.challenge1, P)) % P

  return zeroBranch && oneBranch
}

/** verifySumIsOne i 99bfb49. */
function legacyVerifySumIsOne(
  publicKey: bigint,
  product: Ciphertext,
  proof: EqualityProof,
  context: string,
): boolean {
  if (proof.challenge !== challengeHash(context + '|summa', [product.c1, product.c2, proof.a, proof.b])) {
    return false
  }
  const shifted = (product.c2 * G_INVERSE) % P
  return (
    modPow(G, proof.response, P) === (proof.a * modPow(product.c1, proof.challenge, P)) % P &&
    modPow(publicKey, proof.response, P) === (proof.b * modPow(shifted, proof.challenge, P)) % P
  )
}

/** Alla fält tolkade, eller ett undantag. Den gamla verifieringen används bara på ärliga valsedlar här. */
function parsed<T extends Record<string, bigint | null>>(fields: T): { [K in keyof T]: bigint } {
  for (const value of Object.values(fields)) {
    if (value === null) throw new Error('Ett tal i valsedeln gick inte att tolka.')
  }
  return fields as { [K in keyof T]: bigint }
}

/**
 * Verifieringen i src/lib/crypto/verify-ballot.ts i 99bfb49, med samma
 * kontroller i samma ordning: tolkningen, chifferhashen, undergruppen, varje
 * 0-eller-1-bevis och summabeviset.
 */
export function legacyVerifyEncryptedBallot(
  publicKey: string,
  electionId: string,
  ballotId: string,
  expectedLength: number,
  ballot: EncryptedBallot,
): boolean {
  const key = parseElement(publicKey)
  if (key === null) throw new Error('Valets publika nyckel är inte ett tal i [1, p).')
  if (ballot.ciphertext.length !== expectedLength) return false
  if (ballot.proofs.components.length !== expectedLength) return false

  const ciphertexts = ballot.ciphertext.map((pair) =>
    parsed({ c1: parseElement(pair.c1), c2: parseElement(pair.c2) }),
  )
  const components = ballot.proofs.components.map((proof) =>
    parsed({
      a0: parseElement(proof.a0),
      b0: parseElement(proof.b0),
      a1: parseElement(proof.a1),
      b1: parseElement(proof.b1),
      challenge0: parseScalar(proof.challenge0),
      challenge1: parseScalar(proof.challenge1),
      response0: parseScalar(proof.response0),
      response1: parseScalar(proof.response1),
    }),
  )
  const sum = parsed({
    a: parseElement(ballot.proofs.sum.a),
    b: parseElement(ballot.proofs.sum.b),
    challenge: parseScalar(ballot.proofs.sum.challenge),
    response: parseScalar(ballot.proofs.sum.response),
  })

  if (ballot.ciphertextHash !== hashCiphertext(ballot.ciphertext)) return false
  if (!ciphertexts.every(({ c1, c2 }) => isInSubgroup(c1) && isInSubgroup(c2))) return false

  for (const [index, ciphertext] of ciphertexts.entries()) {
    const context = legacyContext(electionId, ballotId, index)
    if (!legacyVerifyZeroOrOne(key, ciphertext, components[index]!, context)) return false
  }

  const product = ciphertexts.reduce((a, b) => multiply(a, b))
  return legacyVerifySumIsOne(key, product, sum, legacyContext(electionId, ballotId, -1))
}
