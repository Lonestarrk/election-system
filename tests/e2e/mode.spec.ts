import { expect, test } from './fixtures'

/**
 * E2E: läget syns, och ingen väg byter det (uppgift 17).
 *
 * Sviten körs mot en server i demoläget, och banderollen ska då stå på varje
 * sida. Skarpt läge prövas i enhetstesterna och i uppstartsvakten: en server i
 * skarpt läge startar inte förrän en riktig BankID-klient finns (uppgift 17c).
 */

const ADMIN = 'Alex — administratör'

test.describe('banderollen i demoläge', () => {
  for (const path of ['/', '/verify', '/architecture', '/admin']) {
    test(`står på ${path}`, async ({ page }) => {
      await page.goto(path)
      await expect(page.getByTestId('mode-banner')).toHaveText('Demo, inte ett riktigt val. BankID är en attrapp.')
    })
  }

  test('ger ingen sidoskroll på en telefon', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto('/')
    const banner = page.getByTestId('mode-banner')
    await expect(banner).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})

test.describe('lägesrutterna', () => {
  test('/api/mode ger bara läget', async ({ request }) => {
    const response = await request.get('/api/mode')
    expect(response.status()).toBe(200)
    expect(await response.json()).toEqual({ mode: 'DEMO' })
  })

  test('checklistan kräver adminsessionen', async ({ request }) => {
    const response = await request.get('/api/admin/mode')
    expect(response.status()).toBe(401)
    expect(JSON.stringify(await response.json())).not.toMatch(/bankid-real|requirements/)
  })

  test('ingen rutt tar emot ett nytt läge', async ({ request, baseURL }) => {
    for (const path of ['/api/mode', '/api/admin/mode']) {
      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        const response = await request[method](path, {
          headers: { origin: baseURL! },
          data: { mode: 'SHARP', demoMode: false },
        })
        expect(response.status(), `${method} ${path}`).toBe(405)
      }
    }
    // Läget är oförändrat.
    expect(await (await request.get('/api/mode')).json()).toEqual({ mode: 'DEMO' })
  })
})

test.describe('lägeskortet på adminsidan', () => {
  test('visar läget, BankID, checklistan och att läget inte kan ändras där', async ({ page }) => {
    await page.goto('/admin')
    await page.getByRole('button', { name: 'BankID på annan enhet' }).click()
    await expect(page.getByAltText('QR-kod för BankID')).toBeVisible()
    await page.getByRole('button', { name: ADMIN }).click()

    const card = page.locator('.mode-card')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText('Demoläge')
    await expect(card).toContainText('BankID: attrappen')
    await expect(card).toContainText('bankid-real')
    await expect(card).toContainText('Vad som saknas för skarpt läge')
    await expect(card).toContainText('Läget sätts vid driftsättning och kan inte ändras här.')

    // Kortet kommer före omröstningen, och har ingen knapp.
    await expect(card.getByRole('button')).toHaveCount(0)
    const cardBox = (await card.boundingBox())!
    const electionBox = (await page.getByRole('heading', { name: 'Omröstning' }).boundingBox())!
    expect(cardBox.y).toBeLessThan(electionBox.y)

    // Servern svarar med samma checklista, nu med sessionen.
    const response = await page.request.get('/api/admin/mode')
    expect(response.status()).toBe(200)
    const body = (await response.json()) as { mode: string; requirements: Array<{ id: string; blocking: boolean }> }
    expect(body.mode).toBe('DEMO')
    expect(body.requirements.find((requirement) => requirement.id === 'bankid-real')?.blocking).toBe(true)
  })
})
