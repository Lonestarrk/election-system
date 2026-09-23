import type { DatabaseState } from '../../src/app/api/demo/database-state/route'
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
/** Verifikationskoden: chifferhashen, 64 hextecken, som väljaren fick när hon röstade. */
const ANNAS_CODE = HASH + 'ab'.repeat(26)

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

  test('Följ en röst: sidan glömmer kuvertet vid stängningen och hittar rösten bara med koden', async ({
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
    // Sidan minns inte vem den följde, och märker inget chiffer på eget bevåg.
    await expect(follow.getByText(ANNA)).toHaveCount(0)
    await expect(votesDb.getByText('din kod')).toHaveCount(0)

    // Bara koden hittar rösten, och raden den hittar bär ingen väljare.
    await follow.getByLabel('Verifikationskod').fill(ANNAS_CODE.toUpperCase())
    await expect(follow.getByText('Hittad i encrypted_vote, i röstdatabasen.')).toBeVisible()
    await expect(votesDb.getByText('din kod')).toHaveCount(1)
    await expect(follow.getByText(ANNA)).toHaveCount(0)
  })

  test('sidan säger rakt ut att den som kopierade pending_vote har kopplingen', async ({ page }) => {
    await page.goto('/architecture')
    const follow = page.getByRole('region', { name: 'Följ en röst' })

    await expect(
      follow.getByText('Den som kopierade pending_vote före stängningen har kopplingen.'),
    ).toBeVisible()
    await expect(follow.getByText(/backup, en läsreplik eller WAL-loggen/)).toBeVisible()
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
})
