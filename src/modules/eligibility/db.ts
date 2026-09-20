import { PrismaClient } from '.prisma/voters'

/**
 * Prisma-klient mot röstlängdsdatabasen (voters_db).
 *
 * Detta är den ENDA klienten som når identiteter. Den anonyma röstmodulen har
 * en egen klient mot en egen databas och kan inte nå den här — inte via en
 * join, inte via en foreign key, inte via en rå SQL-fråga. Databaserna är
 * skilda åt på PostgreSQL-nivå.
 */

const globalForPrisma = globalThis as unknown as { votersDb?: PrismaClient }

export const votersDb =
  globalForPrisma.votersDb ??
  new PrismaClient({
    // Ingen query-loggning. Prismas frågelogg skulle skriva ut
    // identitetshashar och därmed göra hela hashningen verkningslös mot den
    // som kommer åt loggarna.
    log: ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.votersDb = votersDb
}
