import { runtimeMode } from '@/lib/mode-flag'
import type { IBankIdService } from './IBankIdService'
import { MockBankIdService } from './MockBankIdService'
import { UnavailableBankIdService } from './UnavailableBankIdService'

/**
 * Enda stället där implementationen väljs.
 *
 * Attrappen byggs bara i demoläget. Skarpt läge får en tjänst som vägrar varje
 * anrop, tills uppgift 17c lägger in klienten mot BankID:s RP-API. Läget läses
 * en gång, när modulen laddas: en process byter aldrig läge, och en tjänst som
 * valdes i ett läge ska inte kunna bli en annan av att variabeln ändras.
 *
 * Resten av systemet är beroende av gränssnittet, inte av implementationen.
 */
export const bankIdService: IBankIdService =
  runtimeMode() === 'DEMO' ? new MockBankIdService() : new UnavailableBankIdService()

export type * from './IBankIdService'
