import { describe, expect, it } from 'vitest'
import { hashLeaf, merkleRoot } from '@/lib/merkle'

/**
 * Merkleträdet bär kravet att röster inte ska kunna ändras eller tas bort utan
 * att det upptäcks — samtidigt som det INTE får avslöja i vilken ordning
 * rösterna kom in.
 *
 * De två egenskaperna drar åt olika håll, och testerna nedan prövar båda.
 */

/** Innehållet i ett löv. Själva trädet bryr sig inte om vad det är, bara om att det är en sträng. */
function vote(id: string): string {
  return `${id.repeat(64)}|11111111-1111-1111-1111-111111111111`
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
      hashLeaf(vote('1')),
      hashLeaf(vote('2')),
      hashLeaf(vote('3')),
      hashLeaf(vote('4')),
      hashLeaf(vote('5')),
    ]

    const forward = merkleRoot(leaves)
    const backward = merkleRoot([...leaves].reverse())
    const shuffled = merkleRoot([leaves[2]!, leaves[0]!, leaves[4]!, leaves[1]!, leaves[3]!])

    expect(backward).toEqual(forward)
    expect(shuffled).toEqual(forward)
  })
})

describe('Merkleroten upptäcker manipulation', () => {
  const leaves = ['1', '2', '3', '4', '5', '6', '7'].map((digit) =>
    hashLeaf(vote(digit)),
  )
  const root = merkleRoot(leaves)

  it('en ändrad röst ger en annan rot', () => {
    const tampered = [...leaves]
    tampered[3] = hashLeaf(vote('9'))

    expect(merkleRoot(tampered)).not.toEqual(root)
  })

  it('en borttagen röst ger en annan rot', () => {
    expect(merkleRoot(leaves.slice(0, -1))).not.toEqual(root)
  })

  it('en tillagd röst ger en annan rot', () => {
    expect(merkleRoot([...leaves, hashLeaf(vote('8'))])).not.toEqual(root)
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
