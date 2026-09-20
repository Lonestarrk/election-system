import { PrismaClient } from '.prisma/votes'

/**
 * Prisma-klient mot den anonyma röstdatabasen (votes_db).
 *
 * Klienten är genererad från ett eget schema och pekar på en egen databas.
 * Den kan inte nå röstlängden: det finns ingen modell för `voter_status` i
 * det här schemat, och en join över databasgränsen är omöjlig i PostgreSQL.
 *
 * Separationen är alltså inte upprätthållen av disciplin utan av topologi.
 */

const globalForPrisma = globalThis as unknown as { votesDb?: PrismaClient }

export const votesDb =
  globalForPrisma.votesDb ??
  new PrismaClient({
    // Ingen query-loggning: en Prisma-frågelogg skulle skriva ut token-hashar
    // i klartext till applikationsloggen.
    log: ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.votesDb = votesDb
}
