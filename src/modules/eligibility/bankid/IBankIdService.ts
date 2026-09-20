/**
 * Abstraktion över BankID-legitimering.
 *
 * Poängen med gränssnittet är att `MockBankIdService` ska kunna bytas mot en
 * riktig BankID-implementation utan att någon annan del av systemet ändras.
 * Signaturerna följer därför den riktiga BankID-API:ets form: `auth` startar
 * en order och returnerar en referens, `collect` frågar efter status tills den
 * blir klar eller misslyckas.
 *
 * Observera vad gränssnittet INTE exponerar: ingen metod tar emot eller
 * returnerar något som har med röstning att göra. Legitimering och röst möts
 * först i orkestreringslagret, och bara under den korta stund en session lever.
 */

export type BankIdAuthOrder = {
  orderRef: string
  /** Data som klienten renderar som QR-kod. I mocken ett attrappvärde. */
  qrData: string
  autoStartToken: string
}

export type BankIdCollectPending = {
  status: 'pending'
  /** Meddelandenyckel enligt BankID:s meddelandekatalog. */
  hintCode: string
}

export type BankIdCollectComplete = {
  status: 'complete'
  completionData: {
    /** Personnummer. Får aldrig lämna eligibility-modulen. */
    personalNumber: string
    name: string
  }
}

export type BankIdCollectFailed = {
  status: 'failed'
  hintCode: string
}

export type BankIdCollectResult =
  | BankIdCollectPending
  | BankIdCollectComplete
  | BankIdCollectFailed

export type BankIdAuthRequest = {
  /**
   * Valfritt personnummer, som i BankID:s riktiga auth-anrop. Anges det binds
   * ordern till den personen; utelämnas det legitimerar sig den som skannar
   * QR-koden. POC:en använder den första varianten eftersom det ger ett
   * begripligt demoflöde utan app.
   */
  personalNumber?: string
}

export interface IBankIdService {
  /** Startar en legitimeringsorder. */
  auth(request: BankIdAuthRequest): Promise<BankIdAuthOrder>

  /** Frågar efter status för en pågående order. */
  collect(orderRef: string): Promise<BankIdCollectResult>

  /** Avbryter en pågående order. */
  cancel(orderRef: string): Promise<void>
}
