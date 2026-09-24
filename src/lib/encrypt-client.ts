import { randomScalar } from './crypto/group'
import { encrypt, multiply, type Ciphertext } from './crypto/elgamal'
import { proveSumIsOne, proveZeroOrOne } from './crypto/proofs'
import { indexOfChoice, unitVector, type BallotOption } from './crypto/ballot-encoding'
import {
  hashCiphertext,
  proofContext,
  serialiseEqualityProof,
  serialiseZeroOrOneProof,
  type EncryptedBallot,
  type SerialisedZeroOrOneProof,
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
 *
 * EN IMPLEMENTATION, TVÅ SÄTT ATT KÖRA DEN.
 *
 * Krypteringen görs komponent för komponent i `ballotEncryption`, som lämnar
 * ifrån sig ett steg i taget. `encryptBallot` kör alla steg i ett svep, för
 * servern och testerna. `encryptBallotInSteps` släpper fram webbläsaren mellan
 * stegen, så att röstsidan kan visa hur långt den kommit: en valsedel med
 * personröst tar flera sekunder, och en sida som står still så länge ser
 * trasig ut. Båda kör samma kod och ger samma sorts resultat.
 *
 * Det enda som lämnar ett steg är hur många komponenter som är klara. Slumptalen
 * ligger kvar i generatorns egna variabler och försvinner med den.
 */
function* ballotEncryption(
  publicKey: string,
  electionId: string,
  ballotId: string,
  options: BallotOption[],
  choice: BallotOption,
): Generator<number, EncryptedBallot, void> {
  const key = BigInt(publicKey)
  const vector = unitVector(options.length, indexOfChoice(options, choice))

  const nonces: bigint[] = []
  const ciphertexts: Ciphertext[] = []
  const components: SerialisedZeroOrOneProof[] = []

  for (const [index, message] of vector.entries()) {
    const nonce = randomScalar()
    const ciphertext = encrypt(key, message, nonce)

    components.push(
      serialiseZeroOrOneProof(
        proveZeroOrOne(
          key,
          ciphertext,
          message === 1n ? 1 : 0,
          nonce,
          proofContext(electionId, ballotId, index),
        ),
      ),
    )
    ciphertexts.push(ciphertext)
    nonces.push(nonce)

    yield index + 1
  }

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

export function encryptBallot(
  publicKey: string,
  electionId: string,
  ballotId: string,
  options: BallotOption[],
  choice: BallotOption,
): EncryptedBallot {
  const steps = ballotEncryption(publicKey, electionId, ballotId, options, choice)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
  }
}

/** Hur långt krypteringen kommit: färdiga komponenter av alla. */
export type EncryptionProgress = (done: number, total: number) => void

/**
 * Samma kryptering, med en paus efter varje komponent.
 *
 * Pausen är en ny uppgift i händelseslingan, inte en tidsfördröjning: den ger
 * webbläsaren tillfälle att rita om sidan och hantera ett tryck på en knapp.
 * Det gör inte krypteringen snabbare, bara möjlig att följa.
 */
export async function encryptBallotInSteps(
  publicKey: string,
  electionId: string,
  ballotId: string,
  options: BallotOption[],
  choice: BallotOption,
  onProgress: EncryptionProgress = () => {},
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<EncryptedBallot> {
  const steps = ballotEncryption(publicKey, electionId, ballotId, options, choice)
  // Summabeviset är ett steg till efter komponenterna.
  const total = options.length + 1

  onProgress(0, total)
  await pause()

  for (;;) {
    const step = steps.next()
    if (step.done) {
      onProgress(total, total)
      return step.value
    }
    onProgress(step.value, total)
    await pause()
  }
}

export { hashCiphertext }
