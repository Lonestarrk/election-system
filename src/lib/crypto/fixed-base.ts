/**
 * FÖRBERÄKNADE TABELLER FÖR EN FAST BAS.
 *
 * VARFÖR
 *
 * Väljarens webbläsare krypterar valsedeln själv, i ren BigInt. En
 * exponentiering med 2048 bitar kostar där omkring 4,4 ms (spec 4.1), och en
 * riksdagsvalsedel med 26 alternativ behöver omkring 236 stycken. Två av
 * baserna är desamma i varje kryptering under ett val: generatorn g och valets
 * publika nyckel h. Tre av fyra exponentieringar i krypteringen har någon av
 * dem som bas. De två andra baserna i beviset, c1 och målet för c2, beror på
 * chiffret och har ingen tabell.
 *
 * HUR
 *
 * Exponenten skrivs i bas 2^w, alltså e = Σ e_i · 2^(w·i). Tabellen håller
 * bas^(j · 2^(w·i)) för varje fönster i och varje siffra j från 1 till 2^w − 1.
 * Då är
 *
 *   bas^e = Π_i tabell[i][e_i]
 *
 * en multiplikation per fönster som inte är noll, och ingen kvadrering alls.
 * Den vanliga metoden i group.ts gör en kvadrering per bit och en
 * multiplikation per etta, för 2048 bitar omkring 3 000 multiplikationer.
 *
 * Priset är tabellen: ⌈bitar / w⌉ · (2^w − 1) tal om 256 byte, och lika många
 * multiplikationer för att bygga den. Fönsterbredden väljs i group.ts, efter
 * mätningarna i scripts/measure-crypto.ts.
 *
 * INTE KONSTANT TID
 *
 * Vilka tabellrader som läses beror på exponentens siffror, precis som
 * kvadrera-och-multiplicera i group.ts beror på dess bitar. Ren BigInt i en
 * webbläsare är inte konstant i tid oavsett metod. Servern räknar med hemliga
 * exponenter i OpenSSL i stället, se native-exponentiation.ts.
 */

export type FixedBaseTable = {
  /** bas^exponent mod modulus, eller null när exponenten ligger utanför tabellen. */
  pow(exponent: bigint): bigint | null
  /** Antal tal i tabellen, för mätningarna. */
  readonly entries: number
}

export function buildFixedBaseTable(
  base: bigint,
  modulus: bigint,
  exponentBits: number,
  windowBits: number,
): FixedBaseTable {
  if (base < 0n || base >= modulus) {
    throw new Error('Basen i en tabell måste ligga i [0, modulus).')
  }
  if (!Number.isInteger(windowBits) || windowBits < 1 || windowBits > 16) {
    throw new Error('Fönsterbredden måste vara ett heltal mellan 1 och 16.')
  }

  const windows = Math.ceil(exponentBits / windowBits)
  const perWindow = 2 ** windowBits - 1
  const table: bigint[] = []

  // windowBase är bas^(2^(w·i)). Raden för fönster i är dess potenser 1 … 2^w − 1,
  // och nästa fönsters bas är radens sista tal gånger windowBase en gång till.
  let windowBase = base
  for (let window = 0; window < windows; window += 1) {
    let entry = windowBase
    table.push(entry)
    for (let digit = 2; digit <= perWindow; digit += 1) {
      entry = (entry * windowBase) % modulus
      table.push(entry)
    }
    windowBase = (entry * windowBase) % modulus
  }

  const maximumBits = windows * windowBits

  return {
    entries: table.length,
    pow(exponent: bigint): bigint | null {
      if (exponent < 0n) return null

      const bits = exponent.toString(2)
      if (bits.length > maximumBits) return null

      // Fönstren läses från den minst signifikanta änden, w bitar i taget.
      let result = 1n
      for (let window = 0, end = bits.length; end > 0; window += 1, end -= windowBits) {
        const digit = parseInt(bits.slice(Math.max(0, end - windowBits), end), 2)
        if (digit !== 0) result = (result * table[window * perWindow + digit - 1]!) % modulus
      }
      return result
    },
  }
}
