/**
 * Miljövariabler, lästa på ett ställe.
 *
 * Peppret valideras hårt: ett svagt eller saknat pepper gör hela
 * identitetshashningen verkningslös vid en databasdump, och det är precis den
 * sortens fel som annars upptäcks först efter en incident.
 */

function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(`Miljövariabeln ${name} saknas.`)
  }
  return value
}

export const env = {
  get votersDatabaseUrl(): string {
    return required('VOTERS_DATABASE_URL')
  },

  get votesDatabaseUrl(): string {
    return required('VOTES_DATABASE_URL')
  },

  get identityPepper(): string {
    const pepper = required('IDENTITY_PEPPER')
    if (pepper.length < 32) {
      throw new Error(
        'IDENTITY_PEPPER måste vara minst 32 tecken. Svenska personnummer har ' +
          'ett så litet utfallsrum att ett kort pepper går att brute-forca.',
      )
    }
    return pepper
  },

  get adminPassword(): string {
    return required('ADMIN_PASSWORD')
  },

  get appOrigin(): string {
    return process.env.APP_ORIGIN ?? 'http://localhost:3000'
  },

  get cookieSecure(): boolean {
    return process.env.COOKIE_SECURE === 'true'
  },

  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production'
  },

  get mockBankIdPollsUntilComplete(): number {
    const raw = process.env.MOCK_BANKID_POLLS_UNTIL_COMPLETE
    const parsed = raw ? Number.parseInt(raw, 10) : 2
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2
  },
}
