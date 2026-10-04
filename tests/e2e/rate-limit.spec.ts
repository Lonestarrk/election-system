import { expect, test } from './fixtures'

/**
 * EN PÅHITTAD X-FORWARDED-FOR GER INGEN NY HASTIGHETSGRÄNS (fixrunda 1, uppgift 14b).
 *
 * Förut gick hastighetsbegränsningen efter den första posten i
 * X-Forwarded-For, och den kan klienten sätta själv. En klient som skickade en
 * ny adress i varje begäran fick en ny gräns varje gång, och tog sig förbi
 * varje gräns i systemet.
 *
 * Testet går mot den riktiga servern, eftersom skyddet vilar på hur Next
 * behandlar rubriken. Dev-servern körs utan proxy, och då tar middleware bort
 * klientens rubrik, och Next sätter den i stället till anslutningens adress.
 * Det går inte att visa i Vitest, som inte kör Next.
 *
 * Fixturen nollställer gränserna före varje test, så det här testet tömmer
 * bara sin egen hink.
 */
test('tjugo försök per minut gäller också den som byter X-Forwarded-For varje gång', async ({
  request,
  baseURL,
}) => {
  const statuses: number[] = []

  for (let attempt = 1; attempt <= 21; attempt += 1) {
    const response = await request.post('/api/auth/bankid/start', {
      headers: {
        origin: baseURL ?? 'http://localhost:3000',
        'x-forwarded-for': `203.0.113.${attempt}`,
      },
      data: { purpose: 'ogiltigt' },
    })
    statuses.push(response.status())
  }

  // De tjugo första når valideringen och får 400 för ett ogiltigt syfte. Det visar
  // att gränsen inte stoppar allt. Den tjugoförsta stoppas, fast adressen är ny.
  expect(statuses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 400))
  expect(statuses[20]).toBe(429)
})
