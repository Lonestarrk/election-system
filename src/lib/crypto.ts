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
 * N = 2^15, r = 8, p = 1 ger 128 · N · r = 32 MiB minne och ungefär 100 ms per
 * hashning på en modern kärna.
 *
 * VARFÖR MINNESHÅRDHET ÄR HELA POÄNGEN
 *
 * Ett svenskt personnummer har ett litet utfallsrum: födelsedatum över ~110 år
 * är omkring 40 000 dagar, och de fyra sista siffrorna ger 1 000 giltiga
 * kombinationer eftersom kontrollsiffran är bestämd. Det blir cirka 4 · 10^7
 * kandidater — ingenting för SHA-256, som går igenom hela mängden på sekunder
 * på en GPU.
 *
 * scrypt tvingar varje försök att allokera 32 MiB. Det dödar GPU-parallellisering,
 * eftersom en GPU har mycket beräkningskraft men lite minne per kärna.
 *
 * VAD DET INTE SKYDDAR MOT
 *
 * En riktad kontroll — "finns den här personen i röstlängden?" — är ett enda
 * anrop och kostar 100 ms oavsett parametrar. Skyddet gäller MASSREVERSERING,
 * alltså det som förvandlar spridda offentliga uppgifter till en enda farlig
 * fil med varje väljares personnummer och folkbokföringskommun.
 *
 * KOSTNADEN LIGGER PÅ OSS OCKSÅ
 *
 * 32 MiB per samtidig hashning. Tusen samtidiga legitimeringar blir 32 GB.
 * Anropet är därför asynkront och körs på libuv:s trådpool, som med sina fyra
 * trådar ger en naturlig gräns — och ett tak på ungefär 40 legitimeringar per
 * sekund. Ett riktigt val måste välja parametrar mot förväntad topplast, som
 * infaller exakt när man minst har råd med det.
 */
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const

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
