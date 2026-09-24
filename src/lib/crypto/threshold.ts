import { G, P, Q, isInSubgroup, modPow, randomScalar } from './group'
import type { Ciphertext } from './elgamal'
import { challengeHash, type EqualityProof } from './proofs'

/**
 * SHAMIR-DELNING ÖVER Z_q.
 *
 * Nyckeln som öppnar valresultatet får inte finnas hos en enda person. Den delas
 * i n andelar där k krävs för att öppna, så att en ensam administratör varken
 * kan läsa resultatet i förtid eller vägra släppa det.
 *
 * BETRODD UTDELARE — och det är en känd begränsning. Under ett kort ögonblick
 * vid valets skapande existerar hela den privata nyckeln på ett ställe. Riktig
 * distribuerad nyckelgenerering låter förtroendemännen bygga nyckeln utan att
 * den någonsin sätts ihop; det ligger utanför den här etappen.
 */

export type Share = { index: number; value: bigint }
export type PartialDecryption = { trusteeIndex: number; value: bigint; proof: EqualityProof }

export function splitSecret(secret: bigint, trustees: number, threshold: number): Share[] {
  // Polynom av grad k-1 med hemligheten som konstantterm.
  const coefficients = [secret, ...Array.from({ length: threshold - 1 }, () => randomScalar())]

  return Array.from({ length: trustees }, (_, position) => {
    const x = BigInt(position + 1)
    let value = 0n
    let power = 1n

    for (const coefficient of coefficients) {
      value = (value + coefficient * power) % Q
      power = (power * x) % Q
    }

    return { index: position + 1, value }
  })
}

export function publicShare(share: Share): bigint {
  return modPow(G, share.value, P)
}

export function partiallyDecrypt(share: Share, ciphertext: Ciphertext): PartialDecryption {
  const value = modPow(ciphertext.c1, share.value, P)

  // Beviset binder BÅDE c1 och generatorn till samma exponent, så bidraget kan
  // inte flyttas till ett annat chiffer.
  const commitment = randomScalar()
  const a = modPow(G, commitment, P)
  const b = modPow(ciphertext.c1, commitment, P)
  const challenge = challengeHash('partiell-dekryptering', [
    publicShare(share),
    ciphertext.c1,
    value,
    a,
    b,
  ])

  return {
    trusteeIndex: share.index,
    value,
    proof: { a, b, challenge, response: (commitment + challenge * share.value) % Q },
  }
}

export function verifyPartialDecryption(
  expectedPublicShare: bigint,
  ciphertext: Ciphertext,
  partial: PartialDecryption,
): boolean {
  const { proof } = partial

  /**
   * DET PARTIELLA VÄRDET MÅSTE LIGGA I UNDERGRUPPEN (granskningen av uppgift
   * 14b, MINDRE 7).
   *
   * Beviset binder värdet bara upp till tecknet. För p − v i stället för v
   * håller det när utmaningen är jämn, eftersom (p − v)^c = (−1)^c · v^c, och
   * en förtroendeman kan pröva nya åtaganden tills utmaningen blir det.
   * Granskaren fick igenom p − v på tredje försöket. Summan blev ändå rätt,
   * eftersom `combine` inverterar med exponenten q − 1, som är jämn och tar
   * bort tecknet. Det är en egenskap hos dagens kod och ingenting som uppgift
   * 12 ska behöva veta om. Kontrollen är densamma som för varje annat mottaget
   * element.
   */
  if (!isInSubgroup(partial.value)) return false

  if (
    proof.challenge !==
    challengeHash('partiell-dekryptering', [
      expectedPublicShare,
      ciphertext.c1,
      partial.value,
      proof.a,
      proof.b,
    ])
  ) {
    return false
  }

  return (
    modPow(G, proof.response, P) === (proof.a * modPow(expectedPublicShare, proof.challenge, P)) % P &&
    modPow(ciphertext.c1, proof.response, P) ===
      (proof.b * modPow(partial.value, proof.challenge, P)) % P
  )
}

/** Returnerar g^m. Anroparen tar den diskreta logaritmen. */
export function combine(ciphertext: Ciphertext, partials: PartialDecryption[]): bigint {
  const indices = partials.map((partial) => BigInt(partial.trusteeIndex))

  let shared = 1n
  for (const partial of partials) {
    const i = BigInt(partial.trusteeIndex)

    // Lagrange-koefficient vid x = 0, räknad mod q.
    let numerator = 1n
    let denominator = 1n
    for (const j of indices) {
      if (j === i) continue
      numerator = (numerator * j) % Q
      denominator = (denominator * ((Q + j - i) % Q)) % Q
    }

    const lambda = (numerator * modPow(denominator, Q - 2n, Q)) % Q
    shared = (shared * modPow(partial.value, lambda, P)) % P
  }

  return (ciphertext.c2 * modPow(shared, Q - 1n, P)) % P
}
