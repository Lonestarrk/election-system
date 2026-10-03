import { describe, expect, it } from 'vitest'
import { RATE_LIMITS } from '@/lib/rate-limit'

/**
 * Pollningen av signeringen får inte strypa väljare bakom samma adress
 * (uppgift 14e, fixrunda 1, ruling 139).
 *
 * Röstsidan frågar /api/vote/encrypted varannan sekund, alltså 30 gånger per
 * minut och väljare. Gränsen var 30 per minut och adress, så en enda väljare
 * låg exakt på den och två bakom samma NAT blev strypta.
 */
describe('hastighetsgränsen för pollningen av signeringen', () => {
  const POLLS_PER_MINUTE = 60 / 2

  it('ger plats för fyra väljare bakom samma adress, med marginal', () => {
    expect(RATE_LIMITS.castEncryptedBallot.windowMs).toBe(60_000)
    expect(RATE_LIMITS.castEncryptedBallot.limit).toBeGreaterThanOrEqual(POLLS_PER_MINUTE * 4)
  })

  it('är ändå ett tak, inte obegränsad', () => {
    expect(RATE_LIMITS.castEncryptedBallot.limit).toBeLessThanOrEqual(POLLS_PER_MINUTE * 10)
  })
})
