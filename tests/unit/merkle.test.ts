import { describe, expect, it } from 'vitest'
import { canonicalVoteRecord, commitmentHash, hashLeaf, merkleRoot } from '@/lib/merkle'

/**
 * Merkleträdet bär kravet att röster inte ska kunna ändras eller tas bort utan
 * att det upptäcks — samtidigt som det INTE får avslöja i vilken ordning
 * rösterna kom in.
 *
 * De två egenskaperna drar åt olika håll, och testerna nedan prövar båda.
 */

function vote(overrides: Partial<Parameters<typeof canonicalVoteRecord>[0]> = {}) {
  return canonicalVoteRecord({
    tokenHash: 'a'.repeat(64),
    credentialId: 'b'.repeat(64),
    credentialSignature: 'c'.repeat(512),
    ballotId: '11111111-1111-1111-1111-111111111111',
    ballotPartyId: '22222222-2222-2222-2222-222222222222',
    candidateId: null,
    optionId: null,
    ...overrides,
  })
}

describe('Merkleroten avslöjar ingen ordning', () => {
  it('samma röster i olika insättningsordning ger samma rot', () => {
    /**
     * DETTA ÄR HELA SKÄLET TILL ATT LÖVEN SORTERAS PÅ INNEHÅLL.
     *
     * Vore roten beroende av insättningsordningen skulle den läcka i vilken
     * följd rösterna lades — och den följden är, tillsammans med
     * röstlängdsdatabasen, tillräcklig för att para ihop väljare med röst.
     */
    const leaves = [
      hashLeaf(vote({ tokenHash: '1'.repeat(64) })),
      hashLeaf(vote({ tokenHash: '2'.repeat(64) })),
      hashLeaf(vote({ tokenHash: '3'.repeat(64) })),
      hashLeaf(vote({ tokenHash: '4'.repeat(64) })),
      hashLeaf(vote({ tokenHash: '5'.repeat(64) })),
    ]

    const forward = merkleRoot(leaves)
    const backward = merkleRoot([...leaves].reverse())
    const shuffled = merkleRoot([leaves[2]!, leaves[0]!, leaves[4]!, leaves[1]!, leaves[3]!])

    expect(backward).toEqual(forward)
    expect(shuffled).toEqual(forward)
  })

  it('den kanoniska formen innehåller ingen tidsstämpel', () => {
    // Tas skapandetidpunkten med blir trädet tidsberoende igen, och två
    // observatörer som hämtar data vid olika tillfällen räknar fram olika
    // rötter.
    expect(vote()).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(vote()).not.toMatch(/T\d{2}:\d{2}/)
  })
})

describe('Merkleroten upptäcker manipulation', () => {
  const leaves = ['1', '2', '3', '4', '5', '6', '7'].map((digit) =>
    hashLeaf(vote({ tokenHash: digit.repeat(64) })),
  )
  const root = merkleRoot(leaves)

  it('en ändrad röst ger en annan rot', () => {
    const tampered = [...leaves]
    tampered[3] = hashLeaf(vote({ tokenHash: '9'.repeat(64) }))

    expect(merkleRoot(tampered)).not.toEqual(root)
  })

  it('en borttagen röst ger en annan rot', () => {
    expect(merkleRoot(leaves.slice(0, -1))).not.toEqual(root)
  })

  it('en tillagd röst ger en annan rot', () => {
    expect(merkleRoot([...leaves, hashLeaf(vote({ tokenHash: '8'.repeat(64) }))])).not.toEqual(root)
  })

  it('ett ändrat parti på en röst ger en annan rot', () => {
    // Rösträkningen sker på partiet. Ändras det utan att roten ändras vore
    // hela konstruktionen verkningslös.
    const tampered = [...leaves]
    tampered[0] = hashLeaf(
      vote({ tokenHash: '1'.repeat(64), ballotPartyId: '33333333-3333-3333-3333-333333333333' }),
    )

    expect(merkleRoot(tampered)).not.toEqual(root)
  })

  it('ett löv kan inte förväxlas med en intern nod', () => {
    /**
     * Utan skilda prefix för löv och noder kan en angripare påstå att en
     * intern nod i själva verket är ett löv, och därmed konstruera ett falskt
     * bevis för en röst som aldrig funnits.
     */
    const twoLeaves = [hashLeaf('a'), hashLeaf('b')]
    const rootOfTwo = merkleRoot(twoLeaves)

    // Roten över två löv får inte råka vara ett giltigt löv i sig.
    expect(merkleRoot([rootOfTwo])).not.toEqual(rootOfTwo)
  })

  it('ett udda antal löv dubbleras inte', () => {
    // Många implementationer hashar sista noden med sig själv vid udda antal.
    // Det öppnar för att två olika mängder röster ger samma rot.
    const three = [hashLeaf('a'), hashLeaf('b'), hashLeaf('c')]
    const four = [...three, hashLeaf('c')]

    expect(merkleRoot(three)).not.toEqual(merkleRoot(four))
  })

  it('ett tomt underlag har en definierad rot', () => {
    // "Inga röster ännu" ska gå att åta sig och kontrollera, inte vara ett
    // specialfall som hoppas över.
    expect(merkleRoot([])).toMatch(/^[0-9a-f]{64}$/)
    expect(merkleRoot([])).not.toEqual(merkleRoot([hashLeaf('a')]))
  })
})

describe('åtagandekedjan', () => {
  it('varje åtagande binds till det föregående', () => {
    const first = commitmentHash({ sequence: 1, root: 'aa', voteCount: 3, previousHash: null })
    const second = commitmentHash({ sequence: 2, root: 'bb', voteCount: 5, previousHash: first })

    // Byts det första åtagandet ut stämmer inte det andra längre.
    const forgedFirst = commitmentHash({
      sequence: 1,
      root: 'cc',
      voteCount: 3,
      previousHash: null,
    })
    const secondAfterForgery = commitmentHash({
      sequence: 2,
      root: 'bb',
      voteCount: 5,
      previousHash: forgedFirst,
    })

    expect(secondAfterForgery).not.toEqual(second)
  })

  it('antalet röster ingår i åtagandet', () => {
    // Annars kunde någon påstå att samma rot gällde ett annat antal röster.
    const withThree = commitmentHash({ sequence: 1, root: 'aa', voteCount: 3, previousHash: null })
    const withFour = commitmentHash({ sequence: 1, root: 'aa', voteCount: 4, previousHash: null })

    expect(withThree).not.toEqual(withFour)
  })
})
