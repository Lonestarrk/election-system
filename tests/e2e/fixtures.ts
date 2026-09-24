import { test as base, expect } from '@playwright/test'

/**
 * GEMENSAM TESTBAS FÖR E2E-SVITEN.
 *
 * Specarna importerar `test` härifrån i stället för från @playwright/test, av
 * ett enda skäl: sviten slog ut sin egen hastighetsbegränsning.
 *
 * Ett tjugotal legitimeringar från samma IP-adress inom ett par minuter
 * överskrider `authStart` (20/min), och `adminLogin` (5 per 5 minuter) tickas
 * dessutom bara av MISSLYCKADE inloggningar — varav ett test framkallar en med
 * flit. Följden var tre röda av tjugoett vid full körning, alla med
 * "Legitimeringen misslyckades", och alla gröna körda var för sig. Den sortens
 * fel är värre än ett vanligt rött test, eftersom det ser ut som en regression
 * i appen.
 *
 * Gränserna är medvetet orörda. Nollställningen sker mellan tester, via en
 * rutt som bara finns när BankID är en attrapp — se
 * api/demo/reset-rate-limits.
 */

/**
 * Dev-servern kompilerar varje rutt vid första anropet, och det kostar
 * hundratals millisekunder.
 *
 * Det räckte för att fälla tre tester. Den första `/api/admin/login` tog 478
 * ms medan Next byggde rutten, vilket hann framkalla en extra pollning som
 * konsumerade BankID-ordern — och testet såg "Legitimeringen misslyckades" i
 * stället för behörighetsavslaget. Symptomet pekade på appen, orsaken låg i
 * uppsättningen.
 *
 * Själva kapplöpningen är rättad i BankIdLogin (en fråga i taget), men
 * uppvärmningen står kvar: en svit vars första test betalar
 * kompileringstiden är ändå ojämn, och ojämna tester slutar man tro på.
 *
 * Röstsidans rutter är kuvertmodellens sedan uppgift 14. Det gamla flödets
 * /api/vote/cast anropas inte längre av någon sida och värms därför inte.
 */
const ROUTES_TO_WARM = [
  '/api/auth/bankid/start',
  '/api/auth/bankid/collect',
  '/api/auth/bankid/qr',
  '/api/admin/login',
  '/api/demo/bankid-scan',
  '/api/vote/session',
  '/api/vote/ballot',
  '/api/vote/compare',
  '/api/vote/sign-start',
  '/api/vote/encrypted',
]

let warmed = false

const resetRateLimits = base.extend<{ freshRateLimits: void }>({
  freshRateLimits: [
    async ({ request, baseURL }, use) => {
      const origin = baseURL ?? 'http://localhost:3000'

      if (!warmed) {
        warmed = true
        // Svaren är ointressanta — 400 och 403 kompilerar rutten lika bra som
        // 200. Poängen är att ingen betalar bygget mitt i ett flöde.
        await Promise.all(
          ROUTES_TO_WARM.map((path) =>
            request.post(path, { headers: { origin }, data: {} }).catch(() => undefined),
          ),
        )
      }

      const response = await request.post('/api/demo/reset-rate-limits', {
        headers: { origin },
      })

      /**
       * Ett tyst misslyckande här vore särskilt förvirrande: testerna skulle
       * falla längre fram med "Legitimeringen misslyckades", alltså ett
       * meddelande som pekar på appen i stället för på uppsättningen.
       *
       * 404 betyder att BankID inte är en attrapp, och då ska sviten inte
       * köras alls — den bygger på demoidentiteterna.
       */
      if (!response.ok()) {
        throw new Error(
          `Kunde inte nollställa hastighetsbegränsningen (${response.status()}). ` +
            'Är BankID skarpt konfigurerat? E2E-sviten kräver attrappen.',
        )
      }

      await use()
    },
    { auto: true },
  ],
})

export { resetRateLimits as test, expect }
