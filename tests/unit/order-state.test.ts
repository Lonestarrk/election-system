import { beforeEach, describe, expect, it } from 'vitest'
import {
  attachCompletion,
  MAX_ORDERS,
  MAX_ORDERS_PER_SESSION,
  ORDER_LIFETIME_MS,
  getOrder,
  orderCount,
  putOrder,
  resetOrders,
  takeOrder,
  type OrderState,
} from '@/lib/order-state'
import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'

/**
 * SERVERNS TILLSTÅND PER BANKID-ORDER (uppgift 14e), src/lib/order-state.ts.
 *
 * Fyra egenskaper ska gälla: ordern kan bara förbrukas en gång, en annan session
 * kommer inte åt den, den förfaller, och lagret har ett tak.
 */

const BALLOT = { ciphertext: [], ciphertextHash: 'a'.repeat(64) } as unknown as EncryptedBallot
const state = (ballotId = 'valsedel-1'): OrderState => ({ ballotId, ballot: BALLOT })

const ORDER = '11111111-1111-4111-8111-111111111111'

beforeEach(() => resetOrders())

describe('en order förbrukas en gång', () => {
  it('get lämnar ordern kvar, så att en pollning som inte är klar kan fråga igen', () => {
    putOrder(ORDER, 'session-a', state())
    expect(getOrder(ORDER, 'session-a')?.ballotId).toBe('valsedel-1')
    expect(getOrder(ORDER, 'session-a')?.ballotId).toBe('valsedel-1')
  })

  it('take ger ordern en gång och tar bort den', () => {
    putOrder(ORDER, 'session-a', state())
    expect(takeOrder(ORDER, 'session-a')?.ballot).toBe(BALLOT)
    expect(takeOrder(ORDER, 'session-a')).toBeNull()
    expect(getOrder(ORDER, 'session-a')).toBeNull()
    expect(orderCount()).toBe(0)
  })

  it('en okänd order ger null', () => {
    expect(getOrder(ORDER, 'session-a')).toBeNull()
    expect(takeOrder(ORDER, 'session-a')).toBeNull()
  })
})

describe('en order är bunden till väljarens session', () => {
  it('en annan session får inte hämta valsedeln med samma orderRef', () => {
    putOrder(ORDER, 'session-a', state())

    expect(getOrder(ORDER, 'session-b')).toBeNull()
    expect(takeOrder(ORDER, 'session-b')).toBeNull()
  })

  it('en annan sessions försök förbrukar inte ordern: ägaren får den fortfarande', () => {
    putOrder(ORDER, 'session-a', state())
    takeOrder(ORDER, 'session-b')

    expect(takeOrder(ORDER, 'session-a')?.ballotId).toBe('valsedel-1')
  })

  it('sessionens id sparas inte i klartext', () => {
    putOrder(ORDER, 'session-hemlig', state())
    const held = (globalThis as { __orderStates?: Map<string, { sessionKey: string }> })
      .__orderStates!
    expect(JSON.stringify([...held.values()].map((entry) => entry.sessionKey))).not.toContain(
      'session-hemlig',
    )
  })
})

describe('en order som aldrig blir klar förfaller', () => {
  it('är kvar strax före livslängden och borta vid den', () => {
    const start = 1_000_000
    putOrder(ORDER, 'session-a', state(), start)

    expect(getOrder(ORDER, 'session-a', start + ORDER_LIFETIME_MS - 1)).not.toBeNull()
    expect(getOrder(ORDER, 'session-a', start + ORDER_LIFETIME_MS)).toBeNull()
    expect(takeOrder(ORDER, 'session-a', start + ORDER_LIFETIME_MS)).toBeNull()
  })

  it('de förfallna städas bort även om ingen frågar efter dem', () => {
    const start = 1_000_000
    putOrder(ORDER, 'session-a', state(), start)
    putOrder('22222222-2222-4222-8222-222222222222', 'session-b', state(), start + ORDER_LIFETIME_MS)

    expect(orderCount()).toBe(1)
  })
})

describe('taken', () => {
  it('lagret avvisar en ny order när det är fullt, och ingenting läggs', () => {
    for (let index = 0; index < MAX_ORDERS; index += 1) {
      expect(putOrder(`order-${index}`, `session-${index}`, state())).toBe(true)
    }

    expect(putOrder('en-till', 'session-ny', state())).toBe(false)
    expect(orderCount()).toBe(MAX_ORDERS)
    expect(getOrder('en-till', 'session-ny')).toBeNull()
  })

  it('en session håller högst ett fåtal ordrar, och den äldsta ersätts', () => {
    for (let index = 0; index <= MAX_ORDERS_PER_SESSION; index += 1) {
      putOrder(`order-${index}`, 'session-a', state(`valsedel-${index}`))
    }

    expect(getOrder('order-0', 'session-a')).toBeNull()
    expect(getOrder('order-1', 'session-a')).not.toBeNull()
    expect(getOrder(`order-${MAX_ORDERS_PER_SESSION}`, 'session-a')).not.toBeNull()
    expect(orderCount()).toBe(MAX_ORDERS_PER_SESSION)
  })

  it('en session som fyller sitt tak tar inte någon annans order', () => {
    putOrder('annans', 'session-b', state())
    for (let index = 0; index < MAX_ORDERS_PER_SESSION + 2; index += 1) {
      putOrder(`order-${index}`, 'session-a', state())
    }

    expect(getOrder('annans', 'session-b')).not.toBeNull()
  })
})

describe('kapacitetskontrollen går före ersättningen (fixrunda 1)', () => {
  it('ett fullt lager avvisar utan att ersätta sessionens äldsta order', () => {
    for (let index = 0; index < MAX_ORDERS_PER_SESSION; index += 1) {
      putOrder(`egen-${index}`, 'session-a', state())
    }
    for (let index = 0; index < MAX_ORDERS - MAX_ORDERS_PER_SESSION; index += 1) {
      putOrder(`order-${index}`, `session-${index}`, state())
    }
    expect(orderCount()).toBe(MAX_ORDERS)

    expect(putOrder('ny', 'session-a', state())).toBe(false)

    for (let index = 0; index < MAX_ORDERS_PER_SESSION; index += 1) {
      expect(getOrder(`egen-${index}`, 'session-a')).not.toBeNull()
    }
    expect(orderCount()).toBe(MAX_ORDERS)
  })
})

describe('det insamlade resultatet hålls med ordern (fixrunda 1)', () => {
  const completion = { signature: 'sig', certificateChain: ['kedja'], signedData: 'signerat' }

  it('läggs på ordern, bunden till sessionen, och följer med get och take', () => {
    putOrder(ORDER, 'session-a', state())
    expect(getOrder(ORDER, 'session-a')?.completion).toBeUndefined()

    expect(attachCompletion(ORDER, 'session-a', completion)).toBe(true)
    expect(getOrder(ORDER, 'session-a')?.completion).toEqual(completion)
    expect(takeOrder(ORDER, 'session-a')?.completion).toEqual(completion)
    expect(getOrder(ORDER, 'session-a')).toBeNull()
  })

  it('en annan session kan varken lägga eller läsa det', () => {
    putOrder(ORDER, 'session-a', state())

    expect(attachCompletion(ORDER, 'session-b', completion)).toBe(false)
    expect(getOrder(ORDER, 'session-a')?.completion).toBeUndefined()
    attachCompletion(ORDER, 'session-a', completion)
    expect(getOrder(ORDER, 'session-b')).toBeNull()
  })

  it('förlänger inte förfallet: resultatet förfaller med ordern', () => {
    const start = 1_000_000
    putOrder(ORDER, 'session-a', state(), start)
    attachCompletion(ORDER, 'session-a', completion, start + ORDER_LIFETIME_MS - 1)

    expect(getOrder(ORDER, 'session-a', start + ORDER_LIFETIME_MS)).toBeNull()
  })

  it('en order som saknas kan inte få något', () => {
    expect(attachCompletion(ORDER, 'session-a', completion)).toBe(false)
  })
})

describe('lagret ligger på globalThis', () => {
  it('en omladdad modul ser ordrar som en tidigare upplaga lade', async () => {
    putOrder(ORDER, 'session-a', state())

    const reloaded = await import('@/lib/order-state?omladdad' as string)
    expect(reloaded.getOrder(ORDER, 'session-a')?.ballotId).toBe('valsedel-1')
  })
})
