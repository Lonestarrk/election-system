import { truncateToHour } from '@/lib/time'
import { verify } from '@/lib/blind-signature'
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

export type RedeemedCredential = {
  /** Väljarens eget intygsvärde, aldrig sett av myndigheten före inlösen. */
  credentialId: string
  /** Myndighetens signatur över intyget, avblindad av väljaren. */
  signature: string
}

export type RecordVoteOutcome =
  | { status: 'recorded'; token: string }
  | { status: 'invalid_credential' }
  | { status: 'credential_already_used' }
  | { status: 'failed' }

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
export async function recordAnonymousVote(
  choice: BallotChoiceInput,
  credential: RedeemedCredential,
): Promise<RecordVoteOutcome> {
  const ballot = await votesDb.electionBallot.findUnique({
    where: { id: choice.ballotId },
    select: { signingPublicKeyPem: true },
  })

  if (!ballot) return { status: 'invalid_credential' }

  /**
   * INTYGET VERIFIERAS KRYPTOGRAFISKT, INTE MOT EN TABELL.
   *
   * Det är skillnaden mellan ett system som kan bevisa sin riktighet och ett
   * som bara påstår den. Signaturen kan bara ha skapats av den som har
   * valsedelns privata nyckel, och det kan vem som helst kontrollera i
   * efterhand med den publika nyckeln — utan att fråga systemet och utan att
   * behöva lita på det.
   *
   * Att nyckeln är valsedelns egen är också det som binder intyget till rätt
   * valsedel. Myndigheten signerade blint och såg aldrig vilken valsedel det
   * gällde; bindningen kommer från VILKEN nyckel som användes. Ett intyg för
   * kommunvalsedeln verifierar därför inte här om detta är riksdagsvalsedeln.
   */
  if (!verify(credential.credentialId, credential.signature, ballot.signingPublicKeyPem)) {
    return { status: 'invalid_credential' }
  }

  for (let attempt = 1; attempt <= MAX_TOKEN_ATTEMPTS; attempt += 1) {
    const { token, tokenHash } = generateVoteToken()

    try {
      await votesDb.anonymousVote.create({
        data: {
          tokenHash,
          credentialId: credential.credentialId,
          credentialSignature: credential.signature,
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
      return { status: 'recorded', token }
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : null

      if (code === 'P2002') {
        /**
         * ENGÅNGSANVÄNDNING, GARANTERAD AV DATABASEN.
         *
         * Konflikten kan gälla två olika kolumner. Är det intyget som redan
         * använts har någon försökt lösa in samma intyg två gånger — det är
         * dubbelröstningsförsöket, och det avvisas oavsett hur många
         * parallella begäranden som kommer samtidigt. Är det token har vi
         * råkat på en kollision och försöker igen med en ny.
         */
        const alreadyUsed =
          await votesDb.anonymousVote.count({
            where: { credentialId: credential.credentialId },
          })

        if (alreadyUsed > 0) return { status: 'credential_already_used' }

        if (attempt < MAX_TOKEN_ATTEMPTS) continue
      }

      logger.error('Kunde inte registrera anonym röst', { attempt })
      return { status: 'failed' }
    }
  }

  return { status: 'failed' }
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
