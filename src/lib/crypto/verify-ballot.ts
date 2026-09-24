import { isInSubgroup } from './group'
import { multiply, type Ciphertext } from './elgamal'
import { verifySumIsOne, verifyZeroOrOne, type EqualityProof, type ZeroOrOneProof } from './proofs'
import { sha256Hex } from './sha256'

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
 *
 * Av samma skäl är hashen `sha256Hex`, som också finns i webbläsaren, och inte
 * Nodes `createHash`. Indatan är oförändrad, och därmed hashen. Se ./sha256.ts.
 */
export function hashCiphertext(ciphertext: Array<{ c1: string; c2: string }>): string {
  const parts = ['valsystem/chiffer/v1']
  for (const pair of ciphertext) {
    parts.push('\u0000', pair.c1, '\u0000', pair.c2)
  }
  return sha256Hex(parts.join(''))
}

/** Kontexten som binder ett bevis till sin plats. Måste vara identisk hos bevisaren. */
export function proofContext(electionId: string, ballotId: string, index: number): string {
  return `${electionId}|${ballotId}|${index}`
}

/**
 * Verifierar en inkommen valsedel fullständigt, ett steg i taget.
 *
 * Ordningen är vald: billiga kontroller först, så att skräp avvisas innan vi
 * betalar för hundra modexp.
 *
 * EN IMPLEMENTATION, TVÅ SÄTT ATT KÖRA DEN, som krypteringen i
 * src/lib/encrypt-client.ts. Generatorn lämnar ifrån sig efter varje
 * alternativs undergruppskontroll och efter varje alternativs bevis. Mellan
 * stegen kan den som kör den släppa fram annat arbete, och det är hela
 * skillnaden: kontrollerna, deras ordning och svaret är desamma.
 * `verifyEncryptedBallot` kör alla steg i ett svep. Servern kör dem genom
 * `verifyEncryptedBallotInSteps`, via src/lib/crypto/server.ts, så att
 * händelseslingan inte står still medan en valsedel prövas.
 */
function* ballotVerification(
  publicKey: string,
  electionId: string,
  ballotId: string,
  expectedLength: number,
  ballot: EncryptedBallot,
): Generator<void, boolean, void> {
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
    // tröskelnyckeln vid varje partiell dekryptering. Varje element prövas
    // innan något bevis räknas med det, också när stegen körs ett i taget.
    if (!isInSubgroup(c1) || !isInSubgroup(c2)) return false

    ciphertexts.push({ c1, c2 })
    yield
  }

  for (const [index, ciphertext] of ciphertexts.entries()) {
    const proof = parseZeroOrOneProof(ballot.proofs.components[index]!)
    if (!verifyZeroOrOne(key, ciphertext, proof, proofContext(electionId, ballotId, index))) {
      return false
    }
    yield
  }

  const product = ciphertexts.reduce((a, b) => multiply(a, b))
  const sumProof = parseEqualityProof(ballot.proofs.sum)

  return verifySumIsOne(key, product, sumProof, proofContext(electionId, ballotId, -1))
}

/** Alla steg i ett svep, för testerna och för den som inte har någon händelseslinga att hålla fri. */
export function verifyEncryptedBallot(
  publicKey: string,
  electionId: string,
  ballotId: string,
  expectedLength: number,
  ballot: EncryptedBallot,
): boolean {
  const steps = ballotVerification(publicKey, electionId, ballotId, expectedLength, ballot)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
  }
}

/**
 * Samma verifiering, med `pause` mellan stegen.
 *
 * Ett steg är ett alternativs undergruppskontroll, två exponentieringar, eller
 * ett alternativs bevis, åtta. Pausen avgör vad som får köra däremellan. På
 * servern är det `setImmediate`, som släpper fram väntande I/O, alltså andra
 * besökares begäranden. Kastar ett steg, till exempel på ett tal som inte går
 * att tolka, blir det ett avvisat löfte, precis som den synkrona varianten
 * kastar.
 */
export async function verifyEncryptedBallotInSteps(
  publicKey: string,
  electionId: string,
  ballotId: string,
  expectedLength: number,
  ballot: EncryptedBallot,
  pause: () => Promise<void>,
): Promise<boolean> {
  const steps = ballotVerification(publicKey, electionId, ballotId, expectedLength, ballot)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
    await pause()
  }
}
