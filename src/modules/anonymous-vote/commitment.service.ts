import { canonicalVoteRecord, commitmentHash, hashLeaf, merkleRoot } from '@/lib/merkle'
import { votesDb } from './db'

/**
 * Åtaganden om röstunderlaget.
 *
 * Ett åtagande är Merkleroten över samtliga röster i en omröstning plus
 * antalet, publicerat vid en tidpunkt. Den som publicerat en rot har bundit
 * sig vid exakt den mängden röster.
 *
 * VAD DET GER SOM EN VANLIG DATABAS INTE GER
 *
 * En databas kan alltid ändras av den som har åtkomst till den. Skillnaden är
 * att en ändring efter ett publicerat åtagande blir UPPTÄCKBAR: roten som
 * räknas fram ur de manipulerade rösterna stämmer inte med den som redan
 * publicerats, och observatören behöver inte lita på någon för att se det —
 * bara räkna om den själv.
 *
 * Det är därför rötterna måste publiceras externt för att ha fullt bevisvärde.
 * Ett åtagande som bara finns i samma databas som det skyddar kan skrivas om
 * tillsammans med rösterna. Var de publiceras — anslagstavla, tidning,
 * blockkedja, observatörernas egna kopior — ligger utanför den här POC:en, men
 * API:t är byggt så att vem som helst kan hämta och spara dem löpande.
 */

export type Commitment = {
  sequence: number
  root: string
  voteCount: number
  previousHash: string | null
  entryHash: string
  createdAt: Date
}

/**
 * Räknar fram den aktuella Merkleroten över omröstningens röster.
 *
 * Löven sorteras på sitt hashvärde, inte på när rösten skrevs — se lib/merkle.ts
 * om varför en ordning i tid vore oacceptabel här.
 */
export async function currentRoot(
  electionId: string,
): Promise<{ root: string; voteCount: number }> {
  const votes = await votesDb.anonymousVote.findMany({
    where: { ballot: { electionId } },
    select: {
      tokenHash: true,
      credentialId: true,
      credentialSignature: true,
      ballotId: true,
      ballotPartyId: true,
      candidateId: true,
      optionId: true,
    },
  })

  const leaves = votes.map((vote) => hashLeaf(canonicalVoteRecord(vote)))

  return { root: merkleRoot(leaves), voteCount: votes.length }
}

export async function listCommitments(electionId: string): Promise<Commitment[]> {
  return votesDb.electionCommitment.findMany({
    where: { electionId },
    orderBy: { sequence: 'asc' },
    select: {
      sequence: true,
      root: true,
      voteCount: true,
      previousHash: true,
      entryHash: true,
      createdAt: true,
    },
  })
}

export async function latestCommitment(electionId: string): Promise<Commitment | null> {
  const rows = await votesDb.electionCommitment.findMany({
    where: { electionId },
    orderBy: { sequence: 'desc' },
    take: 1,
    select: {
      sequence: true,
      root: true,
      voteCount: true,
      previousHash: true,
      entryHash: true,
      createdAt: true,
    },
  })

  return rows[0] ?? null
}

/**
 * Publicerar ett nytt åtagande om det aktuella röstunderlaget.
 *
 * Kan köras när som helst och hur ofta som helst. Ju tätare åtaganden, desto
 * snävare fönster har en angripare att ändra röster utan att det syns: en
 * ändring kan bara gömmas bland röster som ännu inte omfattats av något
 * publicerat åtagande.
 */
export async function commitCurrentState(electionId: string): Promise<Commitment> {
  const { root, voteCount } = await currentRoot(electionId)
  const previous = await latestCommitment(electionId)

  const sequence = (previous?.sequence ?? 0) + 1
  const previousHash = previous?.entryHash ?? null

  const entryHash = commitmentHash({ sequence, root, voteCount, previousHash })

  return votesDb.electionCommitment.create({
    data: { electionId, sequence, root, voteCount, previousHash, entryHash },
    select: {
      sequence: true,
      root: true,
      voteCount: true,
      previousHash: true,
      entryHash: true,
      createdAt: true,
    },
  })
}

export type ChainVerdict =
  | { intact: true; commitments: number }
  | { intact: false; reason: string; brokenAtSequence: number }

/**
 * Kontrollerar att åtagandekedjan är obruten.
 *
 * Tre saker prövas: att löpnumren är sammanhängande, att varje åtagandes hash
 * stämmer med dess innehåll, och att varje åtagande pekar på föregående. En
 * borttagen eller ändrad rad bryter minst en av dem.
 */
export async function verifyCommitmentChain(electionId: string): Promise<ChainVerdict> {
  const commitments = await listCommitments(electionId)

  let previousHash: string | null = null

  for (const [index, commitment] of commitments.entries()) {
    const expectedSequence = index + 1

    if (commitment.sequence !== expectedSequence) {
      return {
        intact: false,
        reason: `Löpnummer ${commitment.sequence} bryter följden — ${expectedSequence} väntades.`,
        brokenAtSequence: expectedSequence,
      }
    }

    if (commitment.previousHash !== previousHash) {
      return {
        intact: false,
        reason: 'Åtagandet pekar inte på det föregående.',
        brokenAtSequence: commitment.sequence,
      }
    }

    const recomputed = commitmentHash({
      sequence: commitment.sequence,
      root: commitment.root,
      voteCount: commitment.voteCount,
      previousHash: commitment.previousHash,
    })

    if (recomputed !== commitment.entryHash) {
      return {
        intact: false,
        reason: 'Åtagandets hash stämmer inte med dess innehåll.',
        brokenAtSequence: commitment.sequence,
      }
    }

    previousHash = commitment.entryHash
  }

  return { intact: true, commitments: commitments.length }
}
