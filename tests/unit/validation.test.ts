import { describe, expect, it } from 'vitest'
import {
  adminLoginSchema,
  castVoteSchema,
  personalNumberSchema,
  verifyTokenSchema,
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

describe('validering av en röst', () => {
  const validVote = {
    ballotId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    ballotPartyId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
    credentialId: 'a'.repeat(64),
    credentialSignature: 'b'.repeat(512),
  }

  it('godtar en röst med valsedel, parti och röstintyg', () => {
    expect(castVoteSchema.safeParse(validVote).success).toBe(true)
  })

  it('kräver ett röstintyg', () => {
    const { credentialId: _omitted, ...utanIntyg } = validVote
    expect(castVoteSchema.safeParse(utanIntyg).success).toBe(false)
  })

  it('avvisar ett röstintyg med fel längd', () => {
    // Intyget är exakt 32 byte och signaturen exakt modulusens bredd. Allt
    // annat är antingen ett fel eller ett försök att pröva sig fram.
    expect(castVoteSchema.safeParse({ ...validVote, credentialId: 'a'.repeat(63) }).success).toBe(
      false,
    )
    expect(
      castVoteSchema.safeParse({ ...validVote, credentialSignature: 'b'.repeat(511) }).success,
    ).toBe(false)
  })

  it('avvisar både parti och svarsalternativ i samma röst', () => {
    expect(
      castVoteSchema.safeParse({
        ...validVote,
        optionId: '3f2504e0-4f89-11d3-9a0c-0305e82c3303',
      }).success,
    ).toBe(false)
  })

  it('avvisar en personröst utan parti', () => {
    const { ballotPartyId: _omitted, ...utanParti } = validVote
    expect(
      castVoteSchema.safeParse({
        ...utanParti,
        candidateId: '3f2504e0-4f89-11d3-9a0c-0305e82c3304',
      }).success,
    ).toBe(false)
  })
})

describe('validering av token', () => {
  it('godtar token med och utan bindestreck', () => {
    expect(verifyTokenSchema.safeParse({ token: 'ABCDEFGH-JKMNPQRS' }).success).toBe(true)
    expect(verifyTokenSchema.safeParse({ token: 'ABCDEFGHJKMNPQRS' }).success).toBe(true)
  })

  it('avvisar tecken utanför alfabetet', () => {
    expect(verifyTokenSchema.safeParse({ token: "ABC'; DROP TABLE--" }).success).toBe(false)
    expect(verifyTokenSchema.safeParse({ token: '<script>' }).success).toBe(false)
  })

  it('avvisar orimligt långa värden', () => {
    expect(verifyTokenSchema.safeParse({ token: 'A'.repeat(500) }).success).toBe(false)
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
