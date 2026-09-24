import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientAddressFrom, trustedProxyHops } from '@/lib/client-address'
import { getClientIp } from '@/lib/http'

/**
 * KLIENTENS ADRESS FÖR HASTIGHETSBEGRÄNSNINGEN (fixrunda 1, uppgift 14b).
 *
 * Förut togs den första posten i X-Forwarded-For, och den väljer klienten
 * själv. En ny påhittad adress per begäran tog sig förbi varje gräns i
 * systemet. Här prövas tolkningen. Att middleware tar bort klientens rubrik,
 * och att Next då sätter anslutningens adress, prövas i
 * tests/unit/middleware-headers.test.ts och mot den riktiga servern i
 * tests/e2e/rate-limit.spec.ts.
 */

afterEach(() => {
  vi.unstubAllEnvs()
})

function requestWith(forwardedFor: string | null): Request {
  const headers = new Headers()
  if (forwardedFor !== null) headers.set('x-forwarded-for', forwardedFor)
  return new Request('http://localhost:3000/api/verify', { method: 'POST', headers })
}

describe('TRUSTED_PROXY_HOPS', () => {
  it('är 0 när den saknas, och då är ingen proxy betrodd', () => {
    expect(trustedProxyHops(undefined)).toBe(0)
    expect(trustedProxyHops('')).toBe(0)
    expect(trustedProxyHops('0')).toBe(0)
  })

  it('läser ett heltal', () => {
    expect(trustedProxyHops('1')).toBe(1)
    expect(trustedProxyHops(' 2 ')).toBe(2)
  })

  it('räknar allt annat som 0, så att ett skrivfel aldrig gör rubriken betrodd', () => {
    for (const raw of ['ja', 'true', '-1', '1.5', '100', '1 2', '0x1']) {
      expect(trustedProxyHops(raw), raw).toBe(0)
    }
  })
})

describe('adressen ur X-Forwarded-For', () => {
  it('utan betrodd proxy är den enda posten anslutningens adress, som Next satte', () => {
    expect(clientAddressFrom('::1', 0)).toBe('::1')
  })

  it('tar aldrig den första posten, som klienten själv kan ha valt', () => {
    // Före rättelsen gav det här 203.0.113.9, alltså klientens eget val.
    expect(clientAddressFrom('203.0.113.9, 198.51.100.4', 0)).toBe('198.51.100.4')
    expect(clientAddressFrom('203.0.113.9, 198.51.100.4', 1)).toBe('198.51.100.4')
  })

  it('med två proxyer är adressen den som den yttre proxyn såg', () => {
    // Klienten skickade 203.0.113.9 själv. CDN:en såg 198.51.100.4 och lade
    // till den, och den inre proxyn lade till CDN:ens adress.
    expect(clientAddressFrom('203.0.113.9, 198.51.100.4, 192.0.2.1', 2)).toBe('198.51.100.4')
  })

  it('en lista kortare än antalet proxyer ger den första posten, som en betrodd proxy skrev', () => {
    expect(clientAddressFrom('198.51.100.4', 2)).toBe('198.51.100.4')
  })

  it('utan rubrik blir adressen okänd, och alla sådana delar en gräns', () => {
    expect(clientAddressFrom(null, 0)).toBe('okand')
    expect(clientAddressFrom(' , ', 1)).toBe('okand')
  })
})

describe('getClientIp', () => {
  it('följer TRUSTED_PROXY_HOPS', () => {
    const request = requestWith('203.0.113.9, 198.51.100.4, 192.0.2.1')

    expect(getClientIp(request)).toBe('192.0.2.1')
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2')
    expect(getClientIp(request)).toBe('198.51.100.4')
  })

  it('läser inte X-Real-IP, som klienten också kan sätta', () => {
    const request = new Request('http://localhost:3000/', { headers: { 'x-real-ip': '203.0.113.9' } })
    expect(getClientIp(request)).toBe('okand')
  })
})
