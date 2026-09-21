/**
 * ANTAGNINGSKÖ FÖR MINNESHÅRD HASHNING
 *
 * Identitetshashningen använder scrypt med 16 MiB per anrop. Det är hela
 * skyddet — minneshårdheten dödar GPU-parallellisering hos en angripare som
 * försöker vända på röstlängden. Men kostnaden gäller oss också: tusen
 * samtidiga legitimeringar vore 16 GB.
 *
 * VARFÖR EN KÖ OCH INTE EN HASTIGHETSGRÄNS
 *
 * Det fanns redan en hastighetsgräns, och den gjorde fel sak. Den avvisar per
 * IP-adress och oavsett faktisk last: en väljare på ett bibliotek kunde få 429
 * medan servern stod nästan tom.
 *
 * I ett val är det dessutom ett dåligt svar i sig. "För många förfrågningar"
 * ser ut som att man hindras från att rösta, så väljaren försöker igen — och
 * fler försök gör lasten värre. En kö vänder det: ingen avvisas, man får en
 * plats och väntar.
 *
 * De två löser olika problem och båda behövs. Hastighetsgränsen hindrar
 * MISSBRUK från en enskild källa. Kön hanterar KAPACITET globalt.
 *
 * RÄKNINGEN
 *
 * 8 samtidiga hashningar à ~37 ms ger ungefär 217 legitimeringar per sekund.
 * En kö med 300 platser töms därför på under två sekunder, vilket betyder
 * att avvisning i praktiken aldrig inträffar — och när den gör det är systemet
 * verkligen överlastat, inte bara ojämnt belastat.
 *
 * Minnestoppen blir 8 · 16 MiB = 128 MiB. Väntande kostar bara en promise.
 *
 * KÖN ÄR FIFO, OCH DET ÄR ETT RÄTTVISEKRAV
 *
 * En vanlig semafor släpper igenom väntande i den ordning deras promises råkar
 * schemaläggas. Här får den som kom först gå först — en väljare ska inte kunna
 * bli omkörd av någon som anlände senare. Det är också vad som gör en
 * uppskattad väntetid meningsfull att visa.
 *
 * SAMMA BEGRÄNSNING SOM HASTIGHETSGRÄNSEN: TILLSTÅNDET ÄR PER PROCESS
 *
 * Med flera instanser bakom en lastbalanserare blir den faktiska gränsen
 * gånger antalet instanser. Ett riktigt system behöver en delad kö — och
 * troligen en riktig nummerlappsfunktion med bestående platser, så att en
 * väljare som tappar nätet inte hamnar sist igen.
 */

/**
 * Samtidiga hashningar.
 *
 * Fyra är libuv:s trådpool som standard; åtta låter en ny hashning stå redo
 * när en tråd blir fri, utan att minnestoppen blir orimlig. Att sätta det
 * högre än trådpoolen ger ingen extra genomströmning — anropen köar i libuv
 * i stället, fast då utan rättvis ordning och utan mätbar väntetid.
 */
export const MAX_CONCURRENT = 8

/** Platser i kön. Väntande kostar en promise, inte minne. */
export const MAX_QUEUED = 300

/** Uppmätt kostnad per hashning. Används bara för att uppskatta väntetid. */
const ESTIMATED_TASK_MS = 80

type Waiter = { resolve: () => void }

let active = 0
const waiting: Waiter[] = []

/** Kastas när kön är full. Systemet är då verkligen överlastat. */
export class AdmissionQueueFull extends Error {
  constructor() {
    super('Antagningskön är full.')
    this.name = 'AdmissionQueueFull'
  }
}

export type AdmissionStats = {
  active: number
  waiting: number
  /** Grov uppskattning, avsedd att visas för väljaren. */
  estimatedWaitSeconds: number
}

export function admissionStats(): AdmissionStats {
  return {
    active,
    waiting: waiting.length,
    estimatedWaitSeconds: Math.ceil(
      ((waiting.length + active) / MAX_CONCURRENT) * (ESTIMATED_TASK_MS / 1000),
    ),
  }
}

function release(): void {
  active -= 1

  const next = waiting.shift()
  if (next) {
    active += 1
    next.resolve()
  }
}

/**
 * Kör uppgiften när det finns kapacitet.
 *
 * Platsen frigörs i `finally`, så ett fel i uppgiften läcker aldrig en plats.
 * Utan det skulle en enda kastad exception permanent minska kapaciteten, och
 * efter tillräckligt många fel vore systemet låst utan att någonting syntes i
 * loggarna.
 */
export async function runAdmitted<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    if (waiting.length >= MAX_QUEUED) {
      throw new AdmissionQueueFull()
    }

    await new Promise<void>((resolve) => {
      waiting.push({ resolve })
    })
  } else {
    active += 1
  }

  try {
    return await task()
  } finally {
    release()
  }
}

/** Endast för tester. */
export function resetAdmissionQueue(): void {
  active = 0
  waiting.length = 0
}
