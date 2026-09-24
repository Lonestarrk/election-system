import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildFixedBaseTable } from '@/lib/crypto/fixed-base'
import {
  FIXED_BASE_WINDOW_BITS,
  G,
  G_INVERSE,
  P,
  Q,
  bigintModPow,
  isInSubgroup,
  modPow,
  registerGroupExponentiation,
  useFixedBase,
} from '@/lib/crypto/group'

/**
 * TABELLERNA FÖR FASTA BASER MOT BIGINT.
 *
 * Tabellen ger en annan väg till samma potens. Webbläsaren bygger bevisen med
 * den, och servern prövar dem utan den, så ett fel här syns som att äkta röster
 * underkänns. Varje fönsterbredd prövas mot `bigintModPow` på slumpade
 * exponenter och på exponenterna vid fönstrens gränser.
 */

function randomBits(bits: number): bigint {
  const bytes = randomBytes(Math.ceil(bits / 8))
  return BigInt('0x' + bytes.toString('hex')) >> BigInt(bytes.length * 8 - bits)
}

const EXPONENT_BITS = P.toString(2).length

describe('tabell för en fast bas', () => {
  const h = bigintModPow(G, randomBits(2047) % Q, P)

  it('ger samma potens som BigInt för varje fönsterbredd', () => {
    for (let window = 1; window <= 8; window += 1) {
      const table = buildFixedBaseTable(h, P, EXPONENT_BITS, window)
      expect(table.entries).toBe(Math.ceil(EXPONENT_BITS / window) * (2 ** window - 1))

      const exponents = [
        0n,
        1n,
        2n,
        BigInt(2 ** window - 1),
        BigInt(2 ** window),
        (1n << BigInt(window * 3)) - 1n,
        1n << BigInt(window * 3),
        Q - 1n,
        Q,
        Q + 1n,
        P - 1n,
        (1n << BigInt(EXPONENT_BITS)) - 1n,
        ...Array.from({ length: 6 }, () => randomBits(2047) % Q),
        ...Array.from({ length: 6 }, () => randomBits(1 + Number(randomBits(8)))),
      ]

      for (const exponent of exponents) {
        expect(table.pow(exponent), `fönster ${window}, exponent ${exponent}`).toBe(
          bigintModPow(h, exponent, P),
        )
      }
    }
  }, 60_000)

  it('vägrar exponenter utanför tabellen i stället för att räkna fel', () => {
    // Anroparen räknar dem i BigInt. En tabell som tyst tappade de höga
    // bitarna hade gett ett annat tal och ett underkänt bevis.
    const table = buildFixedBaseTable(G, P, EXPONENT_BITS, 4)
    expect(table.pow(1n << BigInt(EXPONENT_BITS))).toBeNull()
    expect(table.pow((1n << 4096n) + 5n)).toBeNull()
    expect(table.pow(-1n)).toBeNull()
  })

  it('klarar baserna 0, 1 och p − 1', () => {
    for (const base of [0n, 1n, P - 1n]) {
      const table = buildFixedBaseTable(base, P, 64, 4)
      for (const exponent of [0n, 1n, 2n, 3n, (1n << 64n) - 1n]) {
        expect(table.pow(exponent)).toBe(bigintModPow(base, exponent, P))
      }
    }
  })

  it('vägrar en bas utanför [0, p) och en orimlig fönsterbredd', () => {
    expect(() => buildFixedBaseTable(P, P, 64, 4)).toThrow()
    expect(() => buildFixedBaseTable(-1n, P, 64, 4)).toThrow()
    expect(() => buildFixedBaseTable(G, P, 64, 0)).toThrow()
    expect(() => buildFixedBaseTable(G, P, 64, 1.5)).toThrow()
  })
})

describe('gruppens exponentiering', () => {
  it('g^(−1) i sluten form är samma tal som g^(q−1)', () => {
    expect((G * G_INVERSE) % P).toBe(1n)
    expect(G_INVERSE).toBe(bigintModPow(G, Q - 1n, P))
  })

  it('räknar g och valets nyckel med tabell, med samma svar som BigInt', () => {
    // modPow ger samma tal oavsett väg. Här går g och h genom tabellerna,
    // eftersom ingen snabbare exponentiering är registrerad i den här filen.
    const h = bigintModPow(G, randomBits(2047) % Q, P)
    useFixedBase(h)

    for (const base of [G, h]) {
      for (const exponent of [0n, 1n, Q - 1n, Q, ...Array.from({ length: 4 }, () => randomBits(2047))]) {
        expect(modPow(base, exponent, P)).toBe(bigintModPow(base, exponent, P))
      }
    }
    expect(FIXED_BASE_WINDOW_BITS).toBe(4)
  })

  it('en ny publik nyckel ersätter den förra, och båda räknas rätt', () => {
    const first = bigintModPow(G, 11n, P)
    const second = bigintModPow(G, 13n, P)
    const exponent = randomBits(2047)

    useFixedBase(first)
    expect(modPow(first, exponent, P)).toBe(bigintModPow(first, exponent, P))
    useFixedBase(second)
    expect(modPow(second, exponent, P)).toBe(bigintModPow(second, exponent, P))
    expect(modPow(first, exponent, P)).toBe(bigintModPow(first, exponent, P))
  })

  it('använder en registrerad exponentiering bara modulo p', () => {
    // Lagrange-koefficienterna i threshold.ts räknas modulo q. De ska aldrig
    // skickas till en implementation som bara känner p.
    const seen: Array<[bigint, bigint]> = []
    registerGroupExponentiation((base, exponent) => {
      seen.push([base, exponent])
      return bigintModPow(base, exponent, P)
    })

    try {
      expect(modPow(7n, 5n, P)).toBe(bigintModPow(7n, 5n, P))
      expect(modPow(7n, Q - 2n, Q)).toBe(bigintModPow(7n, Q - 2n, Q))
      expect(seen).toEqual([[7n, 5n]])
    } finally {
      registerGroupExponentiation(null)
    }
  })
})

describe('undergruppskontrollen', () => {
  // REVIEW FOCUS 1. isInSubgroup räknar y^q som y^(q−1) · y. Det ska ge exakt
  // samma svar som definitionen, y^q ≡ 1 med 1 < y < p, för varje värde.
  const byDefinition = (value: bigint) =>
    value > 1n && value < P && bigintModPow(value, Q, P) === 1n

  it('ger samma svar som definitionen, i och utanför undergruppen', () => {
    const values = [
      0n,
      1n,
      2n,
      3n,
      G,
      G_INVERSE,
      P - 2n,
      P - 1n,
      P,
      P + 1n,
      -4n,
      ...Array.from({ length: 6 }, () => bigintModPow(G, randomBits(2047), P)),
      ...Array.from({ length: 6 }, () => P - bigintModPow(G, randomBits(2047), P)),
      ...Array.from({ length: 6 }, () => randomBits(2048) % P),
    ]

    for (const value of values) {
      expect(isInSubgroup(value), String(value)).toBe(byDefinition(value))
    }
  }, 60_000)
})
