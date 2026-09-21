import { randomBytes, randomUUID } from 'node:crypto'
import { env } from '@/lib/env'
import { computeQrData, QR_ORDER_LIFETIME_SECONDS } from './qr'
import type {
  BankIdAuthOrder,
  BankIdAuthRequest,
  BankIdCollectResult,
  BankIdQrData,
  IBankIdService,
} from './IBankIdService'

/**
 * Attrapp för BankID v6.
 *
 * Simulerar det riktiga API:ets beteende: en order startas och ger en
 * autostart-token plus underlaget för en animerad QR-kod. Klienten pollar
 * `collect` och får `pending` några gånger innan status blir `complete`.
 *
 * QR-KODEN ÄR INTE EN ATTRAPP.
 *
 * Tokens och hemligheten slumpas lokalt i stället för att komma från BankID,
 * men koderna räknas fram med exakt samma algoritm som det skarpa API:et
 * kräver: HMAC-SHA256 över sekunder sedan ordern startade. Det gör att
 * animeringen, uppdateringstakten och klientens hantering kan utvecklas och
 * testas mot verkligt beteende — och att bytet till skarp BankID inte avslöjar
 * att QR-hanteringen aldrig provats.
 *
 * VARFÖR DEMOIDENTITETEN LIGGER I MOCKEN OCH INTE I GRÄNSSNITTET
 *
 * Det skarpa API:et tar inget personnummer: identiteten kommer ur BankID:s
 * svar efter att personen legitimerat sig med sin egen app. En demo behöver
 * ändå kunna visa olika fall — röstberättigad, inte röstberättigad,
 * administratör — och därför finns `selectDemoIdentity` HÄR, utanför
 * `IBankIdService`.
 *
 * Placeringen är själva skyddet. Funktionen finns inte i gränssnittet, så en
 * rutt som anropar den kompilerar bara så länge mocken är aktiv. Byts den mot
 * en riktig implementation faller anropet vid kompilering i stället för att
 * tyst bli en väg att legitimera sig som vem som helst.
 *
 * Ordertillståndet ligger i processminne. Rätt avvägning för en POC, fel för
 * drift: en omstart tappar alla pågående legitimeringar, och med flera
 * instanser hamnar polling-anropen på fel process. Ett riktigt system lägger
 * dem i en delad lagring med kort livslängd.
 */

type MockOrder = {
  qrStartToken: string
  qrStartSecret: string
  startedAt: number
  /** Vem som "legitimerar sig". Sätts av demovalet, aldrig av en riktig BankID. */
  demoPersonalNumber: string | null
  pollsRemaining: number
  cancelled: boolean
}

const orders = new Map<string, MockOrder>()

/**
 * Namn för demoändamål. Ett riktigt BankID-svar innehåller personens namn;
 * mocken hittar på ett så att flödet ser äkta ut.
 */
const DEMO_NAMES: Record<string, { givenName: string; surname: string }> = {
  '199001011234': { givenName: 'Anna', surname: 'Lindqvist' },
  '198505152345': { givenName: 'Kim', surname: 'Sandberg' },
  '197012123456': { givenName: 'Robin', surname: 'Ek' },
  '196003015678': { givenName: 'Charlie', surname: 'Näslund' },
  '195507076789': { givenName: 'Mira', surname: 'Holmberg' },
  '199912317890': { givenName: 'Noa', surname: 'Wikander' },
  '201001014567': { givenName: 'Elis', surname: 'Ström' },
  '194204048901': { givenName: 'Gunvor', surname: 'Björk' },
  '198001019876': { givenName: 'Alex', surname: 'Falk' },
}

function demoName(personalNumber: string): { name: string; givenName: string; surname: string } {
  const known = DEMO_NAMES[personalNumber] ?? { givenName: 'Demo', surname: 'Person' }
  return {
    name: `${known.givenName} ${known.surname}`,
    givenName: known.givenName,
    surname: known.surname,
  }
}

export class MockBankIdService implements IBankIdService {
  async auth(_request: BankIdAuthRequest): Promise<BankIdAuthOrder> {
    const orderRef = randomUUID()

    orders.set(orderRef, {
      // Riktiga värden kommer från BankID. Formatet är detsamma: 32 byte som
      // base64 respektive hex, beroende på fält.
      qrStartToken: randomUUID(),
      qrStartSecret: randomBytes(32).toString('hex'),
      startedAt: Date.now(),
      demoPersonalNumber: null,
      pollsRemaining: env.mockBankIdPollsUntilComplete,
      cancelled: false,
    })

    return { orderRef, autoStartToken: randomUUID() }
  }

  async qrData(orderRef: string): Promise<BankIdQrData | null> {
    const order = orders.get(orderRef)
    if (!order || order.cancelled) return null

    const elapsedSeconds = Math.floor((Date.now() - order.startedAt) / 1000)
    if (elapsedSeconds > QR_ORDER_LIFETIME_SECONDS) return null

    return {
      // Hemligheten stannar här inne. Klienten får bara den färdiga strängen.
      qrData: computeQrData(order.qrStartToken, order.qrStartSecret, elapsedSeconds),
      elapsedSeconds,
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

    // Ingen har valt identitet i demon än — motsvarar att ingen skannat
    // QR-koden eller öppnat appen. BankID svarar då med att ordern är
    // utestående.
    if (!order.demoPersonalNumber) {
      return { status: 'pending', hintCode: 'outstandingTransaction' }
    }

    if (order.pollsRemaining > 0) {
      order.pollsRemaining -= 1
      // userSign: appen är öppnad och väntar på att personen skriver sin kod.
      return { status: 'pending', hintCode: 'userSign' }
    }

    const personalNumber = order.demoPersonalNumber
    orders.delete(orderRef)

    return {
      status: 'complete',
      completionData: { personalNumber, ...demoName(personalNumber) },
    }
  }

  async cancel(orderRef: string): Promise<void> {
    const order = orders.get(orderRef)
    if (order) order.cancelled = true
  }
}

/**
 * ENDAST FÖR DEMO. Motsvarar att någon skannar QR-koden med sin BankID-app.
 *
 * Finns medvetet utanför `IBankIdService` — se klassens dokumentation. Byts
 * mocken mot en riktig implementation slutar den här funktionen existera, och
 * varje anrop till den faller vid kompilering.
 */
export function selectDemoIdentity(orderRef: string, personalNumber: string): boolean {
  const order = orders.get(orderRef)
  if (!order || order.cancelled) return false

  order.demoPersonalNumber = personalNumber.replace(/\D/g, '')
  return true
}

/** Endast för tester. */
export function resetMockBankIdOrders(): void {
  orders.clear()
}
