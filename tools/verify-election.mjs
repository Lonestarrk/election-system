#!/usr/bin/env node
/**
 * OBEROENDE KONTROLL AV ETT PUBLICERAT VALRESULTAT (uppgift 13)
 *
 * Verktyget läser det som valet publicerar efter räkningen och räknar om det
 * som går att räkna om utan de enskilda rösterna:
 *
 *   1. varje förtroendepersons partiella dekryptering, mot hennes publika andel
 *      och summans c1, med beviset (DLEQ) räknat ur spec 4.5
 *   2. att de publika andelarna hör till valets publika nyckel
 *   3. att Lagrange-kombinationen av bidragen ger g^antal = c2 / kombinationen,
 *      för varje alternativ och med det publicerade antalet
 *   4. att räkneverken summerar till antalet rader i urnan, och att antalet
 *      rader och markeringarna "har röstat" stämmer med varandra
 *   5. att kuvertroten och urnroten finns och har formen av en rot
 *   6. att varje valsedel står en gång, och att publiceringen gäller den
 *      omröstning som efterfrågades
 *
 * VERKTYGET ÄR AVSIKTLIGT FRISTÅENDE. Det importerar bara Nodes inbyggda
 * moduler och ingenting ur src. Transkriptet, tolkningen av talen och
 * kombinationen är skrivna på nytt ur specen (docs/spec/2026-09-22-dubbla-kuvert.md,
 * avsnitt 4.4 och 4.5), inte ur appens kod. Gruppen tas ur OpenSSL:s kopia av
 * RFC 3526. Ett verktyg som delade kod med appen hade bara visat att appen är
 * konsekvent med sig själv: ett fel i kodningen hade gett samma fel på båda
 * sidor och aldrig synts.
 *
 * VARJE TAL TOLKAS STRIKT. Uppgift 14b:s granskning fann att appen räknade en
 * negativ exponent som 1 och inte prövade några intervall, så att en förfalskad
 * valsedel med +1000 och −999 godkändes. Verktyget godtar därför bara kanoniska
 * decimaltal med högst 617 siffror, utmaningar och svar i [0, q), gruppelement
 * i [1, p) och, där specen kräver det, i undergruppen av ordning q. Ett
 * räkneverk är ett heltal från 0 till antalet rader i urnan.
 *
 * VAD VERKTYGET INTE KAN KONTROLLERA står i utskriften, längst ned. Det
 * viktigaste: att summan består av exakt de giltiga rösterna. De enskilda
 * chiffren publiceras aldrig (spec 3.1), så summan går inte att räkna om här.
 *
 * Använd:
 *   node tools/verify-election.mjs <URL eller fil> [omröstningens id]
 *
 * URL:en är den offentliga rutten, till exempel
 *   https://<värd>/api/observer/results?electionId=<omröstningens id>
 * och filen en JSON-fil med samma innehåll. Ingen inloggning krävs. Publiceringen
 * ska gälla omröstningen i adressen, eller den i det andra argumentet.
 *
 * Utfallet: 0 när allt som går att kontrollera stämmer, 1 när något inte gör
 * det, 2 när underlaget inte gick att läsa.
 */

import { createDiffieHellman, createHash, getDiffieHellman } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Gruppen, ur OpenSSL och inte ur appen
// ---------------------------------------------------------------------------

/** RFC 3526 MODP Group 14, 2048 bitar, som OpenSSL har den. */
export const P = BigInt('0x' + getDiffieHellman('modp14').getPrime('hex'))
/** Undergruppens ordning. p är ett säkert primtal, så q är också ett primtal. */
export const Q = (P - 1n) / 2n
/** Generatorn enligt spec 4.1. 4 är ett kvadrattal och ligger därför i undergruppen. */
export const G = 4n

/** Tröskeln enligt spec 4.5: tre förtroendepersoner, två krävs. */
export const TRUSTEE_COUNT = 3
export const TRUSTEE_THRESHOLD = 2

/** Publiceringens format, som rutten skriver det. */
export const PUBLICATION_FORMAT = 'valsystem/publicering/v1'

/** Antalet siffror i p. Inget tal i gruppen är längre. */
const MAX_DIGITS = P.toString().length

const ELEMENT_BYTES = 256

/** Ett fel i underlaget. Fångas per kontroll och blir en rad i utskriften. */
class Invalid extends Error {}

/**
 * Potensen mod p, räknad i OpenSSL genom Nodes Diffie–Hellman, som är omkring
 * tjugo gånger snabbare än BigInt. Faller tillbaka på `bigintModPow` för allt
 * OpenSSL inte räknar: en bas som är 0, 1 eller p − 1, en exponent under 2, och
 * ett svar som är 1, som OpenSSL vägrar lämna ut (fixrunda 1: sviten med
 * verktyget i samma process tog över åttio sekunder, och testkörarens
 * hjärtslag hann gå ut). Det är samma räkneoperation och samma bibliotek som
 * Node, inte appens kod: verktyget importerar fortfarande bara node:.
 */
let engine = null
const PRIME_BYTES = ELEMENT_BYTES

function toBytes(value) {
  const hex = value.toString(16)
  return Buffer.from(hex.length % 2 === 0 ? hex : '0' + hex, 'hex')
}

function opensslModPow(base, exponent) {
  if (base <= 1n || base >= P - 1n || exponent < 2n) return null
  engine ??= createDiffieHellman(toBytes(P), toBytes(G))
  try {
    engine.setPrivateKey(toBytes(exponent))
    const shared = engine.computeSecret(toBytes(base))
    if (shared.length === 0 || shared.length > PRIME_BYTES) return null
    const value = BigInt('0x' + shared.toString('hex'))
    return value > 0n && value < P ? value : null
  } catch {
    return null
  }
}

export function modPow(base, exponent, modulus) {
  if (exponent < 0n) throw new Invalid('en negativ exponent')
  if (modulus === P) {
    const reduced = ((base % P) + P) % P
    const fast = opensslModPow(reduced, exponent)
    if (fast !== null) return fast
  }
  return bigintModPow(base, exponent, modulus)
}

/** Kvadrera och multiplicera i BigInt. Referensen, och vägen för det OpenSSL inte räknar. */
export function bigintModPow(base, exponent, modulus) {
  if (exponent < 0n) throw new Invalid('en negativ exponent')
  let result = 1n
  let square = ((base % modulus) + modulus) % modulus
  let rest = exponent
  while (rest > 0n) {
    if (rest & 1n) result = (result * square) % modulus
    square = (square * square) % modulus
    rest >>= 1n
  }
  return result
}

/** Inversen mod ett primtal, med Fermats lilla sats. */
function inverse(value, prime) {
  if (value % prime === 0n) throw new Invalid('noll har ingen invers')
  return modPow(value, prime - 2n, prime)
}

// ---------------------------------------------------------------------------
// Tolkningen av talen
// ---------------------------------------------------------------------------

const CANONICAL = /^(?:0|[1-9][0-9]*)$/

/** Ett kanoniskt decimaltal: bara ASCII-siffror, ingen inledande nolla, högst 617 siffror. */
function parseDecimal(value, what) {
  if (typeof value !== 'string') throw new Invalid(`${what} är inte en decimalsträng`)
  if (value.length > MAX_DIGITS) throw new Invalid(`${what} har fler än ${MAX_DIGITS} siffror`)
  if (!CANONICAL.test(value)) throw new Invalid(`${what} är inte ett kanoniskt skrivet decimaltal`)
  return BigInt(value)
}

/** En utmaning eller ett svar: ett heltal i [0, q). */
function parseExponent(value, what) {
  const parsed = parseDecimal(value, what)
  if (parsed >= Q) throw new Invalid(`${what} ligger inte i [0, q)`)
  return parsed
}

/** Ett tal modulo p: ett heltal i [1, p). */
function parseResidue(value, what) {
  const parsed = parseDecimal(value, what)
  if (parsed < 1n || parsed >= P) throw new Invalid(`${what} ligger inte i [1, p)`)
  return parsed
}

/** I undergruppen av ordning q, och inte 1: 1 < y < p och y^q ≡ 1 (mod p). */
function inSubgroup(value) {
  // y^q räknas som y^(q−1) · y: samma tal, men OpenSSL lämnar aldrig ut svaret 1,
  // och y^(q−1) är 1 bara för y = 1, som redan är utesluten.
  return value > 1n && value < P && (modPow(value, Q - 1n, P) * value) % P === 1n
}

/** Ett gruppelement som ska ligga i undergruppen. */
function parseSubgroupElement(value, what) {
  const parsed = parseResidue(value, what)
  if (!inSubgroup(parsed)) throw new Invalid(`${what} ligger inte i undergruppen av ordning q`)
  return parsed
}

/** Ett antal: ett heltal som JSON-tal, från 0. */
function parseCount(value, what) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Invalid(`${what} är inte ett heltal från 0`)
  return value
}

/** En text som kodas i transkriptet. En ensam surrogathalva hade blivit U+FFFD och kunnat förväxlas. */
function parseId(value, what) {
  if (typeof value !== 'string' || value.length === 0) throw new Invalid(`${what} saknas`)
  if (!value.isWellFormed()) throw new Invalid(`${what} är inte giltig Unicode`)
  return value
}

const ROOT = /^[0-9a-f]{64}$/

// ---------------------------------------------------------------------------
// Transkriptet, ur spec 4.5
// ---------------------------------------------------------------------------

const PARTIAL_DOMAIN = Buffer.from('valsystem/bevis/v2/partiell-dekryptering\u0000', 'ascii')

/** U32: fyra byte, big-endian. */
function u32(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('index utanför U32')
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}

/** L(s): antalet byte i UTF-8(s) som U32, följt av UTF-8(s). */
function lengthPrefixed(text) {
  if (typeof text !== 'string' || !text.isWellFormed()) throw new RangeError('id:t är inte giltig Unicode')
  const bytes = Buffer.from(text, 'utf8')
  return Buffer.concat([u32(bytes.length), bytes])
}

/** E(x): x big-endian, vänsterutfyllt med nollbyte till exakt 256 byte, för 0 ≤ x < p. */
function element(value) {
  if (typeof value !== 'bigint' || value < 0n || value >= P) throw new RangeError('talet ligger inte i [0, p)')
  return Buffer.from(value.toString(16).padStart(ELEMENT_BYTES * 2, '0'), 'hex')
}

/**
 * T för den partiella dekrypteringens bevis, fält för fält som tabellen i
 * spec 4.5: prefixet, valets och valsedelns id, alternativets och
 * förtroendepersonens index, och sedan Y, C1, C2, v, a och b.
 */
export function partialDecryptionTranscript(binding, values) {
  if (!Array.isArray(values) || values.length !== 6) throw new RangeError('transkriptet har sex tal')
  return Buffer.concat([
    PARTIAL_DOMAIN,
    lengthPrefixed(binding.electionId),
    lengthPrefixed(binding.ballotId),
    u32(binding.optionIndex),
    u32(binding.trusteeIndex),
    ...values.map(element),
  ])
}

/** e = int(SHA-256(T)) mod q. */
export function partialDecryptionChallenge(binding, values) {
  const digest = createHash('sha256').update(partialDecryptionTranscript(binding, values)).digest('hex')
  return BigInt('0x' + digest) % Q
}

// ---------------------------------------------------------------------------
// Kontrollerna
// ---------------------------------------------------------------------------

/**
 * Ett bidrag för ett alternativ, prövat enligt "Beviset håller om" i spec 4.5.
 * Kastar `Invalid` med skälet, annars ingenting.
 */
function checkPartial({ electionId, ballotId, optionIndex, trusteeIndex, publicShare, sum, partial }) {
  if (typeof partial !== 'object' || partial === null) throw new Invalid('bidraget saknas')
  if (partial.optionIndex !== optionIndex) throw new Invalid('bidraget står inte på sitt alternativs plats')

  const proof = partial.proof
  if (typeof proof !== 'object' || proof === null || Array.isArray(proof)) throw new Invalid('beviset saknas')
  if (proof.format !== 2) throw new Invalid('beviset har inte formatet 2')

  const v = parseResidue(partial.value, 'värdet')
  const a = parseResidue(proof.a, 'a')
  const b = parseResidue(proof.b, 'b')
  const challenge = parseExponent(proof.challenge, 'utmaningen')
  const response = parseExponent(proof.response, 'svaret')

  // v är 1 när C1 är 1, och ligger annars i undergruppen.
  if (sum.c1 === 1n ? v !== 1n : !inSubgroup(v)) {
    throw new Invalid(sum.c1 === 1n ? 'värdet är inte 1 fast summans c1 är 1' : 'värdet ligger inte i undergruppen')
  }

  const expected = partialDecryptionChallenge({ electionId, ballotId, optionIndex, trusteeIndex }, [
    publicShare,
    sum.c1,
    sum.c2,
    v,
    a,
    b,
  ])
  if (challenge !== expected) throw new Invalid('utmaningen är inte den som transkriptet ger')
  if (modPow(G, response, P) !== (a * modPow(publicShare, challenge, P)) % P) {
    throw new Invalid('g^svar är inte a · Y^utmaning')
  }
  if (modPow(sum.c1, response, P) !== (b * modPow(v, challenge, P)) % P) {
    throw new Invalid('C1^svar är inte b · v^utmaning')
  }
  return v
}

/** Lagrange-koefficienten i x = 0 för punkten `index` bland `indices`, mod q. */
function lagrange(index, indices) {
  let numerator = 1n
  let denominator = 1n
  const i = BigInt(index)
  for (const other of indices) {
    if (other === index) continue
    const j = BigInt(other)
    numerator = (numerator * j) % Q
    denominator = (denominator * (((j - i) % Q) + Q)) % Q
  }
  return (numerator * inverse(denominator, Q)) % Q
}

/** Π base_t^λ_t mod p, över förtroendepersonerna i `values`. */
function combineAt(values) {
  const indices = [...values.keys()]
  let combined = 1n
  for (const [index, value] of values) combined = (combined * modPow(value, lagrange(index, indices), P)) % P
  return combined
}

/**
 * Prövar en publicering och ger raderna som ska skrivas ut. `ok` är sant när
 * ingen kontroll underkändes.
 */
export function verifyPublication(publication, options = {}) {
  const lines = []
  let failures = 0
  let decryptionHolds = true

  const pass = (label, detail = '') => lines.push(`  OK   ${label}${detail ? ` — ${detail}` : ''}`)
  const fail = (label, detail = '') => {
    failures += 1
    lines.push(`  FEL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
  /** Kör en kontroll. Ett `Invalid` blir en underkänd rad, och kontrollen ger null. */
  const attempt = (label, run) => {
    try {
      return run()
    } catch (error) {
      if (!(error instanceof Invalid) && !(error instanceof RangeError)) throw error
      fail(label, error.message)
      return null
    }
  }

  if (typeof publication !== 'object' || publication === null || Array.isArray(publication)) {
    fail('Underlaget är ingen publicering')
    return finish()
  }
  if (publication.status !== 'published') {
    const message = typeof publication.message === 'string' ? publication.message : 'inget besked'
    fail('Valet har inget publicerat resultat', message)
    return finish()
  }
  if (publication.format !== PUBLICATION_FORMAT) {
    fail('Publiceringen har ett annat format än det verktyget läser', String(publication.format))
    return finish()
  }

  // --- Gruppen och tröskeln ----------------------------------------------------
  const group = publication.group ?? {}
  if (group.p === P.toString() && group.q === Q.toString() && group.g === G.toString()) {
    pass('Gruppen är RFC 3526 MODP Group 14 med g = 4')
  } else {
    fail('Publiceringen gäller en annan grupp än RFC 3526 MODP Group 14 med g = 4')
    return finish()
  }

  const trustees = publication.trustees ?? {}
  if (trustees.count !== TRUSTEE_COUNT || trustees.threshold !== TRUSTEE_THRESHOLD) {
    fail(`Tröskeln är inte ${TRUSTEE_THRESHOLD} av ${TRUSTEE_COUNT} förtroendepersoner, som spec 4.5 säger`)
    return finish()
  }

  const electionId = attempt('Omröstningens id', () => parseId(publication.election?.id, 'omröstningens id'))
  if (electionId === null) return finish()

  // Publiceringen ska gälla den omröstning som efterfrågades (fixrunda 1, Mindre
  // 4). Ett svar för en annan omröstning hade annars godkänts som det rätta.
  if (options.electionId !== undefined) {
    if (electionId === options.electionId) pass('Publiceringen gäller den efterfrågade omröstningen', electionId)
    else fail(`Publiceringen gäller omröstningen ${electionId}, men ${options.electionId} efterfrågades`)
  }

  // --- Rötterna ------------------------------------------------------------------
  for (const [key, name] of [
    ['envelopeRoot', 'Kuvertroten'],
    ['urnRoot', 'Urnroten'],
  ]) {
    if (typeof publication[key] === 'string' && ROOT.test(publication[key])) {
      pass(`${name} finns`, publication[key])
    } else {
      fail(`${name} saknas eller är inte 64 små hextecken`)
    }
  }

  // --- De publika andelarna hör till valets nyckel -------------------------------
  const shares = new Map()
  const publicKey = attempt('Valets publika nyckel', () =>
    parseSubgroupElement(publication.encryptionPublicKey, 'valets publika nyckel'),
  )
  const listed = Array.isArray(trustees.publicShares) ? trustees.publicShares : []
  for (const entry of listed) {
    const index = entry?.trusteeIndex
    const label = `Förtroendeperson ${index}:s publika andel`
    if (!Number.isSafeInteger(index) || index < 1 || index > TRUSTEE_COUNT) {
      fail(`Förtroendeperson ${index} finns inte bland de ${TRUSTEE_COUNT}`)
      continue
    }
    if (shares.has(index)) {
      fail(`Förtroendeperson ${index}:s publika andel står två gånger`)
      continue
    }
    const share = attempt(label, () => parseSubgroupElement(entry.publicShare, `förtroendeperson ${index}:s publika andel`))
    if (share !== null) shares.set(index, share)
  }
  if (shares.size !== TRUSTEE_COUNT) {
    fail(`Publiceringen har inte alla ${TRUSTEE_COUNT} förtroendepersoners publika andelar i undergruppen`)
  } else if (publicKey !== null) {
    // Andelarna ligger på ett polynom av grad k − 1 med nyckeln i x = 0, så varje
    // par ska kombineras till valets publika nyckel.
    const indices = [...shares.keys()]
    let consistent = true
    for (const first of indices) {
      for (const second of indices) {
        if (second <= first) continue
        const pair = new Map([
          [first, shares.get(first)],
          [second, shares.get(second)],
        ])
        if (combineAt(pair) !== publicKey) consistent = false
      }
    }
    if (consistent) pass('De publika andelarna hör till valets publika nyckel', 'varje par kombineras till den')
    else fail('De publika andelarna hör inte till valets publika nyckel', 'ett par kombineras till en annan')
  }

  // --- Valsedlarna -----------------------------------------------------------------
  const ballots = Array.isArray(publication.ballots) ? publication.ballots : null
  if (ballots === null || ballots.length === 0) {
    fail('Publiceringen har inga valsedlar')
    return finish()
  }

  // Samma valsedel två gånger blåser upp antalet röster utan att något resultat
  // per valsedel ändras, och alla andra kontroller håller då (granskningens 07f,
  // fixrunda 1). Varje valsedel ska därför stå en gång. Vilka valsedlar
  // omröstningen har kan verktyget inte veta, se utskriften.
  const seen = new Map()
  for (const ballot of ballots) {
    const id = ballot?.ballotId
    seen.set(id, (seen.get(id) ?? 0) + 1)
  }
  for (const [id, times] of seen) {
    if (times > 1) fail(`Publiceringen är fel: valsedeln ${String(id)} står ${times === 2 ? 'två' : times} gånger`)
  }

  let totalRows = 0
  let totalMarkers = 0
  let countsKnown = true

  for (const [position, ballot] of ballots.entries()) {
    const name = typeof ballot?.label === 'string' ? ballot.label : `Valsedel ${position + 1}`
    const ballotId = attempt(`${name}: valsedelns id`, () => parseId(ballot?.ballotId, 'valsedelns id'))
    const rows = attempt(`${name}: antalet rader i urnan`, () => parseCount(ballot?.rows, 'antalet rader'))
    const markers = attempt(`${name}: antalet markeringar "har röstat"`, () =>
      parseCount(ballot?.markedAsVoted, 'antalet markeringar'),
    )
    if (ballotId === null || rows === null || markers === null) {
      countsKnown = false
      decryptionHolds = false
      continue
    }
    totalRows += rows
    totalMarkers += markers

    const options = Array.isArray(ballot.options) ? ballot.options : []
    if (options.length === 0) {
      fail(`${name}: valsedeln har inga alternativ`)
      decryptionHolds = false
      continue
    }

    // Summan per alternativ.
    const sums = options.map((option, optionIndex) =>
      attempt(`${name}: summan för alternativ ${optionIndex}`, () => {
        if (option?.optionIndex !== optionIndex) throw new Invalid('alternativet står inte på sin plats')
        const c1 = parseResidue(option.c1, 'c1')
        const c2 = parseResidue(option.c2, 'c2')
        // C1 och C2 är 1 eller ligger i undergruppen. Summan av inga röster är (1, 1).
        if (c1 !== 1n && !inSubgroup(c1)) throw new Invalid('c1 är varken 1 eller i undergruppen')
        if (c2 !== 1n && !inSubgroup(c2)) throw new Invalid('c2 är varken 1 eller i undergruppen')
        return { c1, c2 }
      }),
    )

    // Bidragen, prövade ett och ett.
    const contributions = Array.isArray(ballot.contributions) ? ballot.contributions : []
    const valid = new Map()
    let partialsChecked = 0
    let ballotHolds = sums.every((sum) => sum !== null)

    // Två bidrag från samma förtroendeperson ger fel Lagrange-koefficienter utan
    // att något kastar (spec 4.5). Inget av dem räknas.
    const occurrences = new Map()
    for (const contribution of contributions) {
      const index = contribution?.trusteeIndex
      occurrences.set(index, (occurrences.get(index) ?? 0) + 1)
    }

    for (const contribution of contributions) {
      const trusteeIndex = contribution?.trusteeIndex
      if (!Number.isSafeInteger(trusteeIndex) || trusteeIndex < 1 || trusteeIndex > TRUSTEE_COUNT) {
        fail(`${name}: ett bidrag från förtroendeperson ${trusteeIndex}, som inte finns bland de ${TRUSTEE_COUNT}`)
        ballotHolds = false
        continue
      }
      if (occurrences.get(trusteeIndex) > 1) {
        if (!valid.has(trusteeIndex)) fail(`${name}: förtroendeperson ${trusteeIndex} lämnar bidrag två gånger`)
        valid.set(trusteeIndex, null)
        ballotHolds = false
        continue
      }
      const share = shares.get(trusteeIndex)
      if (share === undefined) {
        fail(`${name}: förtroendeperson ${trusteeIndex} har ingen publik andel att pröva bidraget mot`)
        valid.set(trusteeIndex, null)
        ballotHolds = false
        continue
      }
      const partials = Array.isArray(contribution.partials) ? contribution.partials : []
      if (partials.length !== options.length) {
        fail(`${name}: förtroendeperson ${trusteeIndex}:s bidrag har inte ett värde per alternativ`)
        valid.set(trusteeIndex, null)
        ballotHolds = false
        continue
      }

      const values = []
      for (const [optionIndex, partial] of partials.entries()) {
        const sum = sums[optionIndex]
        if (sum === null) {
          values.push(null)
          continue
        }
        const value = attempt(`${name}: förtroendeperson ${trusteeIndex}:s bidrag för alternativ ${optionIndex}`, () =>
          checkPartial({ electionId, ballotId, optionIndex, trusteeIndex, publicShare: share, sum, partial }),
        )
        if (value !== null) partialsChecked += 1
        values.push(value)
      }
      if (values.some((value) => value === null)) {
        ballotHolds = false
        valid.set(trusteeIndex, null)
      } else {
        valid.set(trusteeIndex, values)
      }
    }

    const usable = new Map([...valid].filter(([, values]) => values !== null))
    if (usable.size < TRUSTEE_THRESHOLD) {
      fail(
        `${name}: bidrag som håller finns från ${usable.size} förtroendepersoner, och kombinationen kräver ` +
          `${TRUSTEE_THRESHOLD} förtroendepersoner`,
      )
      decryptionHolds = false
      countsKnown = false
      continue
    }
    if (ballotHolds) {
      pass(`${name}: varje partiell dekryptering håller`, `${partialsChecked} bevis, från ${usable.size} förtroendepersoner`)
    }

    // Kombinationen och räkneverken.
    let total = 0
    let countsValid = true
    for (const [optionIndex, option] of options.entries()) {
      const sum = sums[optionIndex]
      const count = attempt(`${name}: räkneverket för alternativ ${optionIndex}`, () => {
        const parsed = parseCount(option?.count, 'räkneverket')
        if (parsed > rows) throw new Invalid(`räkneverket ${parsed} är fler än urnans ${rows} rader`)
        return parsed
      })
      if (count === null) {
        countsValid = false
        ballotHolds = false
        continue
      }
      total += count
      if (sum === null) continue

      const shared = combineAt(new Map([...usable].map(([index, values]) => [index, values[optionIndex]])))
      const opened = (sum.c2 * inverse(shared, P)) % P
      if (modPow(G, BigInt(count), P) !== opened) {
        fail(
          `${name}: resultatet för alternativ ${optionIndex} är inte dekrypteringen av summan`,
          `g^${count} är inte c2 delat med kombinationen av bidragen`,
        )
        ballotHolds = false
      }
    }

    if (ballotHolds) pass(`${name}: dekrypteringen av summan ger de publicerade talen`)
    else decryptionHolds = false

    if (countsValid) {
      if (total === rows) pass(`${name}: räkneverken summerar till antalet rader i urnan`, `${rows}`)
      else fail(`${name}: räkneverken summerar till ${total}, men urnan har ${rows} rader för valsedeln`)
    } else {
      countsKnown = false
    }

    if (rows === markers) pass(`${name}: urnan har lika många rader som markeringar "har röstat"`, `${markers}`)
    else fail(`${name}: urnan har ${rows} rader, men ${markers} markeringar "har röstat"`)
  }

  // --- Summan av markeringarna ------------------------------------------------------------
  // Fältet är summan av markeringarna "har röstat" över omröstningens valsedlar
  // (fixrunda 1, Mindre 3). Skalningen skriver en markering per flyttat kuvert,
  // men antalet kuvert lagras inte för sig, så det här är inget oberoende tal.
  const markedTotal = publication.markedAsVotedTotal
  if (!Number.isSafeInteger(markedTotal) || markedTotal < 0) {
    fail('Summan av markeringarna "har röstat" saknas eller är inte ett heltal från 0')
  } else if (!countsKnown) {
    fail('Summan av markeringarna går inte att jämföra med antalet röster, eftersom ett räkneverk inte gick att läsa')
  } else if (markedTotal === totalRows && markedTotal === totalMarkers) {
    pass('Summan av markeringarna stämmer med antalet rader i urnorna och valsedlarnas markeringar', `${markedTotal}`)
  } else {
    fail(
      `Summan av markeringarna är ${markedTotal}, men urnorna har ${totalRows} rader och valsedlarna ` +
        `${totalMarkers} markeringar`,
    )
  }

  // Slutsatsen skrivs bara när ingenting har underkänts (fixrunda 1, Mindre 1).
  // Förut stod den också när nyckeln, en rot eller antalen underkändes, och den
  // som letade efter raden kunde luras.
  if (decryptionHolds && failures === 0) {
    lines.push('', '  Slutsats: dekrypteringen stämmer för varje valsedel.')
  }

  return finish()

  function finish() {
    lines.push(
      '',
      failures === 0
        ? 'ALLT SOM VERKTYGET KAN KONTROLLERA STÄMMER'
        : `${failures} ${failures === 1 ? 'KONTROLL UNDERKÄND' : 'KONTROLLER UNDERKÄNDA'}`,
      '',
      'Det här kan verktyget inte kontrollera:',
      '  – Att summan består av exakt de giltiga rösterna. De enskilda chiffren publiceras inte, så',
      '    summan kan inte räknas om här. Det vilar på valideringen medan kopplingen mellan väljare och',
      '    röst fanns, och på slutkontrollen, som båda körs av den som driver systemet.',
      '  – Kuvertroten och urnroten kan inte räknas om, eftersom de enskilda kuverten och chiffren inte',
      '    publiceras. De är åtaganden: den som sparade dem vid stängningen kan jämföra dem med de',
      '    publicerade. Ändras urnan och rötterna tillsammans syns det inte här.',
      '  – Att antalet rader och markeringarna är riktiga. Verktyget prövar bara att de stämmer med',
      '    varandra och med räkneverken. Antalet kuvert som skalades publiceras inte för sig.',
      '  – Vilka valsedlar omröstningen har. Verktyget prövar de valsedlar som publiceringen tar med',
      '    och underkänner en valsedel som står två gånger, men ser inte om en valsedel saknas.',
      '  – Att valets publika nyckel och förtroendepersonernas andelar är de som fanns när rösterna',
      '    krypterades. Den som sparade nyckeln medan röstningen pågick kan jämföra med den.',
      '',
    )
    return { ok: failures === 0, lines }
  }
}

// ---------------------------------------------------------------------------
// Programmet
// ---------------------------------------------------------------------------

const USAGE = [
  'Använd: node tools/verify-election.mjs <URL eller fil> [omröstningens id]',
  '',
  '  URL:en är den offentliga rutten, till exempel',
  '    https://<värd>/api/observer/results?electionId=<omröstningens id>',
  '  och filen en JSON-fil med samma innehåll.',
  '',
  '  Publiceringen ska gälla omröstningen i adressen, eller den som anges som andra',
  '  argument. För en fil utan andra argument prövas inte vilken omröstning den gäller.',
].join('\n')

/** Omröstningens id i adressen, när underlaget är en adress med `electionId`. */
export function expectedElectionIdFrom(source) {
  if (!/^https?:\/\//i.test(source)) return undefined
  return new URL(source).searchParams.get('electionId') ?? undefined
}

async function load(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { headers: { Accept: 'application/json' } })
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`svaret var inte JSON (status ${response.status})`)
    }
  }
  return JSON.parse(await readFile(source, 'utf8'))
}

async function main(argv) {
  const source = argv[2]
  if (!source || argv.length > 4) {
    console.error(USAGE)
    return 2
  }

  let publication
  try {
    publication = await load(source)
  } catch (error) {
    console.error(`Kunde inte läsa ${source}: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }

  const name = typeof publication?.election?.name === 'string' ? publication.election.name : 'okänd omröstning'
  console.log(`\nOmröstning: ${name}`)
  if (typeof publication?.election?.phase === 'string') console.log(`Fas: ${publication.election.phase}`)
  console.log('')

  const { ok, lines } = verifyPublication(publication, { electionId: argv[3] ?? expectedElectionIdFrom(source) })
  for (const line of lines) console.log(line)
  return ok ? 0 : 1
}

/** Sant när filen körs som program, inte när den importeras av ett test. */
function invokedDirectly() {
  if (!process.argv[1]) return false
  const self = fileURLToPath(import.meta.url)
  const invoked = resolve(process.argv[1])
  return process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked
}

if (invokedDirectly()) {
  process.exitCode = await main(process.argv)
}
