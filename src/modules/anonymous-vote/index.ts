/**
 * Den anonyma röstmodulens publika yta.
 *
 * Detta är hela kontraktet mot resten av systemet. Lägg märke till vad
 * `castAnonymousVote` tar emot:
 *
 *     { partyId: string }
 *
 * Ingenting annat. Det finns ingen parameter för väljar-id, personnummer,
 * sessions-id, IP-adress eller request-id — så en anropare kan inte skicka med
 * sådant ens av misstag. TypeScript avvisar det vid kompilering.
 *
 * Det är skillnaden mot en dokumenterad regel: en kommentar som säger "skicka
 * inte in identitet här" håller tills någon har bråttom. Ett typkontrakt
 * håller alltid.
 *
 * Modulen kan inte heller hämta informationen på egen hand: dess Prisma-klient
 * pekar på en annan PostgreSQL-databas än röstlängden.
 */

export type CastAnonymousVoteInput = {
  partyId: string
}

export type CastAnonymousVoteResult = {
  /** Klartext-token. Visas för väljaren en gång och lagras aldrig. */
  token: string
}

import {
  recordAnonymousVote,
  listParties as listPartiesInternal,
  partyExists,
  verifyToken as verifyTokenInternal,
  getVoteStatistics as getVoteStatisticsInternal,
  VoteRecordingError,
} from './vote.service'

/**
 * Registrerar en anonym röst.
 *
 * Anroparen — orkestreringslagret — har redan kontrollerat att väljaren är
 * röstberättigad och markerat att rösten lagts. Den informationen följer
 * medvetet inte med hit.
 */
export async function castAnonymousVote(
  input: CastAnonymousVoteInput,
): Promise<CastAnonymousVoteResult> {
  return recordAnonymousVote(input.partyId)
}

/**
 * Kontrollerar att ett parti-id finns.
 *
 * Finns här för att orkestreringslagret ska kunna avvisa ett ogiltigt parti
 * INNAN väljaren markeras som röstande. Utan den kontrollen skulle en felaktig
 * begäran kunna bränna någons rösträtt utan att någon röst registrerades.
 */
export const isKnownParty = partyExists

export const listParties = listPartiesInternal
export const verifyToken = verifyTokenInternal
export const getVoteStatistics = getVoteStatisticsInternal

export { VoteRecordingError }
export type { Party, VerificationResult } from './vote.service'
