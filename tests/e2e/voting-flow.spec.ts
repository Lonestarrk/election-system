import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

/**
 * E2E: röstsidan i kuvertmodellen, i en riktig webbläsare.
 *
 * Det avgörande som bara går att pröva här: att valsedeln faktiskt krypteras
 * med BigInt i webbläsaren, att bevisen den bygger godkänns av servern, och
 * att underskriften i BankID går hela vägen till ett liggande kuvert. Ett fel
 * i buntningen eller i webbläsarens kryptering syns inte i något annat test.
 * Det har redan hänt en gång: klientmodulen importerade node:crypto, och
 * röstsidan gick inte att bygga, med alla andra tester gröna.
 *
 * Spec 3.1 styr vad sidan visar: den nuvarande rösten på enheten som lade
 * den, att rösten kan ändras, att det enheten visar inte är ett bevis, och
 * ingen kod.
 *
 * VARJE TEST HAR SIN EGEN VÄLJARE, NÄR DET GÅR.
 *
 * Testerna körs seriellt mot samma databas och återställer den inte emellan.
 * En väljare som redan har ett liggande kuvert visar "Du har en röst
 * registrerad" i stället för en orörd valsedel, så ett test som delade väljare
 * med ett annat skulle bero på ordningen. Där två tester delar en väljare
 * klarar båda att kuvertet redan finns.
 */

const ELECTION = 'Valet 2026'

/**
 * Demoidentiteter, angivna med den ETIKETT knappen har — inte med personnummer.
 *
 * BankID v6 tillåter inte att användaren skriver in sitt personnummer, så det
 * finns ingen inmatningsruta att fylla i. Testet klickar på den knapp som står
 * för "den här personen skannade QR-koden", och personnumret existerar bara
 * inuti attrappen. Samma knapp står för underskriften av rösten.
 */
const VOTERS = {
  canVote: 'Anna — röstberättigad',
  verifiesReceipt: 'Kim — röstberättigad',
  doubleVote: 'Robin — röstberättigad',
  oldRoutes: 'Charlie — röstberättigad',
  noStorage: 'Mira — röstberättigad',
  /**
   * Samma väljare som ovan, på en annan valsedel. Noa lämnas med flit orörd
   * av sviten, så att det efter en körning finns en röstberättigad väljare med
   * tre orörda valsedlar att visa röstsidan med.
   */
  personalVote: 'Charlie — röstberättigad',
}

const NOT_ELIGIBLE = 'Elis — ej röstberättigad'
const OTHER_MUNICIPALITY = 'Gunvor — annan kommun'

/**
 * Valsedeln testerna röstar på, om inget annat sägs.
 *
 * Regionvalsedeln har nio alternativ och tar några sekunder att kryptera i
 * webbläsaren och att verifiera på servern. Riksdagsvalsedeln med personröst
 * har tjugosex och tar flera gånger så lång tid; den prövas i ett eget test.
 *
 * Inte kommunvalsedeln, som var den det gamla flödets tester röstade på. En
 * databas som inte nollställts sedan dess bär det gamla flödets markering där,
 * och den valsedeln går då med rätta inte att rösta på.
 */
const BALLOT = /Regionfullmäktige/

/** Vem som legitimerat sig på en sida, så att samma person skriver under rösten. */
const signers = new WeakMap<Page, string>()

/**
 * Legitimerar för Valet 2026 och hamnar på röstsidan.
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
  signers.set(page, demoIdentity)
}

/**
 * Röstar på ett parti och väntar tills sidan visar rösten som den nuvarande.
 *
 * Samma väg vare sig väljaren röstar första gången eller ändrar sig, och det
 * är poängen: ändringen ska vara lika lätt som den första rösten.
 */
async function voteFor(page: Page, party: string, ballotName: RegExp = BALLOT) {
  const ballot = page.getByRole('region', { name: ballotName })

  await ballot.getByRole('button', { name: /^(Rösta|Ändra din röst)$/ }).click()
  await ballot.getByRole('radio', { name: new RegExp(party) }).check()
  await ballot.getByRole('button', { name: 'Lägg rösten' }).click()

  // Rösten låses i webbläsaren och skrivs sedan under, i samma mönster som
  // legitimeringen. Knappen finns först när låsningen är klar.
  await ballot.getByRole('button', { name: 'BankID på annan enhet' }).click()
  await expect(ballot.getByAltText('QR-kod för BankID')).toBeVisible()
  await ballot.getByRole('button', { name: signers.get(page)! }).click()

  // Servern kontrollerar varje bevis innan rösten läggs, och det tar tid.
  await expect(ballot.getByText(/din nuvarande röst/i)).toContainText(party, { timeout: 60_000 })
}

test.describe('röstning från början till slut', () => {
  test.describe.configure({ timeout: 180_000 })

  test('en väljare kan ändra sin röst, och enheten visar den nya', async ({ page }) => {
    // Hela skyddet mot röstköp. Kan rösten inte ändras är en köpt röst köpt.
    await identify(page, VOTERS.canVote)
    await voteFor(page, 'Socialdemokraterna')
    await expect(page.getByText(/din nuvarande röst/i)).toContainText('Socialdemokraterna')
    await expect(page.getByText(/kan ändra/i)).toBeVisible()

    await voteFor(page, 'Moderaterna')
    await expect(page.getByText(/din nuvarande röst/i)).toContainText('Moderaterna')
  })

  test('en annan enhet ser att rösten finns, men inte vad den innehåller', async ({ browser }) => {
    // Innehållet finns bara där rösten lades. Servern vet det inte.
    const here = await browser.newPage()
    await identify(here, VOTERS.verifiesReceipt)
    await voteFor(here, 'Moderaterna')

    const elsewhere = await (await browser.newContext()).newPage()
    await identify(elsewhere, VOTERS.verifiesReceipt)
    await expect(elsewhere.getByText(/du har en röst registrerad/i)).toBeVisible()
    await expect(elsewhere.getByText('Moderaterna')).toHaveCount(0)

    await here.context().close()
    await elsewhere.context().close()
  })

  test('en röst ändrad från en annan enhet visas inte längre på den första', async ({ browser }) => {
    const first = await browser.newPage()
    await identify(first, VOTERS.doubleVote)
    await voteFor(first, 'Centerpartiet')

    const second = await (await browser.newContext()).newPage()
    await identify(second, VOTERS.doubleVote)
    await voteFor(second, 'Liberalerna')

    /**
     * EN VÄLJARE HAR EN SESSION I TAGET.
     *
     * Legitimeringen på den andra enheten raderade den första enhetens
     * session (createVotingSession), så en omladdning där säger att sessionen
     * upphört. Den första enheten legitimerar sig igen, som en väljare som
     * kommer tillbaka till sin dator, och det är då den ska se att rösten
     * ändrats.
     */
    await first.reload()
    await expect(first.getByText(/röstsession har upphört/i)).toBeVisible()
    await identify(first, VOTERS.doubleVote)

    await expect(first.getByText(/ändrats från en annan enhet/i)).toBeVisible()
    await expect(first.getByText('Centerpartiet')).toHaveCount(0)

    await first.context().close()
    await second.context().close()
  })

  test('en personröst på riksdagsvalsedeln går hela vägen', async ({ page }) => {
    /**
     * Den tyngsta valsedeln: tjugosex alternativ med kandidaterna. Den prövar
     * att sidans kanoniska alternativlista, byggd ur partiernas och
     * kandidaternas ordning, är densamma som serverns, och att sidan visar
     * hur långt låsningen kommit i stället för att se låst ut.
     */
    await identify(page, VOTERS.personalVote)
    const ballot = page.getByRole('region', { name: /Riksdagen/ })

    await ballot.getByRole('button', { name: /^(Rösta|Ändra din röst)$/ }).click()
    await ballot.getByRole('radio', { name: /Kristdemokraterna/ }).check()
    await ballot.getByRole('radio', { name: 'Ingrid Sundqvist' }).check()
    await ballot.getByRole('button', { name: 'Lägg rösten' }).click()

    await expect(ballot.getByRole('progressbar')).toBeVisible()

    await ballot.getByRole('button', { name: 'BankID på annan enhet' }).click()
    await expect(ballot.getByAltText('QR-kod för BankID')).toBeVisible()
    await ballot.getByRole('button', { name: VOTERS.personalVote }).click()

    await expect(ballot.getByText(/din nuvarande röst/i)).toContainText(
      'Kristdemokraterna, personröst på Ingrid Sundqvist',
      { timeout: 90_000 },
    )
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
    // Kommunvalsedeln gäller bara den som är folkbokförd i kommunen. Seeden
    // har bara Stockholms, och Gunvor bor i en annan kommun.
    await identify(page, OTHER_MUNICIPALITY)

    await expect(page).toHaveURL(/\/vote/)
    // Riksdagen först: en räkning till noll innan sidan laddat vore alltid sann.
    await expect(page.getByRole('heading', { name: /Riksdagen/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: /Kommunfullmäktige/ })).toHaveCount(0)
  })

  /**
   * TVÅ TESTER UR DET GAMLA FLÖDET ÄR BORTTAGNA, OCH SKÄLET ÄR ATT DERAS
   * EGENSKAPER INTE LÄNGRE ÄR SANNA.
   *
   * "Samma väljare kan inte rösta två gånger på samma valsedel": i
   * kuvertmodellen ersätter en ny röst den förra fram till stängningen. Det är
   * skyddet mot röstköp, och testet ovan om att ändra rösten kräver motsatsen.
   *
   * "Röstläggningen sker utan att servern slår upp någon session": det yttre
   * kuvertet bär väljarens id och hennes underskrift med avsikt, så att rösten
   * kan bytas ut. Kopplingen raderas vid stängningen i stället (spec 2).
   */
})

test.describe('vad sidorna inte läcker', () => {
  test.describe.configure({ timeout: 180_000 })

  test('signaturen begärs av BankID, inte av sidan', async ({ page }) => {
    // Sidan får inte konstruera något som liknar ett kuvert. Den startar en
    // signering och pollar; allt som signeras byggs av servern.
    const bodies: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/vote/encrypted')) bodies.push(request.postData() ?? '')
    })

    await identify(page, VOTERS.doubleVote)
    await voteFor(page, 'Centerpartiet')

    for (const body of bodies) {
      expect(body).not.toMatch(/signature|certificate|castSequence/)
    }
  })

  test('ingen verifikationskod visas och inget slumptal sparas', async ({ page }) => {
    await identify(page, VOTERS.canVote)
    await voteFor(page, 'Socialdemokraterna')

    // En 64-teckens hex på skärmen vore ett handtag en köpare kan anteckna.
    await expect(page.locator('body')).not.toContainText(/[0-9a-f]{64}/)

    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }))
    expect(stored).not.toMatch(/random|slump|nonce|token/i)

    // Inte heller i adressfältet, där den hamnar i historik och loggar.
    expect(page.url()).not.toMatch(/[0-9a-f]{64}/)
  })

  test('enheten sparar valet och chifferhashen, aldrig slumptalet och aldrig en token', async ({
    page,
  }) => {
    /**
     * Lagringen innehåller avsiktligt valet och chifferhashen: det är så
     * enheten kan visa rösten igen. Men bara de två, per valsedel. Slumptalet
     * skulle göra visningen till ett bevis, och en token finns inte längre.
     */
    await identify(page, VOTERS.noStorage)
    await voteFor(page, 'Miljöpartiet')

    const stored = await page.evaluate(() => ({
      local: Object.fromEntries(Object.entries(localStorage)),
      session: JSON.stringify({ ...sessionStorage }),
    }))

    const entries = Object.entries(stored.local).filter(([key]) => key.startsWith('valsystem.'))
    expect(entries).toHaveLength(1)

    const records = Object.values(JSON.parse(entries[0]![1]) as Record<string, Record<string, unknown>>)
    expect(records).toHaveLength(1)
    expect(Object.keys(records[0]!).sort()).toEqual(['choice', 'ciphertextHash', 'label'])
    expect(records[0]!.ciphertextHash).toMatch(/^[0-9a-f]{64}$/)
    expect(records[0]!.label).toBe('Miljöpartiet')

    expect(JSON.stringify(stored.local)).not.toMatch(/random|slump|nonce|token/i)
    expect(stored.session).not.toMatch(/valsystem|[0-9a-f]{64}/)

    // Och sidan säger rakt ut att det den visar inte bevisar något.
    await expect(page.getByRole('heading', { name: 'Det här är inget kvitto' })).toBeVisible()
    await expect(page.getByText(/ingen kan få ett/i)).toBeVisible()
  })

  test('röstsidan och verifieringssidan anropar inte det gamla flödets rutter', async ({ page }) => {
    // Rutterna finns kvar tills det gamla flödet tas bort, men ingen sida
    // ska använda dem. Ett anrop hit vore en röst eller ett kvitto som ingen
    // längre ska kunna få.
    const oldRoutes: string[] = []
    page.on('request', (request) => {
      if (/^\/api\/(vote\/cast|vote\/credential|verify)$/.test(new URL(request.url()).pathname)) {
        oldRoutes.push(request.url())
      }
    })

    await identify(page, VOTERS.oldRoutes)
    await voteFor(page, 'Vänsterpartiet')

    await page.goto('/verify')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    expect(oldRoutes).toEqual([])
  })

  test('verifieringssidan frågar inte efter någon kod', async ({ page }) => {
    // Inga kvitton delas ut längre, så det finns ingenting att skriva in. En
    // ruta för en kod vore dessutom köparens verktyg (spec 3.1).
    await page.goto('/verify')

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('textbox')).toHaveCount(0)
    await expect(page.getByText(/inte byggd än/i)).toBeVisible()
  })
})
