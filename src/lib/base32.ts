/**
 * Crockford base32.
 *
 * Alfabetet utelämnar I, L, O och U. De tre första för att de förväxlas med 1,
 * 1 och 0 när någon läser upp eller skriver av sin token; U för att undvika att
 * slumpen råkar stava olämpliga ord.
 *
 * Ligger i en egen fil utan beroenden så att både applikationen och
 * seedskriptet kan använda samma implementation. Seedskriptet körs av tsx
 * utanför Next.js modulupplösning och importerar den här filen relativt.
 */

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function encodeCrockfordBase32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8

    while (bits >= 5) {
      output += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }

  if (bits > 0) {
    output += CROCKFORD_ALPHABET[(value << (5 - bits)) & 31]
  }

  return output
}

/**
 * Normaliserar en sträng som en människa skrivit av.
 *
 * Följer Crockfords avkodningsregler: versaler, bindestreck och mellanslag
 * ignoreras, och tecken som ser lika ut tolkas som varandra. Utan det skulle en
 * väljare som läst av sin token fel få beskedet att rösten inte finns — ett
 * onödigt alarmerande svar på ett avskrivningsfel.
 */
export function normaliseCrockfordBase32(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
}
