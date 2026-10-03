import type {
  BankIdAuthOrder,
  BankIdCollectResult,
  BankIdQrData,
  IBankIdService,
} from './IBankIdService'

/**
 * Tjänsten skarpt läge får när BANKID_ENV inte pekar ut någon BankID-miljö
 * (uppgift 17, och sedan 17c bara det fallet).
 *
 * Varje anrop kastar. Skarpt läge ska aldrig falla tillbaka på attrappen, och
 * en process som ändå startats i skarpt läge utan klient (uppstartsvakten
 * stoppar den, men vakten är en andra rad) ska inte kunna legitimera någon.
 * Att kasta är ett fel som syns, och att svara "misslyckad" vore ett som
 * ser ut som en väljare som tryckte avbryt.
 *
 * Med BANKID_ENV satt används klienten mot RP API v6.0 i stället, se ./index.ts.
 */
export class UnavailableBankIdService implements IBankIdService {
  private unavailable(): never {
    throw new Error(
      'Skarpt läge saknar en BankID-klient: BANKID_ENV pekar inte ut någon miljö. Attrappen används ' +
        'aldrig utanför demoläget, och ingen legitimering eller underskrift kan göras.',
    )
  }

  async auth(): Promise<BankIdAuthOrder> {
    return this.unavailable()
  }

  async sign(): Promise<BankIdAuthOrder> {
    return this.unavailable()
  }

  async qrData(): Promise<BankIdQrData | null> {
    return this.unavailable()
  }

  async collect(): Promise<BankIdCollectResult> {
    return this.unavailable()
  }

  async cancel(): Promise<void> {
    return this.unavailable()
  }
}
