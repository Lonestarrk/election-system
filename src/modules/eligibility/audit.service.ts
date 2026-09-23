import { createHash } from 'node:crypto'
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
  /**
   * Ett röstintyg utfärdades — alltså en godkänd röstning.
   *
   * Ersätter VOTE_RECORDED som markör för "någon röstade". Den händelsen kan
   * inte längre loggas här: själva röstläggningen sker anonymt mot en annan
   * databas, och en revisionsrad därifrån skulle kräva just den koppling
   * mellan sidorna som systemet är byggt för att undvika.
   */
  CREDENTIAL_ISSUED: 'CREDENTIAL_ISSUED',
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
  /**
   * Valideringen som körs medan `PendingVote` fortfarande pekar på en väljare
   * — se `validate-before-close.usecase.ts`.
   *
   * Loggas utan antal och utan identiteter, av samma skäl som allt annat här:
   * validering körs en gång per omröstning strax före skalningen, så även ett
   * enda antal skulle i praktiken peka ut precis det tillfället. Det som ska
   * synas är ATT kopplingen lästs, inte vad läsningen gav för resultat —
   * resultatet hör hemma i valideringsrapporten, som publiceras separat.
   */
  PRE_CLOSE_VALIDATION: 'PRE_CLOSE_VALIDATION',
  /**
   * Kopplingen mellan väljare och röst raderades — skalningen, se
   * `close-election.usecase.ts`.
   *
   * Den enda oåterkalleliga händelsen i systemet, och därför den som allra
   * minst får ske tyst. Posten säger ATT den skedde, och vilken timme.
   *
   * Inget antal och inget omröstnings-id, av samma skäl som
   * PRE_CLOSE_VALIDATION: skalningen sker en gång per omröstning, så redan ett
   * ensamt antal skulle peka ut precis det tillfället — och tillsammans med
   * timmen vore det en tidsmarkör bredvid varje röst som just flyttats.
   */
  LINK_CLEARED: 'LINK_CLEARED',
} as const

export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS]

/**
 * Hashen för en rad i kedjan.
 *
 * Över löpnummer, händelsetyp, tidpunkt och föregående rads hash. Ändras något
 * av det slutar alla senare hashar stämma.
 */
export function auditEntryHash(input: {
  sequence: number
  eventType: string
  occurredAt: Date
  previousHash: string | null
}): string {
  return createHash('sha256')
    .update(
      [
        input.sequence,
        input.eventType,
        input.occurredAt.toISOString(),
        input.previousHash ?? 'GENESIS',
      ].join('|'),
      'utf8',
    )
    .digest('hex')
}

/**
 * Antal försök att få ett ledigt löpnummer.
 *
 * Två samtidiga händelser kan råka läsa samma "senaste löpnummer" och båda
 * försöka skriva nästa. Det unika indexet avvisar den andra, som då får läsa om
 * och försöka igen. Att låta databasen avgöra är avsiktligt: en räknare i
 * applikationen skulle gå sönder så fort systemet kör i mer än en process.
 */
const MAX_SEQUENCE_ATTEMPTS = 5

/**
 * Klienten händelsen skrivs med.
 *
 * Normalt den delade `votersDb`. En anropare som redan kör i en transaktion
 * skickar in sin `tx` i stället, så att revisionsposten lever och dör med det
 * den beskriver — se `closeElection`, där en post om en radering som rullats
 * tillbaka vore värre än ingen post alls.
 */
export type AuditClient = Pick<typeof votersDb, 'auditEvent'>

export async function recordAuditEvent(
  eventType: AuditEventType,
  client: AuditClient = votersDb,
): Promise<void> {
  const occurredAt = truncateToHour(new Date())

  for (let attempt = 1; attempt <= MAX_SEQUENCE_ATTEMPTS; attempt += 1) {
    try {
      const previous = await client.auditEvent.findFirst({
        orderBy: { sequence: 'desc' },
        select: { sequence: true, entryHash: true },
      })

      const sequence = (previous?.sequence ?? 0) + 1
      const previousHash = previous?.entryHash ?? null

      await client.auditEvent.create({
        data: {
          eventType,
          occurredAt,
          sequence,
          previousHash,
          entryHash: auditEntryHash({ sequence, eventType, occurredAt, previousHash }),
        },
      })

      return
    } catch (error) {
      const isUniqueViolation =
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'

      if (isUniqueViolation && attempt < MAX_SEQUENCE_ATTEMPTS) continue

      // En revisionslogg som inte går att skriva får inte stoppa en väljare
      // från att rösta. Felet loggas, men rösträtten går före.
      logger.error('Kunde inte skriva revisionshändelse', { eventType, attempt })
      return
    }
  }
}

export type AuditChainVerdict =
  | { intact: true; entries: number }
  | { intact: false; reason: string; brokenAtSequence: number }

/**
 * Kontrollerar att revisionskedjan är obruten.
 *
 * Upptäcker en borttagen rad (hål i löpnumren), en ändrad rad (hashen stämmer
 * inte med innehållet) och en omskriven historik (pekaren bakåt stämmer inte).
 *
 * VAD DEN INTE UPPTÄCKER
 *
 * Att någon med skrivrättigheter räknar om hela kedjan från en viss punkt. Mot
 * det hjälper bara att kedjans spets publiceras externt och löpande — vilket är
 * vad observatörsgränssnittet finns till för.
 */
export async function verifyAuditChain(): Promise<AuditChainVerdict> {
  const entries = await votersDb.auditEvent.findMany({
    orderBy: { sequence: 'asc' },
    select: { sequence: true, eventType: true, occurredAt: true, previousHash: true, entryHash: true },
  })

  let previousHash: string | null = null

  for (const [index, entry] of entries.entries()) {
    const expectedSequence = index + 1

    if (entry.sequence !== expectedSequence) {
      return {
        intact: false,
        reason: `Löpnummer ${entry.sequence} bryter följden — ${expectedSequence} väntades.`,
        brokenAtSequence: expectedSequence,
      }
    }

    if (entry.previousHash !== previousHash) {
      return {
        intact: false,
        reason: 'Raden pekar inte på den föregående.',
        brokenAtSequence: entry.sequence,
      }
    }

    const recomputed = auditEntryHash({
      sequence: entry.sequence,
      eventType: entry.eventType,
      occurredAt: entry.occurredAt,
      previousHash: entry.previousHash,
    })

    if (recomputed !== entry.entryHash) {
      return {
        intact: false,
        reason: 'Radens hash stämmer inte med dess innehåll.',
        brokenAtSequence: entry.sequence,
      }
    }

    previousHash = entry.entryHash
  }

  return { intact: true, entries: entries.length }
}

/** Antal händelser av en viss typ. Används av slutkontrollen. */
export async function countAuditEvents(eventType: AuditEventType): Promise<number> {
  return votersDb.auditEvent.count({ where: { eventType } })
}
