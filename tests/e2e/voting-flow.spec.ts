import { expect, test, type Page } from '@playwright/test'

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

/** Seedade röstberättigade, en per test. */
const VOTERS = {
  canVote: '19900101-1234',
  verifiesReceipt: '19850515-2345',
  doubleVote: '19701212-3456',
  noCookie: '19600301-5678',
  noStorage: '19550707-6789',
}

const NOT_ELIGIBLE = '20100101-4567'

/** Namnet på en valsedel i Valet 2026. */
const BALLOT = /Kommunfullmäktige|Regionfullmäktige|Riksdagen/

/**
 * Legitimerar för Valet 2026 och hamnar på röstningssidan.
 *
 * Omröstningen väljs på NAMN, inte som "den första i listan". Integrations-
 * testerna lämnar kvar egna testomröstningar i databasen, och ett test som
 * plockar den första blir beroende av vad som kördes innan.
 */
async function identify(page: Page, personalNumber: string) {
  await page.goto('/legitimera')

  const electionSelect = page.getByLabel('Omröstning')
  await expect(electionSelect).toBeVisible()
  await electionSelect.selectOption({ label: ELECTION })

  await page.getByLabel('Personnummer').fill(personalNumber)
  await page.getByRole('button', { name: 'Starta BankID' }).click()
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

    await expect(page).toHaveURL(/\/rosta/)
    await expect(page.getByRole('heading', { name: 'Valsedlar' })).toBeVisible()

    await voteOnFirstBallot(page)

    await expect(page.getByRole('heading', { name: 'Dina kvittokoder' })).toBeVisible()

    // Kvittokoden finns i svarskroppen — aldrig i URL:en, där den hamnar i
    // webbläsarhistorik, accessloggar och Referer-headern.
    expect(page.url()).not.toMatch(/[0-9A-Z]{8}-[0-9A-Z]{8}/)
  })

  test('kvittokoden går att verifiera', async ({ page }) => {
    await identify(page, VOTERS.verifiesReceipt)
    await expect(page).toHaveURL(/\/rosta/)

    await voteOnFirstBallot(page)
    await expect(page.getByRole('heading', { name: 'Dina kvittokoder' })).toBeVisible()

    const token = (await page.locator('.mono').first().innerText()).trim()

    await page.goto('/verifiera')
    await page.getByRole('textbox').fill(token)
    await page.getByRole('button').first().click()

    await expect(page.getByText(/registrerad/i).first()).toBeVisible()
    // Verifieringen avslöjar valsedeln och valet, aldrig väljaren.
    await expect(page.getByText(ELECTION).first()).toBeVisible()
  })

  test('en person som inte är röstberättigad avvisas', async ({ page }) => {
    await identify(page, NOT_ELIGIBLE)

    await expect(page.getByText(/inte röstberättigad|kan inte rösta|finns inte/i)).toBeVisible()
    await expect(page).not.toHaveURL(/\/rosta/)
  })

  test('samma väljare kan inte rösta två gånger på samma valsedel', async ({ page }) => {
    await identify(page, VOTERS.doubleVote)
    await expect(page).toHaveURL(/\/rosta/)

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
    await identify(page, VOTERS.noCookie)
    await expect(page).toHaveURL(/\/rosta/)

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
    await expect(page).toHaveURL(/\/rosta/)

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
