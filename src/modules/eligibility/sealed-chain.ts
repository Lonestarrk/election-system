import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, type X509Certificate } from 'node:crypto'
import { env } from '@/lib/env'
import { certificateFromDer } from './bankid/certificate-chain'
import { splitDerSequences } from './bankid/der-reader'
import { MAX_SIGNATURE_XML_BYTES } from './bankid/xmldsig'

/**
 * BANKID:S UNDERSKRIFT I PENDING_VOTE LAGRAS FÖRSEGLAD.
 *
 * SEDAN UPPGIFT 17b ÄR DET HELA UNDERSKRIFTEN, inte bara kedjan. BankID lämnar
 * underskriften som ett XMLDSig-dokument med det signerade innehållet och
 * certifikatkedjan inbäddade, se ./bankid/xmldsig.ts. Hela dokumentet förseglas,
 * tillsammans med BankID:s svar på spärrfrågan (`ocspResponse`), i kolumnen
 * bankid_certificate_chain. Kolumnen behåller sitt namn, eftersom ett nytt namn
 * hade krävt en schemaändring och inget mer. Före 17b låg där bara kedjan, i
 * formatet v2 nedan, och valideringen läser det formatet för att känna igen
 * gamla kuvert.
 *
 * VARFÖR UNDERSKRIFTEN ALLS LAGRAS. Valideringen före stängningen ska kunna pröva
 * varje underskrift mot BankID:s rot, också i en rad som aldrig passerade
 * läggningen, för det är just den raden en angripare med skrivrätt skriver. Då
 * måste raden bära det BankID står för, alltså dokumentet med kedjan och det
 * signerade, och inte bara en nyckel som vem som helst kunde byta ut.
 *
 * VARFÖR DEN FÖRSEGLAS. Lövet i kedjan bär väljarens personnummer och namn i
 * klartext, i subject. Röstlängden lagrar i övrigt bara en hash av personnumret,
 * och ingenstans namnet, så att en databasdump utan pepparn inte ska avslöja vem
 * som röstat. Ett dokument i klartext hade gjort varje liggande kuvert till en
 * namngiven rad. Spärrsvaret förseglas med, så att en senare uppgift kan pröva
 * det. Ingenting prövar det i dag, se posten `no-revocation-check` i
 * src/lib/known-limitations.ts.
 *
 * VARFÖR DEN FYLLS UT (granskningen av uppgift 14f, V1). AES-GCM bevarar
 * längden: chiffret är exakt lika långt som klartexten. Granskaren mätte 3765
 * tecken för "Robin Ek" och 3797 för "Charlie Näslund". Med riktig BankID säger
 * längden sannolikt också vilken bank som utfärdat certifikatet, eftersom
 * bankernas mellannivåer skiljer sig åt. Nu är klartexten alltid lika lång, se
 * `SIGNATURE_PLAINTEXT_BYTES`, och varje förseglad underskrift blir lika lång
 * oavsett namn, nycklar, antal mellannivåer och spärrsvarets storlek.
 *
 * Underskriften i bankid_signature, alltså SignatureValue ur dokumentet, lagras
 * däremot som den är. Dess längd följer lövets nyckelstorlek. Det står i
 * src/lib/known-limitations.ts.
 *
 * NYCKELN härleds som förut ur IDENTITY_PEPPER med HKDF-SHA256 och en egen
 * domänsträng. Pepparn är redan den hemlighet som skyddar röstlängden och som
 * inte finns i databasen, så nyckeln följer inte med en dump. I Azure ligger
 * pepparn i Key Vault, och appen får den som miljövariabel (infra/azure/app.bicep),
 * så den som får läsa valvet eller tar sig in i appen har den. Domänsträngen gör
 * att nyckeln aldrig blir densamma som något annat pepparn används till:
 * identitetshashen är scrypt med pepparn som salt, och ingen av de två kan
 * räknas fram ur den andra. Varje format har sin domän, och därmed sin nyckel,
 * så att en text i ett format aldrig går att öppna som ett annat.
 *
 * AES-256-GCM med en slumpad nonce per kuvert. Samma underskrift förseglad två
 * gånger blir två olika texter. Taggen gör att en ändrad text inte går att öppna
 * alls, i stället för att bli en annan underskrift.
 *
 * RADEN BINDS IN SOM AUTENTISERAD DATA, som förut: väljarens id och valsedelns
 * id. En underskrift som flyttas till en annan väljares rad, eller till en annan
 * valsedel, går då inte att öppna, och valideringen rapporterar raden i stället
 * för att pröva något som aldrig hörde dit. Radens eget id binds inte in,
 * eftersom det skapas av databasen först när raden skapas, och en läggning som
 * hinner före en annan gör om skapandet till en uppdatering.
 *
 * VAD FÖRSEGLINGEN INTE SKYDDAR MOT. Den som har pepparn kan öppna varje
 * underskrift, och får då personnummer och namn för varje väljare med ett
 * liggande kuvert utan att behöva räkna fram en enda hash, och dessutom texten
 * väljaren såg och det hon skrev under. Det är mer än röstlängden ger den som har
 * pepparn. Där går identitetshasharna att vända genom att alla tänkbara
 * personnummer prövas, ungefär 17 processordygn som går att dela upp, men namnet
 * står inte där. Underskriften raderas med raden vid skalningen, så efter
 * stängningen finns ingenting kvar att öppna i den levande databasen. En
 * säkerhetskopia från före stängningen har underskrifterna kvar, och pepparn,
 * som distributionen bara skriver när den saknas i valvet, öppnar dem också där.
 * Det står som begränsningen `pepper-holder-reads-voter-names` i
 * src/lib/known-limitations.ts, och dess markör är raden i `chainKey` som
 * härleder nyckeln ur pepparn.
 */

const NONCE_BYTES = 12
const TAG_BYTES = 16
const LENGTH_BYTES = 4

/** Raden underskriften hör till. */
export type EnvelopeLocation = { voterStatusId: string; ballotId: string }

function chainKey(domain: string): Buffer {
  return Buffer.from(hkdfSync('sha256', env.identityPepper, Buffer.alloc(0), domain, 32))
}

/** Längdprefix på varje del, av samma skäl som i det signerade kuvertet: gränserna blir entydiga. */
function associatedData(domain: string, location: EnvelopeLocation): Buffer {
  return Buffer.from(
    [domain, location.voterStatusId, location.ballotId]
      .map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`)
      .join(''),
    'utf8',
  )
}

function seal(domain: string, version: string, plaintext: Buffer, location: EnvelopeLocation, encoding: 'hex' | 'base64') {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', chainKey(domain), nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(associatedData(domain, location))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

  return [version, nonce.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext.toString(encoding)].join(':')
}

function open(
  domain: string,
  key: Buffer,
  match: RegExpExecArray,
  location: EnvelopeLocation,
  encoding: 'hex' | 'base64',
): Buffer | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(match[1]!, 'hex'), { authTagLength: TAG_BYTES })
    decipher.setAAD(associatedData(domain, location))
    decipher.setAuthTag(Buffer.from(match[2]!, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(match[3]!, encoding)), decipher.final()])
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------------- */
/* Formatet v3: hela underskriften och spärrsvaret (uppgift 17b).            */
/* ------------------------------------------------------------------------- */

const SIGNATURE_DOMAIN = 'valsystem/pending-vote/bankid-underskrift/aes-256-gcm/v3'
const SIGNATURE_VERSION = 'v3'

/**
 * KLARTEXTENS FASTA STORLEK: 32 KiB.
 *
 * Fyra byte med dokumentets längd, dokumentet, fyra byte med spärrsvarets längd,
 * spärrsvaret och nollor.
 *
 *   - Dokumentet får vara högst `MAX_SIGNATURE_XML_BYTES`, 24 KiB, som läsaren tar.
 *     Det största realistiska är omkring 15 KiB och attrappens 5 370 byte, se
 *     mätningen vid taket i ./bankid/xmldsig.ts.
 *   - Spärrsvaret får vara högst `MAX_OCSP_RESPONSE_BYTES`, resten, 8 184 byte. Ett
 *     OCSP-svar med svarandens certifikat är omkring 2 KiB, och med två certifikat
 *     omkring 4 KiB, så marginalen är omkring 4 KiB. Attrappen har inget spärrsvar.
 *   - Tillsammans: det realistiska största är omkring 19 KiB, och marginalen 13 KiB.
 *
 * Priset är lagring. Varje liggande kuvert bär 43 692 tecken base64, mot 32 768
 * hextecken för kedjan förut, och det raderas vid skalningen.
 *
 * EN UNDERSKRIFT SOM INTE RYMS VÄGRAS, i `sealBankIdSignature`. Att fylla ut den
 * till en större storlek hade gjort just den igenkännbar på längden, och det är
 * precis vad utfyllnaden finns för att förhindra.
 */
const SIGNATURE_PLAINTEXT_BYTES = 32 * 1024
export const MAX_OCSP_RESPONSE_BYTES = SIGNATURE_PLAINTEXT_BYTES - 2 * LENGTH_BYTES - MAX_SIGNATURE_XML_BYTES

/** 32 768 byte i base64: 43 690 tecken ur alfabetet och ett =. */
const SIGNATURE_CIPHERTEXT_CHARS = Math.ceil(SIGNATURE_PLAINTEXT_BYTES / 3) * 4

/**
 * Version, nonce, tagg och chiffer. EN TEMPLATE-STRÄNG, se `STORED_CHAIN` nedan
 * och tests/security/regexp-construction.test.ts.
 */
const STORED_SIGNATURE = new RegExp(
  `^${SIGNATURE_VERSION}:([0-9a-f]{${NONCE_BYTES * 2}}):([0-9a-f]{${TAG_BYTES * 2}}):([A-Za-z0-9+/]{${SIGNATURE_CIPHERTEXT_CHARS - 1}}=)$`,
)

/** Varje förseglad underskrift är exakt så här lång. */
export const SEALED_SIGNATURE_LENGTH =
  SIGNATURE_VERSION.length + 1 + NONCE_BYTES * 2 + 1 + TAG_BYTES * 2 + 1 + SIGNATURE_CIPHERTEXT_CHARS

/** Det som förseglas: BankID:s XML och spärrsvaret, som bytes. */
export type SealedSignature = { xml: Buffer; ocspResponse: Buffer }

/**
 * Förseglar underskriften för en rad, utfylld till `SIGNATURE_PLAINTEXT_BYTES`.
 *
 * Kastar för en underskrift som inte ryms. Den kommer ur BankID:s svar och är då
 * redan prövad, så en underskrift som inte ryms betyder att storleken här är vald
 * för snålt, och det ska synas som ett fel och inte gömmas. Rösten läggs inte.
 */
export function sealBankIdSignature(signature: SealedSignature, location: EnvelopeLocation): string {
  if (signature.xml.length > MAX_SIGNATURE_XML_BYTES || signature.ocspResponse.length > MAX_OCSP_RESPONSE_BYTES) {
    throw new Error(
      `BankID:s underskrift (${signature.xml.length} byte) eller spärrsvar (${signature.ocspResponse.length} byte) ` +
        `ryms inte i den förseglade kolumnen, som tar ${MAX_SIGNATURE_XML_BYTES} och ${MAX_OCSP_RESPONSE_BYTES}. ` +
        'Den vägras i stället för att fyllas ut till en egen längd.',
    )
  }

  const plaintext = Buffer.alloc(SIGNATURE_PLAINTEXT_BYTES)
  let at = plaintext.writeUInt32BE(signature.xml.length, 0)
  at += signature.xml.copy(plaintext, at)
  at = plaintext.writeUInt32BE(signature.ocspResponse.length, at)
  signature.ocspResponse.copy(plaintext, at)

  return seal(SIGNATURE_DOMAIN, SIGNATURE_VERSION, plaintext, location, 'base64')
}

/**
 * Öppnar en underskrift förseglad för just den här raden. Null för allt annat,
 * också för en kedja i det gamla formatet, och aldrig ett undantag för det: raden
 * kommer ur databasen, och valideringen ska rapportera den, inte krascha på den.
 *
 * Kastar bara när pepparn saknas, eftersom det är ett fel i driftsättningen och
 * inte något en rad kan orsaka. Därför hämtas nyckeln före allt annat.
 */
export function openBankIdSignature(stored: unknown, location: EnvelopeLocation): SealedSignature | null {
  const key = chainKey(SIGNATURE_DOMAIN)

  if (typeof stored !== 'string' || stored.length !== SEALED_SIGNATURE_LENGTH) return null
  const match = STORED_SIGNATURE.exec(stored)
  if (!match) return null

  const plaintext = open(SIGNATURE_DOMAIN, key, match, location, 'base64')
  if (!plaintext || plaintext.length !== SIGNATURE_PLAINTEXT_BYTES) return null

  // Längd, dokument, längd, spärrsvar och sedan bara nollor. En enda kodning, av
  // samma skäl som DER-läsaren är strikt.
  const xmlLength = plaintext.readUInt32BE(0)
  if (xmlLength > MAX_SIGNATURE_XML_BYTES) return null
  const ocspAt = LENGTH_BYTES + xmlLength
  const ocspLength = plaintext.readUInt32BE(ocspAt)
  if (ocspLength > MAX_OCSP_RESPONSE_BYTES) return null
  const end = ocspAt + LENGTH_BYTES + ocspLength
  if (plaintext.subarray(end).some((byte) => byte !== 0)) return null

  return {
    xml: Buffer.from(plaintext.subarray(LENGTH_BYTES, ocspAt)),
    ocspResponse: Buffer.from(plaintext.subarray(ocspAt + LENGTH_BYTES, end)),
  }
}

/**
 * Vilket format en lagrad text påstår sig ha, ur versionen först i texten.
 * Påståendet är inte prövat: bara öppningen avgör om texten är äkta.
 */
export function sealedFormatOf(stored: unknown): 'signature' | 'legacy_chain' | null {
  if (typeof stored !== 'string') return null
  if (stored.startsWith(`${SIGNATURE_VERSION}:`)) return 'signature'
  if (stored.startsWith(`${LEGACY_VERSION}:`)) return 'legacy_chain'
  return null
}

/* ------------------------------------------------------------------------- */
/* Formatet v2: bara kedjan, före uppgift 17b.                               */
/* ------------------------------------------------------------------------- */

/**
 * DET GAMLA FORMATET, MED BARA KEDJAN.
 *
 * Kuvert som lades före uppgift 17b bär kedjan i det här formatet och en
 * underskrift i attrappens tidigare form, en RSA-signatur direkt över det
 * signerade. Läggningen skriver det aldrig mer. Valideringen före stängningen
 * öppnar det för att skilja ett äkta gammalt kuvert från en förfalskning, se
 * `OLD_BANKID_FORMAT` i src/orchestration/validate-before-close.usecase.ts, och
 * ett sådant kuvert stoppar stängningen.
 */
const LEGACY_DOMAIN = 'valsystem/pending-vote/bankid-certifikatkedja/aes-256-gcm/v2'
const LEGACY_VERSION = 'v2'

/** 16 KiB: fyra byte med kedjans längd, kedjan och nollor. */
const LEGACY_PLAINTEXT_BYTES = 16 * 1024
const MAX_LEGACY_CHAIN_BYTES = LEGACY_PLAINTEXT_BYTES - LENGTH_BYTES

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
const STORED_CHAIN = new RegExp(
  `^${LEGACY_VERSION}:([0-9a-f]{${NONCE_BYTES * 2}}):([0-9a-f]{${TAG_BYTES * 2}}):([0-9a-f]{${LEGACY_PLAINTEXT_BYTES * 2}})$`,
)

/** Varje förseglad kedja i det gamla formatet är exakt så här lång. */
export const SEALED_CHAIN_LENGTH =
  LEGACY_VERSION.length + 1 + NONCE_BYTES * 2 + 1 + TAG_BYTES * 2 + 1 + LEGACY_PLAINTEXT_BYTES * 2

/**
 * Förseglar en kedja i det gamla formatet. BARA FÖR TESTERNA, som behöver
 * skriva gamla kuvert för att visa vad valideringen gör med dem.
 */
export function sealLegacyCertificateChain(chain: readonly X509Certificate[], location: EnvelopeLocation): string {
  const der = Buffer.concat(chain.map((certificate) => certificate.raw))
  if (der.length > MAX_LEGACY_CHAIN_BYTES) throw new Error('Kedjan ryms inte i det gamla formatet.')

  const plaintext = Buffer.alloc(LEGACY_PLAINTEXT_BYTES)
  plaintext.writeUInt32BE(der.length, 0)
  der.copy(plaintext, LENGTH_BYTES)
  return seal(LEGACY_DOMAIN, LEGACY_VERSION, plaintext, location, 'hex')
}

/**
 * Öppnar en kedja i det gamla formatet. Null för allt som inte går att öppna som
 * en kedja förseglad för just den här raden, och aldrig ett undantag för det.
 * Kastar bara när pepparn saknas.
 */
export function openLegacyCertificateChain(stored: unknown, location: EnvelopeLocation): X509Certificate[] | null {
  const key = chainKey(LEGACY_DOMAIN)

  if (typeof stored !== 'string' || stored.length !== SEALED_CHAIN_LENGTH) return null
  const match = STORED_CHAIN.exec(stored)
  if (!match) return null

  const plaintext = open(LEGACY_DOMAIN, key, match, location, 'hex')
  if (!plaintext) return null

  const length = plaintext.readUInt32BE(0)
  if (length > MAX_LEGACY_CHAIN_BYTES) return null
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
