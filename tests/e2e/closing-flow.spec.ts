import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { DEMO_TRUSTEE_PASSPHRASES } from '../../src/lib/demo-election'
import { closeTimePassed, dropElection, partyIdsFor } from './db'
import { expect, test } from './fixtures'

/**
 * E2E: hela avslutningen på adminsidan, i demoläge (uppgift 12c).
 *
 * Två väljare röstar, administratören stänger och ser att valideringen
 * passerat, två förtroendepersoner lämnar sina demofraser och räkningen ger
 * rätt summor, slutkontrollen passerar och omröstningen fastställs. En fel fras
 * visar "fel fras" och räknas inte.
 *
 * TESTET SKAPAR SIN EGEN OMRÖSTNING och rör inte demovalet, som andra tester
 * röstar i. Omröstningen skapas med den väg administratören använder
 * (POST /api/admin/elections), med demofraserna som förtroendepersonernas
 * fraser, och tas bort efteråt. Stängningen vägrar före stängningstiden, så
 * tiden sätts till nu direkt i databasen när väljarna har röstat.
 *
 * SKÄRMDUMPAR. Är E2E_SCREENSHOT_DIR satt sparas sidan i fyra varianter (1280 och
 * 390 px, ljust och mörkt) vid några lägen i flödet. Utan variabeln sparas inget.
 */

const ADMIN = 'Alex — administratör'
const VOTERS = { first: 'Anna — röstberättigad', second: 'Kim — röstberättigad' }

async function adminLogin(page: Page) {
  await page.goto('/admin')
  await page.getByRole('button', { name: 'BankID på annan enhet' }).click()
  await expect(page.getByAltText('QR-kod för BankID')).toBeVisible()
  await page.getByRole('button', { name: ADMIN }).click()
  await expect(page.getByRole('heading', { name: 'Omröstning', exact: true })).toBeVisible({ timeout: 30_000 })
}

async function identify(page: Page, electionName: string, demoIdentity: string) {
  await page.goto('/identify')
  const electionSelect = page.getByLabel('Omröstning')
  await expect(electionSelect).toBeVisible()
  await electionSelect.selectOption({ label: electionName })
  await page.getByRole('button', { name: 'BankID på annan enhet' }).click()
  await expect(page.getByAltText('QR-kod för BankID')).toBeVisible()
  await page.getByRole('button', { name: demoIdentity }).click()
}

async function voteFor(page: Page, demoIdentity: string, party: string, ballotName: RegExp) {
  const ballot = page.getByRole('region', { name: ballotName })
  await ballot.getByRole('button', { name: /^(Rösta|Ändra din röst)$/ }).click()
  await ballot.getByRole('radio', { name: new RegExp(party) }).check()
  await ballot.getByRole('button', { name: 'Lägg rösten' }).click()
  await ballot.getByRole('button', { name: 'BankID på annan enhet' }).click()
  await expect(ballot.getByAltText('QR-kod för BankID')).toBeVisible()
  await ballot.getByRole('button', { name: demoIdentity }).click()
  await expect(ballot.getByText(/din nuvarande röst/i)).toContainText(party, { timeout: 60_000 })
}

/** Fyra skärmdumpar av läget, om katalogen är satt. */
async function shoot(page: Page, name: string, prefix = '12c') {
  const directory = process.env.E2E_SCREENSHOT_DIR
  if (!directory) return
  mkdirSync(directory, { recursive: true })

  const original = page.viewportSize()
  for (const width of [1280, 390]) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await page.screenshot({ path: `${directory}/${prefix}-${name}-${width}-${scheme}.png`, fullPage: true })
    }
  }
  await page.emulateMedia({ colorScheme: null })
  if (original) await page.setViewportSize(original)
}

/**
 * Verifieringssidan för en väljare (uppgift 13): legitimering för den valda
 * omröstningen, och sedan beskedet per valsedel.
 */
async function verifyAs(page: Page, electionName: string, demoIdentity: string) {
  await page.goto('/verify')
  const electionSelect = page.getByLabel('Omröstning')
  await expect(electionSelect).toBeVisible()
  await electionSelect.selectOption({ label: electionName })
  await page.getByRole('button', { name: 'BankID på annan enhet' }).click()
  await expect(page.getByAltText('QR-kod för BankID')).toBeVisible()
  await page.getByRole('button', { name: demoIdentity }).click()
  await expect(page.getByRole('heading', { name: electionName })).toBeVisible({ timeout: 30_000 })
}

/** Fasen sidan visar som den nuvarande, ur stegraden. */
function currentPhase(page: Page) {
  return page.getByRole('list', { name: 'Omröstningens faser' }).locator('[aria-current="step"] .phase-code')
}

test.describe('avslutningen på adminsidan', () => {
  test.describe.configure({ timeout: 360_000 })

  test('från två röster till en fastställd omröstning, och en fel fras räknas inte', async ({ browser, page }) => {
    const name = `E2E-avslutning ${Date.now()}`
    const ballotName = /Regionfullmäktige E2E/
    let electionId = ''

    try {
      // --- Omröstningen, skapad av en administratör --------------------------
      const [socialdemokraterna, moderaterna] = await partyIdsFor('S', 'M')
      const setup = await (await browser.newContext()).newPage()
      await adminLogin(setup)

      const cookies = await setup.context().cookies()
      const csrf = cookies.find((cookie) => cookie.name === 'valcsrf')?.value ?? ''
      const created = await setup.request.post('/api/admin/elections', {
        headers: { Origin: new URL(setup.url()).origin, 'X-CSRF-Token': csrf },
        data: {
          name,
          kind: 'RIKSDAGSVAL',
          opensAt: new Date(Date.now() - 3_600_000).toISOString(),
          closesAt: new Date(Date.now() + 3_600_000).toISOString(),
          ballots: [
            {
              kind: 'LANDSTING',
              label: 'Regionfullmäktige E2E',
              areaCode: '01',
              parties: [{ partyId: socialdemokraterna }, { partyId: moderaterna }],
            },
          ],
          trusteePassphrases: [...DEMO_TRUSTEE_PASSPHRASES],
        },
      })
      expect(created.status()).toBe(200)
      electionId = (await created.json()).election.id
      await setup.context().close()

      // --- Två väljare röstar ------------------------------------------------
      for (const [voter, party] of [
        [VOTERS.first, 'Socialdemokraterna'],
        [VOTERS.second, 'Moderaterna'],
      ] as const) {
        const voterPage = await (await browser.newContext()).newPage()
        await identify(voterPage, name, voter)
        await voteFor(voterPage, voter, party, ballotName)
        await voterPage.context().close()
      }

      await closeTimePassed(electionId)

      // --- Administratören ---------------------------------------------------
      await adminLogin(page)
      await page.getByLabel('Vilken omröstning gäller det?').selectOption({ label: name })

      await expect(currentPhase(page)).toHaveText('OPEN')
      await expect(page.getByText(/2 kuvert ligger i röstlängden/)).toBeVisible()

      // Bara nästa steg har en aktiv knapp.
      await expect(page.getByRole('button', { name: 'Stäng röstningen' })).toBeEnabled()
      await expect(page.getByRole('button', { name: 'Räkna', exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: 'Lämna bidrag' }).first()).toBeDisabled()
      await expect(page.getByRole('button', { name: 'Fastställ resultatet' })).toBeDisabled()
      await shoot(page, 'open')

      // Stängningen ber om en bekräftelse som säger att den inte går att ångra.
      await page.getByRole('button', { name: 'Stäng röstningen' }).click()
      await expect(page.getByText(/Det här går inte att ångra/)).toBeVisible()
      await page.getByRole('button', { name: 'Ja, stäng röstningen' }).click()

      await expect(page.getByText('Omröstningen är stängd. Kopplingen mellan väljare och röst är raderad.').first()).toBeVisible({
        timeout: 120_000,
      })
      await expect(currentPhase(page)).toHaveText('STRIPPED')
      await expect(page.getByText(/Godkända kuvert:\s*2\.\s*Underkända:\s*0/)).toBeVisible()
      await expect(page.getByText('Raderingen av kopplingen')).toBeVisible()

      // Ingenting per väljare: bara antal.
      await expect(page.getByText(/\b(Anna|Kim)\b/)).toHaveCount(0)

      // --- Räkningen ---------------------------------------------------------
      await expect(page.getByText(/2 av 3/).first()).toBeVisible()
      await expect(page.getByText(/Servern låser upp/)).toBeVisible()
      await shoot(page, 'stripped')

      const slot = (index: number) => page.getByRole('group', { name: `Förtroendeperson ${index}` })
      const phraseField = (index: number) => page.getByLabel(`Fras för förtroendeperson ${index}`)

      // En fel fras visar "fel fras" och räknas inte.
      await phraseField(2).fill('en-helt-felaktig-fras')
      await slot(2).getByRole('button', { name: 'Lämna bidrag' }).click()
      await expect(slot(2).getByText(/fel fras/i)).toBeVisible({ timeout: 60_000 })
      await expect(slot(2).getByText(/0 av 1 valsedlar/)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Räkna', exact: true })).toBeDisabled()

      // Förtroendeperson 1 med demofrasen. Räkna väntar på en till.
      await slot(1).getByRole('button', { name: 'Fyll i demofrasen' }).click()
      await expect(phraseField(1)).not.toHaveValue('')
      await slot(1).getByRole('button', { name: 'Lämna bidrag' }).click()
      await expect(slot(1).getByText(/Godkänd/)).toBeVisible({ timeout: 60_000 })
      await expect(slot(1).getByText(/1 av 1 valsedlar|alla 1 valsedlar/)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Räkna', exact: true })).toBeDisabled()

      // Förtroendeperson 2, nu med rätt fras.
      await slot(2).getByRole('button', { name: 'Fyll i demofrasen' }).click()
      await slot(2).getByRole('button', { name: 'Lämna bidrag' }).click()
      await expect(slot(2).getByText(/Godkänd/)).toBeVisible({ timeout: 60_000 })
      await expect(page.getByRole('button', { name: 'Räkna', exact: true })).toBeEnabled()
      await shoot(page, 'contributions')

      await page.getByRole('button', { name: 'Räkna', exact: true }).click()
      await expect(currentPhase(page)).toHaveText('TALLIED', { timeout: 60_000 })

      // Resultatet per valsedel: en röst vardera, summan två.
      const results = page.getByRole('region', { name: 'Resultat' })
      await expect(results.getByRole('heading', { name: 'Regionfullmäktige E2E' })).toBeVisible()
      await expect(results.getByRole('row', { name: /^Blankt\s+0$/ })).toBeVisible()
      await expect(results.getByRole('row', { name: /^Socialdemokraterna\s+1$/ })).toBeVisible()
      await expect(results.getByRole('row', { name: /^Moderaterna\s+1$/ })).toBeVisible()
      await expect(results.getByRole('row', { name: /^Summa\s+2$/ })).toBeVisible()

      // Resultatet finns kvar efter en omladdning: sidan läser det ur servern.
      // Omladdningen kräver ny inloggning, så den prövas mot rutten med sessionen.
      const cookiesNow = await page.context().cookies()
      const csrfNow = cookiesNow.find((cookie) => cookie.name === 'valcsrf')?.value ?? ''
      const again = await page.request.post('/api/admin/elections/results', {
        headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': csrfNow },
        data: { electionId },
      })
      expect(again.status()).toBe(200)
      expect((await again.json()).ballots[0].total).toBe(2)

      // --- Slutkontrollen och fastställandet --------------------------------
      await expect(page.getByRole('button', { name: 'Fastställ resultatet' })).toBeDisabled()
      await page.getByRole('button', { name: 'Kör slutkontrollen' }).click()
      await expect(page.getByText('Samtliga kontroller är godkända. Resultatet kan fastställas.')).toBeVisible({
        timeout: 120_000,
      })
      await expect(page.getByRole('button', { name: 'Fastställ resultatet' })).toBeEnabled()
      await shoot(page, 'checked')

      await page.getByRole('button', { name: 'Fastställ resultatet' }).click()
      await expect(page.getByText(/Fastställandet går inte att ångra/)).toBeVisible()
      await page.getByRole('button', { name: 'Ja, fastställ resultatet' }).click()

      await expect(currentPhase(page)).toHaveText('CERTIFIED', { timeout: 120_000 })
      await expect(page.getByRole('button', { name: 'Redan fastställt' })).toBeDisabled()
      await shoot(page, 'certified')

      // --- Publiceringen och det oberoende verktyget (uppgift 13) -----------
      const published = await page.request.get(`/api/observer/results?electionId=${electionId}`)
      expect(published.status()).toBe(200)
      const publication = await published.json()
      expect(publication.ballots[0].options.map((option: { count: number }) => option.count)).toEqual([0, 1, 1])
      expect(JSON.stringify(publication)).not.toMatch(/ciphertextHash/)

      // Verktyget läser samma adress som en granskare ger det, och importerar ingenting ur src.
      const toolOutput = execFileSync(
        process.execPath,
        [join(process.cwd(), 'tools/verify-election.mjs'), new URL(`/api/observer/results?electionId=${electionId}`, page.url()).href],
        { encoding: 'utf8' },
      )
      expect(toolOutput).toContain('dekrypteringen stämmer')

      // --- Verifieringssidan: att väljaren röstat, inte vad -------------------
      const voterPage = await (await browser.newContext()).newPage()
      await verifyAs(voterPage, name, VOTERS.first)
      const answer = voterPage.getByRole('list', { name: 'Valsedlar' })
      await expect(answer.getByText('Regionfullmäktige E2E')).toBeVisible()
      await expect(answer.getByText('Du har röstat.')).toBeVisible()
      // Inget om vad: varken partiet eller något som liknar en hash eller en tid.
      await expect(voterPage.getByText(/Socialdemokraterna|Moderaterna/)).toHaveCount(0)
      expect(await voterPage.locator('main').innerText()).not.toMatch(/[0-9a-f]{16}|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}/)
      await expect(voterPage.getByRole('link', { name: 'Det publicerade resultatet' })).toHaveAttribute(
        'href',
        `/api/observer/results?electionId=${electionId}`,
      )
      await expect(voterPage.getByText('node tools/verify-election.mjs', { exact: false })).toBeVisible()
      await shoot(voterPage, 'verify-voted', '13')
      for (const width of [1280, 390]) {
        await voterPage.setViewportSize({ width, height: 900 })
        const sideways = await voterPage.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        )
        expect(sideways, `verifieringssidan rullar i sidled vid ${width} px`).toBeLessThanOrEqual(0)
      }
      await voterPage.context().close()

      // Robin bor i regionen men röstade inte.
      const otherPage = await (await browser.newContext()).newPage()
      await verifyAs(otherPage, name, 'Robin — röstberättigad')
      await expect(otherPage.getByRole('list', { name: 'Valsedlar' }).getByText('Du har inte röstat.')).toBeVisible()
      await shoot(otherPage, 'verify-not-voted', '13')
      await otherPage.context().close()

      // Utan legitimering: valet av omröstning och BankID.
      const anonymous = await (await browser.newContext()).newPage()
      await anonymous.goto('/verify')
      await expect(anonymous.getByRole('button', { name: 'BankID på annan enhet' })).toBeVisible()
      await shoot(anonymous, 'verify-login', '13')
      await anonymous.context().close()

      // Sidan ska aldrig rulla i sidled.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
    } finally {
      if (electionId) await dropElection(electionId)
    }
  })
})
