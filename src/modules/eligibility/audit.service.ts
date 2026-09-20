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
