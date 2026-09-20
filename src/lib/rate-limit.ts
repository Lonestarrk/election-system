/**
 * Hastighetsbegränsning med token bucket, i processminne.
 *
 * TILLRÄCKLIGT FÖR EN POC, INTE FÖR SKARP DRIFT: tillståndet ligger i en
 * enskild Node-process. Med flera instanser bakom en lastbalanserare blir den
 * faktiska gränsen gånger antalet instanser, och den nollställs vid omstart.
 * Ett riktigt system lägger detta i Redis eller i en WAF framför applikationen.
 *
 * Nycklarna hashas innan de lagras. Nyckeln är oftast en IP-adress, och en
 * minnesstruktur full av IP-adresser som går att dumpa via en heap-dump är
 * precis den sortens sidokanal som kan knyta en person till en tidpunkt.
 */

import { sha256Hex } from './crypto'

type Bucket = { tokens: number; lastRefill: number }

const buckets = new Map<string, Bucket>()

export type RateLimitRule = {
  /** Antal tillåtna anrop i fönstret. */
  limit: number
  /** Fönstrets längd i millisekunder. */
  windowMs: number
}

export const RATE_LIMITS = {
  /** Legitimeringsstart: dyr operation, tajt gräns. */
  authStart: { limit: 5, windowMs: 60_000 },
  /** Polling av legitimeringsstatus: sker ofta, mjukare gräns. */
  authCollect: { limit: 60, windowMs: 60_000 },
  /** Röstläggning. */
  castVote: { limit: 5, windowMs: 60_000 },
  /**
   * Verifiering. Stramt satt trots att en 240-bitars token inte går att
   * gissa — gränsen finns för att stoppa uppräkning som lastangrepp.
   */
  verify: { limit: 10, windowMs: 60_000 },

  /**
   * Uppslag av en valsedels innehåll. Generös gräns — det är offentlig
   * information och en väljare slår upp tre valsedlar i rad. Gränsen finns för
   * att uppräkning inte ska bli ett billigt lastangrepp, inte för att skydda
   * innehållet.
   */
  ballotLookup: { limit: 60, windowMs: 60_000 },
  /** Admininloggning. */
  adminLogin: { limit: 5, windowMs: 300_000 },

  /** Adminstatistik. Läses om ofta medan en omröstning pågår. */
  adminStats: { limit: 120, windowMs: 60_000 },

  /** Skapa omröstning. Sällan-operation; gränsen finns mot felslagna skript. */
  createElection: { limit: 10, windowMs: 300_000 },

  /**
   * Prenumeration på notiser. En enhet prenumererar en gång och sedan sällan.
   * Gränsen hindrar att tabellen fylls med påhittade endpoints.
   */
  pushSubscribe: { limit: 5, windowMs: 300_000 },
} as const satisfies Record<string, RateLimitRule>

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number }

/**
 * Tak för antal spårade nycklar.
 *
 * Utan det växer strukturen med en post per unik IP-adress och scope, och en
 * angripare med tillgång till många adresser kan driva upp minnesanvändningen
 * tills processen faller. En hastighetsbegränsare som går att använda för att
 * ta ned tjänsten är sämre än ingen alls.
 */
const MAX_TRACKED_KEYS = 10_000

/**
 * Städar bort nycklar vars hink hunnit fyllas på helt.
 *
 * En full hink är funktionellt identisk med en som inte finns: båda ger
 * `allowed: true` med maximalt antal kvarvarande försök. Att slänga dem
 * påverkar alltså inte begränsningen.
 */
function evictRefilledBuckets(rule: RateLimitRule, now: number): void {
  const refillRate = rule.limit / rule.windowMs

  for (const [key, bucket] of buckets) {
    const refilled = bucket.tokens + (now - bucket.lastRefill) * refillRate
    if (refilled >= rule.limit) buckets.delete(key)
  }
}

export function checkRateLimit(scope: string, rawKey: string, rule: RateLimitRule): RateLimitResult {
  const key = `${scope}:${sha256Hex(rawKey)}`
  const now = Date.now()
  const refillRate = rule.limit / rule.windowMs

  if (buckets.size >= MAX_TRACKED_KEYS && !buckets.has(key)) {
    evictRefilledBuckets(rule, now)
  }

  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = { tokens: rule.limit, lastRefill: now }
    buckets.set(key, bucket)
  }

  bucket.tokens = Math.min(rule.limit, bucket.tokens + (now - bucket.lastRefill) * refillRate)
  bucket.lastRefill = now

  if (bucket.tokens < 1) {
    const msUntilNextToken = (1 - bucket.tokens) / refillRate
    return { allowed: false, retryAfterSeconds: Math.ceil(msUntilNextToken / 1000) }
  }

  bucket.tokens -= 1
  return { allowed: true, retryAfterSeconds: 0 }
}

/** Endast för tester. */
export function resetRateLimits(): void {
  buckets.clear()
}
