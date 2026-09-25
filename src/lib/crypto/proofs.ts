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
 * Fiat–Shamir i det första formatet, v1. INGENTING I src ANVÄNDER DET LÄNGRE.
 *
 * Valsedelns bevis använde det fram till uppgift 14d, med kontexten
 * `${electionId}|${ballotId}|${index}`. Den kontexten band inte de andra
 * chiffren i valsedeln, och ett lodstreck i ett id kunde flytta gränsen mellan
 * fälten. Förtroendepersonernas partiella dekryptering använde det fram till
 * uppgift 12, med kontexten 'partiell-dekryptering', och band då ingenting
 * utöver talen. Båda har nu egna transkript, se `BallotBinding` och
 * `partialDecryptionTranscript` nedan. Funktionen finns kvar för testernas
 * kuvert i det gamla formatet, tests/unit/crypto/legacy-ballot.ts, som
 * valideringen före stängningen ska känna igen och stoppa.
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
 * valsedelns id, valets publika nyckel h, hela chifferlistan och bevisets egna
 * tal. Ett 0-eller-1-bevis binder dessutom sitt alternativs index. Före uppgift
 * 14d band ett 0-eller-1-bevis bara sitt eget chiffer av listan, och
 * summabeviset bara produkten av den. Ett giltigt bevis kunde därför i princip
 * klippas ut ur en valsedel, tillsammans med sitt chiffer, och sättas in på
 * samma plats i en annan. En sådan valsedel stoppades då bara av summabeviset,
 * eftersom produkten ändrades (tests/unit/crypto/ballot-binding.test.ts).
 *
 * NYCKELN I TRANSKRIPTET (ruling 132, fixrunda 1 av uppgift 14d). Utan h kunde
 * den som väljer nyckeln efter utmaningen få ett enskilt bevis godkänt för ett
 * chiffer som inte krypterar det som beviset påstår. x löses då ur
 * verifieringens egna ekvationer, och h = g^x. Granskaren av uppgift 14d visade
 * det, och ballot-binding.test.ts bygger samma förfalskning. Nyckeln i
 * transkriptet är samma tal som ekvationerna räknar med, `publicKey` i varje
 * funktion nedan, och inte ett eget fält i bindningen, så att de två inte kan
 * skilja sig åt. Formatet v2 utan h, i commit c06533d, släpptes aldrig: det
 * pushades inte och driftsattes inte. Därför heter formatet med h också v2.
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
 *     E(h)                                  valets publika nyckel
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
 *     E(h)                                  valets publika nyckel
 *     H                                     32 byte
 *     E(C1) E(C2)                           produkten av alla chiffer
 *     E(a) E(b)                             åtagandena
 *
 *   där
 *
 *     L(s)     längden av s i UTF-8, räknad i byte, som U32, och sedan s i
 *              UTF-8. s hashas exakt som id:t lagras, utan
 *              Unicode-normalisering, och ska vara giltig Unicode
 *     U32(n)   n som fyra byte, big-endian, utan tecken
 *     H        chifferlistans hash, alltså de 32 byte som valsedelns
 *              ciphertextHash skriver med 64 små hextecken: SHA-256 över
 *              UTF-8 av "valsystem/chiffer/v1" följt av, för varje alternativ
 *              i ordning, en NUL, c1 och en NUL, c2, talen decimalt utan
 *              inledande nollor, som i valsedeln (`hashCiphertext` i
 *              verify-ballot.ts)
 *     E(x)     x som ett tal big-endian, vänsterutfyllt med nollbyte till
 *              exakt 256 byte, för 0 ≤ x < p
 *     C1, C2   produkten modulo p av alla alternativs c1 respektive c2
 *
 *   Transkriptet är fälten efter varandra, utan något mellan dem. Med id:n som
 *   UUID, 36 byte vardera, är ett 0-eller-1-transkript 1 942 byte och ett
 *   summatranskript 1 417 byte. Utmaningen är SHA-256 över transkriptet, läst
 *   som ett tal big-endian, modulo q. Reduktionen ändrar ingenting, eftersom q
 *   är större än 2^256, men den står med, så att utmaningen alltid är en
 *   exponent. Ett 0-eller-1-bevis håller bara om (challenge0 + challenge1) mod
 *   q är utmaningen, och summabeviset bara om challenge är det. Ekvationerna
 *   efter utmaningen är desamma som före uppgift 14d.
 *
 * PREFIXET BESTÄMMER DET SOM INTE STÅR SOM FÄLT. Det är gruppen, alltså p, q
 * och g = 4 (RFC 3526 MODP Group 14, se group.ts), och vad bevisen påstår: att
 * varje alternativ krypterar 0 eller 1, och att produkten krypterar 1. En
 * annan grupp, eller en valsedel där fler än ett alternativ får väljas, kräver
 * därför ett nytt prefix, och med det en ny formatmarkör.
 *
 * FORMATMARKÖREN. Valsedelns bevis bär `format: 2` (`PROOF_FORMAT` nedan), och
 * siffran är versionen i prefixen. Valsedelns verifiering i verify-ballot.ts
 * prövar bara bevis med den markören. Valideringen före stängningen skiljer
 * därmed ett helt kuvert utan markör, som ett som lades före fixrunda 1 av
 * uppgift 14d, från ett trasigt bevis (`isOldProofFormat` i verify-ballot.ts).
 * Markören ligger i bevisen och inte i chiffret, så den ingår inte i
 * chifferhashen.
 *
 * INGET FÄLT KAN LÄSAS PÅ TVÅ SÄTT. De två prefixen skiljer sig redan i
 * tecknet efter "valsystem/bevis/v2/", och inget av dem är början på det andra,
 * på den partiella dekrypteringens prefix (se `partialDecryptionTranscript`
 * nedan), eller på det gamla formatets "valsystem/bevis/v1" och chifferhashens
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

/**
 * Formatmarkören i valsedelns bevis, `proofs.format`, och versionen i
 * transkriptens prefix. Ett nytt transkript får en ny siffra, och därmed nya
 * prefix, så att inget bevis kan prövas mot ett annat formats transkript.
 */
export const PROOF_FORMAT = 2

const encoder = new TextEncoder()

const ZERO_OR_ONE_DOMAIN = encoder.encode(`valsystem/bevis/v${PROOF_FORMAT}/noll-eller-ett\u0000`)
const SUM_DOMAIN = encoder.encode(`valsystem/bevis/v${PROOF_FORMAT}/summa\u0000`)

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

/** Transkriptet för 0-eller-1-beviset för alternativ `index`, under valets publika nyckel `publicKey`. */
export function zeroOrOneTranscript(
  publicKey: bigint,
  binding: BallotBinding,
  index: number,
  values: ZeroOrOneValues,
): Uint8Array {
  return concatenate([
    ZERO_OR_ONE_DOMAIN,
    lengthPrefixed(binding.electionId),
    lengthPrefixed(binding.ballotId),
    element(publicKey),
    uint32(index),
    listHash(binding.ciphertextHash),
    ...values.map(element),
  ])
}

/** Transkriptet för summabeviset, under valets publika nyckel `publicKey`. */
export function sumTranscript(publicKey: bigint, binding: BallotBinding, values: SumValues): Uint8Array {
  return concatenate([
    SUM_DOMAIN,
    lengthPrefixed(binding.electionId),
    lengthPrefixed(binding.ballotId),
    element(publicKey),
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

export function zeroOrOneChallenge(
  publicKey: bigint,
  binding: BallotBinding,
  index: number,
  values: ZeroOrOneValues,
): bigint {
  return challengeOf(zeroOrOneTranscript(publicKey, binding, index, values))
}

export function sumChallenge(publicKey: bigint, binding: BallotBinding, values: SumValues): bigint {
  return challengeOf(sumTranscript(publicKey, binding, values))
}

/**
 * DEN PARTIELLA DEKRYPTERINGENS BEVIS BINDER SITT SAMMANHANG (uppgift 12,
 * ruling 133).
 *
 * Förtroendeperson t bidrar till summan av alternativ i med värdet v = C1^x,
 * där x är hennes andel av nyckeln, och ett Chaum–Pedersen-bevis för att
 * samma x står i hennes publika andel Y = g^x. Fram till uppgift 12 band
 * utmaningen bara talen, genom det första formatets `challengeHash` med
 * kontexten 'partiell-dekryptering'. Ett bidrag hade då hållit för varje
 * valsedel och varje alternativ med samma summa, och en summa av inga röster
 * är (1, 1) på varje valsedel. Nu binder utmaningen valet, valsedeln,
 * alternativet, förtroendepersonens index och publika andel, hela det
 * aggregerade chiffret och värdet, med samma kodning som valsedelns bevis.
 *
 * TRANSKRIPTET, EXAKT. Uppgift 13 skriver en oberoende verifierare ur den här
 * beskrivningen, och tests/unit/crypto/transcript.test.ts bygger transkriptet
 * en gång till med node:crypto och kräver samma byte.
 *
 *     "valsystem/bevis/v2/partiell-dekryptering"   40 byte ASCII
 *     00                                            en nollbyte
 *     L(electionId)
 *     L(ballotId)
 *     U32(i)                                        alternativets index, 0 till M − 1
 *     U32(t)                                        förtroendepersonens index, från 1
 *     E(Y)                                          hennes publika andel, g^x
 *     E(C1) E(C2)                                   summan av alternativ i: produkten
 *                                                   modulo p av c1 respektive c2 i
 *                                                   varje rad i urnan för valsedeln
 *     E(v)                                          det partiella värdet, C1^x
 *     E(a) E(b)                                     åtagandena, g^w och C1^w
 *
 *   med L, U32 och E som för valsedelns bevis ovan. Med id:n som UUID är
 *   transkriptet 41 + 40 + 40 + 4 + 4 + 6 · 256 = 1 665 byte. Utmaningen är
 *   SHA-256 över transkriptet, läst som ett tal big-endian, modulo q. Beviset
 *   håller om `challenge` är den utmaningen, g^response = a · Y^challenge och
 *   C1^response = b · v^challenge, allt modulo p.
 *
 * Summan av inga röster är C1 = C2 = 1. Då är v = 1 och b = 1 för varje
 * förtroendeperson, och beviset håller ändå bara för sin egen valsedel och
 * sitt eget alternativ, eftersom båda står i transkriptet.
 *
 * PREFIXET BESTÄMMER DET SOM INTE STÅR SOM FÄLT: gruppen, som för valsedelns
 * bevis, och vad beviset påstår, att log_g(Y) = log_C1(v). Det skiljer sig
 * från valsedelns två prefix redan i tecknet efter "valsystem/bevis/v2/", och
 * inget av prefixen är början på ett annat. Bidraget bär sitt format som
 * `format: 2` i det lagrade beviset, se `serialisePartialDecryptionProof` i
 * threshold.ts.
 */
export const PARTIAL_DECRYPTION_FORMAT = 2

/** Vad ett bidrag gäller. Förtroendepersonens index står med, eftersom det står i transkriptet. */
export type PartialDecryptionTranscriptBinding = {
  electionId: string
  ballotId: string
  optionIndex: number
  trusteeIndex: number
}

/** Talen som utmaningen binder, i transkriptets ordning. */
export type PartialDecryptionValues = readonly [
  publicShare: bigint,
  c1: bigint,
  c2: bigint,
  value: bigint,
  a: bigint,
  b: bigint,
]

const PARTIAL_DECRYPTION_DOMAIN = encoder.encode(
  `valsystem/bevis/v${PARTIAL_DECRYPTION_FORMAT}/partiell-dekryptering\u0000`,
)

/** Transkriptet för förtroendepersonens bevis för ett alternativs summa. */
export function partialDecryptionTranscript(
  binding: PartialDecryptionTranscriptBinding,
  values: PartialDecryptionValues,
): Uint8Array {
  return concatenate([
    PARTIAL_DECRYPTION_DOMAIN,
    lengthPrefixed(binding.electionId),
    lengthPrefixed(binding.ballotId),
    uint32(binding.optionIndex),
    uint32(binding.trusteeIndex),
    ...values.map(element),
  ])
}

export function partialDecryptionChallenge(
  binding: PartialDecryptionTranscriptBinding,
  values: PartialDecryptionValues,
): bigint {
  return challengeOf(partialDecryptionTranscript(binding, values))
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

    const challenge = zeroOrOneChallenge(publicKey, binding, index, [
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
  const challenge = zeroOrOneChallenge(publicKey, binding, index, [
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
  const challenge = sumChallenge(publicKey, binding, [product.c1, product.c2, a, b])

  return { a, b, challenge, response: (commitment + challenge * (nonceSum % Q)) % Q }
}

export function verifySumIsOne(
  publicKey: bigint,
  product: Ciphertext,
  proof: EqualityProof,
  binding: BallotBinding,
): boolean {
  if (proof.challenge !== sumChallenge(publicKey, binding, [product.c1, product.c2, proof.a, proof.b])) {
    return false
  }

  // Produkten ska kryptera exakt g^1, alltså c2 delat med g.
  const shifted = (product.c2 * G_INVERSE) % P

  return (
    modPow(G, proof.response, P) === (proof.a * modPow(product.c1, proof.challenge, P)) % P &&
    modPow(publicKey, proof.response, P) === (proof.b * modPow(shifted, proof.challenge, P)) % P
  )
}
