/**
 * Den anonyma röstmodulens publika yta.
 *
 * Detta är hela kontraktet mot resten av systemet. Lägg märke till vad
 * `castAnonymousVote` tar emot:
 *
 *     { ballotId, ballotPartyId?, candidateId?, optionId?,
 *       credentialId, credentialSignature }
 *
 * Identifierare som pekar på rader i röstdatabasen, plus ett röstintyg. Det
 * finns ingen parameter för väljar-id, personnummer, sessions-id, IP-adress
 * eller request-id — så en anropare kan inte skicka med sådant ens av misstag.
 * TypeScript avvisar det vid kompilering.
 *
 * RÖSTNINGEN KRÄVER INTE LÄNGRE EN SESSION.
 *
 * Det är den viktigaste följden av att röstintyget infördes, och en direkt
 * vinst för valhemligheten. Tidigare bar röstningsbegäran en sessionscookie
 * som pekade på en rad i röstlängden — under de millisekunder rösten skrevs
 * fanns alltså en identitet och ett partival i samma anropsstack. Nu
 * auktoriseras rösten enbart av ett kryptografiskt intyg som ingen kan spåra
 * till en väljare, och sessionen är inte inblandad alls.
 *
 * Följden i arkitekturen: ingen fil i systemet behöver längre se BÅDA
 * modulerna för att en röst ska kunna läggas. Orkestreringslagret för
 * röstläggning finns inte kvar, eftersom det inte längre har något att
 * orkestrera.
 *
 * Notera också vad som INTE finns i kontraktet: någon parameter som knyter
 * ihop flera röster. Väljaren i ett riksdagsval anropar den här funktionen tre
 * gånger, en gång per valsedel, med tre olika intyg. De tre anropen har
 * ingenting gemensamt som lagras.
 *
 * Modulen kan inte heller hämta identiteten på egen hand: dess Prisma-klient
 * pekar på en annan PostgreSQL-databas än röstlängden.
 */

export type CastAnonymousVoteInput = {
  ballotId: string
  ballotPartyId?: string
  candidateId?: string
  optionId?: string
  credentialId: string
  credentialSignature: string
}

export type CastAnonymousVoteResult =
  | { status: 'recorded'; token: string }
  | { status: 'invalid_credential' }
  | { status: 'credential_already_used' }
  | { status: 'invalid_choice'; reason: string }
  | { status: 'failed' }

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
  getBallotPublicKey as getBallotPublicKeyInternal,
  getElection as getElectionInternal,
  listElections as listElectionsInternal,
  listOpenElections as listOpenElectionsInternal,
  listRegisteredParties as listRegisteredPartiesInternal,
  validateBallotChoice,
  BallotValidationError,
} from './election.service'

/**
 * Registrerar en anonym röst.
 *
 * Auktorisationen ligger helt i röstintyget. Modulen frågar inte vem som
 * röstar och har ingen möjlighet att ta reda på det — den kontrollerar att
 * intyget bär valmyndighetens signatur för just den här valsedeln, och att det
 * inte redan är inlöst.
 */
export async function castAnonymousVote(
  input: CastAnonymousVoteInput,
): Promise<CastAnonymousVoteResult> {
  // Valet måste passa valsedeln: rätt sorts svar, giltigt parti, kandidat som
  // står för det partiet, och en omröstning som faktiskt är öppen.
  const validation = await validateBallotChoice({
    ballotId: input.ballotId,
    ballotPartyId: input.ballotPartyId,
    candidateId: input.candidateId,
    optionId: input.optionId,
  })

  if (!validation.valid) {
    return { status: 'invalid_choice', reason: validation.reason }
  }

  return recordAnonymousVote(
    {
      ballotId: input.ballotId,
      ballotPartyId: input.ballotPartyId,
      candidateId: input.candidateId,
      optionId: input.optionId,
    },
    { credentialId: input.credentialId, signature: input.credentialSignature },
  )
}

export const listElections = listElectionsInternal
export const listOpenElections = listOpenElectionsInternal
export const getElection = getElectionInternal
export const getBallotChoices = getBallotChoicesInternal
export const getBallotPublicKey = getBallotPublicKeyInternal
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
