import { createHash } from 'node:crypto'
import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'

/**
 * SERVERNS TILLSTÅND PER BANKID-ORDER.
 *
 * Underskriften är en pollning. Väljaren startar en order i /api/vote/sign-start
 * och frågar sedan /api/vote/encrypted var annan sekund tills BankID är klart.
 * Förut bar varje fråga hela valsedeln, omkring 170 kB, så att servern hade den
 * när ordern blev klar. Nu lämnar sidan valsedeln en enda gång, vid starten, och
 * servern håller den här, under orderns referens. Pollningen bär bara
 * referensen.
 *
 * Lagret är det enda stället som håller något mellan de två anropen. Där
 * ligger också saltet för åtagandet över chifferhashen (uppgift 11e), som
 * skapas i sign-start och hålls på servern med ordern, så att det aldrig
 * behöver gå via klienten.
 *
 * GRÄNSSNITTET ÄR SMALT, PER ORDERREFERENS:
 *
 *   putOrder(orderRef, sessionId, state)  lägger ordern, eller returnerar false när lagret är fullt
 *   getOrder(orderRef, sessionId)         läser utan att förbruka, för en pollning som inte är klar
 *   takeOrder(orderRef, sessionId)        läser och tar bort, så att en order bara förbrukas en gång
 *   attachCompletion(orderRef, sessionId, completion)
 *                                         lägger BankID:s insamlade svar på ordern, med förfallet
 *                                         oförändrat, när kön var full; false om ordern saknas
 *
 * EN ORDER ÄR BUNDEN TILL VÄLJARENS SESSION. Referensen är en UUID som BankID
 * ger och som sidan skickar tillbaka, och en annan väljare som kommer över den
 * ska inte kunna hämta valsedeln. En annan session får därför `null`, och
 * ordern ligger kvar för sin egen väljare. Sessionen sparas som en hash, inte
 * som sitt id, så att lagret inte håller något som går att återanvända som
 * session.
 *
 * ORDERN FÖRFALLER. En order som aldrig blir klar, för att väljaren gav upp
 * eller tappade nätet, ligger inte kvar för alltid: efter `ORDER_LIFETIME_MS`
 * är den borta. Tiden följer BankID, som låter en order gå ut efter tre
 * minuter.
 *
 * LAGRET LOGGAR ALDRIG. Det har ingen loggning alls, och därmed ingenting som
 * kan läcka en referens, en session eller en valsedel dit.
 *
 * TILLSTÅNDET ÄR PER PROCESS, på samma villkor som inträdeskön
 * (`admission-queue-per-process` i begränsningslistan): med flera instanser
 * bakom en lastbalanserare kan pollningen hamna hos en instans som inte har
 * ordern, och väljaren får då skriva under igen. Det hänger på `globalThis`,
 * som attrappens ordrar, eftersom Next bygger om en rutt efter en stunds
 * inaktivitet och då laddar om modulen: en tabell i modulen själv fanns sedan i
 * flera upplagor, och en order lagd av sign-start fanns inte där
 * encrypted-rutten läste.
 */

/**
 * BankID:s svar när ordern är klar. Hålls bara om verifieringskön var full när
 * svaret kom, så att nästa pollning kan lägga rösten utan att fråga BankID igen:
 * ordern är förbrukad hos BankID, och väljaren ska inte behöva skriva under på nytt.
 * Innehåller en signatur och en certifikatkedja med väljarens personnummer, och
 * loggas därför aldrig.
 */
export type Completion = { signature: string; certificateChain: string[]; signedData: string }

/** Det servern håller för en order. */
export type OrderState = {
  ballotId: string
  /** Den krypterade valsedeln, med chiffer, bevis och hash. */
  ballot: EncryptedBallot
  /**
   * Saltet i åtagandet som BankID-ordern bär, se `ciphertextCommitment` i
   * src/modules/eligibility/bankid/envelope-signature.ts. Lämnar servern aldrig:
   * det skickas inte till klienten eller till BankID, och loggas inte.
   * Läggningen sparar det i `PendingVote`, och det raderas med raden vid
   * skalningen.
   */
  commitmentSalt: string
  /** BankID:s insamlade svar, när ordern är klar men rösten ännu inte lagd. */
  completion?: Completion
}

/** Hur länge en order som inte blir klar ligger kvar. BankID låter en order gå ut efter tre minuter. */
export const ORDER_LIFETIME_MS = 3 * 60_000

/**
 * Högsta antal ordrar samtidigt. En order håller en valsedel, och taket är
 * minnestaket. En riksdagsvalsedel med 26 alternativ är omkring 170 kB, så 500
 * ordrar är omkring 85 MB. Men valsedelns storlek följer antalet alternativ, och
 * schemat tillåter 200: omkring 1,3 MB per order, alltså upp till omkring 650 MB
 * när varje order är en sådan. `sign-start` kräver att antalet chiffer är
 * omröstningens, så en valsedel kan inte vara större än valsedeln den gäller.
 * Fullt lager avvisar en ny order, och väljaren får försöka igen om en stund.
 */
export const MAX_ORDERS = 500

/** Högsta antal ordrar per session. En väljare som startar om får sin äldsta order ersatt. */
export const MAX_ORDERS_PER_SESSION = 3

/**
 * Hur ofta timern städar bort förfallna ordrar (fixrunda 1 av uppgift 11e, ruling
 * 142). En förfallen order håller valsedeln och saltet, och ska inte ligga kvar
 * tills nästa väljare råkar anropa lagret.
 */
export const ORDER_SWEEP_INTERVAL_MS = 30_000

type Entry = { sessionKey: string; state: OrderState; expiresAt: number }

const globalForOrders = globalThis as typeof globalThis & {
  __orderStates?: Map<string, Entry>
  __orderSweeper?: ReturnType<typeof setInterval>
}

const orders: Map<string, Entry> = globalForOrders.__orderStates ?? new Map<string, Entry>()
globalForOrders.__orderStates = orders

/**
 * Startar timern första gången en order läggs. unref(), så att timern aldrig
 * håller processen vid liv. Den hänger på globalThis, som tabellen, så att en
 * omladdad modul inte startar en till.
 */
function ensureSweeper(): void {
  if (globalForOrders.__orderSweeper) return
  const sweeper = setInterval(() => sweep(Date.now()), ORDER_SWEEP_INTERVAL_MS)
  sweeper.unref?.()
  globalForOrders.__orderSweeper = sweeper
}

function sessionKeyOf(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex')
}

/** Tar bort det som förfallit. Körs vid varje anrop och av timern. */
function sweep(now: number): void {
  for (const [orderRef, entry] of orders) {
    if (entry.expiresAt <= now) orders.delete(orderRef)
  }
}

/**
 * Lägger en order. Returnerar false när lagret är fullt, och då är ingenting lagt.
 *
 * `now` finns för testerna, som inte ska behöva vänta tre minuter.
 */
export function putOrder(
  orderRef: string,
  sessionId: string,
  state: OrderState,
  now: number = Date.now(),
): boolean {
  sweep(now)
  ensureSweeper()
  const sessionKey = sessionKeyOf(sessionId)

  // Kapaciteten prövas FÖRE ersättningen: en avvisad order ska inte kosta sessionen
  // en order den redan hade.
  if (!orders.has(orderRef) && orders.size >= MAX_ORDERS) return false

  // Samma session har redan sina ordrar: den äldsta ersätts. Map håller
  // insättningsordningen, så den första träffen är den äldsta.
  const own = [...orders].filter(([, entry]) => entry.sessionKey === sessionKey)
  for (const [staleRef] of own.slice(0, Math.max(0, own.length - MAX_ORDERS_PER_SESSION + 1))) {
    orders.delete(staleRef)
  }

  orders.delete(orderRef)
  orders.set(orderRef, { sessionKey, state, expiresAt: now + ORDER_LIFETIME_MS })
  return true
}

function lookup(orderRef: string, sessionId: string, now: number): Entry | null {
  sweep(now)
  const entry = orders.get(orderRef)
  if (!entry) return null
  // Annan session: ordern finns inte för den, och ligger kvar för sin ägare.
  if (entry.sessionKey !== sessionKeyOf(sessionId)) return null
  return entry
}

/** Läser ordern utan att förbruka den. Null om den saknas, har förfallit eller tillhör en annan session. */
export function getOrder(
  orderRef: string,
  sessionId: string,
  now: number = Date.now(),
): OrderState | null {
  return lookup(orderRef, sessionId, now)?.state ?? null
}

/**
 * Lägger BankID:s insamlade svar på ordern, med ordern och dess förfall oförändrade.
 * Returnerar false om ordern saknas eller tillhör en annan session.
 */
export function attachCompletion(
  orderRef: string,
  sessionId: string,
  completion: Completion,
  now: number = Date.now(),
): boolean {
  const entry = lookup(orderRef, sessionId, now)
  if (!entry) return false
  entry.state = { ...entry.state, completion }
  return true
}

/** Läser ordern och tar bort den, så att den bara kan förbrukas en gång. */
export function takeOrder(
  orderRef: string,
  sessionId: string,
  now: number = Date.now(),
): OrderState | null {
  const entry = lookup(orderRef, sessionId, now)
  if (!entry) return null
  orders.delete(orderRef)
  return entry.state
}

/** Antal ordrar som ligger kvar, för testerna. */
export function orderCount(): number {
  return orders.size
}

/**
 * Tar bort varje order för valsedlarna, när omröstningen stängs (ruling 142).
 *
 * En order håller valsedeln och saltet. En övergiven order för en valsedel vars
 * chiffer ligger i urnan hade efter stängningen låtit den som läser processens
 * minne räkna åtagandet och känna igen BankID:s kopia. Stängningen anropar den
 * här, se close-election.usecase.ts.
 */
export function removeOrdersForBallots(ballotIds: readonly string[]): void {
  const ballots = new Set(ballotIds)
  for (const [orderRef, entry] of orders) {
    if (ballots.has(entry.state.ballotId)) orders.delete(orderRef)
  }
}

/** Endast för tester. Stoppar också timern, så att nästa order startar en ny med testets klocka. */
export function resetOrders(): void {
  orders.clear()
  if (globalForOrders.__orderSweeper) clearInterval(globalForOrders.__orderSweeper)
  globalForOrders.__orderSweeper = undefined
}
