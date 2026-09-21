/**
 * Abstraktion över BankID-legitimering, enligt BankID API v6.
 *
 * Poängen med gränssnittet är att `MockBankIdService` ska kunna bytas mot en
 * riktig implementation utan att någon annan del av systemet ändras.
 * Signaturerna följer därför det skarpa API:ets form.
 *
 * DET FINNS INGET PERSONNUMMER I AUTH-ANROPET, OCH DET ÄR AVSIKTLIGT.
 *
 * BankID v6 (Secure Start) tillåter inte längre flöden där användaren skriver
 * in sitt personnummer. Legitimeringen startas i stället på ett av två sätt:
 *
 *   – ANNAN ENHET: en animerad QR-kod som väljaren skannar med sin BankID-app.
 *   – SAMMA ENHET: en autostart-token som öppnar BankID-appen lokalt.
 *
 * Skälet BankID anger är att en illasinnad app annars kan förmå någon att
 * signera något genom att mata in ett personnummer den fått tag på. Att koden
 * eller autostarten binder ordern till just den enhet som har appen stänger
 * det.
 *
 * FÖR DET HÄR SYSTEMET ÄR DET EN FÖRBÄTTRING, INTE BARA ETT KRAV.
 *
 * Den tidigare inmatningsrutan var ett uppslagsverk mot röstlängden i
 * förklädnad. Den svarade medvetet likadant oavsett om personnumret fanns i
 * röstlängden eller inte — men den tog ändå emot godtyckliga personnummer från
 * vem som helst. Nu kommer personnumret först i BankID:s eget svar, efter att
 * personen legitimerat sig på sin egen enhet med sin egen app. Systemet kan
 * inte längre tillfrågas om ett personnummer det inte redan fått.
 *
 * Observera också vad gränssnittet INTE exponerar: ingen metod tar emot eller
 * returnerar något som har med röstning att göra. Legitimering och röst möts
 * först vid utfärdandet av röstintyget.
 */

export type BankIdAuthOrder = {
  orderRef: string

  /**
   * Token som öppnar BankID-appen på samma enhet.
   *
   * Används i en URL enligt BankID:s specifikation:
   *   bankid:///?autostarttoken=<token>&redirect=null
   *
   * På iOS krävs universal link-varianten i stället:
   *   https://app.bankid.com/?autostarttoken=<token>&redirect=null
   *
   * `redirect=null` betyder att appen avslutas utan att öppna någon URL, så
   * att den anropande sidan hamnar i fokus igen. Ett värde där skulle skicka
   * väljaren vidare — och en URL som går att styra utifrån är en
   * omdirigeringssårbarhet i ett flöde som just legitimerat någon.
   */
  autoStartToken: string
}

export type BankIdCollectPending = {
  status: 'pending'
  /**
   * Meddelandenyckel enligt BankID:s meddelandekatalog.
   * outstandingTransaction | noClient | started | userSign | userMrtd
   */
  hintCode: string
}

export type BankIdCollectComplete = {
  status: 'complete'
  completionData: {
    /**
     * Personnummer, hämtat ur BankID:s svar.
     *
     * Detta är den ENDA vägen ett personnummer kommer in i systemet. Det
     * skrivs aldrig in av någon och kan inte gissas fram — det kommer från
     * BankID efter att personen bevisat vem hen är.
     *
     * Får aldrig lämna eligibility-modulen.
     */
    personalNumber: string
    name: string
    givenName: string
    surname: string
  }
}

export type BankIdCollectFailed = {
  status: 'failed'
  /**
   * expiredTransaction | certificateErr | userCancel | cancelled | startFailed
   */
  hintCode: string
}

export type BankIdCollectResult =
  | BankIdCollectPending
  | BankIdCollectComplete
  | BankIdCollectFailed

export type BankIdAuthRequest = {
  /**
   * Väljarens IP-adress, som BankID:s `endUserIp`.
   *
   * BankID kräver den för sin egen riskbedömning. Systemet lagrar den inte och
   * loggar den inte — den passerar till BankID och kastas.
   */
  endUserIp: string

  /** Text som visas i BankID-appen. Ska säga vad personen legitimerar sig för. */
  userVisibleData?: string
}

/**
 * Den animerade QR-kodens aktuella data.
 *
 * Beräknas på servern varje gång den efterfrågas, eftersom den bygger på
 * `qrStartSecret` — som enligt BankID:s specifikation aldrig får lämna
 * servern. Klienten får bara den färdiga strängen, som är värdelös en sekund
 * senare.
 */
export type BankIdQrData = {
  /** bankid.<qrStartToken>.<sekunder>.<qrAuthCode> */
  qrData: string
  /** Sekunder sedan ordern startades. Hjälper klienten veta om den är aktuell. */
  elapsedSeconds: number
}

export interface IBankIdService {
  /** Startar en legitimeringsorder. */
  auth(request: BankIdAuthRequest): Promise<BankIdAuthOrder>

  /**
   * Den animerade QR-kodens data just nu.
   *
   * Returnerar null om ordern inte finns eller har gått ut. BankID:s
   * specifikation anger att koden ska uppdateras varje sekund.
   */
  qrData(orderRef: string): Promise<BankIdQrData | null>

  /** Frågar efter status för en pågående order. */
  collect(orderRef: string): Promise<BankIdCollectResult>

  /** Avbryter en pågående order. */
  cancel(orderRef: string): Promise<void>
}
