/**
 * VALSEDELN SOM ENHETSVEKTOR.
 *
 * Varje alternativ får en plats i en vektor. Väljarens val är en etta på sin
 * plats och nollor på alla andra. Varje komponent krypteras för sig, och
 * summan av alla väljares vektorer ger röstetalen — utan att någon enskild
 * vektor öppnas.
 *
 * ORDNINGEN MÅSTE VARA IDENTISK ÖVERALLT. Klienten bygger vektorn, servern
 * verifierar bevisen, och den oberoende verifieraren räknar om summan. Skiljer
 * sig listan på en enda plats räknas röster på fel alternativ, och ingenting i
 * bevisen fångar det — de bevisar bara att vektorn är välformad, inte att den
 * betyder samma sak för alla.
 */

export type BallotOption =
  | { kind: 'BLANK' }
  | { kind: 'PARTY'; ballotPartyId: string }
  | { kind: 'CANDIDATE'; ballotPartyId: string; candidateId: string }

export type BallotShape = {
  allowsCandidateVote: boolean
  parties: Array<{
    id: string
    displayOrder: number
    candidates: Array<{ id: string; displayOrder: number }>
  }>
}

export function canonicalOptions(shape: BallotShape): BallotOption[] {
  const parties = [...shape.parties].sort((a, b) => a.displayOrder - b.displayOrder)

  const options: BallotOption[] = [{ kind: 'BLANK' }]

  for (const party of parties) {
    options.push({ kind: 'PARTY', ballotPartyId: party.id })
  }

  if (shape.allowsCandidateVote) {
    for (const party of parties) {
      const candidates = [...party.candidates].sort((a, b) => a.displayOrder - b.displayOrder)
      for (const candidate of candidates) {
        options.push({ kind: 'CANDIDATE', ballotPartyId: party.id, candidateId: candidate.id })
      }
    }
  }

  return options
}

/**
 * Jämför fält för fält, inte via JSON.stringify.
 *
 * Serialisering beror på nyckelordningen i objektet. En anropare som bygger
 * sitt val med fälten i annan ordning hade fått "Valet finns inte på den här
 * valsedeln" — ett meddelande som pekar på data när felet ligger i formen.
 */
function sameOption(a: BallotOption, b: BallotOption): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'BLANK') return true
  if (b.kind === 'BLANK') return false
  if (a.ballotPartyId !== b.ballotPartyId) return false
  if (a.kind === 'CANDIDATE' && b.kind === 'CANDIDATE') return a.candidateId === b.candidateId
  return a.kind === b.kind
}

export function indexOfChoice(options: BallotOption[], choice: BallotOption): number {
  const index = options.findIndex((option) => sameOption(option, choice))

  if (index === -1) throw new Error('Valet finns inte på den här valsedeln.')
  return index
}

export function unitVector(length: number, index: number): bigint[] {
  if (index < 0 || index >= length) throw new Error(`Index ${index} ligger utanför vektorn.`)
  return Array.from({ length }, (_, position) => (position === index ? 1n : 0n))
}
