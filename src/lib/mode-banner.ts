import { isDemoMode } from '@/lib/demo-mode'
import { configuredBankIdEnvironment } from '@/modules/eligibility/bankid/kind'

/**
 * BANDEROLLEN ÖVERST PÅ VARJE SIDA (uppgift 17, och fixrunda 1 av 17c).
 *
 *   demoläge                   attrappen, och inget riktigt val
 *   skarpt läge, BankID test   BankID:s testmiljö: vem som helst kan skaffa ett
 *                              test-BankID för vilket personnummer som helst, och
 *                              därmed rösta som vem som helst
 *   skarpt läge, produktion    ingen banderoll
 *
 * Testmiljön är riktiga BankID-flöden, och det är just därför den behöver en
 * banderoll: utan den ser den ut som ett riktigt val.
 */
export function modeBannerText(): string | null {
  if (isDemoMode()) return 'Demo, inte ett riktigt val. BankID är en attrapp.'
  if (configuredBankIdEnvironment() === 'test') {
    return (
      'Test: BankID:s testmiljö. Vem som helst kan skaffa ett test-BankID för vilket personnummer som ' +
      'helst, så identiteten är inte säkrad.'
    )
  }
  return null
}
