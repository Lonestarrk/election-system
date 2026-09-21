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

  /**
   * ADMIN_PASSWORD är borttagen.
   *
   * Adminbehörighet avgörs numera av `isAdmin` på personens rad i
   * röstlängden, efter BankID-legitimering. Det finns alltså ingen delad
   * adminhemlighet kvar i konfigurationen — inget att läcka ur en .env-fil,
   * och inget som är samma i alla miljöer.
   */

  /**
   * VAPID-nycklar för Web Push.
   *
   * Frivilliga. Saknas de är notiser avstängda och systemet fungerar i övrigt
   * precis som vanligt — en POC ska inte vägra starta för att en
   * bekvämlighetsfunktion är okonfigurerad.
   *
   * Den privata nyckeln signerar utskicken och identifierar avsändaren mot
   * push-tjänsterna. Läcker den kan någon annan skicka notiser i systemets
   * namn, vilket vore ett trovärdigt sätt att lura väljare till en falsk sajt.
   * Den hör alltså hemma i samma kategori som IDENTITY_PEPPER.
   */
  get vapid(): { publicKey: string; privateKey: string; subject: string } | null {
    const publicKey = process.env.VAPID_PUBLIC_KEY
    const privateKey = process.env.VAPID_PRIVATE_KEY
    if (!publicKey || !privateKey) return null

    return {
      publicKey,
      privateKey,
      // mailto: eller en https-URL. Push-tjänsterna kräver en kontaktpunkt för
      // att kunna höra av sig om utskicken missbrukas.
      subject: process.env.VAPID_SUBJECT ?? 'mailto:valmyndigheten@example.org',
    }
  },

  /**
   * Tillåtna origins, kommaseparerade i APP_ORIGIN.
   *
   * En lista och inte ett enda värde, eftersom appen på riktigt nås på flera
   * adresser samtidigt: localhost under utveckling, maskinens LAN-adress när
   * man provar från en telefon, och domänen i drift. Med ett enda värde blir
   * varje POST från de andra avvisad med 403, och felet ser ut som en bugg i
   * inloggningen i stället för en felkonfiguration.
   *
   * Det är fortfarande en spärrlista med exakt matchning — inte en
   * uppluckring. Varje origin måste vara uppräknad.
   */
  get appOrigins(): string[] {
    const raw = process.env.APP_ORIGIN ?? 'http://localhost:3000'
    return raw
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0)
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
