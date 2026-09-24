import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, type X509Certificate } from 'node:crypto'
import { env } from '@/lib/env'
import { certificateFromDer } from './bankid/certificate-chain'
import { splitDerSequences } from './bankid/der-reader'

/**
 * BANKID-KEDJAN I PENDING_VOTE LAGRAS KRYPTERAD.
 *
 * VARFÖR KEDJAN ALLS LAGRAS. Valideringen före stängningen ska kunna pröva
 * varje underskrift mot BankID:s rot, också i en rad som aldrig passerade
 * läggningen, för det är just den raden en angripare med skrivrätt skriver.
 * Då måste raden bära det BankID står för, alltså certifikaten, och inte bara
 * den nyckel som tidigare lagrades och som vem som helst kunde byta ut.
 *
 * VARFÖR DEN KRYPTERAS. Lövet bär väljarens personnummer och namn i klartext,
 * i subject. Röstlängden lagrar i övrigt bara en hash av personnumret, och
 * ingenstans namnet, så att en databasdump utan pepparn inte ska avslöja vem
 * som röstat. En kedja i klartext hade gjort varje liggande kuvert till en
 * namngiven rad, och dumpen till en lista över vilka som röstat. Krypterad och
 * utfylld till en fast storlek avslöjar dumpen inte mer än i dag.
 *
 * VARFÖR DEN FYLLS UT (granskningen av uppgift 14f, V1). AES-GCM bevarar
 * längden: chiffret är exakt lika långt som klartexten. Före fixrundan var
 * klartexten certifikaten efter varandra, och längden följde namnet i lövet.
 * Granskaren mätte 3765 tecken för "Robin Ek" och 3797 för "Charlie Näslund",
 * helt förutsägbart. Med riktig BankID säger längden sannolikt också vilken
 * bank som utfärdat certifikatet, eftersom bankernas mellannivåer skiljer sig
 * åt. Tillsammans med kommunkoden i klartext gav en dump utan pepparn alltså
 * något nytt. Nu är klartexten alltid lika lång, se `SEALED_PLAINTEXT_BYTES`,
 * och varje förseglad kedja blir lika lång oavsett namn, nycklar och antal
 * mellannivåer.
 *
 * NYCKELN härleds ur IDENTITY_PEPPER med HKDF-SHA256 och en egen domänsträng.
 * Pepparn är redan den hemlighet som skyddar röstlängden och som inte finns i
 * databasen, så nyckeln följer inte med en dump. Domänsträngen gör att nyckeln
 * aldrig blir densamma som något annat pepparn används till: identitetshashen
 * är scrypt med pepparn som salt, och ingen av de två kan räknas fram ur den
 * andra.
 *
 * AES-256-GCM med en slumpad nonce per kuvert. Samma kedja krypterad två
 * gånger blir två olika texter, så att en väljare som röstar om inte går att
 * känna igen på sin kedja. Taggen gör att en ändrad text inte går att öppna
 * alls, i stället för att bli en annan kedja.
 *
 * RADEN BINDS IN SOM AUTENTISERAD DATA: väljarens id och valsedelns id. En
 * kedja som flyttas till en annan väljares rad, eller till en annan valsedel,
 * går då inte att öppna, och valideringen rapporterar raden i stället för att
 * pröva en kedja som aldrig hörde dit. Radens eget id binds inte in, eftersom
 * det skapas av databasen först när raden skapas, och en läggning som hinner
 * före en annan gör om skapandet till en uppdatering.
 *
 * VAD KRYPTERINGEN INTE SKYDDAR MOT. Den som har pepparn kan öppna varje kedja,
 * och får då personnummer och namn för varje väljare med ett liggande kuvert
 * utan att behöva räkna fram en enda hash. Det är mer än röstlängden ger den
 * som har pepparn, som bara kan pröva ett personnummer i taget och aldrig får
 * namnet. Kedjan raderas med raden vid skalningen, så efter stängningen finns
 * ingenting kvar att öppna. Det står som begränsningen
 * `pepper-holder-reads-voter-names` i src/lib/known-limitations.ts, och dess
 * markör är raden i `chainKey` som härleder nyckeln ur pepparn.
 */

/**
 * Version 2 sedan utfyllnaden (V1). Domänen, och därmed nyckeln, byter version
 * med formatet, så att en text i det gamla formatet aldrig går att öppna som
 * det nya. Inget ligger i drift, och de gamla förseglingarna behöver inte
 * kunna läsas.
 */
const DOMAIN = 'valsystem/pending-vote/bankid-certifikatkedja/aes-256-gcm/v2'
const VERSION = 'v2'

const NONCE_BYTES = 12
const TAG_BYTES = 16

/**
 * KLARTEXTENS FASTA STORLEK: fyra byte med kedjans längd, kedjan och nollor.
 *
 * 16 KiB rymmer kedjans tak i ./bankid/certificate-chain.ts, ett löv och tre
 * mellannivåer, med god marginal. Ett certifikat med en RSA-nyckel på 4096
 * bitar och BankID:s tillägg är omkring 2 KiB, och attrappens hela kedja är
 * knappt 2 KiB. Hur djup och hur stor BankID:s riktiga kedja är får adaptern
 * bekräfta.
 *
 * Priset är lagring. Varje liggande kuvert bär 32 KiB i hex, mot omkring
 * 4 KiB förut, och det raderas vid skalningen.
 *
 * EN KEDJA SOM INTE RYMS VÄGRAS, i `sealCertificateChain`. Att fylla ut den
 * till en större storlek hade gjort just den kedjan igenkännbar på längden,
 * och det är precis vad utfyllnaden finns för att förhindra.
 */
const SEALED_PLAINTEXT_BYTES = 16 * 1024
const LENGTH_BYTES = 4
const MAX_CHAIN_BYTES = SEALED_PLAINTEXT_BYTES - LENGTH_BYTES

/**
 * Version, nonce, tagg och chiffer, i gemen hex. Varje del har sin exakta längd.
 *
 * EN TEMPLATE-STRÄNG, INTE TVÅ SOM FÖRENAS MED `+`. Uttrycket var först delat på
 * två rader. SWC:s minifiering i `next build` slog då ihop de två
 * template-strängarna och tappade `}):` i skarven, så att produktionsbygget fick
 * `…{32([0-9a-f]{32768})$` och föll med "Unterminated group" på
 * /api/vote/compare. Vitest och `next dev` minifierar inte, så felet syntes bara
 * i bygget. `tests/security/regexp-construction.test.ts` vaktar mönstret i hela
 * `src`.
 */
const STORED = new RegExp(
  `^${VERSION}:([0-9a-f]{${NONCE_BYTES * 2}}):([0-9a-f]{${TAG_BYTES * 2}}):([0-9a-f]{${SEALED_PLAINTEXT_BYTES * 2}})$`,
)

/** Varje förseglad kedja är exakt så här lång. */
export const SEALED_CHAIN_LENGTH =
  VERSION.length + 1 + NONCE_BYTES * 2 + 1 + TAG_BYTES * 2 + 1 + SEALED_PLAINTEXT_BYTES * 2

/** Raden kedjan hör till. */
export type EnvelopeLocation = { voterStatusId: string; ballotId: string }

function chainKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', env.identityPepper, Buffer.alloc(0), DOMAIN, 32))
}

/** Längdprefix på varje del, av samma skäl som i det signerade kuvertet: gränserna blir entydiga. */
function associatedData(location: EnvelopeLocation): Buffer {
  return Buffer.from(
    [DOMAIN, location.voterStatusId, location.ballotId]
      .map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`)
      .join(''),
    'utf8',
  )
}

/**
 * Krypterar kedjan, lövet först, som certifikatens DER efter varandra och
 * utfylld till `SEALED_PLAINTEXT_BYTES`.
 *
 * Kastar för en kedja som inte ryms. Kedjan kommer ur BankID:s svar och är då
 * redan prövad, så en kedja som inte ryms betyder att storleken här är vald
 * för snålt, och det ska synas som ett fel och inte gömmas. Rösten läggs inte.
 */
export function sealCertificateChain(
  chain: readonly X509Certificate[],
  location: EnvelopeLocation,
): string {
  const der = Buffer.concat(chain.map((certificate) => certificate.raw))
  if (der.length > MAX_CHAIN_BYTES) {
    throw new Error(
      `BankID-kedjan är ${der.length} byte och ryms inte i den förseglade kolumnen, som tar ` +
        `${MAX_CHAIN_BYTES}. Den vägras i stället för att fyllas ut till en egen längd.`,
    )
  }

  const plaintext = Buffer.alloc(SEALED_PLAINTEXT_BYTES)
  plaintext.writeUInt32BE(der.length, 0)
  der.copy(plaintext, LENGTH_BYTES)

  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', chainKey(), nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(associatedData(location))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

  return [VERSION, nonce.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext.toString('hex')].join(
    ':',
  )
}

/**
 * Öppnar en lagrad kedja. Null för allt som inte går att öppna som en kedja
 * förseglad för just den här raden, och aldrig ett undantag för det: raden
 * kommer ur databasen, och valideringen ska rapportera den, inte krascha på
 * den.
 *
 * Kastar bara när pepparn saknas, eftersom det är ett fel i driftsättningen
 * och inte något en rad kan orsaka. Därför hämtas nyckeln före allt annat.
 */
export function openCertificateChain(
  stored: unknown,
  location: EnvelopeLocation,
): X509Certificate[] | null {
  const key = chainKey()

  if (typeof stored !== 'string' || stored.length !== SEALED_CHAIN_LENGTH) return null
  const match = STORED.exec(stored)
  if (!match) return null

  let plaintext: Buffer
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(match[1]!, 'hex'), {
      authTagLength: TAG_BYTES,
    })
    decipher.setAAD(associatedData(location))
    decipher.setAuthTag(Buffer.from(match[2]!, 'hex'))
    plaintext = Buffer.concat([decipher.update(Buffer.from(match[3]!, 'hex')), decipher.final()])
  } catch {
    return null
  }

  /**
   * Längden, kedjan och sedan bara nollor. Taggen gör att ingen utan nyckeln
   * kan skriva något annat, men en förseglad kedja ska ha en enda kodning,
   * av samma skäl som DER-läsaren är strikt: två kodningar av samma sak är två
   * sätt att skriva samma rad.
   */
  const length = plaintext.readUInt32BE(0)
  if (length > MAX_CHAIN_BYTES) return null
  if (plaintext.subarray(LENGTH_BYTES + length).some((byte) => byte !== 0)) return null

  const parts = splitDerSequences(plaintext.subarray(LENGTH_BYTES, LENGTH_BYTES + length))
  if (!parts) return null

  const chain: X509Certificate[] = []
  for (const part of parts) {
    const certificate = certificateFromDer(part)
    if (!certificate) return null
    chain.push(certificate)
  }

  return chain
}
