import { bankIdIsMocked } from '@/modules/eligibility/bankid'

/**
 * OM APPEN KÖR I DEMOLÄGE, AVGJORT PÅ ETT ENDA STÄLLE.
 *
 * Demoläget släpper fram sådant som aldrig får finnas i drift: genvägen som
 * står för att någon skannar QR-koden (/api/demo/bankid-scan), nollställningen
 * av hastighetsbegränsningen (/api/demo/reset-rate-limits) och röstlängdens
 * innehåll i arkitektursidans livevy (/api/demo/database-state och sidan
 * själv).
 *
 * ALLA LÄSER DEN HÄR FUNKTIONEN, OCH INGEN LÄSER `bankIdIsMocked` SJÄLV.
 *
 * Tidigare läste var och en villkoret på egen hand, och en av dem hade glömt
 * det: database-state lämnade ut röstlängden oavsett läge, medan sidan som
 * visar den bara frågade i demoläget. En sida som låter bli att fråga är inget
 * skydd. Med villkoret på fyra ställen hade samma sak kunnat hända åt andra
 * hållet när uppgift 17 byter predikatet: den som följer kommentaren på ett
 * ställe döljer livevyn, medan rutten fortsätter att svara.
 * tests/security/api-surface.test.ts kräver därför att varje rutt under
 * /api/demo börjar med att fråga den här funktionen, och att ingen fil utom
 * den här läser `bankIdIsMocked`.
 *
 * I dag är demoläget detsamma som att BankID är en attrapp. Uttrycket är
 * skrivet mot implementationen och inte mot en miljövariabel: byts attrappen
 * ut blir svaret falskt av sig självt, utan konfiguration att komma ihåg.
 *
 * Uppgift 17 byter uttrycket mot lägesväxeln (`runtimeMode() === 'DEMO'`).
 * Det är raden nedan, och bara den.
 */
export function isDemoMode(): boolean {
  return bankIdIsMocked
}
