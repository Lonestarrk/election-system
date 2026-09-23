import type { IBankIdService } from './IBankIdService'
import { MockBankIdService } from './MockBankIdService'

/**
 * Enda stället där implementationen väljs.
 *
 * Byte till skarp BankID görs här, när certifikat och konfiguration finns.
 * Resten av systemet är beroende av gränssnittet, inte av implementationen.
 */
export const bankIdService: IBankIdService = new MockBankIdService()

/**
 * Om legitimeringen är en attrapp.
 *
 * Läses bara av `isDemoMode` i src/lib/demo-mode.ts, det enda ställe där
 * demoläget avgörs. Uttrycket är medvetet skrivet mot implementationen och
 * inte mot en miljövariabel: byts mocken ut blir värdet falskt automatiskt, i
 * stället för att hänga på att någon kommer ihåg att ändra konfigurationen.
 */
export const bankIdIsMocked: boolean = bankIdService instanceof MockBankIdService

export type * from './IBankIdService'
