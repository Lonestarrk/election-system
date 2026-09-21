import { describe, expect, it } from 'vitest'
import { hmacSha256Hex, safeEqual, sha256Hex } from '@/lib/crypto'
import { hashPersonalNumber } from '@/modules/eligibility/identity'
import { truncateToDay, truncateToHour } from '@/lib/time'

describe('identitetshashning', () => {
  it('är deterministisk', async () => {
    expect(await hashPersonalNumber('199001011234')).toBe(await hashPersonalNumber('199001011234'))
  })

  it('ger samma hash med och utan bindestreck', async () => {
    expect(await hashPersonalNumber('19900101-1234')).toBe(await hashPersonalNumber('199001011234'))
  })

  it('innehåller inte personnumret', async () => {
    const hash = await hashPersonalNumber('199001011234')
    expect(hash).not.toContain('199001011234')
    expect(hash).not.toContain('1234')
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('beror på peppret', async () => {
    const withoutPepper = sha256Hex('199001011234')
    expect(await hashPersonalNumber('199001011234')).not.toBe(withoutPepper)

    // Ett annat pepper ger ett annat värde: det är det som gör en stulen
    // röstlängd oanvändbar utan applikationens konfiguration.
    const otherPepper = hmacSha256Hex('199001011234', 'ett-annat-pepper-minst-trettiotva-tecken')
    expect(await hashPersonalNumber('199001011234')).not.toBe(otherPepper)
  })

  it('skiljer olika personer åt', async () => {
    expect(await hashPersonalNumber('199001011234')).not.toBe(await hashPersonalNumber('199001011235'))
  })
})

describe('konstanttidsjämförelse', () => {
  it('är sann för identiska strängar', () => {
    expect(safeEqual('hemlighet', 'hemlighet')).toBe(true)
  })

  it('är falsk för olika strängar', () => {
    expect(safeEqual('hemlighet', 'hemlighEt')).toBe(false)
  })

  it('hanterar olika längd utan att kasta', () => {
    expect(safeEqual('kort', 'betydligt längre sträng')).toBe(false)
  })
})

describe('grovkorniga tidsstämplar', () => {
  it('avrundar till hel timme', () => {
    const result = truncateToHour(new Date('2026-09-13T14:37:52.418Z'))
    expect(result.toISOString()).toBe('2026-09-13T14:00:00.000Z')
  })

  it('avrundar till dygn', () => {
    const result = truncateToDay(new Date('2026-09-13T14:37:52.418Z'))
    expect(result.toISOString()).toBe('2026-09-13T00:00:00.000Z')
  })

  it('två händelser inom samma timme blir oskiljbara', () => {
    const first = truncateToHour(new Date('2026-09-13T14:00:01.000Z'))
    const second = truncateToHour(new Date('2026-09-13T14:59:59.999Z'))

    // Det här är hela poängen: utan avrundningen skulle de två kunna paras
    // ihop med sina motsvarigheter i den andra databasen.
    expect(first.getTime()).toBe(second.getTime())
  })
})
