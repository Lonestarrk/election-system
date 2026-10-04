import { expect, test } from './fixtures'

/**
 * E2E: API-dokumentationen laddar i en riktig webbläsare, under CSP:n.
 *
 * Ett skript som CSP:n blockerar syns inte som ett fel i bygget, och sidan renderas ändå som en
 * tom ruta. Därför öppnas sidan på riktigt, och varje överträdelse av policyn räknas. Mot ett
 * produktionsbygge, som saknar 'unsafe-eval', är det här beviset för att Swagger UI inte behöver
 * något policyn förbjuder. Mot dev-servern, som tillåter eval, visar det bara att sidan renderar.
 */
test('dokumentationen renderas ur specen utan att policyn stoppar något', async ({ page, baseURL }) => {
  const violations: string[] = []
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text())
  })
  page.on('pageerror', (error) => violations.push(error.message))
  const foreign: string[] = []
  page.on('request', (request) => {
    // Inga anrop till något annat än appen själv.
    const url = new URL(request.url())
    if (url.protocol.startsWith('http') && url.origin !== new URL(baseURL!).origin) foreign.push(request.url())
  })

  await page.goto('/api-docs')

  await expect(page.getByTestId('api-docs').locator('.swagger-ui .info')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('/api/vote/compare').first()).toBeVisible()
  await expect(page.getByText('/api/admin/elections/close').first()).toBeVisible()

  expect(violations).toEqual([])
  expect(foreign).toEqual([])
})

test('sidan erbjuder inga anrop', async ({ page }) => {
  await page.goto('/api-docs')
  await expect(page.getByTestId('api-docs').locator('.swagger-ui .info')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: /try it out/i })).toHaveCount(0)
})
