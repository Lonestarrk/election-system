import { truncateToHour } from '@/lib/time'
import { logger } from '@/lib/logger'
import { votesDb } from './db'
import { generateVoteToken, hashToken } from './token.service'

/**
 * Registrering och verifiering av anonyma röster.
 *
 * Ingen funktion i den här filen tar emot något som identifierar en person.
 * Det är inte en konvention utan ett typkontrakt: se `index.ts`, där modulens
 * publika yta är avsiktligt smal.
 */

export type Party = {
  id: string
  name: string
  abbreviation: string
  color: string
}

export async function listParties(): Promise<Party[]> {
  return votesDb.party.findMany({
    orderBy: { displayOrder: 'asc' },
    select: { id: true, name: true, abbreviation: true, color: true },
  })
}

export async function partyExists(partyId: string): Promise<boolean> {
  const count = await votesDb.party.count({ where: { id: partyId } })
  return count === 1
}

/**
 * Antal försök att generera en unik token innan vi ger upp.
 *
 * Med 240 bitars entropi är en kollision praktiskt taget omöjlig; den här
 * slingan finns för att kollisionen ska bli ett hanterat fel i stället för ett
 * tyst överskrivande av någon annans röst. Databasens unika index är den
 * faktiska garantin — inte slingan.
 */
const MAX_TOKEN_ATTEMPTS = 5

export class VoteRecordingError extends Error {}

/**
 * Registrerar en anonym röst och returnerar token i klartext.
 *
 * Klartexten returneras en enda gång, till anroparen, och lagras aldrig.
 */
export async function recordAnonymousVote(partyId: string): Promise<{ token: string }> {
  if (!(await partyExists(partyId))) {
    throw new VoteRecordingError('Okänt parti.')
  }

  for (let attempt = 1; attempt <= MAX_TOKEN_ATTEMPTS; attempt += 1) {
    const { token, tokenHash } = generateVoteToken()

    try {
      await votesDb.anonymousVote.create({
        data: {
          tokenHash,
          partyId,
          // Timupplösning. Se lib/time.ts om varför exakta tidsstämplar här
          // skulle göra hela separationen verkningslös.
          createdAt: truncateToHour(new Date()),
        },
      })

      // Notera att ingenting loggas här. Inte token, inte hashen, inte
      // partiet, inte ens ett "röst registrerad"-meddelande med tidsstämpel:
      // en rad i applikationsloggen med millisekundsprecision vore samma
      // tidskorrelationsproblem som exakta tidsstämplar i databasen.
      return { token }
    } catch (error) {
      const isUniqueViolation =
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'

      if (!isUniqueViolation || attempt === MAX_TOKEN_ATTEMPTS) {
        logger.error('Kunde inte registrera anonym röst', { attempt })
        throw new VoteRecordingError('Rösten kunde inte registreras.')
      }
      // Kollision: försök igen med en ny token.
    }
  }

  throw new VoteRecordingError('Rösten kunde inte registreras.')
}

export type VerificationResult =
  | { registered: true; party: string }
  | { registered: false }

/**
 * Verifierar en token.
 *
 * Svaret innehåller partinamnet och ingenting annat. Det finns medvetet ingen
 * motsvarande funktion som går åt andra hållet — det går inte att fråga
 * systemet "vilken token hör till den här personen?", eftersom den här
 * modulen inte vet vad en person är.
 */
export async function verifyToken(rawToken: string): Promise<VerificationResult> {
  const vote = await votesDb.anonymousVote.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: { party: { select: { name: true } } },
  })

  if (!vote) return { registered: false }

  // Notera att varken id, tokenHash eller createdAt returneras. Ett
  // löpnummer eller en exakt tidsstämpel i svaret skulle låta den som samlat
  // in flera kvitton ordna rösterna i tid och därmed korrelera mot
  // legitimeringstidpunkter.
  return { registered: true, party: vote.party.name }
}

/** Aggregat för adminvyn. Inga enskilda röster, inga tokens. */
export async function getVoteStatistics(): Promise<{
  totalVotes: number
  perParty: Array<{ party: string; abbreviation: string; color: string; votes: number }>
}> {
  const [totalVotes, parties, grouped] = await Promise.all([
    votesDb.anonymousVote.count(),
    listParties(),
    votesDb.anonymousVote.groupBy({ by: ['partyId'], _count: { _all: true } }),
  ])

  const countByParty = new Map(grouped.map((row) => [row.partyId, row._count._all]))

  return {
    totalVotes,
    perParty: parties.map((party) => ({
      party: party.name,
      abbreviation: party.abbreviation,
      color: party.color,
      votes: countByParty.get(party.id) ?? 0,
    })),
  }
}
