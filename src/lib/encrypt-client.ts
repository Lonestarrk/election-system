import { randomScalar } from './crypto/group'
import { encrypt, multiply } from './crypto/elgamal'
import { proveSumIsOne, proveZeroOrOne } from './crypto/proofs'
import { indexOfChoice, unitVector, type BallotOption } from './crypto/ballot-encoding'
import {
  hashCiphertext,
  proofContext,
  serialiseEqualityProof,
  serialiseZeroOrOneProof,
  type EncryptedBallot,
} from './crypto/verify-ballot'

/**
 * KRYPTERAR VÄLJARENS VAL — OCH KASTAR SLUMPTALEN.
 *
 * Slumptalen returneras inte, loggas inte och sparas inte. Det är den enda
 * anledningen till att kvittot inte är ett bevis: utan dem kan väljaren visa
 * ATT hennes chiffer ingår i räkningen, men inte VAD det innehåller.
 *
 * Skulle någon senare "hjälpsamt" returnera dem för felsökning är röstköp
 * möjligt igen, och ingenting i databasen avslöjar att det hänt.
 */
export function encryptBallot(
  publicKey: string,
  electionId: string,
  ballotId: string,
  options: BallotOption[],
  choice: BallotOption,
): EncryptedBallot {
  const key = BigInt(publicKey)
  const vector = unitVector(options.length, indexOfChoice(options, choice))

  const nonces = vector.map(() => randomScalar())
  const ciphertexts = vector.map((message, index) => encrypt(key, message, nonces[index]!))

  const components = ciphertexts.map((ciphertext, index) =>
    serialiseZeroOrOneProof(
      proveZeroOrOne(
        key,
        ciphertext,
        vector[index] === 1n ? 1 : 0,
        nonces[index]!,
        proofContext(electionId, ballotId, index),
      ),
    ),
  )

  const sum = serialiseEqualityProof(
    proveSumIsOne(
      key,
      ciphertexts.reduce((a, b) => multiply(a, b)),
      nonces.reduce((a, b) => a + b, 0n),
      proofContext(electionId, ballotId, -1),
    ),
  )

  const serialised = ciphertexts.map((c) => ({ c1: c.c1.toString(), c2: c.c2.toString() }))

  return { ciphertext: serialised, proofs: { components, sum }, ciphertextHash: hashCiphertext(serialised) }
}

export { hashCiphertext }
