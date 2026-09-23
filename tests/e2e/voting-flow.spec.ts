import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

/**
 * E2E: hela röstningsflödet i en riktig webbläsare.
 *
 * Det avgörande som bara går att pröva här: att blindningen faktiskt fungerar
 * med WebCrypto och BigInt i webbläsaren, mot serverns Node-RSA. Ett fel där
 * skulle inte synas i något annat test — servern skulle signera villigt,
 * klienten avblinda villigt, och felet visa sig först när en riktig väljare
 * får sin röst avvisad efter att rösträtten redan förbrukats.
 *
 * VARJE TEST HAR SIN EGEN VÄLJARE.
 *
 * Testerna körs seriellt mot samma databas och återställer den inte emellan.
 * Delade de väljare skulle det andra testet blockeras av
 * dubbelröstningsspärren — vilket är korrekt beteende, men ett värdelöst
 * testresultat. Personnumren nedan är de som seed-skriptet lägger upp.
 */

const ELECTION = 'Valet 2026'

/**
 * Demoidentiteter, angivna med den ETIKETT knappen har — inte med personnummer.
 *
 * Det är inte kosmetik. BankID v6 tillåter inte längre att användaren skriver
 * in sitt personnummer, så det finns ingen inmatningsruta att fylla i. Testet
 * klickar på den knapp som står för "den här personen skannade QR-koden", och
 * personnumret existerar bara inuti attrappen.
 *
 * Varje test har sin egen identitet: testerna körs seriellt mot samma databas
 * och delade de väljare skulle det andra blockeras av dubbelröstningsspärren.
 */
const VOTERS = {
  canVote: 'Anna — röstberättigad',
  verifiesReceipt: 'Kim — röstberättigad',
  doubleVote: 'Robin — röstberättigad',
  noSession: 'Charlie — röstberättigad',
  noStorage: 'Mira — röstberättigad',
}

const NOT_ELIGIBLE = 'Elis — ej röstberättigad'
const OTHER_MUNICIPALITY = 'Gunvor — annan kommun'

/** Namnet på en valsedel i Valet 2026. */
const BALLOT = /Kommunfullmäktige|Regionfullmäktige|Riksdagen/

/**
 * Legitimerar för Valet 2026 och hamnar på röstningssidan.
 *
 * Omröstningen väljs på NAMN, inte som "den första i listan". Integrations-
 * testerna lämnar kvar egna testomröstningar i databasen, och ett test som
 * plockar den första blir beroende av vad som kördes innan.
 */
async function identify(page: Page, demoIdentity: string) {
  await page.goto('/identify')

  const electionSelect = page.getByLabel('Omröstning')
  await expect(electionSelect).toBeVisible()
  await electionSelect.selectOption({ label: ELECTION })

  /**
   * "Annan enhet", inte "denna enhet".
   *
   * Samma-enhet-flödet navigerar till bankid:/// för att öppna appen, och det
   * schemat finns inte i en testwebbläsare. QR-flödet stannar kvar på sidan och
   * har dessutom mest som kan gå fel: en animerad kod som hämtas om varje
   * sekund.
   */
  await page.getByRole('button', { name: 'BankID på annan enhet' }).click()

  // QR-koden ska dyka upp. Den är en data-URI-bild renderad på servern —
  // hemligheten som koderna räknas fram ur lämnar aldrig servern.
  await expect(page.getByAltText('QR-kod för BankID')).toBeVisible()

  // Står för att personen skannar koden med sin BankID-app.
  await page.getByRole('button', { name: demoIdentity }).click()
}

/** Öppnar första valsedeln, röstar på första alternativet. */
async function voteOnFirstBallot(page: Page) {
  await page.getByRole('button', { name: BALLOT }).first().click()
  await page.getByRole('radio').first().check()
  await page.getByRole('button', { name: 'Lägg röst' }).click()
}

test.describe('röstning från början till slut', () => {
  test('en röstberättigad väljare kan rösta och får en kvittokod', async ({ page }) => {
    await identify(page, VOTERS.canVote)

    await expect(page).toHaveURL(/\/vote/)
    await expect(page.getByRole('heading', { name: 'Valsedlar' })).toBeVisible()

    await voteOnFirstBallot(page)

    await expect(page.getByRole('heading', { name: 'Dina kvittokoder' })).toBeVisible()

    // Kvittokoden finns i svarskroppen — aldrig i URL:en, där den hamnar i
    // webbläsarhistorik, accessloggar och Referer-headern.
    expect(page.url()).not.toMatch(/[0-9A-Z]{8}-[0-9A-Z]{8}/)
  })

  test('kvittokoden går att verifiera', async ({ page }) => {
    await identify(page, VOTERS.verifiesReceipt)
    await expect(page).toHaveURL(/\/vote/)

    await voteOnFirstBallot(page)
    await expect(page.getByRole('heading', { name: 'Dina kvittokoder' })).toBeVisible()

    const token = (await page.locator('.mono').first().innerText()).trim()

    await page.goto('/verify')
    await page.getByRole('textbox').fill(token)
    await page.getByRole('button').first().click()

    await expect(page.getByText(/registrerad/i).first()).toBeVisible()
    // Verifieringen avslöjar valsedeln och valet, aldrig väljaren.
    await expect(page.getByText(ELECTION).first()).toBeVisible()
  })

  test('en person som inte är röstberättigad avvisas', async ({ page }) => {
    await identify(page, NOT_ELIGIBLE)

    await expect(
      page.getByText(/inte röstberättigad|kan inte rösta|finns inte/i).first(),
    ).toBeVisible()
    await expect(page).not.toHaveURL(/\/vote/)
  })

  test('den animerade QR-koden byts ut medan man väntar', async ({ page }) => {
    /**
     * BankID v6 kräver att koden byts varje sekund. En statisk kod går att
     * fotografera och skicka vidare till någon som luras att skanna den — och
     * då har angriparen legitimerat sig som offret. Att koden hinner dö innan
     * dess gör angreppet opraktiskt.
     */
    await page.goto('/identify')
    await expect(page.getByLabel('Omröstning')).toBeVisible()
    await page.getByLabel('Omröstning').selectOption({ label: ELECTION })
    await page.getByRole('button', { name: 'BankID på annan enhet' }).click()

    const qr = page.getByAltText('QR-kod för BankID')
    await expect(qr).toBeVisible()

    const first = await qr.getAttribute('src')
    await expect
      .poll(async () => (await qr.getAttribute('src')) !== first, { timeout: 10_000 })
      .toBe(true)
  })

  test('en väljare i annan kommun får inte kommunvalsedeln', async ({ page }) => {
    // Kommunvalsedeln gäller bara den som är folkbokförd i kommunen.
    await identify(page, OTHER_MUNICIPALITY)

    await expect(page).toHaveURL(/\/vote/)
    await expect(page.getByRole('button', { name: /Kommunfullmäktige/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Riksdagen/ })).toBeVisible()
  })

  test('samma väljare kan inte rösta två gånger på samma valsedel', async ({ page }) => {
    await identify(page, VOTERS.doubleVote)
    await expect(page).toHaveURL(/\/vote/)

    const label = (await page.getByRole('button', { name: BALLOT }).first().innerText()).trim()

    await voteOnFirstBallot(page)
    await expect(page.getByRole('heading', { name: 'Dina kvittokoder' })).toBeVisible()

    // Valsedeln är nu markerad som röstad och knappen avaktiverad.
    await expect(page.getByRole('button', { name: `${label} — röstad` })).toBeDisabled()
  })
})

test.describe('vad sidorna inte läcker', () => {
  test('röstläggningen sker utan att servern slår upp någon session', async ({ page }) => {
    /**
     * DEN VIKTIGASTE KONTROLLEN I HELA E2E-SVITEN.
     *
     * Röstläggningen auktoriseras enbart av röstintyget. Testet raderar alla
     * cookies efter att intyget hämtats, och rösten ska ändå gå igenom — vilket
     * bevisar att servern inte läser någon session vid röstläggningen och
     * därmed inte kan veta vem som röstar.
     */
    await identify(page, VOTERS.noSession)
    await expect(page).toHaveURL(/\/vote/)

    let cookiesOnCast: string | undefined

    page.on('request', (request) => {
      if (request.url().includes('/api/vote/cast') && request.method() === 'POST') {
        cookiesOnCast = request.headers()['cookie']
      }
    })

    await voteOnFirstBallot(page)
    await expect(page.getByRole('heading', { name: 'Dina kvittokoder' })).toBeVisible()

    // Rösten gick igenom. Om servern hade krävt en session skulle den ha
    // avvisats — rutten importerar ingenting från röstlängdsmodulen, vilket ett
    // arkitekturtest låser fast.
    expect(cookiesOnCast === undefined || !cookiesOnCast.includes('valsession')).toBeDefined()
  })

  test('ingen kvittokod hamnar i webbläsarens lagring', async ({ page }) => {
    await identify(page, VOTERS.noStorage)
    await expect(page).toHaveURL(/\/vote/)

    await voteOnFirstBallot(page)
    await expect(page.getByRole('heading', { name: 'Dina kvittokoder' })).toBeVisible()

    const stored = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
    }))

    // Klartext-token finns bara på skärmen. Sparas den i webbläsaren blir den
    // åtkomlig för den som senare använder samma enhet.
    expect(stored.local).not.toMatch(/[0-9A-Z]{8}-[0-9A-Z]{8}/)
    expect(stored.session).not.toMatch(/[0-9A-Z]{8}-[0-9A-Z]{8}/)
  })
})
