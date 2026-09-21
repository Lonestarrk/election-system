import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright: E2E mot appen i en riktig webbläsare.
 *
 * VARFÖR DE HÄR TESTERNA BEHÖVS UTÖVER VITEST
 *
 * Vitest-sviten kör tjänstelagret direkt i Node. Den kan visa att röstintyg
 * utfärdas och löses in korrekt, men inte att blindningen fungerar i en riktig
 * webbläsare — och det är där den MÅSTE fungera. Blindningsfaktorn är det enda
 * som hindrar valmyndigheten från att koppla ihop ett utfärdat intyg med en
 * inlämnad röst, och den räknas fram med WebCrypto och BigInt på klienten.
 *
 * Ett fel där skulle inte synas i något annat test: servern skulle signera
 * villigt, klienten avblinda villigt, och felet visa sig först när en riktig
 * väljare får sin röst avvisad.
 *
 * KRÄVER DATABAS OCH SEEDAD DEMODATA.
 *
 *   docker compose up -d postgres
 *   npm run migrate && npm run seed
 *   npm run test:e2e
 */
export default defineConfig({
  testDir: './tests/e2e',

  /**
   * Nollställer röstdata och seedar om före sviten.
   *
   * Testerna röstar på riktigt och förbrukar rösträtt. Utan detta blockeras
   * andra körningen av dubbelröstningsspärren — korrekt beteende, värdelöst
   * testresultat.
   */
  globalSetup: './tests/e2e/global-setup.ts',

  // Röstning är tillståndsändrande: två tester som röstar som samma person
  // samtidigt skulle störa varandra genom dubbelröstningsspärren.
  fullyParallel: false,
  workers: 1,

  // Ett misslyckat valtest ska inte maskeras av en omkörning. Retry döljer
  // just den sortens tidsberoende fel som är mest intressanta här.
  retries: 0,

  reporter: [['list']],

  /**
   * Generös tidsgräns per förväntan.
   *
   * Sidorna gör riktig kryptografi: blindning, avblindning och verifiering av
   * en 2048-bitars RSA-signatur med BigInt i webbläsaren. Det tar hundratals
   * millisekunder per valsedel, och på en långsam maskin mer.
   */
  expect: { timeout: 20_000 },

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    // WebCrypto kräver säker kontext. localhost räknas som säker, så det
    // fungerar utan certifikat — men mot en annan värd krävs HTTPS.
    ignoreHTTPSErrors: true,
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:3000',
        reuseExistingServer: true,
        timeout: 120_000,
      },
})
