import { randomUUID } from 'node:crypto'
import { env } from '@/lib/env'
import type {
  BankIdAuthOrder,
  BankIdAuthRequest,
  BankIdCollectResult,
  IBankIdService,
} from './IBankIdService'

/**
 * Attrapp för BankID.
 *
 * Simulerar det riktiga API:ets beteende: en order startas, klienten pollar
 * `collect` och får `pending` några gånger innan status blir `complete`.
 * Fördröjningen finns för att flödet i gränssnittet ska bli realistiskt —
 * en väljare ska hinna se att något händer.
 *
 * Ordertillståndet ligger i processminne. Det är rätt avvägning för en POC men
 * fel för drift: en omstart tappar alla pågående legitimeringar, och med flera
 * instanser hamnar polling-anropen på fel process.
 *
 * En riktig implementation byter ut den här klassen mot en som anropar
 * BankID:s REST-API med klientcertifikat. Ingen annan fil behöver ändras.
 */

type MockOrder = {
  personalNumber: string
  pollsRemaining: number
  cancelled: boolean
}

const orders = new Map<string, MockOrder>()

/**
 * Namn för demoändamål. Ett riktigt BankID-svar innehåller personens namn;
 * mocken hittar på ett så att flödet ser äkta ut.
 */
function demoName(personalNumber: string): string {
  const names = ['Alex Lindqvist', 'Kim Sandberg', 'Robin Ek', 'Charlie Näslund']
  const index = Number.parseInt(personalNumber.slice(-2), 10) % names.length
  return names[index] ?? names[0]
}

export class MockBankIdService implements IBankIdService {
  async auth(request: BankIdAuthRequest): Promise<BankIdAuthOrder> {
    const orderRef = randomUUID()

    orders.set(orderRef, {
      personalNumber: request.personalNumber ?? '',
      pollsRemaining: env.mockBankIdPollsUntilComplete,
      cancelled: false,
    })

    return {
      orderRef,
      // Riktiga BankID-QR-koder roteras varje sekund och är kryptografiskt
      // bundna till ordern. Här är det bara ett attrappvärde.
      qrData: `bankid.mock.${orderRef}`,
      autoStartToken: randomUUID(),
    }
  }

  async collect(orderRef: string): Promise<BankIdCollectResult> {
    const order = orders.get(orderRef)

    if (!order) {
      return { status: 'failed', hintCode: 'expiredTransaction' }
    }

    if (order.cancelled) {
      orders.delete(orderRef)
      return { status: 'failed', hintCode: 'userCancel' }
    }

    if (order.pollsRemaining > 0) {
      order.pollsRemaining -= 1
      return { status: 'pending', hintCode: 'userSign' }
    }

    orders.delete(orderRef)

    return {
      status: 'complete',
      completionData: {
        personalNumber: order.personalNumber,
        name: demoName(order.personalNumber),
      },
    }
  }

  async cancel(orderRef: string): Promise<void> {
    const order = orders.get(orderRef)
    if (order) order.cancelled = true
  }
}

/** Endast för tester. */
export function resetMockBankIdOrders(): void {
  orders.clear()
}
