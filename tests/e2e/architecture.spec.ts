import type { Page } from '@playwright/test'
import type { DatabaseState } from '../../src/app/api/demo/database-state/route'
import { MOMENTS } from '../../src/app/architecture/timeline/moments'
import { vaultClaimProblems } from '../vault-claims'
import { expect, test } from './fixtures'

/**
 * E2E: arkitektursidan i en riktig webbläsare.
 *
 * Två gånger har det här projektet haft sidor som byggde och renderade men
 * var döda i webbläsaren, bland annat för att CSP:n stoppade skripten. Ett
 * sådant fel syns inte i något test som inte startar en webbläsare. Sidan
 * hämtar dessutom allt det viktiga i webbläsaren: livevyn och "Följ en röst"
 * finns bara om klientkoden faktiskt kört.
 *
 * VARFÖR STÄNGNINGEN SPELAS UPP MED EGNA SVAR
 *
 * Det som prövas i "Följ en röst" är vad sidan gör med sitt tillstånd när
 * bilden av databaserna byter form, inte själva stängningen. Den prövas mot
 * riktiga databaser i tests/integration/database-state.test.ts och
 * close-election.test.ts. Att stänga en omröstning här skulle kräva en
 * administratör och en klocka som passerat stängningstiden, och lämna
 * dev-databasen i ett läge som inte går att backa.
 */

const ELECTION = '11111111-1111-4111-8111-111111111111'
const ANNA = 'aaaa1111-aaa…'
const HASH = '3fa2b1c9d0e1'

function snapshot(phase: 'OPEN' | 'STRIPPED'): DatabaseState {
  const cipher = { pairs: 3, c1: '182364591027…', c2: '998124570013…', digits: 617 }
  const open = phase === 'OPEN'

  return {
    elections: [
      {
        id: ELECTION,
        name: 'Valet 2026',
        phase,
        closesAt: '2026-09-30T18:00:00.000Z',
        linkClearedAt: open ? null : '2026-09-30T18:05:00.000Z',
        envelopeRoot: open ? null : '9e1f00aa4b2c…',
        encryptionPublicKey: '449896240390…',
        tallyCompletedAt: null,
      },
    ],
    votersDb: {
      name: 'voters_db',
      // Väljaren finns kvar efter stängningen. Det är kuvertet som raderas.
      voterStatus: [
        { id: ANNA, externalIdentityHash: '34232956a3bb…', isEligible: true, isAdmin: false },
      ],
      pendingVote: open
        ? [
            {
              id: 'cccc3333-ccc…',
              voterStatusId: ANNA,
              electionId: ELECTION,
              ballotId: 'dddd4444-ddd…',
              ballotLabel: 'Riksdagen',
              ciphertextHash: `${HASH}…`,
              castSequence: 1,
              updatedAt: '2026-09-23',
              ciphertext: cipher,
            },
          ]
        : [],
      pendingVoteColumns: ['id', 'voter_status_id', 'ballot_id', 'ciphertext', 'ciphertext_hash'],
      foreignKeys: [],
    },
    votesDb: {
      name: 'votes_db',
      encryptedVote: open
        ? []
        : [
            {
              id: '3fa2b1c9-d0e…',
              electionId: ELECTION,
              ballotId: 'dddd4444-ddd…',
              ballotLabel: 'Riksdagen',
              ciphertextHash: `${HASH}…`,
              ciphertext: cipher,
            },
          ],
      encryptedVoteColumns: ['id', 'ballot_id', 'ciphertext', 'proofs', 'ciphertext_hash'],
      trusteeShare: [],
      partialDecryption: [],
      ballotTally: [],
      legacyVote: [],
      foreignKeys: [],
    },
    analysis: {
      linkQuery: { sql: 'SELECT 1', rows: open ? 1 : 0 },
      identityValuesCompared: 2,
      identityValuesInVotesDb: [],
      ciphertextHashesInBoth: [],
      foreignKeysChecked: 0,
      foreignKeysAcrossDatabases: [],
    },
  }
}

test.describe('arkitektursidan', () => {
  test('laddar och kör sin klientkod utan fel i konsolen', async ({ page }) => {
    const problems: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text())
    })
    page.on('pageerror', (error) => problems.push(error.message))

    await page.goto('/architecture')

    await expect(page.getByRole('heading', { level: 1, name: 'Arkitektur' })).toBeVisible()
    // Syns först när klientkoden kört och hämtningen kommit tillbaka. En sida
    // vars skript CSP:n stoppat fastnar på "Hämtar databasernas innehåll".
    await expect(page.getByText(/Hämtad kl/)).toBeVisible()
    expect(problems).toEqual([])
  })

  test('livevyn visar det rutten lämnar ut, med modellen utskriven på varje tabell', async ({
    page,
    request,
  }) => {
    const state = (await (await request.get('/api/demo/database-state')).json()) as DatabaseState

    await page.goto('/architecture')
    const live = page.getByRole('region', { name: 'Databaserna just nu' })
    await expect(live.getByText(/Hämtad kl/)).toBeVisible()

    // Fasen som visas är den som står i databasen, inte en som sidan antar.
    expect(state.elections.length).toBeGreaterThan(0)
    for (const election of state.elections) {
      await expect(live.getByRole('row', { name: new RegExp(election.name) })).toContainText(
        election.phase,
      )
    }

    const tables = [
      ['voter_status', 'Båda modellerna'],
      ['pending_vote', 'Kuvertmodellen'],
      ['encrypted_vote', 'Kuvertmodellen'],
      ['trustee_share', 'Kuvertmodellen'],
      ['partial_decryption', 'Kuvertmodellen'],
      ['ballot_tally', 'Kuvertmodellen'],
      // Det gamla flödet finns kvar, och livevyn låtsas inte något annat.
      ['vote', 'Gamla modellen'],
    ] as const
    for (const [table, model] of tables) {
      await expect(page.getByRole('heading', { name: new RegExp(`^${table} ${model}`) })).toBeVisible()
    }
  })

  test('Följ en röst: sidan glömmer kuvertet vid stängningen och märker inget chiffer', async ({
    page,
  }) => {
    let current = snapshot('OPEN')
    await page.route('**/api/demo/database-state', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) }),
    )

    await page.goto('/architecture')
    const follow = page.getByRole('region', { name: 'Följ en röst' })
    const votesDb = page.getByRole('region', { name: /votes_db/ })

    // Före stängningen: kopplingen syns, eftersom den finns i databasen.
    await follow.getByLabel('Följ ett kuvert i pending_vote').selectOption({ index: 1 })
    await expect(follow.getByText(`voter_status.id = ${ANNA}`)).toBeVisible()

    // Stängningen. Nästa bild har ingen rad i pending_vote, bara ett chiffer.
    current = snapshot('STRIPPED')
    await page.getByRole('button', { name: 'Uppdatera nu' }).click()

    await expect(follow.getByText('Kuvertet du följde finns inte längre i pending_vote.')).toBeVisible()
    await expect(follow.getByText(/1 rad i encrypted_vote, 0 rader kvar i pending_vote/)).toBeVisible()

    // Sidan minns inte vem den följde, och märker ingen rad i röstdatabasen.
    await expect(follow.getByText(ANNA)).toHaveCount(0)
    await expect(votesDb.getByText('följs', { exact: true })).toHaveCount(0)
    await expect(page.getByText('väljaren', { exact: true })).toHaveCount(0)

    // Spec 3.1: ingen ruta att söka med en kod. Den var köparens verktyg.
    await expect(page.getByLabel(/verifikationskod/i)).toHaveCount(0)
  })

  test('en flik som blir synlig hämtar direkt, utan att vänta på nästa tick', async ({ page }) => {
    /**
     * En dold flik hämtar inte. Var den dold under stängningen visar den
     * bilden från före, med kopplingen, och ska inte fortsätta med det i upp
     * till tio sekunder efter att den syns igen.
     *
     * Synligheten spelas upp med visibilitychange. Det räcker för att pröva
     * kopplingen i komponenten; logiken prövas för sig i
     * tests/unit/live-refresh.test.ts.
     */
    let requests = 0
    await page.route('**/api/demo/database-state', (route) => {
      requests += 1
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot('OPEN')),
      })
    })

    await page.goto('/architecture')
    await expect(page.getByText(/Hämtad kl/)).toBeVisible()
    const afterLoad = requests

    const setVisibility = (state: 'hidden' | 'visible') =>
      page.evaluate((next) => {
        Object.defineProperty(document, 'visibilityState', { value: next, configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
      }, state)

    await setVisibility('hidden')
    expect(requests).toBe(afterLoad)

    await setVisibility('visible')
    // Långt före nästa tick, som kommer tio sekunder efter att sidan laddats.
    await expect.poll(() => requests, { timeout: 3_000 }).toBe(afterLoad + 1)
  })

  test('sidan säger rakt ut att livevyn är en insiders vy, och vad det betyder', async ({ page }) => {
    await page.goto('/architecture')
    const follow = page.getByRole('region', { name: 'Följ en röst' })

    await expect(page.getByText('Det här är en insiders vy.')).toBeVisible()
    await expect(
      follow.getByText('Livevyn är en insiders vy, och den som antecknar ur den har kopplingen.'),
    ).toBeVisible()
    await expect(follow.getByText(/BankID:s kopia av det väljaren signerade/)).toBeVisible()
  })

  test('sidan skrollar inte i sidled på en telefon', async ({ page }) => {
    // Användaren läser på mobilen. Tabeller får skrolla i sin egen behållare,
    // men sidan själv får inte bli bredare än skärmen.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/architecture')
    await expect(page.getByText(/Hämtad kl/)).toBeVisible()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
  })

  test('Följ en röst varnar när kuvert ligger kvar efter att kopplingen står som raderad', async ({
    page,
  }) => {
    /**
     * Rutan "Efter stängningen" var tidigare alltid grön och sa att det inte
     * går att säga ur databasen vems ett chiffer är, också när kuvert låg kvar
     * i pending_vote. Då finns kopplingen för dem, och rutan ska säga det.
     */
    const stripped = snapshot('STRIPPED')
    const leftBehind: DatabaseState = {
      ...stripped,
      votersDb: { ...stripped.votersDb, pendingVote: snapshot('OPEN').votersDb.pendingVote },
    }
    await page.route('**/api/demo/database-state', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(leftBehind) }),
    )

    await page.goto('/architecture')
    const follow = page.getByRole('region', { name: 'Följ en röst' })
    const box = follow.getByRole('status').filter({ hasText: /1 rad kvar i pending_vote/ })

    await expect(box).toHaveClass(/notice warning/)
    await expect(box).toContainText('Kopplingen står som raderad, men ett kuvert ligger ändå kvar')
    await expect(box).not.toContainText('går inte att säga ur databasen längre')

    // Kontrasten: utan kvar-liggande kuvert är rutan grön och säger det motsatta.
    await page.unroute('**/api/demo/database-state')
    await page.route('**/api/demo/database-state', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stripped) }),
    )
    await page.getByRole('button', { name: 'Uppdatera nu' }).click()
    const clean = follow.getByRole('status').filter({ hasText: /0 rader kvar i pending_vote/ })
    await expect(clean).toHaveClass(/notice success/)
    await expect(clean).toContainText('går inte att säga ur databasen längre')
  })
})

/** Samlar konsolfel och okastade undantag, som ett test kan kräva ska vara noll. */
function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

/** Spolar fram eller tillbaka varje animation på sidan till en viss tid, i millisekunder. */
async function freezeAnimationsAt(page: Page, time: number): Promise<void> {
  await page.evaluate((ms) => {
    for (const animation of document.getAnimations()) {
      animation.pause()
      animation.currentTime = ms
    }
  }, time)
}

async function finishAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) animation.finish()
  })
}

/**
 * Hur synligt varje element i scenen som matchar väljaren är: produkten av
 * opaciteten hela vägen upp till scenen. Opaciteten ärvs inte, så ett synligt
 * element inuti en osynlig grupp har själv opacitet 1. Det är den sammanlagda
 * som avgör vad läsaren ser.
 */
async function opacities(page: Page, selector: string): Promise<number[]> {
  return page.evaluate(
    (css) =>
      [...document.querySelectorAll(`.tl-scene ${css}`)].map((element) => {
        let opacity = 1
        for (let node: Element | null = element; node; node = node.parentElement) {
          opacity *= Number(getComputedStyle(node).opacity)
          if (node.classList.contains('tl-scene')) break
        }
        return Math.round(opacity * 1000) / 1000
      }),
    selector,
  )
}

/**
 * Förtroendepersonernas nycklar som syns och ligger i eller intill valvet, med
 * sin plats. Tomt när ingen nyckel är i närheten. Marginalen gör att också en
 * nyckel som snuddar vid valvet räknas.
 */
async function keysNearTheVault(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const body = document.querySelector('.tl-scene [data-vault] .tl-vault-body')
    if (!body) return ['valvet saknas i scenen']
    const vault = body.getBoundingClientRect()
    const margin = 8

    const visible = (element: Element) => {
      let opacity = 1
      for (let node: Element | null = element; node; node = node.parentElement) {
        opacity *= Number(getComputedStyle(node).opacity)
        if (node.classList.contains('tl-scene')) break
      }
      return opacity > 0.01
    }

    return [...document.querySelectorAll('.tl-scene .tl-key')]
      .filter(visible)
      .map((key) => key.getBoundingClientRect())
      .filter(
        (key) =>
          key.left < vault.right + margin &&
          key.right > vault.left - margin &&
          key.top < vault.bottom + margin &&
          key.bottom > vault.top - margin,
      )
      .map((key) => `nyckel vid ${Math.round(key.left)},${Math.round(key.top)}`)
  })
}

/** Animationerna i scenen, utan övergångarna på sidans knappar. */
async function sceneAnimationTimes(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const scene = document.querySelector('.tl-scene')!
    return document
      .getAnimations()
      .filter((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target
        return target instanceof Element && scene.contains(target)
      })
      .map((animation) => Number(animation.currentTime))
  })
}

test.describe('tidslinjen', () => {
  /**
   * Tidslinjen är en simulering av hur valet är tänkt att fungera. Texten bär
   * berättelsen och står i en aria-live-region; scenen är dekorativ. Det som
   * prövas här är att varje knapp visar sitt moment, att Föregående och Nästa
   * fungerar, att den som bett om mindre rörelse ser slutläget direkt, och att
   * animationen aldrig pekar ut ditt kuvert efter att namnen tagits bort.
   */
  const timelineOf = (page: Page) => page.getByRole('region', { name: 'Din röst, steg för steg' })

  test('ett klick på varje knapp visar momentets text, utan fel i konsolen', async ({ page }) => {
    const problems = collectProblems(page)
    await page.goto('/architecture')
    const timeline = timelineOf(page)
    const text = timeline.locator('#tidslinjen-text')

    await expect(text).toHaveAttribute('aria-live', 'polite')

    for (const moment of MOMENTS) {
      const button = timeline.getByRole('button', {
        name: `${moment.number} ${moment.label}`,
        exact: true,
      })
      await button.click()

      await expect(button).toHaveAttribute('aria-current', 'step')
      await expect(text.getByRole('heading', { name: moment.title, exact: true })).toBeVisible()
      await expect(text).toContainText(moment.text)
      await expect(text).toContainText(`Moment ${moment.number} av ${MOMENTS.length}`)
      await expect(timeline.locator('[aria-current="step"]')).toHaveCount(1)

      // Anteckningen om valvet står i samma levande region som texten, så att
      // en skärmläsare får den, och bara i de moment som har en.
      const note = text.locator('.tl-vault-note')
      if (moment.vault) {
        await expect(note).toHaveCount(1)
        await expect(note).toContainText(moment.vault.text)
      } else {
        await expect(note).toHaveCount(0)
      }
    }

    expect(problems).toEqual([])
  })

  test('Föregående och Nästa går ett moment i taget, också med tangentbordet', async ({ page }) => {
    await page.goto('/architecture')
    const timeline = timelineOf(page)
    const text = timeline.locator('#tidslinjen-text')
    const previous = timeline.getByRole('button', { name: 'Föregående' })
    const next = timeline.getByRole('button', { name: 'Nästa' })
    const step = (index: number) =>
      timeline.getByRole('button', {
        name: `${MOMENTS[index]!.number} ${MOMENTS[index]!.label}`,
        exact: true,
      })

    await expect(step(0)).toHaveAttribute('aria-current', 'step')
    await expect(previous).toHaveAttribute('aria-disabled', 'true')

    await next.click()
    await expect(step(1)).toHaveAttribute('aria-current', 'step')
    await expect(text).toContainText(MOMENTS[1]!.text)

    await previous.click()
    await expect(step(0)).toHaveAttribute('aria-current', 'step')
    // Knappen ser avstängd ut, men tar emot klicket och gör ingenting.
    await previous.click({ force: true })
    await expect(step(0)).toHaveAttribute('aria-current', 'step')

    // Tangentbordet: knappen behåller fokus, eftersom den aldrig stängs av.
    await next.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')
    await expect(step(2)).toHaveAttribute('aria-current', 'step')
    await expect(next).toBeFocused()

    await step(MOMENTS.length - 1).click()
    await expect(next).toHaveAttribute('aria-disabled', 'true')
    await next.click({ force: true })
    await expect(step(MOMENTS.length - 1)).toHaveAttribute('aria-current', 'step')
    await expect(previous).not.toHaveAttribute('aria-disabled', 'true')
  })

  test('momentknapparna nås med tangentbordet och visar fokus', async ({ page }) => {
    await page.goto('/architecture')
    const first = timelineOf(page).getByRole('button', { name: `1 ${MOMENTS[0]!.label}` })

    await first.focus()
    await page.keyboard.press('Tab')
    const focused = timelineOf(page).locator('.tl-step:focus-visible')
    await expect(focused).toHaveCount(1)
    await expect(focused).toHaveAccessibleName(`2 ${MOMENTS[1]!.label}`)
    expect(await focused.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid')
  })

  test('ett nytt klick på samma moment spelar animationen igen', async ({ page }) => {
    await page.goto('/architecture')
    const button = timelineOf(page).getByRole('button', { name: /^9 / })

    await button.click()
    const scene = await page.locator('.tl-scene').elementHandle()
    await button.click()

    // Scenen monteras om, och dess animationer börjar om från noll.
    expect(await scene!.evaluate((element) => element.isConnected)).toBe(false)
    const times = await sceneAnimationTimes(page)
    expect(times.length).toBeGreaterThan(0)
    expect(Math.max(...times)).toBeLessThan(1000)
  })

  test('med prefers-reduced-motion syns slutläget direkt, utan rörelse', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/architecture')
    const timeline = timelineOf(page)

    for (const [label, check] of [
      ['Du skriver under', 'vault'],
      ['Namnen tas bort', 'anonymous'],
      ['Summan öppnas', 'result'],
    ] as const) {
      await timeline.getByRole('button', { name: new RegExp(`^\\d+ ${label}$`) }).click()
      await expect(timeline.locator('#tidslinjen-text')).toContainText(
        MOMENTS.find((moment) => moment.label === label)!.text,
      )

      const names = await page.evaluate(() => [
        ...new Set(
          [...document.querySelectorAll('.tl-scene .tl-a')].map(
            (element) => getComputedStyle(element).animationName,
          ),
        ),
      ])
      expect(await sceneAnimationTimes(page), label).toEqual([])
      expect(names, label).toEqual(['none'])

      if (check === 'vault') {
        // Slutläget: valvet lyser, och intyget är inlåst i det yttre kuvertet.
        expect(await opacities(page, '[data-vault] .tl-vault-body')).toEqual([1])
        expect(await opacities(page, '.tl-seal')).toEqual([1])
      } else if (check === 'anonymous') {
        // Slutläget: fem kuvert i urnan utan namn, och ingenting pekar ut ditt.
        expect(await opacities(page, '[data-anonymous]')).toEqual([1, 1, 1, 1, 1])
        expect((await opacities(page, '[data-yours]')).every((value) => value === 0)).toBe(true)
      } else {
        const bars = await page.locator('.tl-scene .tl-bar').count()
        expect(bars).toBe(3)
        expect(await opacities(page, '.tl-bar')).toEqual([1, 1, 1])
      }
    }
  })

  test('ditt kuvert är utpekat fram till moment 9, och aldrig efter', async ({ page }) => {
    /**
     * Efter moment 9, när namnen tas bort, får animationen inte längre peka ut
     * vilket inre kuvert som är ditt. Ett kuvert som den pekar ut efter
     * skalningen vore den koppling modellen raderar, visad för alla som tittar.
     */
    await page.goto('/architecture')
    const timeline = timelineOf(page)

    for (const moment of MOMENTS) {
      await timeline
        .getByRole('button', { name: `${moment.number} ${moment.label}`, exact: true })
        .click()
      await finishAnimations(page)
      const visible = (await opacities(page, '[data-yours]')).filter((value) => value > 0)

      if (moment.yourEnvelope === 'utpekad') {
        expect(visible.length, `moment ${moment.number} pekar inte ut ditt kuvert`).toBeGreaterThan(0)
      } else if (moment.yourEnvelope === 'släcks') {
        expect(visible, `moment ${moment.number}: markeringen syns kvar i slutläget`).toEqual([])
      } else {
        expect(
          await page.locator('.tl-scene [data-yours]').count(),
          `moment ${moment.number} bär en markering`,
        ).toBe(0)
      }
    }
  })

  test('i moment 9 släcks markeringen under samma tid som namnen försvinner', async ({ page }) => {
    await page.goto('/architecture')
    await timelineOf(page).getByRole('button', { name: /^9 / }).click()

    const fillOf = (selector: string) =>
      page.evaluate(
        (css) => getComputedStyle(document.querySelector(`.tl-scene ${css} .tl-env`)!).fill,
        selector,
      )
    const yourFill = () => fillOf('[data-yours="envelope"]')
    // Kuverten i urnan utan namn har aldrig burit någon markering.
    const othersFill = () => fillOf('[data-anonymous]')

    // Före: namnet och markeringen finns.
    await freezeAnimationsAt(page, 100)
    expect(await opacities(page, '[data-yours="tag"]')).toEqual([1])
    expect(await opacities(page, '[data-yours="name"]')).toEqual([1])
    const markedFill = await yourFill()

    // Mitt i: båda är på väg bort, i samma takt.
    await freezeAnimationsAt(page, 375)
    const [tag] = await opacities(page, '[data-yours="tag"]')
    const [name] = await opacities(page, '[data-yours="name"]')
    expect(tag!).toBeGreaterThan(0)
    expect(tag!).toBeLessThan(1)
    expect(Math.abs(tag! - name!)).toBeLessThan(0.02)
    expect(await yourFill()).not.toBe(markedFill)

    // Efter: inga namn, ingen lapp, och ditt kuvert har samma färg som de andras.
    await freezeAnimationsAt(page, 600)
    expect(await opacities(page, '[data-name]')).toEqual([0, 0, 0, 0, 0])
    expect(await opacities(page, '[data-yours="tag"]')).toEqual([0])
    expect(await yourFill()).toBe(await othersFill())
  })

  test('i moment 11 lämnas delarna en i taget, och summan syns först när två finns', async ({ page }) => {
    /**
     * Förtroendepersonerna lämnar sina delar av nyckeln var för sig (spec 6.2).
     * Efter den första delen är låset fortfarande stängt och ingenting går att
     * läsa. Först när den andra är lämnad går summakuvertet upp. Det tredje
     * nyckelhålet tänds aldrig.
     */
    await page.goto('/architecture')
    await timelineOf(page).getByRole('button', { name: /^11 / }).click()
    expect(await page.locator('.tl-scene .tl-keyhole-lit').count()).toBe(2)

    const state = async (time: number) => {
      await freezeAnimationsAt(page, time)
      const lit = (await opacities(page, '.tl-keyhole-lit')).filter((value) => value > 0.5).length
      const readable = (await opacities(page, '.tl-option')).filter((value) => value > 0).length
      return { lit, readable }
    }

    expect(await state(450), 'efter den första delen').toEqual({ lit: 1, readable: 0 })
    expect(await state(950), 'efter den andra delen, innan låset gått upp').toEqual({
      lit: 2,
      readable: 0,
    })
    expect(await state(1600), 'när låset gått upp').toEqual({ lit: 2, readable: 3 })
  })

  test('valvet lyser bara där det används, och nyckelns delar kommer aldrig nära det', async ({
    page,
  }) => {
    /**
     * Uppgift 11g. Valvet får aldrig se ut att hålla förtroendepersonernas
     * nycklar: ingen nyckel ritas i det, och ingen nyckel passerar det, inte
     * heller mitt i en animation. Och valvet får inte se ut att ta bort
     * kopplingen: i moment 9, när namnen tas bort, står det nedtonat och
     * stilla, liksom i moment 11, när summan öppnas utan det.
     */
    await page.goto('/architecture')
    const timeline = timelineOf(page)

    for (const moment of MOMENTS) {
      await timeline
        .getByRole('button', { name: `${moment.number} ${moment.label}`, exact: true })
        .click()
      const label = `moment ${moment.number}`
      const vault = page.locator('.tl-scene [data-vault]')
      const lit = moment.vault?.inScene === true

      await expect(vault, label).toHaveCount(1)
      expect(await vault.evaluate((zone) => zone.classList.contains('tl-dimmed')), label).toBe(!lit)
      expect(await page.locator('.tl-scene [data-vault] .tl-key').count(), label).toBe(0)
      if (!lit) {
        // Ingenting i valvet rör sig när momentet inte använder det.
        expect(await page.locator('.tl-scene [data-vault] .tl-a').count(), label).toBe(0)
      }

      for (const time of [0, 300, 600, 900, 1200, 1600, 2400]) {
        await freezeAnimationsAt(page, time)
        expect(await keysNearTheVault(page), `${label}, ${time} ms`).toEqual([])
      }
    }
  })

  test('huvudsidans text låter aldrig valvet hålla nyckelns delar eller ta bort kopplingen', async ({
    page,
  }) => {
    /**
     * Samma regler som tests/unit/timeline-moments.test.ts prövar mot momenten,
     * här mot sidan som den renderas, med förklaringen ovanför tidslinjen och
     * svagheterna under den, i varje moment.
     */
    await page.goto('/architecture')
    const timeline = timelineOf(page)

    for (const moment of MOMENTS) {
      await timeline
        .getByRole('button', { name: `${moment.number} ${moment.label}`, exact: true })
        .click()
      const lines = await page.evaluate(() =>
        [...document.querySelectorAll('main section')]
          .filter(
            (section) =>
              !['livevy', 'voters-db', 'votes-db', 'folj-en-rost'].includes(
                section.getAttribute('aria-labelledby') ?? '',
              ),
          )
          .flatMap((section) => (section as HTMLElement).innerText.split('\n')),
      )

      expect(lines.some((line) => /valv/i.test(line)), `moment ${moment.number}`).toBe(true)
      expect(lines.flatMap((line) => vaultClaimProblems(line)), `moment ${moment.number}`).toEqual([])
    }
  })

  test('tidslinjen hämtar ingenting', async ({ page }) => {
    const requests: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/') && url.pathname !== '/api/demo/database-state') {
        requests.push(url.pathname)
      }
    })

    await page.goto('/architecture')
    const timeline = timelineOf(page)
    for (const moment of MOMENTS) {
      await timeline
        .getByRole('button', { name: `${moment.number} ${moment.label}`, exact: true })
        .click()
    }

    expect(requests).toEqual([])
  })

  test('tidslinjen fungerar också när livevyn inte får något svar', async ({ page }) => {
    // Utanför demoläget svarar rutten 404. Tidslinjen ska inte märka det.
    await page.route('**/api/demo/database-state', (route) => route.fulfill({ status: 404 }))
    const problems = collectProblems(page)

    await page.goto('/architecture')
    await timelineOf(page).getByRole('button', { name: /^11 / }).click()
    await expect(timelineOf(page).locator('#tidslinjen-text')).toContainText(
      'De enskilda kuverten förblir stängda.',
    )

    // Det enda felet är den avvisade hämtningen, inte tidslinjen.
    expect(problems.filter((problem) => !/404|Failed to load resource/.test(problem))).toEqual([])
  })
})

test.describe('huvudsidan och undersidorna', () => {
  test('huvudsidan använder inga fackord utanför livevyn', async ({ page }) => {
    await page.goto('/architecture')
    await expect(page.getByText(/Hämtad kl/)).toBeVisible()

    const text = await page.evaluate(() => {
      const main = document.querySelector('main')!.cloneNode(true) as HTMLElement
      // Livevyn visar databaserna som de är, och får vara teknisk.
      for (const id of ['livevy', 'voters-db', 'votes-db', 'folj-en-rost']) {
        main.querySelector(`section[aria-labelledby="${id}"]`)?.remove()
      }
      return main.textContent ?? ''
    })

    expect(text).toContain('Två kuvert och ett lås')
    expect(text.match(/\S*(krypt|chiff|homomorf|tröskel|hash|merkle|signatur)\S*/gi) ?? []).toEqual([])
  })

  test('huvudsidan länkar till listan över kända begränsningar', async ({ page }) => {
    await page.goto('/architecture')
    const link = page.getByRole('link', { name: 'Alla kända begränsningar', exact: true })

    await expect(link).toHaveAttribute('href', '/architecture/technical#begransningar')
    await link.click()
    await expect(page).toHaveURL(/\/architecture\/technical#begransningar$/)
    await expect(
      page.getByRole('heading', { name: 'Varför detta inte räcker för ett riktigt val' }),
    ).toBeVisible()
  })

  test('Tekniska detaljer laddar utan fel och kör frågan om kopplingen', async ({ page }) => {
    const problems = collectProblems(page)
    await page.goto('/architecture/technical')

    await expect(page.getByRole('heading', { level: 1, name: 'Tekniska detaljer' })).toBeVisible()
    const question = page.getByRole('region', { name: 'Finns det någon koppling?' })
    // Syns först när klientkoden kört och hämtningen kommit tillbaka.
    await expect(question.getByText(/Hämtad kl/)).toBeVisible()
    await expect(question.getByRole('button', { name: 'Uppdatera nu' })).toBeVisible()
    for (const heading of ['Faserna', 'Från liknelsen till tekniken', 'Varför detta inte räcker för ett riktigt val']) {
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    }
    expect(problems).toEqual([])
  })

  test('Utvecklingsstatus laddar utan fel och hämtar ingenting', async ({ page }) => {
    const problems = collectProblems(page)
    const requests: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url())
    })

    await page.goto('/architecture/status')

    await expect(page.getByRole('heading', { level: 1, name: 'Utvecklingsstatus' })).toBeVisible()
    for (const heading of [
      'Läget i korthet',
      'Klart',
      'Kommer att implementeras',
      'Saknas och ingår inte i demon',
      'Granskningen, fråga för fråga',
      'Faserna i koden i dag',
      'Vad som återstår',
    ]) {
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    }
    expect(requests).toEqual([])
    expect(problems).toEqual([])
  })

  test('Utvecklingsstatus märker punkter längre ned på sidan, inte bara i sammanfattningen', async ({
    page,
  }) => {
    /**
     * Uppgift 11h, krav 1 och 5: samma status läses både överst och vid varje
     * punkt längre ned, så etiketterna inte kan säga olika saker. Minst en av
     * varje sorts etikett ska synas UTANFÖR "Läget i korthet", som bevis på
     * att märkningen faktiskt når resten av sidan och inte bara sammanfattas
     * en gång överst.
     */
    await page.goto('/architecture/status')

    const overview = page.getByRole('region', { name: 'Läget i korthet' })
    await expect(overview.getByRole('heading', { name: 'Klart', exact: true })).toBeVisible()

    const restOfPage = page.locator('main').locator('section:not(#laget-i-korthet)')
    await expect(restOfPage.getByText('Klart', { exact: true }).first()).toBeVisible()
    await expect(restOfPage.getByText(/^Kommer \(uppgift/).first()).toBeVisible()
    await expect(restOfPage.getByText('Ingår inte', { exact: true }).first()).toBeVisible()
  })

  test('ingen av de tre sidorna skrollar i sidled på en telefon', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })

    for (const path of ['/architecture', '/architecture/technical', '/architecture/status']) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, path).toBe(0)
    }
  })
})
