import { generateCsrfSecret } from '@/lib/csrf'
import { SESSION_TTL_MINUTES } from '@/lib/cookies'
import { votersDb } from './db'

/**
 * Röstsessionen: den korta stund då identitet och pågående röstning möts.
 *
 * Detta är systemets känsligaste objekt. Så länge sessionen finns går det att
 * gå från sessions-id till väljare. Därför:
 *   – livslängden är kort (10 minuter)
 *   – raden RADERAS när rösten lagts, den markeras inte som förbrukad
 *   – sessionen innehåller aldrig något partival
 *
 * Efter att rösten lagts finns ingen rad kvar som kan knyta ihop de två
 * sidorna av systemet, varken direkt eller via ett gammalt sessions-id.
 */

export type VotingSession = {
  id: string
  voterStatusId: string
  csrfSecret: string
}

export async function createVotingSession(voterStatusId: string): Promise<VotingSession> {
  // En väljare som legitimerar sig på nytt ska inte lämna efter sig gamla
  // sessioner. Varje kvarliggande session är ett extra fönster där
  // kopplingen identitet–röstning existerar.
  await votersDb.votingSession.deleteMany({ where: { voterStatusId } })

  const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000)

  const session = await votersDb.votingSession.create({
    data: {
      voterStatusId,
      expiresAt,
      csrfSecret: generateCsrfSecret(),
    },
    select: { id: true, voterStatusId: true, csrfSecret: true },
  })

  return session
}

/**
 * Hämtar en giltig session. Utgångna sessioner raderas i samma veva.
 */
export async function getValidVotingSession(sessionId: string): Promise<VotingSession | null> {
  const session = await votersDb.votingSession.findUnique({
    where: { id: sessionId },
    select: { id: true, voterStatusId: true, csrfSecret: true, expiresAt: true },
  })

  if (!session) return null

  if (session.expiresAt.getTime() <= Date.now()) {
    await votersDb.votingSession.deleteMany({ where: { id: sessionId } })
    return null
  }

  return {
    id: session.id,
    voterStatusId: session.voterStatusId,
    csrfSecret: session.csrfSecret,
  }
}

export async function destroyVotingSession(sessionId: string): Promise<void> {
  await votersDb.votingSession.deleteMany({ where: { id: sessionId } })
}

/** Städar bort utgångna sessioner. */
export async function purgeExpiredSessions(): Promise<number> {
  const result = await votersDb.votingSession.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  })
  return result.count
}
