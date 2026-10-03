import { runtimeMode } from '@/lib/mode-flag'

/**
 * OM APPEN KÖR I DEMOLÄGE, AVGJORT PÅ ETT ENDA STÄLLE.
 *
 * Demoläget släpper fram sådant som aldrig får finnas i drift: genvägen som
 * står för att någon skannar QR-koden (/api/demo/bankid-scan), nollställningen
 * av hastighetsbegränsningen (/api/demo/reset-rate-limits), demoåterställningen
 * och demofraserna, och röstlängdens innehåll i arkitektursidans livevy
 * (/api/demo/database-state och sidan själv).
 *
 * ALLA LÄSER DEN HÄR FUNKTIONEN. Tidigare läste var och en villkoret på egen
 * hand, och en av dem hade glömt det: database-state lämnade ut röstlängden
 * oavsett läge, medan sidan som visar den bara frågade i demoläget. En sida
 * som låter bli att fråga är inget skydd. tests/security/api-surface.test.ts
 * kräver att varje rutt under /api/demo börjar med att fråga den här
 * funktionen och svara 404 annars, och tests/security/demo-routes-behaviour.
 * test.ts kör rutterna med läget avstängt och kräver 404 utan databasåtkomst.
 *
 * Sedan uppgift 17 följer demoläget DEMO_MODE=true, satt vid driftsättning,
 * och inte längre av att BankID råkar vara en attrapp. Skarpt läge är förvalt.
 * Se src/lib/mode-flag.ts.
 */
export function isDemoMode(): boolean {
  return runtimeMode() === 'DEMO'
}
