/**
 * KLIENTENS ADRESS, OCH NÄR X-FORWARDED-FOR FÅR TROS.
 *
 * Hastighetsbegränsningen går efter klientens IP-adress. Förut lästes den ur
 * X-Forwarded-For utan villkor, och den rubriken kan klienten sätta själv.
 * Varje klient kunde alltså välja sin adress, en ny för varje begäran, och ta
 * sig förbi varje hastighetsgräns i systemet (granskningen av uppgift 14b,
 * MINDRE 3).
 *
 * Rubriken är bara värd något när en proxy vi litar på har skrivit den. En
 * sådan proxy lägger till adressen den själv ser, sist i listan. Allt före
 * det kommer från klienten, eller från proxyer längre ut, och kan vara
 * påhittat.
 *
 * TRUSTED_PROXY_HOPS säger hur många betrodda proxyer som står framför appen:
 *
 *   0 eller osatt  Ingen proxy. Appen nås direkt, som dev-servern gör.
 *                  Middleware tar bort rubriken som klienten skickat, och Next
 *                  sätter den då själv till anslutningens adress.
 *   n ≥ 1          n proxyer, som var och en lägger till sin granne. Adressen
 *                  är den n:te från slutet, alltså den som den yttersta
 *                  betrodda proxyn såg.
 *
 * VARFÖR MIDDLEWARE OCKSÅ, OCH INTE BARA DEN HÄR FUNKTIONEN
 *
 * En rutt i Next 15 ser inte anslutningen, bara rubrikerna. Next sätter
 * X-Forwarded-For till anslutningens adress, men bara om rubriken saknas.
 * Skickar klienten en egen står den kvar, och då finns anslutningens adress
 * ingenstans för rutten att läsa. Middleware körs före rutten och kan ta bort
 * rubriken, och då sätter Next den till anslutningens adress innan rutten
 * körs. tests/e2e/rate-limit.spec.ts prövar det mot den riktiga servern.
 *
 * Står appen bakom en proxy utan att TRUSTED_PROXY_HOPS är satt ser alla
 * besökare ut att komma från proxyns adress, och de delar en gräns. Det felar
 * åt det stränga hållet, och det syns genast.
 *
 * Modulen har inga beroenden, eftersom middleware importerar den och inte ska
 * dra in resten av appen. Därför läses variabeln här och inte i env.ts.
 */

/**
 * TRUSTED_PROXY_HOPS som ett tal. Allt som inte är ett heltal från 0 till 99
 * räknas som 0: då är ingen proxy betrodd, och rubriken från klienten tros
 * aldrig.
 */
export function trustedProxyHops(raw: string | undefined = process.env.TRUSTED_PROXY_HOPS): number {
  const value = raw?.trim() ?? ''
  return /^\d{1,2}$/.test(value) ? Number(value) : 0
}

/**
 * Klientens adress ur X-Forwarded-For, givet hur många betrodda proxyer som
 * står framför appen.
 *
 * Utan betrodd proxy är den enda posten anslutningens adress, som Next satte
 * sedan middleware tagit bort klientens rubrik. Med proxyer är adressen den
 * `hops`:te från slutet. Är listan kortare än så kom begäran inte genom alla
 * proxyerna, och den första posten, som en betrodd proxy skrev, används.
 */
export function clientAddressFrom(forwardedFor: string | null, hops: number): string {
  const entries = (forwardedFor ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  if (entries.length === 0) return 'okand'
  return entries[Math.max(0, entries.length - Math.max(1, hops))]!
}
