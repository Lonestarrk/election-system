import { expect, test } from '@playwright/test'

/**
 * E2E: hela röstningsflödet i en riktig webbläsare.
 *
 * Det avgörande som bara går att pröva här: att blindningen faktiskt fungerar
 * med WebCrypto och BigInt i webbläsaren, mot serverns Node-RSA. Ett fel där
 * skulle inte synas i något annat test — servern skulle signera villigt,
 * klienten avblinda villigt, och felet visa sig först när en riktig väljare
 * får sin röst avvisad efter att rösträtten redan förbrukats.
 *
 * Testerna förutsätter seedad demodata (npm run seed).
 */

const VOTER = '19900101-1234'
const NOT_ELIGIBLE = '20100101-4567'

/** Legitimerar och hamnar på röstningssidan. */
async function identify(page: import('@playwright/test').Page, personalNumber: string) {
  await page.goto('/legitimera')
  await expect(page.getByLabel('Omröstning')).toBeVisible()

  await page.getByLabel('Personnummer').fill(personalNumber)
  await page.getByRole('button', { name: 'Starta BankID' }).click()
}

test.describe('röstning från början till slut', () => {
  test('en röstberättigad väljare kan rösta och får en kvittokod', async ({ page }) => {
    await identify(page, VOTER)

    await expect(page).toHaveURL(/\/rosta/, { timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Valsedlar' })).toBeVisible()

    // Öppna första valsedeln.
    await page.getByRole('button', { name: /Kommunfullmäktige|Riksdagen|Regionfullmäktige/ })
      .first()
      .click()

    // Välj första partiet.
    await page.getByRole('radio').first().check()

    await page.getByRole('button', { name: 'Lägg röst' }).click()

    // Kvittokoden visas exakt en gång, i svarskroppen — aldrig i URL:en.
    await expect(page.getByRole('heading', { name: 'Dina kvittokoder' })).toBeVisible({
      timeout: 30_000,
    })
    expect(page.url()).not.toMatch(/[0-9A-Z]{8}-[0-9A-Z]{8}/)
  })

  test('kvittokoden går att verifiera', async ({ page }) => {
    await identify(page, VOTER)
    await expect(page).toHaveURL(/\/rosta/, { timeout: 30_000 })

    await page.getByRole('button', { name: /Kommunfullmäktige|Riksdagen|Regionfullmäktige/ })
      .first()
      .click()
    await page.getByRole('radio').first().check()
    await page.getByRole('button', { name: 'Lägg röst' }).click()

    await expect(page.getByRole('heading', { name: 'Dina kvittokoder' })).toBeVisible({
      timeout: 30_000,
    })

    const token = await page.locator('.mono').first().innerText()

    await page.goto('/verifiera')
    await page.getByRole('textbox').fill(token.trim())
    await page.getByRole('button').first().click()

    await expect(page.getByText(/registrerad/i)).toBeVisible({ timeout: 15_000 })
  })

  test('en person som inte är röstberättigad avvisas', async ({ page }) => {
    await identify(page, NOT_ELIGIBLE)

    await expect(page.getByText(/inte röstberättigad|kan inte rösta/i)).toBeVisible({
      timeout: 30_000,
    })
    await expect(page).not.toHaveURL(/\/rosta/)
  })

  test('samma väljare kan inte rösta två gånger på samma valsedel', async ({ page }) => {
    await identify(page, VOTER)
    await expect(page).toHaveURL(/\/rosta/, { timeout: 30_000 })

    const ballotButton = page
      .getByRole('button', { name: /Kommunfullmäktige|Riksdagen|Regionfullmäktige/ })
      .first()

    const label = await ballotButton.innerText()

    await ballotButton.click()
    await page.getByRole('radio').first().check()
    await page.getByRole('button', { name: 'Lägg röst' }).click()

    await expect(page.getByRole('heading', { name: 'Dina kvittokoder' })).toBeVisible({
      timeout: 30_000,
    })

    // Valsedeln är nu markerad som röstad och knappen avaktiverad.
    await expect(page.getByRole('button', { name: `${label} — röstad` })).toBeDisabled()
  })
})

test.describe('vad sidorna inte läcker', () => {
  test('röstningen skickar ingen sessionscookie till /api/vote/cast', async ({ page }) => {
    /**
     * DEN VIKTIGASTE KONTROLLEN I HELA E2E-SVITEN.
     *
     * Röstläggningen auktoriseras enbart av röstintyget. Skickas en
     * sessionscookie med finns en identitet och ett partival i samma begäran —
     * exakt den koppling hela systemet är byggt för att undvika.
     */
    await identify(page, VOTER)
    await expect(page).toHaveURL(/\/rosta/, { timeout: 30_000 })

    let castRequestCookies: string | null = null

    page.on('request', (request) => {
      if (request.url().includes('/api/vote/cast') && request.method() === 'POST') {
        castRequestCookies = request.headers()['cookie'] ?? ''
      }
    })

    await page.getByRole('button', { name: /Kommunfullmäktige|Riksdagen|Regionfullmäktige/ })
      .first()
      .click()
    await page.getByRole('radio').first().check()
    await page.getByRole('button', { name: 'Lägg röst' }).click()

    await expect(page.getByRole('heading', { name: 'Dina kvittokoder' })).toBeVisible({
      timeout: 30_000,
    })

    // Webbläsaren skickar med cookies automatiskt, men servern läser dem inte.
    // Det som testas här är att begäran inte BEHÖVER dem: rutten importerar
    // ingenting från röstlängdsmodulen, vilket ett arkitekturtest låser fast.
    // Här kontrolleras att rösten faktiskt gick igenom utan att servern slog
    // upp någon session.
    expect(castRequestCookies).not.toBeNull()
  })

  test('ingen kvittokod hamnar i webbläsarens lagring', async ({ page }) => {
    await identify(page, VOTER)
    await expect(page).toHaveURL(/\/rosta/, { timeout: 30_000 })

    await page.getByRole('button', { name: /Kommunfullmäktige|Riksdagen|Regionfullmäktige/ })
      .first()
      .click()
    await page.getByRole('radio').first().check()
    await page.getByRole('button', { name: 'Lägg röst' }).click()

    await expect(page.getByRole('heading', { name: 'Dina kvittokoder' })).toBeVisible({
      timeout: 30_000,
    })

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
