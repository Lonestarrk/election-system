import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

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

/**
 * scrypt-parametrar för identitetshashning.
 *
 * N = 2^14, r = 8, p = 1 ger 128 · N · r = 16 MiB minne och uppmätt 37 ms per
 * hashning. Med åtta samtidiga (se lib/admission-queue.ts) blir det ~217
 * legitimeringar per sekund och 128 MiB som minnestopp.
 *
 * UPPRÄKNING *ÄR* INVERSIONEN, NÄR INDATAN ÄR LÅGENTROPISK
 *
 * "En hash går inte att vända" gäller en slumpad nyckel, inte ett personnummer.
 * Födelsedatum över ~110 år är omkring 40 000 dagar, och de fyra sista siffrorna
 * ger 1 000 kombinationer eftersom kontrollsiffran är beräknad ur de nio
 * föregående. Cirka 4 · 10^7 kandidater — alltså vänder man hashen genom att
 * pröva dem alla, och parametern bestämmer bara vad det kostar:
 *
 *   HMAC-SHA256      ~4 sekunder        (det vi hade)
 *   scrypt 2^13       8 kärndygn
 *   scrypt 2^14      17 kärndygn        (nu)
 *   scrypt 2^15      35 kärndygn
 *
 * Minneshårdheten är det som gör siffrorna meningsfulla: en GPU har gott om
 * beräkningskraft men lite minne per kärna, så 16 MiB per försök tar bort
 * parallelliseringen som annars gör hela tabellen irrelevant.
 *
 * VAR SKYDDET FAKTISKT KOMMER IFRÅN
 *
 * Inte härifrån. Det kommer från att pepparn inte finns i databasen och
 * därmed inte i en databasdump — det vanligaste läckaget. Utan pepper går
 * ingen kandidathash att beräkna, och då är uppräkning inte dyr utan omöjlig,
 * vid varje parameterval ända ner till SHA-256.
 *
 * VARFÖR PARAMETERN ÄNDÅ INTE ÄR NOLL
 *
 * Miljövariabler läcker på sätt databaser inte gör: en loggrad, en stacktrace,
 * en CI-logg, /proc/self/environ, en skärmdump. En sådan läcka är tyst och
 * träffar bara pepparn. Kombineras den med en äldre backup är HMAC fyra
 * sekunder och det här flera veckor. Parametern är försäkring mot precis det
 * scenariot — inte huvudskyddet.
 *
 * VARFÖR INTE LÄGRE, NÄR RESONEMANGET TILLÅTER DET
 *
 * 16 MiB ligger vid OWASP:s golv för minneshårda funktioner (deras Argon2id-
 * rekommendation är 19 MiB), och valet är enkelriktat: vi lagrar inte
 * personnummer i klartext, så ändrade parametrar ogiltigförklarar varje
 * befintlig hash och kräver en ny import från källan.
 *
 * VAD DET ALDRIG SKYDDADE
 *
 * En riktad kontroll — "finns den här personen?" — är ett anrop och kostar
 * 37 ms oavsett parametrar. Och personnummret i sig är sällan hemligt. Det
 * känsliga i röstlängdsraden är attributen BREDVID hashen: isAdmin är en
 * urvalslista över dem som kan skapa omröstningar, och municipalityCode är
 * folkbokföringsort kopplad till identitet. Ingen hashparameter försvarar de
 * två — se known-limitations.ts.
 *
 * Valhemligheten berörs inte av något av detta. Den sköts av blindsigneringen,
 * i en annan databas, där ingen identitet finns.
 */
const SCRYPT_PARAMS = { N: 2 ** 14, r: 8, p: 1, maxmem: 48 * 1024 * 1024 } as const

/**
 * Minneshård härledning med fast salt.
 *
 * SALTET ÄR INTE SLUMPAT PER ANVÄNDARE, OCH DET SER FEL UT.
 *
 * Normalt ska varje post ha ett eget slumpat salt. Här krävs determinism:
 * hashen används för att SLÅ UPP en person i röstlängden, och ett slumpat
 * salt per rad gör uppslagningen omöjlig — man skulle behöva testa varje rad.
 *
 * Rollen som saltet normalt fyller — att omöjliggöra förberäknade tabeller —
 * fylls här av att saltet är HEMLIGT. Utan peppret går ingen tabell att
 * förberäkna, och med peppret krävs ändå 4 · 10^7 scrypt-anrop.
 */
export function scryptHex(input: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(input, salt, 32, SCRYPT_PARAMS, (error, derived) => {
      if (error) reject(error)
      else resolve(derived.toString('hex'))
    })
  })
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
