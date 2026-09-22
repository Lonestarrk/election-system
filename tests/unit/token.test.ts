import { describe, expect, it } from 'vitest'
import {
  generateVoteToken,
  hashToken,
  normaliseToken,
} from '@/modules/ballot-box/token.service'
import { sha256Hex } from '@/lib/crypto'

/**
 * Testpunkt 5: token genereras säkert.
 * Testpunkt 13: två väljare kan inte råka få samma token.
 */

describe('tokengenerering', () => {
  it('har rätt format: sex grupper om åtta tecken', () => {
    const { token } = generateVoteToken()
    expect(token).toMatch(/^[0-9A-Z]{8}(-[0-9A-Z]{8}){5}$/)
  })

  it('använder 240 bitars entropi', () => {
    const { canonical } = generateVoteToken()
    // 48 base32-tecken × 5 bitar = 240 bitar.
    expect(canonical).toHaveLength(48)
  })

  it('innehåller inga tecken som förväxlas vid avläsning', () => {
    for (let index = 0; index < 200; index += 1) {
      const { canonical } = generateVoteToken()
      expect(canonical).not.toMatch(/[ILOU]/)
    }
  })

  it('ger unika tokens över många dragningar', () => {
    const seen = new Set<string>()
    const iterations = 20_000

    for (let index = 0; index < iterations; index += 1) {
      seen.add(generateVoteToken().canonical)
    }

    expect(seen.size).toBe(iterations)
  })

  it('ger unika hashar över många dragningar', () => {
    const seen = new Set<string>()
    const iterations = 20_000

    for (let index = 0; index < iterations; index += 1) {
      seen.add(generateVoteToken().tokenHash)
    }

    expect(seen.size).toBe(iterations)
  })

  it('producerar inte förutsägbara eller ordnade värden', () => {
    const tokens = Array.from({ length: 500 }, () => generateVoteToken().canonical)

    // Två på varandra följande tokens ska inte dela någon meningsfull prefix.
    for (let index = 1; index < tokens.length; index += 1) {
      const previous = tokens[index - 1]!
      const current = tokens[index]!

      let shared = 0
      while (shared < current.length && previous[shared] === current[shared]) shared += 1

      expect(shared).toBeLessThan(6)
    }

    // Ordningen ska inte vara monoton — en tidsbaserad eller räknarbaserad
    // token skulle sortera sig själv, vilket vore en direkt läcka av i vilken
    // ordning rösterna lades.
    const sorted = [...tokens].sort()
    expect(sorted).not.toEqual(tokens)
  })

  it('fördelar första tecknet jämnt över alfabetet', () => {
    const counts = new Map<string, number>()

    for (let index = 0; index < 32_000; index += 1) {
      const first = generateVoteToken().canonical[0]!
      counts.set(first, (counts.get(first) ?? 0) + 1)
    }

    // 32 möjliga tecken, 32 000 dragningar ⇒ väntevärde 1 000 per tecken.
    // Grov gräns: en trasig slumpkälla skulle avvika långt mer än så.
    expect(counts.size).toBe(32)
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(800)
      expect(count).toBeLessThan(1200)
    }
  })
})

describe('tokenhashning', () => {
  it('lagrar SHA-256 av den normaliserade token', () => {
    const { canonical, tokenHash } = generateVoteToken()
    expect(tokenHash).toBe(sha256Hex(canonical))
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('ger samma hash för token med och utan bindestreck', () => {
    const { token, canonical } = generateVoteToken()
    expect(hashToken(token)).toBe(hashToken(canonical))
  })

  it('ger samma hash oavsett gemener eller versaler', () => {
    const { token } = generateVoteToken()
    expect(hashToken(token.toLowerCase())).toBe(hashToken(token))
  })

  it('hashen avslöjar ingenting om token', () => {
    const { canonical, tokenHash } = generateVoteToken()
    expect(tokenHash).not.toContain(canonical.slice(0, 8))
    expect(tokenHash.toUpperCase()).not.toContain(canonical.slice(0, 4))
  })
})

describe('normalisering av avskriven token', () => {
  it('tolkar tecken som ser lika ut', () => {
    // I → 1, L → 1, O → 0, och gemener versaliseras.
    expect(normaliseToken('IL0-O1l')).toBe('110011')
  })

  it('ignorerar mellanslag och bindestreck', () => {
    expect(normaliseToken(' ABC-DEF GHJ ')).toBe('ABCDEFGHJ')
  })
})
