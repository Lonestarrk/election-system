import { expect, test } from './fixtures'

/**
 * E2E: återvändsgränder i legitimeringen.
 *
 * TESTERNA HÄR FÅNGAR FEL SOM INTE SYNS SOM FEL.
 *
 * Båda sakerna nedan var trasiga utan att någonting kastade, loggade eller
 * returnerade en felkod. Servern svarade 200, klienten renderade, inget test
 * gick rött — och en väljare som tryckte på knappen fick ingenting att hända.
 * Det är den sortens fel bara en riktig webbläsare hittar.
 *
 * VARFÖR ANROPET AVLYSSNAS I STÄLLET FÖR ATT DATABASEN ÄNDRAS
 *
 * Det som var trasigt var rendringsbeslutet vid ett tomt svar, inte
 * databasfrågan. Att stänga omröstningen i databasen skulle pröva samma sak
 * omvägen, kräva städning efteråt, och lämna sviten i ett trasigt läge om
 * testet fallerar mitt i. Regeln för vad som räknas som öppet vaktas där den
 * avgörs, i tests/integration/open-elections.test.ts.
 */

test.describe('när ingen omröstning är öppen', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/elections', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ elections: [] }),
      })
    })
  })

  test('säger det rakt ut i stället för att visa en tom rullgardin', async ({ page }) => {
    await page.goto('/legitimera')

    await expect(page.getByText('Ingen omröstning är öppen just nu.')).toBeVisible()

    // Rullgardinen ska inte finnas alls. Tidigare låg beskedet som ett
    // alternativ INUTI den, vilket är lätt att missa och inte förklarar
    // varför ingenting händer när man trycker vidare.
    await expect(page.getByLabel('Omröstning')).toHaveCount(0)
  })

  test('erbjuder inte BankID-knappar som ändå inte kan göra något', async ({ page }) => {
    /**
     * DET HÄR VAR FELET.
     *
     * Knapparna visades, och `canStart` svarade "Välj vilken omröstning du
     * vill rösta i." Men den första omröstningen väljs automatiskt så snart
     * listan har något i sig, så meddelandet kunde bara uppstå när det inte
     * fanns något att välja. Uppmaningen var alltså omöjlig att följa i exakt
     * det läge där den gavs.
     */
    await page.goto('/legitimera')

    await expect(page.getByRole('button', { name: 'BankID på denna enhet' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'BankID på annan enhet' })).toHaveCount(0)
  })

  test('den omöjliga uppmaningen finns inte kvar någonstans på sidan', async ({ page }) => {
    await page.goto('/legitimera')

    await expect(page.getByText(/Välj vilken omröstning du vill rösta i/)).toHaveCount(0)
  })

  test('hänvisar till seedningen, eftersom det nästan alltid är orsaken', async ({ page }) => {
    // I en demomiljö beror tomt läge på att demodatan saknas eller gått ut.
    // Att säga det sparar den felsökningsrunda som började i gränssnittet.
    await page.goto('/legitimera')

    await expect(page.getByText('npm run seed')).toBeVisible()
  })
})

test.describe('när en omröstning är öppen', () => {
  test('då finns både rullgardinen och knapparna', async ({ page }) => {
    // Kontrasten mot ovan. Utan det här testet kunde ett villkor som alltid
    // är falskt passera de fyra föregående.
    await page.goto('/legitimera')

    await expect(page.getByLabel('Omröstning')).toBeVisible()
    await expect(page.getByRole('button', { name: 'BankID på denna enhet' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'BankID på annan enhet' })).toBeVisible()
  })
})

test.describe('BankID på denna enhet', () => {
  test('erbjuder en knapp som öppnar appen, inte en tyst automatisk navigering', async ({
    page,
  }) => {
    /**
     * Här låg en navigering till bankid:// direkt efter `await post(...)`.
     * Gesten från knapptrycket var då förbrukad, och en webbläsare följer
     * inte ett app-schema utan användaraktivering. En blockerad
     * schemanavigering kastar ingenting, så ingenting hände — tyst.
     *
     * Token kan inte finnas före serveranropet, så gesten går inte att
     * bevara. Öppningen måste därför ligga på en egen knapp, vars tryck ÄR en
     * gest. Testet vaktar att den knappen finns kvar: återinförs den
     * automatiska navigeringen och knappen tas bort går det här rött.
     */
    await page.goto('/legitimera')
    await page.getByRole('button', { name: 'BankID på denna enhet' }).click()

    await expect(page.getByRole('button', { name: 'Öppna BankID' })).toBeVisible()
  })

  test('säger i demoläget att appen kommer att avvisa token', async ({ page }) => {
    // Utan det beskedet ser en misslyckad öppning ut som en bugg i appen, och
    // inte som den förväntade följden av att ingen order finns hos BankID.
    await page.goto('/legitimera')
    await page.getByRole('button', { name: 'BankID på denna enhet' }).click()

    await expect(page.getByText(/ingen order registrerad hos BankID/)).toBeVisible()
  })
})
