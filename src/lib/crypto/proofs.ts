import { G, G_INVERSE, P, Q, modPow, randomScalar } from './group'
import type { Ciphertext } from './elgamal'
import { sha256, sha256Hex } from './sha256'

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
 * Fiat–Shamir i det första formatet, v1. Förtroendemännens partiella
 * dekryptering använder det, med kontexten 'partiell-dekryptering' (se
 * threshold.ts), och det är oförändrat.
 *
 * Valsedelns bevis använde det också fram till uppgift 14d, med kontexten
 * `${electionId}|${ballotId}|${index}`. Den kontexten band inte de andra
 * chiffren i valsedeln, och ett lodstreck i ett id kunde flytta gränsen mellan
 * fälten. Valsedelns bevis har nu ett eget transkript, se `BallotBinding`
 * nedan.
 *
 * Hashen är `sha256Hex` och inte Nodes `createHash`, eftersom bevisen byggs i
 * väljarens webbläsare, där node:crypto inte finns. Indatan är densamma som
 * när Nodes hash användes, byte för byte, och därmed också utmaningen. Se
 * ./sha256.ts.
 */
export function challengeHash(context: string, values: bigint[]): bigint {
  const parts = ['valsystem/bevis/v1\u0000', context]
  for (const value of values) {
    parts.push('\u0000', value.toString(16))
  }
  return BigInt('0x' + sha256Hex(parts.join(''))) % Q
}

/**
 * VALSEDELNS BEVIS BINDER HELA VALSEDELN (uppgift 14d, spec 4.4).
 *
 * Utmaningen i varje 0-eller-1-bevis och i summabeviset binder valets id,
 * valsedelns id, hela chifferlistan och bevisets egna tal. Ett 0-eller-1-bevis
 * binder dessutom sitt alternativs index. Före uppgift 14d band ett
 * 0-eller-1-bevis bara sitt eget chiffer av listan, och summabeviset bara
 * produkten av den. Ett giltigt bevis kunde därför i princip klippas ut ur en
 * valsedel, tillsammans med sitt chiffer, och sättas in på samma plats i en
 * annan. En sådan valsedel stoppades då bara av summabeviset, eftersom
 * produkten ändrades (tests/unit/crypto/ballot-binding.test.ts).
 *
 * TRANSKRIPTET, EXAKT. Uppgift 13 skriver en oberoende verifierare ur den här
 * beskrivningen, och tests/unit/crypto/transcript.test.ts bygger transkriptet
 * en gång till ur den med node:crypto och kräver samma byte.
 *
 *   0-eller-1-beviset för alternativ i:
 *
 *     "valsystem/bevis/v2/noll-eller-ett"   33 byte ASCII
 *     00                                    en nollbyte
 *     L(electionId)
 *     L(ballotId)
 *     U32(i)                                alternativets index, 0 till M − 1
 *     H                                     32 byte
 *     E(c1) E(c2)                           alternativets chiffer
 *     E(a0) E(b0) E(a1) E(b1)               åtagandena för gren 0 och gren 1
 *
 *   summabeviset, som inte har något index:
 *
 *     "valsystem/bevis/v2/summa"            24 byte ASCII
 *     00                                    en nollbyte
 *     L(electionId)
 *     L(ballotId)
 *     H                                     32 byte
 *     E(C1) E(C2)                           produkten av alla chiffer
 *     E(a) E(b)                             åtagandena
 *
 *   där
 *
 *     L(s)     längden av s i UTF-8, räknad i byte, som U32, och sedan s i
 *              UTF-8; s ska vara giltig Unicode
 *     U32(n)   n som fyra byte, big-endian, utan tecken
 *     H        chifferlistans hash, alltså de 32 byte som valsedelns
 *              ciphertextHash skriver med 64 små hextecken: SHA-256 över
 *              UTF-8 av "valsystem/chiffer/v1" följt av, för varje alternativ
 *              i ordning, en NUL, c1 och en NUL, c2, talen decimalt utan
 *              inledande nollor, som i valsedeln (`hashCiphertext` i
 *              verify-ballot.ts)
 *     E(x)     x som 256 byte, big-endian, med inledande nollbyte, för
 *              0 ≤ x < p
 *     C1, C2   produkten modulo p av alla alternativs c1 respektive c2
 *
 *   Transkriptet är fälten efter varandra, utan något mellan dem. Utmaningen
 *   är SHA-256 över transkriptet, läst som ett tal big-endian, modulo q.
 *   Reduktionen ändrar ingenting, eftersom q är större än 2^256, men den står
 *   med, så att utmaningen alltid är en exponent. Ett 0-eller-1-bevis håller
 *   bara om (challenge0 + challenge1) mod q är utmaningen, och summabeviset
 *   bara om challenge är det. Ekvationerna efter utmaningen är desamma som
 *   före uppgift 14d.
 *
 * INGET FÄLT KAN LÄSAS PÅ TVÅ SÄTT. De två prefixen skiljer sig redan i
 * tecknet efter "valsystem/bevis/v2/", och inget av dem är början på det andra
 * eller på det gamla formatets "valsystem/bevis/v1" och chifferhashens
 * "valsystem/chiffer/v1". Id:na har längdprefix, och alla andra fält har fast
 * längd. Samma transkript kan alltså bara komma från samma fält.
 *
 * EN HASH AV LISTAN, INTE LISTAN SJÄLV, och det är ett val. Bindningen blir
 * densamma så länge ingen kan hitta två listor med samma SHA-256, och på det
 * antagandet vilar bevisen redan. Med hela listan i varje utmaning hade
 * arbetet vuxit med kvadraten på antalet alternativ: en riksdagsvalsedel har
 * 27 utmaningar och en lista på 13 kB. Hashen räknas en gång per valsedel. Den
 * är dessutom valsedelns egen chifferhash, som väljaren skriver under med
 * BankID och som kuvertroten byggs av, så bevisen binder samma värde som
 * resten av kuvertet.
 *
 * Valsedelns verifiering i verify-ballot.ts räknar hashen själv ur chiffren
 * och tar den aldrig på ord.
 */
export type BallotBinding = {
  electionId: string
  ballotId: string
  /** Hela chifferlistans hash, `hashCiphertext` i verify-ballot.ts: 64 små hextecken. */
  ciphertextHash: string
}

/** Talen som utmaningen i ett 0-eller-1-bevis binder, i transkriptets ordning. */
export type ZeroOrOneValues = readonly [c1: bigint, c2: bigint, a0: bigint, b0: bigint, a1: bigint, b1: bigint]

/** Talen som summabevisets utmaning binder, i transkriptets ordning. */
export type SumValues = readonly [c1: bigint, c2: bigint, a: bigint, b: bigint]

const encoder = new TextEncoder()

const ZERO_OR_ONE_DOMAIN = encoder.encode('valsystem/bevis/v2/noll-eller-ett\u0000')
const SUM_DOMAIN = encoder.encode('valsystem/bevis/v2/summa\u0000')

/** Antal byte i E(x). p har 2048 bitar. */
const ELEMENT_BYTES = 256

/** Sextiofyra små hextecken, som `sha256Hex` skriver dem. */
const LIST_HASH = /^[0-9a-f]{64}$/

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

/** Hextecken, två per byte. Anroparen har redan prövat att texten är det. */
function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(2 * index, 2 * index + 2), 16)
  }
  return bytes
}

/** U32(n). */
function uint32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError('Ett index eller en längd i transkriptet måste vara ett heltal i [0, 2^32).')
  }
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

/**
 * L(s).
 *
 * Texten ska vara giltig Unicode. En ensam surrogathalva har ingen kodning i
 * UTF-8, och TextEncoder skriver U+FFFD i dess ställe, så två olika id:n kunde
 * annars ge samma byte. Id:na är UUID, så det här kastar bara vid ett
 * programfel.
 */
function lengthPrefixed(text: string): Uint8Array {
  if (!isWellFormed(text)) throw new Error('Ett id i transkriptet är inte giltig Unicode.')
  const bytes = encoder.encode(text)
  return concatenate([uint32(bytes.length), bytes])
}

/** Har varje surrogathalva sin partner? Som `String.prototype.isWellFormed`, som äldre webbläsare saknar. */
function isWellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xdc00 && code <= 0xdfff) return false
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    }
  }
  return true
}

/**
 * H.
 *
 * Hashen kommer från den egna koden, inte utifrån: bevisaren och verifieraren
 * räknar den ur chiffren. Är den ändå inte 64 små hextecken är det ett
 * programfel, och då kastar funktionen i stället för att tyst binda något
 * annat än listan.
 */
function listHash(ciphertextHash: string): Uint8Array {
  if (!LIST_HASH.test(ciphertextHash)) {
    throw new Error('Chifferlistans hash ska vara 64 små hextecken.')
  }
  return fromHex(ciphertextHash)
}

/**
 * E(x).
 *
 * Ett tal utanför [0, p) har en annan kodning än sin rest, eller ingen alls,
 * och kastar därför, precis som en negativ exponent i group.ts. Verifieringen
 * i verify-ballot.ts tolkar varje tal utifrån innan det kommer hit, så det
 * betyder att något har gått förbi tolkningen.
 */
function element(value: bigint): Uint8Array {
  if (value < 0n || value >= P) {
    throw new RangeError('Ett tal i transkriptet måste ligga i [0, p): det har kommit förbi tolkningen.')
  }
  return fromHex(value.toString(16).padStart(2 * ELEMENT_BYTES, '0'))
}

/** Transkriptet för 0-eller-1-beviset för alternativ `index`. */
export function zeroOrOneTranscript(binding: BallotBinding, index: number, values: ZeroOrOneValues): Uint8Array {
  return concatenate([
    ZERO_OR_ONE_DOMAIN,
    lengthPrefixed(binding.electionId),
    lengthPrefixed(binding.ballotId),
    uint32(index),
    listHash(binding.ciphertextHash),
    ...values.map(element),
  ])
}

/** Transkriptet för summabeviset. */
export function sumTranscript(binding: BallotBinding, values: SumValues): Uint8Array {
  return concatenate([
    SUM_DOMAIN,
    lengthPrefixed(binding.electionId),
    lengthPrefixed(binding.ballotId),
    listHash(binding.ciphertextHash),
    ...values.map(element),
  ])
}

/** SHA-256 över transkriptet, läst som ett tal big-endian, modulo q. */
function challengeOf(transcript: Uint8Array): bigint {
  let value = 0n
  for (const byte of sha256(transcript)) value = (value << 8n) | BigInt(byte)
  return value % Q
}

export function zeroOrOneChallenge(binding: BallotBinding, index: number, values: ZeroOrOneValues): bigint {
  return challengeOf(zeroOrOneTranscript(binding, index, values))
}

export function sumChallenge(binding: BallotBinding, values: SumValues): bigint {
  return challengeOf(sumTranscript(binding, values))
}

/**
 * Ett 0-eller-1-bevis vars åtaganden är räknade och som väntar på sin
 * utmaning. Det görs färdigt med valsedelns bindning och alternativets index,
 * och det går bara en gång. Två utmaningar mot samma åtagande avslöjar
 * slumptalet och därmed vad alternativet krypterar, så ett andra försök
 * kastar.
 */
export type PendingZeroOrOneProof = (binding: BallotBinding, index: number) => ZeroOrOneProof

/**
 * Ett 0-eller-1-bevis för alternativ `index` i valsedeln som `binding` pekar ut.
 */
export function proveZeroOrOne(
  publicKey: bigint,
  ciphertext: Ciphertext,
  message: 0 | 1,
  nonce: bigint,
  binding: BallotBinding,
  index: number,
): ZeroOrOneProof {
  return startZeroOrOne(publicKey, ciphertext, message, nonce)(binding, index)
}

/**
 * Första halvan av ett 0-eller-1-bevis: slumptalen och åtagandena, alltså
 * varje exponentiering. Resten görs när utmaningen kan räknas.
 *
 * BEVISET GÖRS I TVÅ STEG SEDAN UPPGIFT 14d. Utmaningen binder hela
 * chifferlistan och kan inte räknas förrän varje chiffer i valsedeln finns,
 * men åtagandena beror bara på det egna chiffret. Röstsidan räknar därför
 * chiffret och åtagandena ett alternativ i taget, som förut, och gör alla
 * bevis färdiga när listan är klar (src/lib/encrypt-client.ts). Det sista är
 * billigt: ett transkript, en hash och några multiplikationer per alternativ.
 * Slumptalen dras i samma ordning som före uppgift 14d, och talen blir
 * desamma utom den ärliga grenens utmaning och svar.
 */
export function startZeroOrOne(
  publicKey: bigint,
  ciphertext: Ciphertext,
  message: 0 | 1,
  nonce: bigint,
): PendingZeroOrOneProof {
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
  const target1 = (ciphertext.c2 * G_INVERSE) % P
  const simulatedTarget = message === 0 ? target1 : target0

  const simulated = {
    a: (modPow(G, fakeResponse, P) * modPow(ciphertext.c1, Q - fakeChallenge, P)) % P,
    b:
      (modPow(publicKey, fakeResponse, P) * modPow(simulatedTarget, Q - fakeChallenge, P)) % P,
  }

  const honest = { a: modPow(G, honestCommitment, P), b: modPow(publicKey, honestCommitment, P) }

  const [first, second] = message === 0 ? [honest, simulated] : [simulated, honest]

  /**
   * EN GÅNG, OCH ALDRIG IGEN.
   *
   * Det ärliga svaret är åtagandets exponent plus utmaningen gånger
   * slumptalet. Två svar mot samma åtagande med olika utmaningar ger
   * slumptalet med en division, och slumptalet avslöjar vad chiffret
   * krypterar. Spärren sätts innan något räknas, så att inte heller ett
   * försök som kastar kan följas av ett till.
   */
  let used = false

  return (binding, index) => {
    if (used) throw new Error('Ett 0-eller-1-bevis får bara göras färdigt en gång.')
    used = true

    const challenge = zeroOrOneChallenge(binding, index, [
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
}

export function verifyZeroOrOne(
  publicKey: bigint,
  ciphertext: Ciphertext,
  proof: ZeroOrOneProof,
  binding: BallotBinding,
  index: number,
): boolean {
  const challenge = zeroOrOneChallenge(binding, index, [
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

  const shifted = (ciphertext.c2 * G_INVERSE) % P

  const oneBranch =
    modPow(G, proof.response1, P) === (proof.a1 * modPow(ciphertext.c1, proof.challenge1, P)) % P &&
    modPow(publicKey, proof.response1, P) === (proof.b1 * modPow(shifted, proof.challenge1, P)) % P

  return zeroBranch && oneBranch
}

/** Summabeviset för valsedeln som `binding` pekar ut: `product` krypterar g^1. */
export function proveSumIsOne(
  publicKey: bigint,
  product: Ciphertext,
  nonceSum: bigint,
  binding: BallotBinding,
): EqualityProof {
  const commitment = randomScalar()
  const a = modPow(G, commitment, P)
  const b = modPow(publicKey, commitment, P)
  const challenge = sumChallenge(binding, [product.c1, product.c2, a, b])

  return { a, b, challenge, response: (commitment + challenge * (nonceSum % Q)) % Q }
}

export function verifySumIsOne(
  publicKey: bigint,
  product: Ciphertext,
  proof: EqualityProof,
  binding: BallotBinding,
): boolean {
  if (proof.challenge !== sumChallenge(binding, [product.c1, product.c2, proof.a, proof.b])) return false

  // Produkten ska kryptera exakt g^1, alltså c2 delat med g.
  const shifted = (product.c2 * G_INVERSE) % P

  return (
    modPow(G, proof.response, P) === (proof.a * modPow(product.c1, proof.challenge, P)) % P &&
    modPow(publicKey, proof.response, P) === (proof.b * modPow(shifted, proof.challenge, P)) % P
  )
}
