import type { Page } from '@playwright/test'
import { DEMO_TRUSTEE_PASSPHRASES } from '../../src/lib/demo-election'
import { dropElection } from './db'
import { expect, test } from './fixtures'

/**
 * E2E: en fråga i en allmän omröstning, i en riktig webbläsare (uppgift 14c).
 *
 * Det som bara går att pröva här: att röstsidan bygger samma kanoniska
 * alternativlista som servern för en fråga (blankt, sedan svaren), krypterar den i
 * webbläsaren, och att servern tar emot bevisen och lägger kuvertet. Räkningen
 * och publiceringen prövas i tests/integration/question-ballot.test.ts.
 *
 * TESTET SKAPAR SIN EGEN OMRÖSTNING, på samma väg som administratören, och
 * tar bort den efteråt. Demovalet rörs inte.
 */

const ADMIN = 'Alex — administratör'
const VOTER = 'Anna — röstberättigad'
const QUESTION = 'Ska kommunen bygga ett nytt bibliotek?'

async function adminLogin(page: Page) {
  await page.goto('/admin')
  await page.getByRole('button', { name: 'BankID på annan enhet' }).click()
  await expect(page.getByAltText('QR-kod för BankID')).toBeVisible()
  await page.getByRole('button', { name: ADMIN }).click()
  await expect(page.getByRole('heading', { name: 'Omröstning', exact: true })).toBeVisible({ timeout: 30_000 })
}

async function chooseElection(page: Page, path: '/identify' | '/verify', electionName: string) {
  await page.goto(path)
  const electionSelect = page.getByLabel('Omröstning')
  await expect(electionSelect).toBeVisible()
  await electionSelect.selectOption({ label: electionName })
  await page.getByRole('button', { name: 'BankID på annan enhet' }).click()
  await expect(page.getByAltText('QR-kod för BankID')).toBeVisible()
  await page.getByRole('button', { name: VOTER }).click()
}

async function answer(page: Page, region: RegExp, option: string) {
  const ballot = page.getByRole('region', { name: region })
  await ballot.getByRole('button', { name: /^(Rösta|Ändra din röst)$/ }).click()
  await ballot.getByRole('radio', { name: option, exact: true }).check()
  await ballot.getByRole('button', { name: 'Lägg rösten' }).click()
  await ballot.getByRole('button', { name: 'BankID på annan enhet' }).click()
  await expect(ballot.getByAltText('QR-kod för BankID')).toBeVisible()
  await ballot.getByRole('button', { name: VOTER }).click()
  await expect(ballot.getByText(/din nuvarande röst/i)).toContainText(option, { timeout: 60_000 })
}

test.describe('en fråga i en allmän omröstning', () => {
  test.describe.configure({ timeout: 240_000 })

  test('en väljare svarar på frågan, ändrar sig till blankt, och verifieringssidan ser att hon röstat', async ({
    browser,
    page,
  }) => {
    const name = `E2E-fråga ${Date.now()}`
    let electionId = ''

    try {
      const setup = await (await browser.newContext()).newPage()
      await adminLogin(setup)
      const cookies = await setup.context().cookies()
      const csrf = cookies.find((cookie) => cookie.name === 'valcsrf')?.value ?? ''
      const created = await setup.request.post('/api/admin/elections', {
        headers: { Origin: new URL(setup.url()).origin, 'X-CSRF-Token': csrf },
        data: {
          name,
          kind: 'ALLMAN_OMROSTNING',
          opensAt: new Date(Date.now() - 3_600_000).toISOString(),
          closesAt: new Date(Date.now() + 3_600_000).toISOString(),
          ballots: [{ kind: 'FRAGA', label: QUESTION, options: ['Ja', 'Nej'] }],
          trusteePassphrases: [...DEMO_TRUSTEE_PASSPHRASES],
        },
      })
      expect(created.status()).toBe(200)
      electionId = (await created.json()).election.id
      await setup.context().close()

      await chooseElection(page, '/identify', name)
      const region = /Ska kommunen bygga/
      await expect(page.getByRole('heading', { name: region })).toBeVisible()
      // Inget meddelande om att frågor inte stöds.
      await expect(page.getByText(/kan inte ta emot en röst/)).toHaveCount(0)

      await answer(page, region, 'Ja')
      await expect(page.getByText(/kan ändra/i)).toBeVisible()

      // Blankt är ett alternativ som alla andra, och ändringen går lika lätt.
      await answer(page, region, 'Blankt')

      const verifier = await (await browser.newContext()).newPage()
      await chooseElection(verifier, '/verify', name)
      await expect(verifier.getByRole('heading', { name })).toBeVisible({ timeout: 30_000 })
      await expect(verifier.getByText('Du har röstat.')).toBeVisible()
      // Servern vet inte vad, och sidan säger det inte.
      await expect(verifier.getByText('Blankt')).toHaveCount(0)
      await verifier.context().close()
    } finally {
      if (electionId) await dropElection(electionId)
    }
  })
})
