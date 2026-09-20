import type { IBankIdService } from './IBankIdService'
import { MockBankIdService } from './MockBankIdService'

/**
 * Enda stället där implementationen väljs.
 *
 * Byte till skarp BankID görs här, när certifikat och konfiguration finns.
 * Resten av systemet är beroende av gränssnittet, inte av implementationen.
 */
export const bankIdService: IBankIdService = new MockBankIdService()

export type * from './IBankIdService'
