import { scryptHex } from '@/lib/crypto'
import { env } from '@/lib/env'

/**
 * Omvandlar ett personnummer till det hash som lagras i röstlängden.
 *
 * Personnumret lämnar aldrig den här modulen i klartext och lagras aldrig.
 *
 * VARFÖR scrypt OCH INTE HMAC-SHA256
 *
 * Tidigare användes HMAC-SHA256 med peppret som nyckel. Peppret gjorde jobbet:
 * utan känd nyckel går HMAC inte att vända på genom att gissa personnummer.
 *
 * Men läcker peppret — och det ligger i samma miljö som applikationen, så det
 * som läcker ena läcker ofta andra — kollapsar skyddet omedelbart. Svenska
 * personnummer har bara omkring 4 · 10^7 realistiska värden, och SHA-256 går
 * igenom hela mängden på sekunder på en GPU. Den hashade röstlängden vore då i
 * praktiken en röstlängd i klartext, komplett med folkbokföringskommun — vilket
 * för någon med skyddad identitet är precis den uppgift som inte får finnas.
 *
 * scrypt tvingar varje försök att allokera 32 MiB och tar ungefär 100 ms.
 * Samma uttömmande sökning går från sekunder till storleksordningen månader av
 * processortid, och minneshårdheten gör den svår att parallellisera på GPU.
 *
 * VAD DET INTE LÖSER
 *
 * En riktad kontroll av EN person kostar ett anrop. Skyddet gäller
 * massreversering — det som förvandlar spridda, delvis offentliga uppgifter
 * till en enda fil över alla väljare.
 *
 * ASYNKRON MED FLIT
 *
 * `scryptSync` skulle blockera event-loopen i 100 ms per legitimering och
 * serialisera hela servern. Den asynkrona varianten kör på libuv:s trådpool.
 */
export async function hashPersonalNumber(personalNumber: string): Promise<string> {
  const normalised = personalNumber.replace(/\D/g, '')
  return scryptHex(normalised, env.identityPepper)
}
