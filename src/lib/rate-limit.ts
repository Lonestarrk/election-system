/**
 * Hastighetsbegränsning med token bucket, i processminne.
 *
 * TILLRÄCKLIGT FÖR EN POC, INTE FÖR SKARP DRIFT: tillståndet ligger i en
 * enskild Node-process. Med flera instanser bakom en lastbalanserare blir den
 * faktiska gränsen gånger antalet instanser, och den nollställs vid omstart.
 * Ett riktigt system lägger detta i Redis eller i en WAF framför applikationen.
 *
 * Nycklarna hashas innan de lagras. Nyckeln är oftast en IP-adress, och en
 * minnesstruktur full av IP-adresser som går att dumpa via en heap-dump är
 * precis den sortens sidokanal som kan knyta en person till en tidpunkt.
 */

import { sha256Hex } from './crypto'

/** `refused`: hinken har avvisat ett anrop sedan den senast släppte igenom ett. */
type Bucket = { tokens: number; lastRefill: number; refused?: boolean }

const buckets = new Map<string, Bucket>()

export type RateLimitRule = {
  /** Antal tillåtna anrop i fönstret. */
  limit: number
  /** Fönstrets längd i millisekunder. */
  windowMs: number
}

export const RATE_LIMITS = {
  /**
   * Legitimeringsstart.
   *
   * GRÄNSEN HÖJDES FRÅN 5 TILL 20 PER MINUT, OCH SKÄLET ÄR VIKTIGT.
   *
   * Fem per minut och IP-adress låter strikt och säkert, men det bryter mot
   * hur väljare faktiskt sitter på nätet: ett bibliotek, en arbetsplats eller
   * en mobiloperatörs NAT delar en utgående adress mellan hundratals personer.
   * Med den gamla gränsen hade den sjätte väljaren på biblioteket blivit
   * utelåst från att rösta — ett allvarligare fel än det gränsen skyddade mot.
   *
   * Vad gränsen faktiskt köper är dessutom begränsat. Rutten avslöjar
   * medvetet ingenting: svaret ser likadant ut oavsett om personnumret finns i
   * röstlängden eller inte, så den går inte att använda som uppslagsverk.
   *
   * VAD GRÄNSEN FAKTISKT SKYDDAR MOT
   *
   * Inte riktad trakasseri. Den här kommentaren påstod tidigare att varje
   * anrop startar en signeringsbegäran i någons BankID-app, och att en gräns
   * per personnummer därför behövdes. Det stämde för den gamla konstruktionen,
   * där rutten tog emot ett personnummer.
   *
   * Med BankID v6 (Secure Start) gör den inte det. `auth` tar `endUserIp` och
   * en text att visa i appen — ingenting som pekar ut en person. En angripare
   * kan alltså inte rikta en förfrågan mot ett offer; hen skulle behöva få
   * offret att själv skanna QR-koden eller trycka autostart.
   *
   * Kvar finns resursskyddet: varje anrop skapar en order hos BankID, och med
   * en skarp integration kostar det. Gränsen finns för det.
   */
  authStart: { limit: 20, windowMs: 60_000 },
  /** Polling av legitimeringsstatus: sker ofta, mjukare gräns. */
  authCollect: { limit: 60, windowMs: 60_000 },
  /** Start av BankID-underskriften över ett kuvert (/api/vote/sign-start). Ett anrop per röst. */
  signStart: { limit: 5, windowMs: 60_000 },
  /**
   * Inlämning av den krypterade, signerade valsedeln (fixrunda 1 av
   * uppgift 9:s granskning, fynd 3).
   *
   * /api/vote/encrypted är, till skillnad från /api/vote/sign-start, en
   * POLLNINGSRUTT: väljarens BankID-signering är oftast inte klar första
   * gången rutten anropas — svaret blir `pending`, och klienten frågar igen
   * om en sekund, precis som /api/auth/bankid/collect (se `authCollect`
   * ovan, samma resonemang). `signStart`s 5/min är satt för ETT anrop per
   * röst; den passar inte en rutt som normalt anropas ett
   * tiotal gånger per signering. Med `signStart`s gräns skulle en ärlig
   * väljare bli hastighetsbegränsad mitt i en egen, pågående signering.
   *
   * 150 per minut och adress (ruling 139). Röstsidan frågar varannan sekund, alltså 30
   * gånger per minut och väljare, så förut låg en enda väljare exakt på gränsen
   * och två bakom samma NAT blev strypta mitt i en egen signering. 150 ger plats
   * för fem väljare bakom samma adress, med pollningen i full takt.
   *
   * Gränsen skyddar inte längre mot kostsamma verifieringsförsök, och det är med
   * flit. Det som kostar är verifieringen av bevisen och hashningen, och de körs
   * först när BankID svarar att ordern är klar, en gång per order. Dem begränsar
   * ordern själv, som bara kan förbrukas en gång, och verifieringskön
   * (src/lib/crypto/server.ts) med sina platser. En pollning som får `pending` är
   * ett billigt anrop. Gränsen är kvar som skydd mot en klient som hamrar rutten.
   */
  castEncryptedBallot: { limit: 150, windowMs: 60_000 },
  /**
   * Jämförelsen av enhetens sparade chifferhash med det liggande kuvertet
   * (/api/vote/compare).
   *
   * Röstsidan frågar en gång när den laddas, för alla valsedlar på en gång,
   * så en väljare kommer aldrig nära gränsen. Gränsen finns för att rutten är
   * ett orakel: den svarar ja eller nej på om en viss hash är väljarens
   * liggande kuvert. Att gissa en hash är hopplöst, men den som redan har en
   * handfull kandidater, till exempel från en annan enhet, ska inte kunna
   * pröva dem i hög takt.
   */
  compareDeviceVotes: { limit: 20, windowMs: 60_000 },

  /**
   * Uppslag av en valsedels innehåll. Generös gräns — det är offentlig
   * information och en väljare slår upp tre valsedlar i rad. Gränsen finns för
   * att uppräkning inte ska bli ett billigt lastangrepp, inte för att skydda
   * innehållet.
   */
  ballotLookup: { limit: 60, windowMs: 60_000 },
  /** Admininloggning. */
  adminLogin: { limit: 5, windowMs: 300_000 },

  /** Adminstatistik. Läses om ofta medan en omröstning pågår. */
  adminStats: { limit: 120, windowMs: 60_000 },
  /** Det offentliga lägessvaret (uppgift 17). Det ger bara läget. */
  publicMode: { limit: 120, windowMs: 60_000 },
  /** Specen (uppgift 18). Den är statisk, men den är stor nog att inte vara gratis att hämta i en slinga. */
  publicOpenApi: { limit: 60, windowMs: 60_000 },

  /**
   * Det publicerade resultatet (uppgift 13). Varje hämtning räknar om
   * valsedlarna ur urnan och prövar varje bidrag, så en hämtning kostar
   * omkring en sekund för ett litet val och mer för ett stort. Gränsen finns
   * mot att det blir ett billigt lastangrepp. En granskare hämtar en gång och
   * sparar svaret.
   */
  observerResults: { limit: 10, windowMs: 60_000 },

  /** Skapa omröstning. Sällan-operation; gränsen finns mot felslagna skript. */
  createElection: { limit: 10, windowMs: 300_000 },

  /**
   * Förtroendepersonernas bidrag och räkningen (uppgift 12), per adress och
   * före inloggningen, så att en ström av begäranden inte når databasen.
   * Generös, eftersom tre förtroendepersoner kan sitta vid samma dator och
   * lämna ett bidrag per valsedel. Gränsen mot gissade fraser är nästa.
   */
  tallyCeremony: { limit: 60, windowMs: 60_000 },

  /**
   * En förtroendepersons bidrag, PER FÖRTROENDEPERSON OCH INTE PER ADRESS
   * (ruling 64).
   *
   * Det som gissas är en förtroendepersons fras, och den som byter adress för
   * varje försök ska inte få fler. Varje försök kostar dessutom en
   * scrypt-härledning. Tio på fem minuter räcker för en förtroendeperson som
   * lämnar sitt bidrag för var och en av demovalets tre valsedlar och prövar
   * igen efter en felskriven fras, och ger den som gissar knappt tre tusen
   * försök om dygnet, vart och ett med en rad i revisionsloggen. Ett val med
   * hundratals valsedlar behöver ett bidrag per omröstning i stället för per
   * valsedel, eller en högre gräns. Gränsen gäller förtroendepersonens nummer,
   * gemensamt för alla omröstningar, och den som når den hindrar ingen med ett
   * annat nummer. Rutten kräver dessutom en inloggad administratör.
   */
  trusteeContribution: { limit: 10, windowMs: 300_000 },

  /**
   * Prenumeration på notiser. En enhet prenumererar en gång och sedan sällan.
   * Gränsen hindrar att tabellen fylls med påhittade endpoints.
   */
  pushSubscribe: { limit: 5, windowMs: 300_000 },

  /**
   * Läsrutterna som saknade gräns (helgrensgranskningen, B10). Gränserna finns mot
   * att en slinga blir ett billigt lastangrepp, inte för att skydda innehållet, som
   * är offentligt.
   *
   * `publicElections` är GET /api/elections. Röstsidan frågar den var trettionde
   * sekund medan den är öppen, för att se om röstningen stängt, alltså två gånger i
   * minuten per flik. 600 i minuten rymmer trehundra flikar bakom samma adress, som
   * på ett bibliotek eller bakom en mobiloperatörs NAT.
   */
  publicElections: { limit: 600, windowMs: 60_000 },
  /** GET /api/push/subscribe, den publika VAPID-nyckeln. Hämtas en gång per sidvisning. */
  pushPublicKey: { limit: 60, windowMs: 60_000 },
  /**
   * GET /api/demo/database-state, livevyn i demoläget. Den frågar var tionde sekund,
   * sex gånger i minuten per flik, och varje anrop gör ett tjugotal frågor mot båda
   * databaserna. 60 i minuten rymmer tio flikar bakom samma adress.
   */
  demoDatabaseState: { limit: 60, windowMs: 60_000 },

  /**
   * Revisionsposten CSRF_REJECTED för en begäran med fel Origin, per adress
   * (helgrensgranskningen, ruling 145). Gäller posten, inte avvisningen, se
   * `recordRejectedOrigin` i src/modules/eligibility/audit.service.ts.
   */
  rejectedOrigin: { limit: 10, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>

/**
 * `firstRejection` är sant för det första avvisade anropet efter ett som släpptes
 * igenom, och falskt för resten (helgrensgranskningen, ruling 145). Rutterna skriver
 * revisionsposten RATE_LIMITED bara då. Skrevs den för varje avvisat anrop kunde en
 * oinloggad skriva poster utan gräns, och varje post tar ett löpnummer i kedjan.
 */
export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number; firstRejection: boolean }

/**
 * Tak för antal spårade nycklar.
 *
 * Utan det växer strukturen med en post per unik IP-adress och scope, och en
 * angripare med tillgång till många adresser kan driva upp minnesanvändningen
 * tills processen faller. En hastighetsbegränsare som går att använda för att
 * ta ned tjänsten är sämre än ingen alls.
 */
const MAX_TRACKED_KEYS = 10_000

/**
 * Städar bort nycklar vars hink hunnit fyllas på helt.
 *
 * En full hink är funktionellt identisk med en som inte finns: båda ger
 * `allowed: true` med maximalt antal kvarvarande försök. Att slänga dem
 * påverkar alltså inte begränsningen.
 */
function evictRefilledBuckets(rule: RateLimitRule, now: number): void {
  const refillRate = rule.limit / rule.windowMs

  for (const [key, bucket] of buckets) {
    const refilled = bucket.tokens + (now - bucket.lastRefill) * refillRate
    if (refilled >= rule.limit) buckets.delete(key)
  }
}

export function checkRateLimit(scope: string, rawKey: string, rule: RateLimitRule): RateLimitResult {
  const key = `${scope}:${sha256Hex(rawKey)}`
  const now = Date.now()
  const refillRate = rule.limit / rule.windowMs

  if (buckets.size >= MAX_TRACKED_KEYS && !buckets.has(key)) {
    evictRefilledBuckets(rule, now)
  }

  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = { tokens: rule.limit, lastRefill: now }
    buckets.set(key, bucket)
  }

  bucket.tokens = Math.min(rule.limit, bucket.tokens + (now - bucket.lastRefill) * refillRate)
  bucket.lastRefill = now

  if (bucket.tokens < 1) {
    const msUntilNextToken = (1 - bucket.tokens) / refillRate
    const firstRejection = bucket.refused !== true
    bucket.refused = true
    return { allowed: false, retryAfterSeconds: Math.ceil(msUntilNextToken / 1000), firstRejection }
  }

  bucket.tokens -= 1
  bucket.refused = false
  return { allowed: true, retryAfterSeconds: 0, firstRejection: false }
}

/** Endast för tester. */
export function resetRateLimits(): void {
  buckets.clear()
}
