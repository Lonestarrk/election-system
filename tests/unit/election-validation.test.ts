import { describe, expect, it } from 'vitest'
import { createElectionSchema } from '@/lib/validation'

const PARTY = '11111111-1111-4111-8111-111111111111'

function election(ballot: Record<string, unknown>) {
  return {
    name: 'Valet',
    kind: 'RIKSDAGSVAL',
    opensAt: '2026-10-01T00:00:00.000Z',
    closesAt: '2026-10-02T00:00:00.000Z',
    ballots: [ballot],
    trusteePassphrases: ['fras-nummer-ett', 'fras-nummer-tva', 'fras-nummer-tre'],
  }
}

describe('svarsalternativ i en omröstning som skapas', () => {
  it('en fråga med svarsalternativ godtas', () => {
    expect(
      createElectionSchema.safeParse(election({ kind: 'FRAGA', label: 'Ska vi?', options: ['Ja', 'Nej'] })).success,
    ).toBe(true)
  })

  it.each(['KOMMUN', 'LANDSTING', 'RIKSDAG'])('en %s-valsedel med svarsalternativ avvisas', (kind) => {
    const result = createElectionSchema.safeParse(
      election({ kind, label: 'Valsedel', parties: [{ partyId: PARTY }], options: ['Ja', 'Nej'] }),
    )
    expect(result.success).toBe(false)
  })

  it('en partivalsedel med en tom lista av svarsalternativ godtas', () => {
    expect(
      createElectionSchema.safeParse(election({ kind: 'RIKSDAG', label: 'R', parties: [{ partyId: PARTY }], options: [] }))
        .success,
    ).toBe(true)
  })
})
