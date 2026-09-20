import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** SHA-256 som hex. Används för att hasha tokens före lagring. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * HMAC-SHA256 som hex. Används för identitetshashning.
 *
 * HMAC med hemligt pepper, inte ren SHA-256: svenska personnummer har omkring
 * 10^10 möjliga värden, vilket en modern GPU går igenom på under en minut.
 * Utan pepper är en hashad röstlängd alltså i praktiken en röstlängd i
 * klartext för den som kommit över databasen.
 */
export function hmacSha256Hex(input: string, key: string): string {
  return createHmac('sha256', key).update(input, 'utf8').digest('hex')
}

/** Kryptografiskt säkra slumpbytes. */
export function secureRandomBytes(length: number): Buffer {
  return randomBytes(length)
}

/**
 * Konstanttidsjämförelse av två hexsträngar.
 *
 * En vanlig `===` avbryter vid första skiljande tecknet, vilket läcker hur
 * många tecken som stämde. Det räcker för att gissa fram en hemlighet tecken
 * för tecken över tillräckligt många försök.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8')
  const bufferB = Buffer.from(b, 'utf8')
  if (bufferA.length !== bufferB.length) {
    // Jämför ändå mot sig själv för att inte göra längdskillnaden
    // mätbart snabbare än en innehållsskillnad.
    timingSafeEqual(bufferA, bufferA)
    return false
  }
  return timingSafeEqual(bufferA, bufferB)
}
