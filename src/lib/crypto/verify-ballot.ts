import { createHash } from 'node:crypto'
import { isInSubgroup } from './group'
import { multiply, type Ciphertext } from './elgamal'
import { verifySumIsOne, verifyZeroOrOne, type EqualityProof, type ZeroOrOneProof } from './proofs'

/**
 * Bevisen på trådformat.
 *
 * ZeroOrOneProof/EqualityProof i proofs.ts bär bigint — praktiskt att räkna
 * med, men JSON.stringify kastar på ett bigint-fält. Precis som chiffret
 * serialiseras därför varje bevisfält till en sträng innan valsedeln lämnar
 * klienten.
 */
export type SerialisedZeroOrOneProof = {
  a0: string
  b0: string
  a1: string
  b1: string
  challenge0: string
  challenge1: string
  response0: string
  response1: string
}

export type SerialisedEqualityProof = { a: string; b: string; challenge: string; response: string }

export type EncryptedBallot = {
  ciphertext: Array<{ c1: string; c2: string }>
  proofs: { components: SerialisedZeroOrOneProof[]; sum: SerialisedEqualityProof }
  ciphertextHash: string
}

export function serialiseZeroOrOneProof(proof: ZeroOrOneProof): SerialisedZeroOrOneProof {
  return {
    a0: proof.a0.toString(),
    b0: proof.b0.toString(),
    a1: proof.a1.toString(),
    b1: proof.b1.toString(),
    challenge0: proof.challenge0.toString(),
    challenge1: proof.challenge1.toString(),
    response0: proof.response0.toString(),
    response1: proof.response1.toString(),
  }
}

function parseZeroOrOneProof(proof: SerialisedZeroOrOneProof): ZeroOrOneProof {
  return {
    a0: BigInt(proof.a0),
    b0: BigInt(proof.b0),
    a1: BigInt(proof.a1),
    b1: BigInt(proof.b1),
    challenge0: BigInt(proof.challenge0),
    challenge1: BigInt(proof.challenge1),
    response0: BigInt(proof.response0),
    response1: BigInt(proof.response1),
  }
}

export function serialiseEqualityProof(proof: EqualityProof): SerialisedEqualityProof {
  return {
    a: proof.a.toString(),
    b: proof.b.toString(),
    challenge: proof.challenge.toString(),
    response: proof.response.toString(),
  }
}

function parseEqualityProof(proof: SerialisedEqualityProof): EqualityProof {
  return {
    a: BigInt(proof.a),
    b: BigInt(proof.b),
    challenge: BigInt(proof.challenge),
    response: BigInt(proof.response),
  }
}

/**
 * Kanonisk hash over chifferlistan.
 *
 * Bor har och inte i klientmodulen, eftersom BADE bevisaren och verifieraren
 * måste rakna fram exakt samma värde. Tva implementationer som glider isar ger
 * ett fel som ser ut som en manipulerad rost.
 */
export function hashCiphertext(ciphertext: Array<{ c1: string; c2: string }>): string {
  const hash = createHash('sha256')
  hash.update('valsystem/chiffer/v1')
  for (const pair of ciphertext) {
    hash.update('\u0000')
    hash.update(pair.c1)
    hash.update('\u0000')
    hash.update(pair.c2)
  }
  return hash.digest('hex')
}

/** Kontexten som binder ett bevis till sin plats. Måste vara identisk hos bevisaren. */
export function proofContext(electionId: string, ballotId: string, index: number): string {
  return `${electionId}|${ballotId}|${index}`
}

/**
 * Verifierar en inkommen valsedel fullständigt.
 *
 * Ordningen är vald: billiga kontroller först, så att skräp avvisas innan vi
 * betalar för hundra modexp.
 */
export function verifyEncryptedBallot(
  publicKey: string,
  electionId: string,
  ballotId: string,
  expectedLength: number,
  ballot: EncryptedBallot,
): boolean {
  if (ballot.ciphertext.length !== expectedLength) return false
  if (ballot.proofs.components.length !== expectedLength) return false

  /**
   * HASHEN MASTE RAKNAS OM, INTE TAS PA ORD.
   *
   * Klienten skickar bade chiffret och dess hash. Godtar vi hashen som den ar
   * kan en klient skicka en hash som inte hor till chiffret — och eftersom
   * signaturen i uppgift 8 binder just den påstådda hashen skulle aven den
   * verifiera.
   *
   * Foljden vore tyst och sen: väljarens inklusionskontroll letar efter en hash
   * som inte finns i den publicerade mangden, och Merkleroten over kuverten
   * beraknas over värden utan motsvarande chiffer. Felet syns forst efter att
   * kopplingen raderats, alltså nar ingen langre kan fraga väljaren.
   */
  if (ballot.ciphertextHash !== hashCiphertext(ballot.ciphertext)) return false

  const key = BigInt(publicKey)
  const ciphertexts: Ciphertext[] = []

  for (const pair of ballot.ciphertext) {
    const c1 = BigInt(pair.c1)
    const c2 = BigInt(pair.c2)

    // REVIEW FOCUS 1. Ett element utanför undergruppen läcker en bit av
    // tröskelnyckeln vid varje partiell dekryptering.
    if (!isInSubgroup(c1) || !isInSubgroup(c2)) return false

    ciphertexts.push({ c1, c2 })
  }

  for (const [index, ciphertext] of ciphertexts.entries()) {
    const proof = parseZeroOrOneProof(ballot.proofs.components[index]!)
    if (!verifyZeroOrOne(key, ciphertext, proof, proofContext(electionId, ballotId, index))) {
      return false
    }
  }

  const product = ciphertexts.reduce((a, b) => multiply(a, b))
  const sumProof = parseEqualityProof(ballot.proofs.sum)

  return verifySumIsOne(key, product, sumProof, proofContext(electionId, ballotId, -1))
}
