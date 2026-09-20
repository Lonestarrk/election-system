/**
 * Den anonyma röstmodulens publika yta.
 *
 * Detta är hela kontraktet mot resten av systemet. Lägg märke till vad
 * `castAnonymousVote` tar emot:
 *
 *     { ballotId, ballotPartyId?, candidateId?, optionId? }
 *
 * Fyra identifierare som alla pekar på rader i röstdatabasen, och ingenting
 * annat. Det finns ingen parameter för väljar-id, personnummer, sessions-id,
 * IP-adress eller request-id — så en anropare kan inte skicka med sådant ens
 * av misstag. TypeScript avvisar det vid kompilering.
 *
 * Det är skillnaden mot en dokumenterad regel: en kommentar som säger "skicka
 * inte in identitet här" håller tills någon har bråttom. Ett typkontrakt
 * håller alltid.
 *
 * Notera särskilt vad som INTE finns i kontraktet: någon parameter som knyter
 * ihop flera röster. Väljaren i ett riksdagsval anropar den här funktionen tre
 * gånger, en gång per valsedel, och de tre anropen har ingenting gemensamt som
 * lagras. Modulen kan därför inte veta — och kan aldrig i efterhand räkna ut —
 * vilka röster som kom från samma person.
 *
 * Modulen kan inte heller hämta identiteten på egen hand: dess Prisma-klient
 * pekar på en annan PostgreSQL-databas än röstlängden.
 */

export type CastAnonymousVoteInput = {
  ballotId: string
  ballotPartyId?: string
  candidateId?: string
  optionId?: string
}

export type CastAnonymousVoteResult = {
  /** Klartext-token. Visas för väljaren en gång och lagras aldrig. */
  token: string
}

import {
  recordAnonymousVote,
  verifyToken as verifyTokenInternal,
  getElectionResults as getElectionResultsInternal,
  countVotes as countVotesInternal,
  VoteRecordingError,
} from './vote.service'

import {
  createElection as createElectionInternal,
  deleteElection as deleteElectionInternal,
  getBallotChoices as getBallotChoicesInternal,
  getElection as getElectionInternal,
  listElections as listElectionsInternal,
  listOpenElections as listOpenElectionsInternal,
  listRegisteredParties as listRegisteredPartiesInternal,
  validateBallotChoice as validateBallotChoiceInternal,
  BallotValidationError,
} from './election.service'

/**
 * Registrerar en anonym röst på en valsedel.
 *
 * Anroparen — orkestreringslagret — har redan kontrollerat att väljaren är
 * röstberättigad och markerat att rösten lagts. Den informationen följer
 * medvetet inte med hit.
 */
export async function castAnonymousVote(
  input: CastAnonymousVoteInput,
): Promise<CastAnonymousVoteResult> {
  return recordAnonymousVote(input)
}

/**
 * Kontrollerar att ett val är giltigt på sin valsedel.
 *
 * Finns här för att orkestreringslagret ska kunna avvisa ett ogiltigt val
 * INNAN väljaren markeras som röstande. Utan den kontrollen skulle en felaktig
 * begäran kunna bränna någons rösträtt på en valsedel utan att någon röst
 * registrerades.
 */
export const validateBallotChoice = validateBallotChoiceInternal

export const listElections = listElectionsInternal
export const listOpenElections = listOpenElectionsInternal
export const getElection = getElectionInternal
export const getBallotChoices = getBallotChoicesInternal
export const listRegisteredParties = listRegisteredPartiesInternal
export const createElection = createElectionInternal
export const deleteElection = deleteElectionInternal
export const verifyToken = verifyTokenInternal
export const getElectionResults = getElectionResultsInternal
export const countVotes = countVotesInternal

export { VoteRecordingError, BallotValidationError }
export type { VerificationResult, BallotResult } from './vote.service'
export type {
  Ballot,
  BallotChoices,
  BallotKind,
  CreateElectionInput,
  CreatedElection,
  Election,
  ElectionKind,
  PartyChoice,
} from './election.service'
