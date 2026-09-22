import { expect, test } from './fixtures'

/**
 * E2E: adminens slutverifiering och den oberoende granskningen.
 *
 * Det som prövas här är inte att knapparna finns, utan att spärrarna håller:
 * att observatörsgränssnittet ger allt som krävs för att verifiera valet utan
 * inloggning, och att fastställandet inte går att tvinga fram.
 */

// Etiketter på demoknapparna, inte personnummer: BankID v6 har ingen
// inmatningsruta för personnummer.
const ADMIN = 'Alex — administratör'
const NOT_ADMIN = 'Anna — vanlig väljare'

/** Startar adminlegitimering via QR-flödet och "skannar" som angiven person. */
async function adminLogin(page: import('@playwright/test').Page, demoIdentity: string) {
  await page.goto('/admin')
  await page.getByRole('button', { name: 'BankID på annan enhet' }).click()
  await expect(page.getByAltText('QR-kod för BankID')).toBeVisible()
  await page.getByRole('button', { name: demoIdentity }).click()
}

test.describe('observatörsgränssnittet', () => {
  test('ger hela röstunderlaget utan inloggning', async ({ request, baseURL }) => {
    const list = await request.post(`${baseURL}/api/observer/election`, {
      data: {},
      headers: { Origin: baseURL! },
    })

    expect(list.ok()).toBe(true)
    const elections = (await list.json()).elections
    expect(elections.length).toBeGreaterThan(0)

    const electionId = elections.find(
      (election: { name: string }) => election.name === 'Valet 2026',
    ).id

    const detail = await request.post(`${baseURL}/api/observer/election`, {
      data: { electionId },
      headers: { Origin: baseURL! },
    })

    expect(detail.ok()).toBe(true)
    const data = await detail.json()

    // Det observatören behöver för att kunna verifiera själv.
    expect(data.ballots.length).toBeGreaterThan(0)
    for (const ballot of data.ballots) {
      expect(ballot.signingPublicKeyPem).toContain('BEGIN PUBLIC KEY')
    }
    expect(data.approvedVotings).toBeDefined()
    expect(data.currentRoot.root).toMatch(/^[0-9a-f]{64}$/)
    expect(data.howToVerify).toBeDefined()
  })

  test('röstunderlaget innehåller ingenting som pekar mot en person', async ({
    request,
    baseURL,
  }) => {
    const list = await request.post(`${baseURL}/api/observer/election`, {
      data: {},
      headers: { Origin: baseURL! },
    })
    const electionId = (await list.json()).elections.find(
      (election: { name: string }) => election.name === 'Valet 2026',
    ).id

    const response = await request.post(`${baseURL}/api/observer/votes`, {
      data: { electionId },
      headers: { Origin: baseURL! },
    })

    expect(response.ok()).toBe(true)
    const body = await response.json()

    const serialised = JSON.stringify(body)

    // Ingen identitet, inget sessionsspår, ingen tidsstämpel att sortera på.
    for (const forbidden of [
      'personalNumber',
      'personnummer',
      'externalIdentityHash',
      'voterStatusId',
      'sessionId',
      'createdAt',
      'votedAt',
    ]) {
      expect(serialised, `underlaget innehåller ${forbidden}`).not.toContain(forbidden)
    }

    for (const vote of body.votes) {
      // Varje röst har det som krävs för att verifieras — och ingenting mer.
      expect(Object.keys(vote).sort()).toEqual([
        'ballotId',
        'ballotPartyId',
        'canonical',
        'candidateId',
        'credentialId',
        'credentialSignature',
        'optionId',
        'tokenHash',
      ])
    }
  })

  test('kräver ingen inloggning men avvisar främmande ursprung', async ({ request, baseURL }) => {
    const response = await request.post(`${baseURL}/api/observer/election`, {
      data: {},
      headers: { Origin: 'https://angripare.example' },
    })

    expect(response.status()).toBe(403)
  })
})

test.describe('adminens slutverifiering', () => {
  test('en icke-administratör släpps inte in', async ({ page }) => {
    await adminLogin(page, NOT_ADMIN)

    // .first(): meddelandet renderas både som statusrad och i avvisningskortet,
    // så en omodifierad lokator matchar två element.
    await expect(page.getByText(/inte behörighet/i).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Slutkontroll' })).toHaveCount(0)
  })

  test('administratören ser hela kontrollrapporten före fastställandet', async ({ page }) => {
    await adminLogin(page, ADMIN)

    await expect(page.getByRole('heading', { name: 'Omröstning' })).toBeVisible({
      timeout: 30_000,
    })

    await page.getByRole('combobox').selectOption({ label: 'Valet 2026' })
    await page.getByRole('button', { name: 'Kör slutkontroll' }).click()

    await expect(page.getByRole('heading', { name: /Slutkontroll/ })).toBeVisible({
      timeout: 30_000,
    })

    // Varje kontroll redovisas med sin fråga i klartext, inte bara ett utfall.
    await expect(
      page.getByText('Motsvarar varje godkänd röstning exakt en registrerad röst?'),
    ).toBeVisible()
    await expect(
      page.getByText('Har varje registrerad röst skapats genom den auktoriserade processen?'),
    ).toBeVisible()
  })

  test('fastställandet går inte att tvinga fram med extra parametrar', async ({
    page,
    request,
    baseURL,
  }) => {
    /**
     * DET HÄR ÄR KRAVET "administratören ska inte kunna kringgå en kritisk
     * säkerhetskontroll", prövat direkt mot API:t i stället för mot knappen.
     *
     * En omröstning som fortfarande är öppen får inte fastställas. Försöket
     * nedan skickar med varje tänkbar flagga för att tvinga igenom det.
     */
    await adminLogin(page, ADMIN)
    await expect(page.getByRole('heading', { name: 'Omröstning' })).toBeVisible({
      timeout: 30_000,
    })

    const cookies = await page.context().cookies()
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    const csrf = cookies.find((cookie) => cookie.name === 'valcsrf')?.value ?? ''

    const list = await request.post(`${baseURL}/api/observer/election`, {
      data: {},
      headers: { Origin: baseURL! },
    })
    const electionId = (await list.json()).elections.find(
      (election: { name: string }) => election.name === 'Valet 2026',
    ).id

    const response = await request.post(`${baseURL}/api/admin/elections/certify`, {
      data: {
        electionId,
        // Inget av detta finns i schemat, och inget av det ska ha någon effekt.
        force: true,
        skipChecks: true,
        override: ['election_closed', 'matches_commitment'],
        canCertify: true,
      },
      headers: { Origin: baseURL!, Cookie: cookieHeader, 'X-CSRF-Token': csrf },
    })

    // Antingen avvisas begäran som ogiltig indata, eller så körs kontrollen och
    // blockerar. Aldrig fastställd.
    const body = await response.json()
    expect(body.status).not.toBe('certified')
  })
})
