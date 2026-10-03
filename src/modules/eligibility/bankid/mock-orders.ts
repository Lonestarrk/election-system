import { ORDER_LIFETIME_MS, ORDER_SWEEP_INTERVAL_MS } from '@/lib/order-state'
import { parseEnvelopePayload } from './envelope-signature'

/**
 * ATTRAPPENS ORDRAR, I EN EGEN MODUL (fixrunda 1 av uppgift 11e, ruling 142).
 *
 * Tabellen låg förut i MockBankIdService.ts. Stängningen ska kunna glömma
 * omröstningens ordrar utan att ladda attrappen, som bär mellannivåns incheckade
 * nyckel, så tabellen och städningen ligger här. I skarpt läge är tabellen tom,
 * och att glömma i den gör ingenting.
 */

export type MockOrder = {
  qrStartToken: string
  qrStartSecret: string
  startedAt: number
  /** Vem som "legitimerar sig". Sätts av demovalet, aldrig av en riktig BankID. */
  demoPersonalNumber: string | null
  pollsRemaining: number
  cancelled: boolean

  /**
   * Sätts endast av `sign`. Skiljer en legitimeringsorder från en
   * signeringsorder, så att `collect` vet om den ska signera något vid
   * avslut.
   */
  userNonVisibleData: string | null

  /** När ordern förfaller, se `sweepExpiredMockOrders`. */
  expiresAt: number
}

/**
 * ORDRARNA LIGGER PÅ globalThis, SOM PRISMA-KLIENTERNA I db.ts.
 *
 * Dev-servern bygger en rutt på nytt när den efterfrågas efter att ha stått
 * oanvänd i en minut, och laddar då om modulerna för de rutter som är aktiva
 * just då. En tabell i modulen själv fanns sedan i flera upplagor: en order
 * som /api/auth/bankid/start lagt i den ena fanns inte i den som
 * /api/auth/bankid/collect läste, och legitimeringen misslyckades direkt, utan
 * fel i koden. Det syntes som "Legitimeringen misslyckades" första gången en
 * rutt användes efter en paus, i e2e-sviten och i en körning i webbläsaren.
 *
 * En tabell på globalThis är densamma för varje upplaga av modulen i processen.
 * Med flera processer hamnar polling-anropen fortfarande på fel process.
 */
const globalForMock = globalThis as unknown as {
  mockBankIdOrders?: Map<string, MockOrder>
  mockBankIdSweeper?: ReturnType<typeof setInterval>
}

export const mockOrders: Map<string, MockOrder> =
  globalForMock.mockBankIdOrders ?? new Map<string, MockOrder>()
globalForMock.mockBankIdOrders = mockOrders

/** Livslängden för en ny order, samma som i orderlagret: tre minuter, som hos BankID. */
export function mockOrderExpiry(now: number): number {
  return now + ORDER_LIFETIME_MS
}

/**
 * EN ORDER FÖRFALLER EFTER ORDERNS LIVSLÄNGD (uppgift 11e).
 *
 * En signeringsorder bär det signerade och, när någon valt identitet, väljarens
 * personnummer. Förut togs den bort först när collect hämtade den, så en order
 * som väljaren övergav låg kvar tills servern startades om. Nu förfaller den
 * efter samma tid som orderlagret (src/lib/order-state.ts). Städningen körs vid
 * varje anrop och av en timer, så att en övergiven order inte ligger kvar tills
 * nästa väljare anropar attrappen (ruling 142).
 */
export function sweepExpiredMockOrders(now: number): void {
  for (const [orderRef, order] of mockOrders) {
    if (order.expiresAt <= now) mockOrders.delete(orderRef)
  }
}

/** Startar timern första gången en order läggs. unref(), så att den aldrig håller processen vid liv. */
export function ensureMockSweeper(): void {
  if (globalForMock.mockBankIdSweeper) return
  const sweeper = setInterval(() => sweepExpiredMockOrders(Date.now()), ORDER_SWEEP_INTERVAL_MS)
  sweeper.unref?.()
  globalForMock.mockBankIdSweeper = sweeper
}

/**
 * Glömmer omröstningens signeringsordrar, när den stängs (ruling 142).
 *
 * En signeringsorder bär det signerade, med åtagandet, och personnumret. En
 * riktig BankID sparar sin kopia ändå, men attrappen är en del av systemet, och
 * systemet ska inte hålla något om omröstningen efter stängningen.
 * Legitimeringar bär inget signerat och ligger kvar.
 */
export function forgetMockOrdersForElection(electionId: string): void {
  for (const [orderRef, order] of mockOrders) {
    if (order.userNonVisibleData === null) continue
    if (parseEnvelopePayload(order.userNonVisibleData)?.electionId === electionId) {
      mockOrders.delete(orderRef)
    }
  }
}

/** Endast för tester. Stoppar också timern, så att nästa order startar en ny med testets klocka. */
export function resetMockOrders(): void {
  mockOrders.clear()
  if (globalForMock.mockBankIdSweeper) clearInterval(globalForMock.mockBankIdSweeper)
  globalForMock.mockBankIdSweeper = undefined
}
