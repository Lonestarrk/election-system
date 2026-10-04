import { describe, expect, it } from 'vitest'
import {
  MAX_JSON_BODY_BYTES,
  adminLoginSchema,
  parseJsonBody,
  personalNumberSchema,
  startAuthSchema,
} from '@/lib/validation'

describe('validering av personnummer', () => {
  it('godtar ÅÅÅÅMMDD-NNNN', () => {
    expect(personalNumberSchema.parse('19900101-1234')).toBe('199001011234')
  })

  it('godtar formatet utan bindestreck', () => {
    expect(personalNumberSchema.parse('199001011234')).toBe('199001011234')
  })

  it.each([
    ['för kort', '900101-1234'],
    ['bokstäver', 'abcdefgh-1234'],
    ['tomt', ''],
    ['SQL-försök', "1' OR '1'='1"],
    ['skript', '<script>alert(1)</script>'],
  ])('avvisar %s', (_label, input) => {
    expect(personalNumberSchema.safeParse(input).success).toBe(false)
  })
})

describe('validering av adminlogin', () => {
  it('tar emot en BankID-referens, inte ett lösenord', () => {
    // Det finns ingen delad adminhemlighet kvar i systemet. Behörigheten
    // avgörs av is_admin på personens rad i röstlängden.
    expect(adminLoginSchema.safeParse({ password: 'admin' }).success).toBe(false)
    expect(
      adminLoginSchema.safeParse({ orderRef: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' }).success,
    ).toBe(true)
  })
})

describe('start av legitimering', () => {
  it('tar inte emot något personnummer', async () => {
    /**
     * BANKID V6 TILLÅTER INTE ATT ANVÄNDAREN SKRIVER IN SITT PERSONNUMMER.
     *
     * Testet finns för att fältet inte ska smyga tillbaka. Den gamla rutten
     * svarade medvetet likadant oavsett om personnumret fanns i röstlängden
     * eller inte — men den tog ändå emot godtyckliga personnummer från vem som
     * helst, och det är precis det angreppssätt Secure Start designats bort.
     *
     * Personnumret ska bara kunna komma in i systemet genom BankID:s eget
     * svar, efter att personen legitimerat sig med sin egen app.
     */
    const { startAuthSchema } = await import('@/lib/validation')

    const parsed = startAuthSchema.safeParse({
      purpose: 'vote',
      personalNumber: '199001011234',
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return

    // Zod plockar bort okända fält. Personnumret når alltså aldrig rutten,
    // ens om någon skickar med det.
    expect(parsed.data).toEqual({ purpose: 'vote' })
    expect('personalNumber' in parsed.data).toBe(false)
  })

  it('kräver ett känt ändamål, eftersom texten visas i BankID-appen', async () => {
    // Texten som visas i appen är ett skydd mot att bli lurad att signera
    // något annat än man tror. Ett okänt ändamål ska därför avvisas, inte
    // tolkas välvilligt.
    const { startAuthSchema } = await import('@/lib/validation')

    expect(startAuthSchema.safeParse({ purpose: 'admin' }).success).toBe(true)
    expect(startAuthSchema.safeParse({ purpose: 'nagot-annat' }).success).toBe(false)
    // Utan angivet ändamål antas röstning.
    expect(startAuthSchema.parse({})).toEqual({ purpose: 'vote' })
  })
})

describe('kroppens storlek', () => {
  /**
   * Fixrunda 1, uppgift 14b. `request.json()` läste hela kroppen, hur stor den
   * än var, och granskaren visade att stoppet i händelseslingan växte med
   * omkring 4 s per MB kropp. Talen har nu en egen gräns i schemat, men också
   * läsningen har en.
   */
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request('http://localhost:3000/api/auth/bankid/start', {
      method: 'POST',
      body,
      headers,
      duplex: 'half',
    } as RequestInit)

  /** En kropp som aldrig tar slut, och som räknar hur mycket som lästs. */
  function endlessBody() {
    const state = { pulled: 0, cancelled: false }
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulled += 1
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x20))
      },
      cancel() {
        state.cancelled = true
      },
    })
    return { stream, state }
  }

  it('en vanlig kropp läses som förut, också med ett inledande byte order mark', async () => {
    expect(await parseJsonBody(post('{"purpose":"admin"}'), startAuthSchema)).toEqual({
      ok: true,
      data: { purpose: 'admin' },
    })
    expect(await parseJsonBody(post('\uFEFF{"purpose":"admin"}'), startAuthSchema)).toEqual({
      ok: true,
      data: { purpose: 'admin' },
    })
    expect(await parseJsonBody(post('inte json'), startAuthSchema)).toEqual({
      ok: false,
      message: 'Ogiltig begäran.',
    })
  })

  it('en kropp som säger sig vara för stor avvisas utan att läsas', async () => {
    const { stream, state } = endlessBody()
    const request = post(stream, { 'content-length': String(MAX_JSON_BODY_BYTES + 1) })

    expect(await parseJsonBody(request, startAuthSchema)).toEqual({
      ok: false,
      message: 'Begäran är för stor.',
    })
    // En ström fyller på i förväg, men läser inte vidare när ingen frågar.
    expect(state.pulled).toBeLessThanOrEqual(2)
  })

  it('en kropp utan längd slutar läsas när gränsen passerats', async () => {
    // Chunkad överföring har ingen Content-Length, och rubriken kan ljuga.
    // Därför räknas också det som faktiskt läses.
    const { stream, state } = endlessBody()

    expect(await parseJsonBody(post(stream), startAuthSchema)).toEqual({
      ok: false,
      message: 'Begäran är för stor.',
    })
    expect(state.cancelled).toBe(true)
    expect(state.pulled * 64 * 1024).toBeLessThan(MAX_JSON_BODY_BYTES + 3 * 64 * 1024)
  })

  it('gränsen rymmer den största valsedel schemat tillåter, 200 alternativ', () => {
    // Tio tal om högst 617 siffror per alternativ, med fältnamn och citattecken.
    const component =
      JSON.stringify({ c1: '9'.repeat(617), c2: '9'.repeat(617) }).length +
      JSON.stringify({
        a0: '9'.repeat(617),
        b0: '9'.repeat(617),
        a1: '9'.repeat(617),
        b1: '9'.repeat(617),
        challenge0: '9'.repeat(617),
        challenge1: '9'.repeat(617),
        response0: '9'.repeat(617),
        response1: '9'.repeat(617),
      }).length
    expect(200 * component).toBeLessThan(MAX_JSON_BODY_BYTES * 0.65)
  })
})
