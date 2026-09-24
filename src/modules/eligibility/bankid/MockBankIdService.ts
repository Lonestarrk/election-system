import {
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
  X509Certificate,
} from 'node:crypto'
import { env } from '@/lib/env'
import { truncateToDay } from '@/lib/time'
import { issueCertificate, issuerFrom } from './mock-ca/issue-certificate'
import {
  MOCK_BANKID_INTERMEDIATE_CERTIFICATE,
  MOCK_BANKID_INTERMEDIATE_PRIVATE_KEY,
} from './mock-ca/issuing-ca-test-key'
import { computeQrData, QR_ORDER_LIFETIME_SECONDS } from './qr'
import type {
  BankIdAuthOrder,
  BankIdAuthRequest,
  BankIdCollectResult,
  BankIdQrData,
  IBankIdService,
  SignRequest,
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

  /**
   * Sätts endast av `sign`. Skiljer en legitimeringsorder från en
   * signeringsorder, så att `collect` vet om den ska signera något vid
   * avslut.
   */
  userNonVisibleData: string | null
}

/**
 * ORDRARNA LIGGER PÅ globalThis, SOM PRISMA-KLIENTERNA I db.ts.
 *
 * Dev-servern bygger en rutt på nytt när den efterfrågas efter att ha stått
 * oanvänd i en minut, och laddar då om modulerna för de rutter som är aktiva
 * just då. En tabell i den här modulen fanns sedan i flera upplagor: en order
 * som /api/auth/bankid/start lagt i den ena fanns inte i den som
 * /api/auth/bankid/collect läste, och legitimeringen misslyckades direkt, utan
 * fel i koden. Det syntes som "Legitimeringen misslyckades" första gången en
 * rutt användes efter en paus, i e2e-sviten och i en körning i webbläsaren.
 *
 * En tabell på globalThis är densamma för varje upplaga av modulen i processen.
 * Med flera processer gäller fortfarande begränsningen ovan.
 */
const globalForMock = globalThis as unknown as { mockBankIdOrders?: Map<string, MockOrder> }

const orders: Map<string, MockOrder> = globalForMock.mockBankIdOrders ?? new Map<string, MockOrder>()
globalForMock.mockBankIdOrders = orders

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

/**
 * ATTRAPPEN ÄR SIN EGEN CERTIFIKATUTFÄRDARE (uppgift 14f).
 *
 * Ett riktigt BankID-certifikat är utfärdat av BankID:s CA och bär
 * personnumret i subject, som ett påstående från utfärdaren. Attrappen gör
 * likadant: vid varje underskrift utfärdar dess mellannivå ett X.509-certifikat
 * för väljarens nyckel, med personnumret som `serialNumber`, namnet i subject,
 * keyUsage digitalSignature och utan CA-rätt. Mellannivån är i sin tur utfärdad
 * av attrappens rot, och i demoläget prövas varje kedja mot den roten, se
 * `trusted-roots.ts`.
 *
 * Tidigare var "certifikatet" en publik nyckel med personnumret på en rad
 * ovanför, och ingenting prövade vem som stod för påståendet. Den som kunde
 * skriva i databasen skapade ett eget nyckelpar och en rad som godkändes.
 *
 * VAD DET INTE GER I DEMOLÄGET. Mellannivåns privata nyckel är incheckad, så
 * den som driver en demo kan utfärda ett giltigt certifikat för vem som helst.
 * Skyddet gäller med riktig BankID, där nyckeln finns hos BankID. Det står som
 * en känd begränsning i src/lib/known-limitations.ts.
 */
const issuingCertificate = new X509Certificate(MOCK_BANKID_INTERMEDIATE_CERTIFICATE)
const issuer = issuerFrom(issuingCertificate, createPrivateKey(MOCK_BANKID_INTERMEDIATE_PRIVATE_KEY))

/** Ett år, som ungefär ett riktigt BankID, men aldrig längre än mellannivån gäller. */
const CERTIFICATE_LIFETIME_MS = 365 * 86_400_000

function issueVoterChain(personalNumber: string, publicKey: KeyObject): string[] {
  const { name, givenName, surname } = demoName(personalNumber)

  /**
   * GILTIGT FRÅN DYGNETS BÖRJAN, INTE FRÅN SEKUNDEN DÅ DET UTFÄRDADES.
   *
   * Attrappen utfärdar ett nytt certifikat vid varje underskrift, så en
   * giltighetstid på sekunden vore underskriftens tidpunkt, och kedjan lagras i
   * röstlängden, där all tidsdata är avrundad till dygn (se src/lib/time.ts).
   * Krypterad är den visserligen, men den som har pepparn ska inte få veta mer
   * om när någon röstade än röstlängden i övrigt säger. Ett riktigt
   * BankID-certifikat har inte problemet: det utfärdas när personen skaffar sitt
   * BankID, inte när hon skriver under.
   */
  const validFrom = truncateToDay(new Date())

  const leaf = issueCertificate({
    subject: { country: 'SE', surname, givenName, serialNumber: personalNumber, commonName: name },
    publicKey,
    issuer,
    notBefore: validFrom,
    notAfter: new Date(
      Math.min(validFrom.getTime() + CERTIFICATE_LIFETIME_MS, issuingCertificate.validToDate.getTime()),
    ),
    ca: false,
    keyUsage: ['digitalSignature'],
  })

  // Lövet först och sedan mellannivån, utan roten, som BankID:s svar.
  return [leaf.toString(), issuingCertificate.toString()]
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
  /**
   * Ett nyckelpar per demoidentitet, hållet i minnet.
   *
   * Attrappen får inte returnera en påhittad sträng. Skulle den göra det
   * prövas verifieringen aldrig, och hela signaturkedjan vore otestad ända
   * tills någon kopplar in skarp BankID — alltså precis när ett fel kostar
   * som mest.
   */
  private readonly keys = new Map<string, { privateKey: KeyObject; publicKey: KeyObject }>()

  private keysFor(personalNumber: string) {
    const existing = this.keys.get(personalNumber)
    if (existing) return existing

    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })

    this.keys.set(personalNumber, pair)
    return pair
  }

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
      userNonVisibleData: null,
    })

    return { orderRef, autoStartToken: randomUUID() }
  }

  async sign(request: SignRequest): Promise<BankIdAuthOrder> {
    const orderRef = randomUUID()

    orders.set(orderRef, {
      qrStartToken: randomUUID(),
      qrStartSecret: randomBytes(32).toString('hex'),
      startedAt: Date.now(),
      demoPersonalNumber: null,
      pollsRemaining: env.mockBankIdPollsUntilComplete,
      cancelled: false,
      // Det som faktiskt signeras. Ligger kvar på ordern tills `collect`
      // avslutar den, precis som skarpt BankID håller kvar begäran under
      // hela legitimeringen.
      userNonVisibleData: request.userNonVisibleData,
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
    const { userNonVisibleData } = order
    orders.delete(orderRef)

    // Auth-ordrar signerar ingenting — det finns inget innehåll att binda en
    // signatur till, och nyckelparet slösas inte bort på att räknas fram i
    // onödan. Fälten är ändå obligatoriska i typen, så att den som konsumerar
    // en sign-order aldrig behöver hantera att de saknas.
    let signature = ''
    let certificateChain: string[] = []
    if (userNonVisibleData) {
      const { privateKey, publicKey } = this.keysFor(personalNumber)
      signature = createSign('sha256').update(userNonVisibleData).end().sign(privateKey, 'base64')
      certificateChain = issueVoterChain(personalNumber, publicKey)
    }

    return {
      status: 'complete',
      completionData: {
        personalNumber,
        ...demoName(personalNumber),
        signature,
        certificateChain,
        // Ordagrant vad som signerades — se dokumentationen på fältet i
        // IBankIdService.ts för varför anroparen inte får bygga om det.
        signedData: userNonVisibleData ?? '',
      },
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
