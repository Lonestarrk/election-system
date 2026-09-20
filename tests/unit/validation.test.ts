import { describe, expect, it } from 'vitest'
import {
  adminLoginSchema,
  castVoteSchema,
  personalNumberSchema,
  verifyTokenSchema,
} from '@/lib/validation'

describe('validering av personnummer', () => {
  it('godtar ÅÅÅÅMMDD-NNNN', () => {
    expect(personalNumberSchema.parse('19900101-1234')).toBe('199001011234')
  })

  it('godtar formatet utan bindestreck', () => {
    expect(personalNumberSchema.parse('199001011234')).toBe('199001011234')
  })

  it.each([
    ['för kort', '900101-1234'],
    ['bokstäver', 'abcdefgh-1234'],
    ['tomt', ''],
    ['SQL-försök', "1' OR '1'='1"],
    ['skript', '<script>alert(1)</script>'],
  ])('avvisar %s', (_label, input) => {
    expect(personalNumberSchema.safeParse(input).success).toBe(false)
  })
})

describe('validering av parti-id', () => {
  it('kräver ett UUID', () => {
    expect(castVoteSchema.safeParse({ partyId: 'Socialdemokraterna' }).success).toBe(false)
    expect(
      castVoteSchema.safeParse({ partyId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' }).success,
    ).toBe(true)
  })

  it('avvisar extra fält som inte hör hemma i en röst', () => {
    const result = castVoteSchema.parse({
      partyId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      voterId: 'något-som-inte-ska-med',
      personalNumber: '199001011234',
    })

    // Zod plockar bort okända nycklar. Det är en extra spärr mot att
    // identitetsuppgifter slinker in i röstvägen via begärans kropp.
    expect(result).toEqual({ partyId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })
    expect(result).not.toHaveProperty('voterId')
    expect(result).not.toHaveProperty('personalNumber')
  })
})

describe('validering av token', () => {
  it('godtar token med och utan bindestreck', () => {
    expect(verifyTokenSchema.safeParse({ token: 'ABCDEFGH-JKMNPQRS' }).success).toBe(true)
    expect(verifyTokenSchema.safeParse({ token: 'ABCDEFGHJKMNPQRS' }).success).toBe(true)
  })

  it('avvisar tecken utanför alfabetet', () => {
    expect(verifyTokenSchema.safeParse({ token: "ABC'; DROP TABLE--" }).success).toBe(false)
    expect(verifyTokenSchema.safeParse({ token: '<script>' }).success).toBe(false)
  })

  it('avvisar orimligt långa värden', () => {
    expect(verifyTokenSchema.safeParse({ token: 'A'.repeat(500) }).success).toBe(false)
  })
})

describe('validering av adminlösenord', () => {
  it('kräver ett värde', () => {
    expect(adminLoginSchema.safeParse({ password: '' }).success).toBe(false)
    expect(adminLoginSchema.safeParse({ password: 'admin' }).success).toBe(true)
  })
})
