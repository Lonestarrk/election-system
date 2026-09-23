import { describe, expect, it } from 'vitest'
import {
  canonicalOptions,
  indexOfChoice,
  unitVector,
  type BallotShape,
} from '@/lib/crypto/ballot-encoding'

const SHAPE: BallotShape = {
  allowsCandidateVote: true,
  parties: [
    { id: 'bp-s', displayOrder: 1, candidates: [{ id: 'k-anna', displayOrder: 1 }] },
    { id: 'bp-m', displayOrder: 2, candidates: [] },
  ],
}

describe('kanonisk ordning', () => {
  it('blank röst ligger alltid först', () => {
    // Utan ett blankalternativ kan den som inte vill rösta på något inte
    // producera en vektor som summerar till 1, och summabeviset faller.
    expect(canonicalOptions(SHAPE)[0]).toEqual({ kind: 'BLANK' })
  })

  it('partier före kandidater, båda i displayOrder', () => {
    expect(canonicalOptions(SHAPE)).toEqual([
      { kind: 'BLANK' },
      { kind: 'PARTY', ballotPartyId: 'bp-s' },
      { kind: 'PARTY', ballotPartyId: 'bp-m' },
      { kind: 'CANDIDATE', ballotPartyId: 'bp-s', candidateId: 'k-anna' },
    ])
  })

  it('utelämnar kandidater när valsedeln inte tillåter personröst', () => {
    const options = canonicalOptions({ ...SHAPE, allowsCandidateVote: false })

    expect(options).toHaveLength(3)
    expect(options.some((option) => option.kind === 'CANDIDATE')).toBe(false)
  })

  it('ordningen är stabil oavsett hur indata råkar komma', () => {
    // Klient, server och den oberoende verifieraren måste räkna fram exakt
    // samma lista. Skiljer de sig på en enda plats räknas röster på fel
    // alternativ, och ingenting i bevisen fångar det.
    const shuffled: BallotShape = { ...SHAPE, parties: [...SHAPE.parties].reverse() }

    expect(canonicalOptions(shuffled)).toEqual(canonicalOptions(SHAPE))
  })
})

describe('enhetsvektor', () => {
  it('sätter exakt en etta', () => {
    expect(unitVector(4, 2)).toEqual([0n, 0n, 1n, 0n])
  })

  it('kastar på index utanför vektorn', () => {
    expect(() => unitVector(4, 4)).toThrow()
    expect(() => unitVector(4, -1)).toThrow()
  })

  it('indexOfChoice hittar rätt plats', () => {
    const options = canonicalOptions(SHAPE)

    expect(indexOfChoice(options, { kind: 'PARTY', ballotPartyId: 'bp-m' })).toBe(2)
    expect(
      indexOfChoice(options, { kind: 'CANDIDATE', ballotPartyId: 'bp-s', candidateId: 'k-anna' }),
    ).toBe(3)
  })

  it('hittar valet oavsett i vilken ordning faltet skrevs', () => {
    // Serialiseringsjamforelse hade fallit har, och felmeddelandet hade pekat
    // pa datan nar felet lag i formen.
    const options = canonicalOptions(SHAPE)
    const choice = { candidateId: 'k-anna', ballotPartyId: 'bp-s', kind: 'CANDIDATE' } as const

    expect(indexOfChoice(options, choice)).toBe(3)
  })

  it('kastar på ett val som inte finns på valsedeln', () => {
    expect(() =>
      indexOfChoice(canonicalOptions(SHAPE), { kind: 'PARTY', ballotPartyId: 'bp-okänt' }),
    ).toThrow()
  })
})
