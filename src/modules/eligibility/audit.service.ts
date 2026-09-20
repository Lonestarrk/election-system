import { truncateToHour } from '@/lib/time'
import { logger } from '@/lib/logger'
import { votersDb } from './db'

/**
 * Revisionslogg för säkerhetshändelser.
 *
 * Här finns en verklig konflikt mellan två legitima krav. En revisionslogg ska
 * göra det möjligt att utreda missbruk. Men en logg som är detaljerad nog för
 * en utredning — vem, när, exakt tidpunkt, från vilken adress — är också
 * detaljerad nog för att avanonymisera en väljare.
 *
 * Valet här är att prioritera valhemligheten. Loggen svarar på frågan "hur
 * många misslyckade legitimeringar har systemet sett den här timmen?" men
 * aldrig på "vem misslyckades?".
 *
 * Vad som medvetet INTE lagras: identitet, identitetshash, parti, token,
 * token-hash, IP-adress, request-id, user agent, sessions-id, exakt tidpunkt.
 *
 * Att händelsetypen inte får innehålla parti är särskilt viktigt: en
 * revisionsrad "VOTE_RECORDED_SD" i röstlängdsdatabasen skulle på egen hand
 * riva hela separationen.
 */

export const AUDIT_EVENTS = {
  AUTH_STARTED: 'AUTH_STARTED',
  AUTH_COMPLETED: 'AUTH_COMPLETED',
  AUTH_FAILED: 'AUTH_FAILED',
  NOT_IN_ELECTORAL_ROLL: 'NOT_IN_ELECTORAL_ROLL',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  DOUBLE_VOTE_BLOCKED: 'DOUBLE_VOTE_BLOCKED',
  VOTING_SESSION_CREATED: 'VOTING_SESSION_CREATED',
  VOTING_SESSION_EXPIRED: 'VOTING_SESSION_EXPIRED',
  VOTE_RECORDED: 'VOTE_RECORDED',
  VOTE_RECORDING_FAILED: 'VOTE_RECORDING_FAILED',
  CSRF_REJECTED: 'CSRF_REJECTED',
  RATE_LIMITED: 'RATE_LIMITED',
  ADMIN_LOGIN_SUCCEEDED: 'ADMIN_LOGIN_SUCCEEDED',
  ADMIN_LOGIN_FAILED: 'ADMIN_LOGIN_FAILED',
  /**
   * Någon legitimerade sig framgångsrikt men saknade adminflaggan.
   *
   * Skild från ADMIN_LOGIN_FAILED, som betyder att legitimeringen i sig inte
   * gick igenom. Skillnaden spelar roll vid en granskning: många
   * ADMIN_ACCESS_DENIED betyder att någon prövar sig fram med giltiga BankID,
   * vilket är ett helt annat mönster än misslyckade signeringar.
   *
   * Raden säger fortfarande inte VEM. Den säger att det hände, och vilken
   * timme.
   */
  ADMIN_ACCESS_DENIED: 'ADMIN_ACCESS_DENIED',
  ELECTION_CREATED: 'ELECTION_CREATED',
  ELECTION_CREATION_FAILED: 'ELECTION_CREATION_FAILED',
  /**
   * En notis om en ny omröstning skickades ut.
   *
   * Notera att antalet mottagare INTE loggas. Ett antal prenumeranter är i sig
   * harmlöst, men tillsammans med en tidsstämpel blir det en signal om hur
   * många enheter som är aktiva just då — och den sortens sidoinformation är
   * precis vad revisionsloggen ska hålla sig ifrån.
   */
  ELECTION_NOTIFICATION_SENT: 'ELECTION_NOTIFICATION_SENT',
} as const

export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS]

export async function recordAuditEvent(eventType: AuditEventType): Promise<void> {
  try {
    await votersDb.auditEvent.create({
      data: {
        eventType,
        occurredAt: truncateToHour(new Date()),
      },
    })
  } catch (error) {
    // En revisionslogg som inte går att skriva får inte stoppa en väljare från
    // att rösta. Felet loggas, men rösträtten går före.
    logger.error('Kunde inte skriva revisionshändelse', { eventType, error: String(error) })
  }
}
