/**
 * DER-KODAREN SOM BARA ATTRAPPEN BEHÖVER.
 *
 * node:crypto kan läsa och pröva X.509-certifikat men inte skapa dem. Attrappen
 * ska utfärda ett certifikat vid varje underskrift, så den bygger sin
 * TBSCertificate själv, med de få DER-typer ett certifikat använder, och
 * signerar den med mellannivåns nyckel.
 *
 * INGENTING I DRIFT FÅR IMPORTERA DEN HÄR FILEN.
 *
 * Riktig BankID skapar certifikaten hos sig, och systemet ska bara läsa och
 * pröva dem. En kodare i produktionskoden vore en väg att skapa certifikat där
 * det aldrig ska göras, och tests/security/module-boundaries.test.ts kräver att
 * bara attrappen och testerna importerar den. Läsaren, som driften behöver,
 * ligger för sig i ../der-reader.ts.
 *
 * Kodaren litar på sin anropare, som är attrappen eller ett test. Den kastar
 * vid ett värde den inte kan koda, eftersom det då är koden som är fel och
 * inte indata från någon utanför.
 */

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.of(length)

  const bytes: number[] = []
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining % 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

/** Ett element med given tagg och givet innehåll. */
export function derElement(tag: number, content: Uint8Array): Buffer {
  return Buffer.concat([Buffer.of(tag), derLength(content.length), content])
}

export function derSequence(...items: Uint8Array[]): Buffer {
  return derElement(0x30, Buffer.concat(items))
}

/**
 * En SET OF. DER kräver att elementen står sorterade på sin kodning, så de
 * sorteras här i stället för att anroparen ska behöva komma ihåg det.
 */
export function derSet(...items: Uint8Array[]): Buffer {
  const sorted = [...items].map((item) => Buffer.from(item)).sort(Buffer.compare)
  return derElement(0x31, Buffer.concat(sorted))
}

/** Ett positivt heltal ur sin storlek i byte, stor ände först, med minsta antal byte. */
export function derInteger(magnitude: Uint8Array): Buffer {
  let start = 0
  while (start < magnitude.length - 1 && magnitude[start] === 0) start += 1

  const trimmed = Buffer.from(magnitude.subarray(start))
  if (trimmed.length === 0) return derElement(0x02, Buffer.of(0))

  // Hög bit satt skulle läsas som ett negativt tal.
  return derElement(0x02, trimmed[0]! >= 0x80 ? Buffer.concat([Buffer.of(0), trimmed]) : trimmed)
}

export function derSmallInteger(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Kan inte koda heltalet ${value}.`)

  const bytes: number[] = []
  for (let remaining = value; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining % 256)
  }
  return derInteger(Uint8Array.from(bytes))
}

/** En objektidentifierare i punktform, till exempel 2.5.29.15. */
export function derOid(dotted: string): Buffer {
  const arcs = dotted.split('.').map((arc) => {
    if (!/^(?:0|[1-9][0-9]*)$/.test(arc)) throw new Error(`Ogiltig objektidentifierare ${dotted}.`)
    return Number(arc)
  })
  if (arcs.length < 2 || arcs[0]! > 2 || (arcs[0]! < 2 && arcs[1]! > 39)) {
    throw new Error(`Ogiltig objektidentifierare ${dotted}.`)
  }

  const content: number[] = []
  for (const arc of [arcs[0]! * 40 + arcs[1]!, ...arcs.slice(2)]) {
    // Bas 128, med hög bit satt på varje byte utom den sista.
    const groups = [arc % 128]
    for (let remaining = Math.floor(arc / 128); remaining > 0; remaining = Math.floor(remaining / 128)) {
      groups.unshift((remaining % 128) | 0x80)
    }
    content.push(...groups)
  }

  return derElement(0x06, Uint8Array.from(content))
}

export function derNull(): Buffer {
  return Buffer.of(0x05, 0x00)
}

export function derBoolean(value: boolean): Buffer {
  return Buffer.of(0x01, 0x01, value ? 0xff : 0x00)
}

/** En bitsträng: antalet oanvända bitar i sista byten, sedan bytena. */
export function derBitString(bytes: Uint8Array, unusedBits = 0): Buffer {
  if (!Number.isInteger(unusedBits) || unusedBits < 0 || unusedBits > 7) {
    throw new Error(`Ogiltigt antal oanvända bitar: ${unusedBits}.`)
  }
  return derElement(0x03, Buffer.concat([Buffer.of(unusedBits), bytes]))
}

export function derOctetString(bytes: Uint8Array): Buffer {
  return derElement(0x04, bytes)
}

export function derUtf8String(text: string): Buffer {
  return derElement(0x0c, Buffer.from(text, 'utf8'))
}

/** PrintableString tillåter bara ett litet urval ASCII-tecken, X.680 41.4. */
const PRINTABLE = /^[A-Za-z0-9 '()+,\-./:=?]*$/

export function derPrintableString(text: string): Buffer {
  if (!PRINTABLE.test(text)) throw new Error(`"${text}" går inte att skriva som PrintableString.`)
  return derElement(0x13, Buffer.from(text, 'latin1'))
}

/**
 * En tidpunkt, som RFC 5280 4.1.2.5 kräver den: UTCTime för åren 1950–2049
 * och GeneralizedTime därefter, alltid i UTC och utan bråkdelar av sekunder.
 */
export function derTime(date: Date): Buffer {
  const year = date.getUTCFullYear()
  const pad = (value: number) => String(value).padStart(2, '0')
  const rest =
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'

  if (year >= 1950 && year < 2050) return derElement(0x17, Buffer.from(pad(year % 100) + rest, 'latin1'))
  if (year < 0 || year > 9999) throw new Error(`Året ${year} går inte att skriva i ett certifikat.`)
  return derElement(0x18, Buffer.from(String(year).padStart(4, '0') + rest, 'latin1'))
}

/** Ett kontextbundet, sammansatt element, som [0] för version och [3] för tilläggen. */
export function derExplicit(tagNumber: number, inner: Uint8Array): Buffer {
  if (!Number.isInteger(tagNumber) || tagNumber < 0 || tagNumber > 30) {
    throw new Error(`Ogiltigt taggnummer ${tagNumber}.`)
  }
  return derElement(0xa0 | tagNumber, inner)
}
