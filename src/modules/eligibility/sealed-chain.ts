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
 * namngiven rad, och dumpen till en lista över vilka som röstat. Krypterad
 * avslöjar dumpen inte mer än i dag.
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

const DOMAIN = 'valsystem/pending-vote/bankid-certifikatkedja/aes-256-gcm/v1'

const NONCE_BYTES = 12
const TAG_BYTES = 16

/** En kedja är ett par kilobyte, och i hex det dubbla. Det här är gott om plats. */
const MAX_STORED_LENGTH = 64 * 1024

/** v1, nonce, tagg och chiffer, i gemen hex och med exakta längder. */
const STORED = /^v1:([0-9a-f]{24}):([0-9a-f]{32}):((?:[0-9a-f]{2})+)$/

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

/** Krypterar kedjan, lövet först, som certifikatens DER efter varandra. */
export function sealCertificateChain(
  chain: readonly X509Certificate[],
  location: EnvelopeLocation,
): string {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', chainKey(), nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(associatedData(location))

  const plaintext = Buffer.concat(chain.map((certificate) => certificate.raw))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

  return ['v1', nonce.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext.toString('hex')].join(
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

  if (typeof stored !== 'string' || stored.length > MAX_STORED_LENGTH) return null
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

  const parts = splitDerSequences(plaintext)
  if (!parts) return null

  const chain: X509Certificate[] = []
  for (const part of parts) {
    const certificate = certificateFromDer(part)
    if (!certificate) return null
    chain.push(certificate)
  }

  return chain
}
