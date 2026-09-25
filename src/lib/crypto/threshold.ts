import { G, P, Q, isInSubgroup, modPow, parseElement, parseScalar, randomScalar } from './group'
import type { Ciphertext } from './elgamal'
import { PARTIAL_DECRYPTION_FORMAT, partialDecryptionChallenge, type EqualityProof } from './proofs'

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

/**
 * VALETS TRÖSKEL: TRE FÖRTROENDEPERSONER, TVÅ KRÄVS (spec 4.5).
 *
 * Valets skapande delar nyckeln med de här talen, och räkningen kräver
 * `TRUSTEE_THRESHOLD` bidrag innan den öppnar en summa. Talen står på ett
 * ställe, så att delningen och räkningen inte kan säga olika saker. Med färre
 * bidrag än tröskeln ger kombinationen ett tal som inte är summan, och den
 * diskreta logaritmen hittar det inte.
 */
export const TRUSTEE_COUNT = 3
export const TRUSTEE_THRESHOLD = 2

export type Share = { index: number; value: bigint }
export type PartialDecryption = { trusteeIndex: number; value: bigint; proof: EqualityProof }

/**
 * Vad ett bidrag gäller: valet, valsedeln och alternativet (ruling 133).
 *
 * Förtroendepersonens index står i bidraget, och hennes publika andel är den
 * beviset prövas mot. Alla fem står i utmaningen, se
 * `partialDecryptionTranscript` i proofs.ts.
 */
export type PartialDecryptionBinding = { electionId: string; ballotId: string; optionIndex: number }

/**
 * I undergruppen av ordning q, identiteten medräknad.
 *
 * `isInSubgroup` räknar inte 1, eftersom ett mottaget chiffer med c1 = 1 har
 * slumptalet noll och visar sitt innehåll. En SUMMA kan däremot vara 1:
 * produkten av inga röster är (1, 1), och då är varje förtroendepersons
 * partiella värde 1 (REVIEW FOCUS 6). Talet 1 är undergruppens identitet, och
 * ett element av någon annan ordning släpps inte igenom.
 */
function isGroupElement(value: bigint): boolean {
  return value === 1n || isInSubgroup(value)
}

/** Ett heltal i [lower, upper). */
function inRange(value: bigint, lower: bigint, upper: bigint): boolean {
  return value >= lower && value < upper
}

/** Ett index som kan stå i transkriptet som U32, från `lower`. */
function isIndex(value: number, lower: number): boolean {
  return Number.isSafeInteger(value) && value >= lower && value <= 0xffff_ffff
}

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

/**
 * Förtroendepersonens bidrag till en summa: C1^x och ett bevis för att samma x
 * står i hennes publika andel.
 *
 * PRIMITIVEN FÖRSVARAR SIG SJÄLV (granskningen av uppgift 1 och 3, uppgift
 * 12). Det här är den enda funktionen som exponentierar med en andel av
 * nyckeln, och ett c1 utanför undergruppen läcker en bit av andelen i värdet
 * (REVIEW FOCUS 1). Chiffret prövas därför innan andelen används, också när
 * anroparen redan har prövat det. Det kostar en exponentiering per komponent.
 */
export function partiallyDecrypt(
  share: Share,
  ciphertext: Ciphertext,
  binding: PartialDecryptionBinding,
): PartialDecryption {
  if (!isGroupElement(ciphertext.c1) || !isGroupElement(ciphertext.c2)) {
    throw new RangeError('Summan är inte ett chiffer i gruppens undergrupp, och andelen används inte på den.')
  }

  const value = modPow(ciphertext.c1, share.value, P)

  // Beviset binder BÅDE c1 och generatorn till samma exponent, och utmaningen
  // binder valet, valsedeln, alternativet och hela summan, så bidraget kan
  // inte flyttas till ett annat chiffer eller ett annat sammanhang.
  const commitment = randomScalar()
  const a = modPow(G, commitment, P)
  const b = modPow(ciphertext.c1, commitment, P)
  const challenge = partialDecryptionChallenge({ ...binding, trusteeIndex: share.index }, [
    publicShare(share),
    ciphertext.c1,
    ciphertext.c2,
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

/**
 * Håller bidraget för den här summan, i det här sammanhanget, mot den här
 * publika andelen?
 *
 * Allt som kommer utifrån prövas innan något räknas med det, och ett tal
 * utanför sitt intervall ger false i stället för ett undantag (granskningen
 * av uppgift 3). Anroparen tolkar redan talen ur databasen strikt, men
 * primitiven litar inte på det.
 */
export function verifyPartialDecryption(
  expectedPublicShare: bigint,
  ciphertext: Ciphertext,
  partial: PartialDecryption,
  binding: PartialDecryptionBinding,
): boolean {
  const { proof, value } = partial

  if (!isIndex(partial.trusteeIndex, 1) || !isIndex(binding.optionIndex, 0)) return false
  if (!isInSubgroup(expectedPublicShare)) return false
  if (!isGroupElement(ciphertext.c1) || !isGroupElement(ciphertext.c2)) return false
  if (!inRange(proof.a, 1n, P) || !inRange(proof.b, 1n, P)) return false
  if (!inRange(proof.challenge, 0n, Q) || !inRange(proof.response, 0n, Q)) return false
  if (!inRange(value, 1n, P)) return false

  /**
   * DET PARTIELLA VÄRDET MÅSTE LIGGA I UNDERGRUPPEN (granskningen av uppgift
   * 14b, MINDRE 7), OCH VARA 1 BARA NÄR SUMMANS c1 ÄR 1, SOM FÖR SUMMAN AV
   * INGA RÖSTER.
   *
   * Beviset binder värdet bara upp till tecknet. För p − v i stället för v
   * håller det när utmaningen är jämn, eftersom (p − v)^c = (−1)^c · v^c, och
   * en förtroendeman kan pröva nya åtaganden tills utmaningen blir det.
   * Granskaren fick igenom p − v på tredje försöket. Kontrollen är densamma
   * som för varje annat mottaget element.
   *
   * Är c1 = 1 är varje potens av det 1, och ett annat värde kan inte vara
   * rätt. Är c1 något annat är värdet 1 bara om andelen är noll, och då är den
   * publika andelen 1, som redan underkänts ovan.
   */
  if (ciphertext.c1 === 1n ? value !== 1n : !isInSubgroup(value)) return false

  if (
    proof.challenge !==
    partialDecryptionChallenge({ ...binding, trusteeIndex: partial.trusteeIndex }, [
      expectedPublicShare,
      ciphertext.c1,
      ciphertext.c2,
      value,
      proof.a,
      proof.b,
    ])
  ) {
    return false
  }

  return (
    modPow(G, proof.response, P) === (proof.a * modPow(expectedPublicShare, proof.challenge, P)) % P &&
    modPow(ciphertext.c1, proof.response, P) === (proof.b * modPow(value, proof.challenge, P)) % P
  )
}

/**
 * Returnerar g^m. Anroparen tar den diskreta logaritmen.
 *
 * VAKTERNA GÖR ETT TYST FEL HÖGLJUTT (granskningen av uppgift 3, uppgift 12).
 * Utan dubblettvakten utesluter den inre slingans `j === i` även dubblettens
 * eget index ur produkten, och Lagrange-koefficienten blir fel, utan att
 * något kastar. Ett felaktigt röstetal som inte kastar är den värsta
 * felklassen i ett räkneverk. Det unika indexet på (valsedel, alternativ,
 * förtroendeperson) i databasen hindrar det i praktiken, men vakten är två
 * rader. Ett index som inte är ett heltal från 1 kastar också: index 0 är
 * hemligheten själv, och ett annat tal ger en koefficient som inte betyder
 * något.
 */
export function combine(ciphertext: Ciphertext, partials: PartialDecryption[]): bigint {
  for (const partial of partials) {
    if (!isIndex(partial.trusteeIndex, 1)) {
      throw new RangeError('En förtroendepersons index är ett heltal från 1.')
    }
  }

  const indices = new Set(partials.map((partial) => partial.trusteeIndex))
  if (indices.size !== partials.length) {
    throw new Error('Samma förtroendeman bidrog två gånger.')
  }

  const points = partials.map((partial) => BigInt(partial.trusteeIndex))

  let shared = 1n
  for (const partial of partials) {
    const i = BigInt(partial.trusteeIndex)

    // Lagrange-koefficient vid x = 0, räknad mod q.
    let numerator = 1n
    let denominator = 1n
    for (const j of points) {
      if (j === i) continue
      numerator = (numerator * j) % Q
      denominator = (denominator * ((Q + j - i) % Q)) % Q
    }

    const lambda = (numerator * modPow(denominator, Q - 2n, Q)) % Q
    shared = (shared * modPow(partial.value, lambda, P)) % P
  }

  return (ciphertext.c2 * modPow(shared, Q - 1n, P)) % P
}

/**
 * Beviset som det lagras i databasen och skickas på tråden.
 *
 * Talen är decimalsträngar, som i valsedeln, eftersom JSON inte har bigint.
 * `format` är vilket transkript beviset är byggt med, `PARTIAL_DECRYPTION_FORMAT`
 * i proofs.ts, så att ett bidrag i ett annat format aldrig prövas mot det här.
 */
export type SerialisedPartialDecryptionProof = {
  format: typeof PARTIAL_DECRYPTION_FORMAT
  a: string
  b: string
  challenge: string
  response: string
}

export function serialisePartialDecryptionProof(proof: EqualityProof): SerialisedPartialDecryptionProof {
  return {
    format: PARTIAL_DECRYPTION_FORMAT,
    a: proof.a.toString(),
    b: proof.b.toString(),
    challenge: proof.challenge.toString(),
    response: proof.response.toString(),
  }
}

/**
 * Beviset tolkat strikt, eller null.
 *
 * Samma tolkning som valsedelns bevis (se parseScalar i group.ts):
 * åtagandena är tal i [1, p), utmaningen och svaret exponenter i [0, q), och
 * varje tal är kanoniskt skrivet. Ett bevis utan formatmarkören, eller med en
 * annan, tolkas inte alls.
 */
export function parsePartialDecryptionProof(proof: unknown): EqualityProof | null {
  if (typeof proof !== 'object' || proof === null || Array.isArray(proof)) return null
  const fields = proof as Record<string, unknown>
  if (fields.format !== PARTIAL_DECRYPTION_FORMAT) return null

  const a = parseElement(fields.a)
  const b = parseElement(fields.b)
  const challenge = parseScalar(fields.challenge)
  const response = parseScalar(fields.response)
  if (a === null || b === null || challenge === null || response === null) return null

  return { a, b, challenge, response }
}
