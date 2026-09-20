import { hmacSha256Hex } from '@/lib/crypto'
import { env } from '@/lib/env'

/**
 * Omvandlar ett personnummer till det hash som lagras i röstlängden.
 *
 * Personnumret lämnar aldrig den här modulen i klartext och lagras aldrig.
 *
 * Valet av HMAC med hemligt pepper i stället för ren hashning är avgörande:
 * ett svenskt personnummer har ungefär 10^10 möjliga värden. En ren SHA-256
 * av en röstlängd går därför att vända på med uttömmande sökning på en modern
 * GPU inom minuter — den hashade röstlängden vore i praktiken en röstlängd i
 * klartext. Med ett hemligt pepper krävs att angriparen får tag på både
 * databasen och applikationens konfiguration.
 */
export function hashPersonalNumber(personalNumber: string): string {
  const normalised = personalNumber.replace(/\D/g, '')
  return hmacSha256Hex(normalised, env.identityPepper)
}
