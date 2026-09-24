/**
 * SHA-256, UTAN NODE OCH UTAN BEROENDEN.
 *
 * VARFÖR DEN FINNS
 *
 * Valsedeln krypteras i väljarens webbläsare, och bevisens utmaningar och
 * chifferhashen räknas där med samma kod som servern verifierar med. Den koden
 * hämtade tidigare `createHash` ur node:crypto. Det gick bra i Node och i
 * testerna, men webbläsarens bunt kan inte läsa `node:crypto` över huvud
 * taget, och röstsidan kompilerade därför inte. Felet syntes inte förrän en
 * sida i webbläsaren importerade klientmodulen.
 *
 * Två vägar valdes bort:
 *
 *   - WebCrypto `subtle.digest` finns överallt men är asynkron. Bevisen och
 *     hela verifieringen är synkrona, och att göra om dem vore en omskrivning
 *     av kod som redan är granskad.
 *   - Nexts ersättning för Nodes crypto i webbläsaren (crypto-browserify)
 *     följer med ett vanligt `import 'crypto'`. Den hade dragit in hundratals
 *     kilobyte främmande kryptokod i just den kod som bär valhemligheten,
 *     vilket är skälet till att projektet inte har några kryptoberoenden.
 *
 * Kvar blir SHA-256 skriven här, en enda implementation som både bevisaren i
 * webbläsaren och verifieraren på servern använder, så att de två aldrig kan
 * räkna olika. tests/unit/crypto/sha256.test.ts jämför den med node:crypto för
 * standardens testvektorer, varje längd runt blockgränserna och slumpade
 * strängar, och visar att utmaningarna och chifferhasharna blev exakt desamma
 * som förut.
 *
 * Hashen används till Fiat–Shamir-utmaningar och till chifferhashen, inte till
 * nycklar eller lösenord. Den behöver alltså vara rätt, inte snabb eller
 * sidokanalssäker: indata är offentligt material.
 */

/** Rundkonstanterna, de första 32 bitarna av bråkdelen i kubikroten ur de 64 första primtalen. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** Startvärdet, de första 32 bitarna av bråkdelen i kvadratroten ur de åtta första primtalen. */
const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

/**
 * SHA-256 över en bytesekvens.
 *
 * Talen hålls som 32-bitars heltal utan tecken. JavaScript räknar i flyttal,
 * men summor av några få 32-bitarstal ryms exakt, och `>>> 0` tar dem modulo
 * 2^32 precis som algoritmen kräver, också när en term är negativ efter en
 * bitoperation.
 */
export function sha256(data: Uint8Array): Uint8Array {
  const length = data.length

  // Utfyllnad: en etta, nollor, och meddelandets längd i bitar som ett
  // 64-bitars tal sist i sista blocket. Ryms inte längden efter ettan behövs
  // ett block till, därav +9.
  const paddedLength = Math.ceil((length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(data)
  padded[length] = 0x80

  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(length / 0x20000000))
  view.setUint32(paddedLength - 4, (length * 8) >>> 0)

  const state = Uint32Array.from(INITIAL)
  const schedule = new Uint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let t = 0; t < 16; t += 1) schedule[t] = view.getUint32(offset + t * 4)

    for (let t = 16; t < 64; t += 1) {
      const w15 = schedule[t - 15]!
      const w2 = schedule[t - 2]!
      const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3)
      const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10)
      schedule[t] = (schedule[t - 16]! + s0 + schedule[t - 7]! + s1) >>> 0
    }

    let a = state[0]!
    let b = state[1]!
    let c = state[2]!
    let d = state[3]!
    let e = state[4]!
    let f = state[5]!
    let g = state[6]!
    let h = state[7]!

    for (let t = 0; t < 64; t += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temp1 = (h + sum1 + choose + K[t]! + schedule[t]!) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + majority) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    state[0] = (state[0]! + a) >>> 0
    state[1] = (state[1]! + b) >>> 0
    state[2] = (state[2]! + c) >>> 0
    state[3] = (state[3]! + d) >>> 0
    state[4] = (state[4]! + e) >>> 0
    state[5] = (state[5]! + f) >>> 0
    state[6] = (state[6]! + g) >>> 0
    state[7] = (state[7]! + h) >>> 0
  }

  const digest = new Uint8Array(32)
  const out = new DataView(digest.buffer)
  for (let index = 0; index < 8; index += 1) out.setUint32(index * 4, state[index]!)
  return digest
}

/**
 * SHA-256 över texten som UTF-8, som hex.
 *
 * Samma sak som `createHash('sha256').update(text).digest('hex')`, där Node
 * också kodar en sträng som UTF-8. Anroparna bygger sin indata som en enda
 * sträng av delar; att hasha delarna i följd eller deras sammanfogning ger
 * samma resultat, eftersom SHA-256 bara ser bytesekvensen.
 */
export function sha256Hex(text: string): string {
  const digest = sha256(new TextEncoder().encode(text))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
