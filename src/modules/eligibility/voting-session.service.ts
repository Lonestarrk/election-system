import { generateCsrfSecret } from '@/lib/csrf'
import { SESSION_TTL_MINUTES } from '@/lib/cookies'
import { votersDb } from './db'

/**
 * Röstsessionen: den korta stund då identitet och pågående röstning möts.
 *
 * Detta är systemets känsligaste objekt. Så länge sessionen finns går det att
 * gå från sessions-id till väljare. Därför:
 *   – livslängden är kort (10 minuter)
 *   – raden RADERAS när omröstningen är avklarad, den markeras inte som förbrukad
 *   – sessionen innehåller aldrig något partival
 *
 * Efter att rösterna lagts finns ingen rad kvar som kan knyta ihop de två
 * sidorna av systemet, varken direkt eller via ett gammalt sessions-id.
 *
 * SESSIONEN LEVER NU ÖVER FLERA VALSEDLAR, OCH DET ÄR EN FÖRSÄMRING.
 *
 * I ett riksdagsval fyller väljaren tre valsedlar under samma session. Fönstret
 * där identitet och röstning existerar samtidigt är alltså längre än när en
 * session täckte en enda röst — det stängs först när sista valsedeln är lagd
 * eller sessionen går ut.
 *
 * Alternativet, en ny legitimering per valsedel, skulle korta fönstret men
 * kräva tre BankID-signeringar av varje väljare. Avvägningen är gjord medvetet
 * och står i SECURITY.md. Livslängden på tio minuter är kvar oförändrad, vilket
 * gör att fönstret inte kan växa obegränsat även om väljaren avbryter mitt i.
 */

export type VotingSession = {
  id: string
  voterStatusId: string
  electionId: string
  csrfSecret: string
}

export async function createVotingSession(
  voterStatusId: string,
  electionId: string,
): Promise<VotingSession> {
  // En väljare som legitimerar sig på nytt ska inte lämna efter sig gamla
  // sessioner. Varje kvarliggande session är ett extra fönster där
  // kopplingen identitet–röstning existerar.
  await votersDb.votingSession.deleteMany({ where: { voterStatusId } })

  const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000)

  return votersDb.votingSession.create({
    data: {
      voterStatusId,
      electionId,
      expiresAt,
      csrfSecret: generateCsrfSecret(),
    },
    select: { id: true, voterStatusId: true, electionId: true, csrfSecret: true },
  })
}

/**
 * Hämtar en giltig session. Utgångna sessioner raderas i samma veva.
 */
export async function getValidVotingSession(sessionId: string): Promise<VotingSession | null> {
  const session = await votersDb.votingSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      voterStatusId: true,
      electionId: true,
      csrfSecret: true,
      expiresAt: true,
    },
  })

  if (!session) return null

  if (session.expiresAt.getTime() <= Date.now()) {
    await votersDb.votingSession.deleteMany({ where: { id: sessionId } })
    return null
  }

  return {
    id: session.id,
    voterStatusId: session.voterStatusId,
    electionId: session.electionId,
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
