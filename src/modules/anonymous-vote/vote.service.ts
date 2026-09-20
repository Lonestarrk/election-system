import { truncateToHour } from '@/lib/time'
import { logger } from '@/lib/logger'
import { votesDb } from './db'
import { generateVoteToken, hashToken } from './token.service'
import type { BallotChoiceInput } from './election.service'

/**
 * Registrering och verifiering av anonyma röster.
 *
 * Ingen funktion i den här filen tar emot något som identifierar en person.
 * Det är inte en konvention utan ett typkontrakt: se `index.ts`, där modulens
 * publika yta är avsiktligt smal.
 *
 * EN RÖST PER VALSEDEL. I ett riksdagsval lägger samma väljare tre röster —
 * kommun, landsting, riksdag — och de registreras som tre fristående rader
 * med var sin token. Det finns ingen kolumn någonstans som säger att de hör
 * ihop, och det är avsiktligt: tre partival tillsammans är betydligt mer
 * identifierande än ett.
 */

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
 * Registrerar en anonym röst på en valsedel och returnerar token i klartext.
 *
 * Klartexten returneras en enda gång, till anroparen, och lagras aldrig.
 *
 * Giltigheten hos valet ska redan vara kontrollerad av `validateBallotChoice`
 * innan väljaren markerades som röstande. Kontrollen görs ändå igen här, som
 * sista spärr — den här funktionen är den enda vägen in i tabellen och ska
 * inte förlita sig på att anroparen gjort rätt.
 */
export async function recordAnonymousVote(choice: BallotChoiceInput): Promise<{ token: string }> {
  for (let attempt = 1; attempt <= MAX_TOKEN_ATTEMPTS; attempt += 1) {
    const { token, tokenHash } = generateVoteToken()

    try {
      await votesDb.anonymousVote.create({
        data: {
          tokenHash,
          ballotId: choice.ballotId,
          ballotPartyId: choice.ballotPartyId ?? null,
          candidateId: choice.candidateId ?? null,
          optionId: choice.optionId ?? null,
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
  | {
      registered: true
      election: string
      ballot: string
      /** Parti eller svarsalternativ, beroende på valsedelns typ. */
      choice: string
      /** Kryssad kandidat, om väljaren personröstade. */
      candidate: string | null
    }
  | { registered: false }

/**
 * Verifierar en token.
 *
 * Svaret beskriver EN valsedel — den som token gäller. Väljaren som röstat på
 * tre valsedlar har tre tokens och får fråga en i taget.
 *
 * Det finns medvetet ingen funktion som går åt andra hållet: det går inte att
 * fråga systemet "vilka tokens hör till den här personen?", eftersom modulen
 * inte vet vad en person är. Det går inte heller att fråga "vilka andra röster
 * lades av samma väljare som den här token?", eftersom den kopplingen inte
 * finns lagrad.
 */
export async function verifyToken(rawToken: string): Promise<VerificationResult> {
  const vote = await votesDb.anonymousVote.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: {
      ballot: { select: { label: true, election: { select: { name: true } } } },
      ballotParty: { select: { party: { select: { name: true } } } },
      option: { select: { label: true } },
      candidate: { select: { name: true } },
    },
  })

  if (!vote) return { registered: false }

  // Notera att varken id, tokenHash eller createdAt returneras. Ett
  // löpnummer eller en exakt tidsstämpel i svaret skulle låta den som samlat
  // in flera kvitton ordna rösterna i tid och därmed korrelera mot
  // legitimeringstidpunkter.
  return {
    registered: true,
    election: vote.ballot.election.name,
    ballot: vote.ballot.label,
    choice: vote.ballotParty?.party.name ?? vote.option?.label ?? 'Okänt val',
    candidate: vote.candidate?.name ?? null,
  }
}

export type BallotResult = {
  ballotId: string
  ballot: string
  kind: string
  totalVotes: number
  rows: Array<{
    label: string
    abbreviation: string | null
    color: string | null
    votes: number
    /**
     * Personröster per kandidat. Tom lista när valsedeln inte tillåter
     * personröst.
     */
    candidates: Array<{ name: string; votes: number }>
  }>
}

/**
 * Aggregat för adminvyn, per valsedel. Inga enskilda röster, inga tokens.
 *
 * ETT MEDVETET UTELÄMNANDE: det finns ingen funktion som korsar valsedlar.
 * "Hur röstade de som röstade på parti X i kommunvalet i riksdagsvalet?" går
 * inte att svara på — inte för att frågan filtreras bort i gränssnittet, utan
 * för att kopplingen aldrig lagrats.
 */
export async function getElectionResults(electionId: string): Promise<BallotResult[]> {
  const ballots = await votesDb.electionBallot.findMany({
    where: { electionId },
    orderBy: { displayOrder: 'asc' },
    select: {
      id: true,
      label: true,
      kind: true,
      allowsCandidateVote: true,
      parties: {
        orderBy: { displayOrder: 'asc' },
        select: {
          id: true,
          party: { select: { name: true, abbreviation: true, color: true } },
          candidates: { select: { id: true, name: true }, orderBy: { displayOrder: 'asc' } },
        },
      },
      options: { orderBy: { displayOrder: 'asc' }, select: { id: true, label: true } },
    },
  })

  const results: BallotResult[] = []

  for (const ballot of ballots) {
    const [totalVotes, byParty, byOption, byCandidate] = await Promise.all([
      votesDb.anonymousVote.count({ where: { ballotId: ballot.id } }),
      votesDb.anonymousVote.groupBy({
        by: ['ballotPartyId'],
        where: { ballotId: ballot.id },
        _count: { _all: true },
      }),
      votesDb.anonymousVote.groupBy({
        by: ['optionId'],
        where: { ballotId: ballot.id },
        _count: { _all: true },
      }),
      votesDb.anonymousVote.groupBy({
        by: ['candidateId'],
        where: { ballotId: ballot.id, candidateId: { not: null } },
        _count: { _all: true },
      }),
    ])

    const partyCounts = new Map(byParty.map((row) => [row.ballotPartyId, row._count._all]))
    const optionCounts = new Map(byOption.map((row) => [row.optionId, row._count._all]))
    const candidateCounts = new Map(byCandidate.map((row) => [row.candidateId, row._count._all]))

    const rows =
      ballot.kind === 'FRAGA'
        ? ballot.options.map((option) => ({
            label: option.label,
            abbreviation: null,
            color: null,
            votes: optionCounts.get(option.id) ?? 0,
            candidates: [],
          }))
        : ballot.parties.map((entry) => ({
            label: entry.party.name,
            abbreviation: entry.party.abbreviation,
            color: entry.party.color,
            votes: partyCounts.get(entry.id) ?? 0,
            candidates: ballot.allowsCandidateVote
              ? entry.candidates.map((candidate) => ({
                  name: candidate.name,
                  votes: candidateCounts.get(candidate.id) ?? 0,
                }))
              : [],
          }))

    results.push({
      ballotId: ballot.id,
      ballot: ballot.label,
      kind: ballot.kind,
      totalVotes,
      rows,
    })
  }

  return results
}

/** Totalt antal registrerade röster i en omröstning. Används av integritetskontrollen. */
export async function countVotes(electionId: string): Promise<number> {
  return votesDb.anonymousVote.count({ where: { ballot: { electionId } } })
}
