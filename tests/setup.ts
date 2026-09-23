import { loadDotEnvFile, redirectToTestDatabases } from './test-databases'

/**
 * Förbereder miljön i varje testprocess, innan testfilen importeras.
 *
 * Ordningen är hela poängen:
 *
 * 1. .env läses in, utan att skriva över det som redan finns i miljön.
 * 2. Databasvariablerna pekas om till voters_test och votes_test — och skrivs
 *    över utan villkor. Annars skulle en VOTERS_DATABASE_URL från skalet, eller
 *    den som .env just fyllde i, gå rakt igenom till klienterna, och testerna
 *    skulle tömma utvecklingsdatabasen.
 * 3. Först därefter importerar testfilen något som skapar en Prisma-klient.
 *    Klienten läser adressen ur miljön, och när den skapas står bara
 *    testadressen där. Därför får den här filen inte själv importera någon
 *    databasmodul, inte ens indirekt.
 *
 * Saknas databasadresserna helt pekas ingenting om. Integrationstesterna får
 * då beskedet "skip" från tests/global-setup.ts och hoppas över, och
 * enhetstesterna kör som vanligt.
 */

loadDotEnvFile()
redirectToTestDatabases()

// Standardvärden så att enhetstesterna kan köras utan .env och utan databas.
process.env.IDENTITY_PEPPER ??= 'test-pepper-minst-trettiotva-tecken-langt-0000'
process.env.APP_ORIGIN ??= 'http://localhost:3000'
process.env.MOCK_BANKID_POLLS_UNTIL_COMPLETE ??= '0'
