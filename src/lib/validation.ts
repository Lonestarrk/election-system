import { z } from 'zod'
import { MAX_DECIMAL_DIGITS, parseElement, parseScalar } from './crypto/group'
import { PROOF_FORMAT } from './crypto/proofs'
import { TRUSTEE_COUNT } from './crypto/threshold'

/**
 * Indatavalidering med Zod.
 *
 * All indata valideras vid systemgränsen. Utöver det uppenbara
 * injektionsskyddet (Prisma parametriserar redan alla frågor) fyller det två
 * syften här: det hindrar att oväntade fält smyger in i modulgränserna, och
 * det ger förutsägbara felsvar som inte läcker interna detaljer.
 */

/** Personnummer: ÅÅÅÅMMDD-NNNN eller ÅÅÅÅMMDDNNNN. */
export const personalNumberSchema = z
  .string()
  .trim()
  .regex(/^\d{8}-?\d{4}$/, 'Ogiltigt personnummer. Ange formatet ÅÅÅÅMMDD-NNNN.')
  .transform((value) => value.replace('-', ''))

/**
 * Start av legitimering.
 *
 * INGET PERSONNUMMER. BankID v6 tillåter inte flöden där användaren skriver in
 * det — legitimeringen startas av väljaren själv med QR-kod eller autostart,
 * och personnumret kommer i BankID:s svar.
 *
 * `purpose` styr bara vilken text som visas i BankID-appen, så att den som
 * legitimerar sig ser om det gäller att rösta eller att administrera. Det är
 * ett skydd mot att bli lurad att signera något annat än man tror.
 */
export const startAuthSchema = z.object({
  purpose: z.enum(['vote', 'admin']).default('vote'),
})

/** Hämtning av den animerade QR-kodens aktuella data. */
export const bankIdQrSchema = z.object({
  orderRef: z.string().uuid('Ogiltig referens.'),
})

/**
 * Demogenvägen som står för "någon skannade QR-koden".
 *
 * Personnumret finns HÄR och ingen annanstans i legitimeringsflödet. Rutten
 * ligger under /api/demo och svarar 404 när BankID inte är en attrapp — se
 * src/app/api/demo/bankid-scan/route.ts.
 */
export const demoScanSchema = z.object({
  orderRef: z.string().uuid('Ogiltig referens.'),
  personalNumber: personalNumberSchema,
})

export const collectAuthSchema = z.object({
  orderRef: z.string().uuid('Ogiltig referens.'),
  /**
   * Vilken omröstning legitimeringen gäller.
   *
   * Följer med hit i stället för att sparas vid start, eftersom BankID-ordern
   * inte ska behöva bära applikationens tillstånd. Att den kontrolleras här
   * spelar roll: sessionen som skapas knyts till omröstningen, och en session
   * för en omröstning kan inte användas för att rösta i en annan.
   */
  electionId: z.string().uuid('Ogiltig omröstning.'),
})

/**
 * En röst på en valsedel.
 *
 * Exakt ett av `ballotPartyId` och `optionId` måste vara satt: en
 * partivalsedel besvaras med ett parti, en fråga med ett alternativ. Att
 * skicka båda eller inget är inte en glömska utan en indikation på att
 * anroparen missförstått valsedeln, och avvisas därför vid gränsen i stället
 * för att tolkas välvilligt.
 *
 * `candidateId` är alltid frivillig — personröst är en rättighet, inte ett
 * krav.
 */
export const castVoteSchema = z
  .object({
    ballotId: z.string().uuid('Ogiltig valsedel.'),
    ballotPartyId: z.string().uuid('Ogiltigt parti.').optional(),
    candidateId: z.string().uuid('Ogiltig kandidat.').optional(),
    optionId: z.string().uuid('Ogiltigt alternativ.').optional(),
    /** Röstintyget. 32 slumpbytes som väljaren valt själv. */
    credentialId: z.string().regex(/^[0-9a-f]{64}$/, 'Ogiltigt röstintyg.'),
    /** Avblindad signatur, 2048 bitar som hex. */
    credentialSignature: z.string().regex(/^[0-9a-f]{512}$/, 'Ogiltig signatur.'),
  })
  .refine((value) => Boolean(value.ballotPartyId) !== Boolean(value.optionId), {
    message: 'Ange antingen ett parti eller ett svarsalternativ, inte båda.',
  })
  .refine((value) => !(value.candidateId && !value.ballotPartyId), {
    message: 'En personröst kräver att du också valt ett parti.',
  })

/**
 * Begäran om ett röstintyg.
 *
 * `blinded` är väljarens intyg multiplicerat med en slumpfaktor. Servern kan
 * inte utläsa något ur det, och validerar därför bara formatet: 2048 bitar
 * som hex, alltså exakt modulusens bredd.
 */
export const issueCredentialSchema = z.object({
  ballotId: z.string().uuid('Ogiltig valsedel.'),
  blinded: z.string().regex(/^[0-9a-f]{512}$/, 'Ogiltigt blindat värde.'),
})

/**
 * Talen i den krypterade valsedeln, chiffer och bevis, som decimalsträngar.
 *
 * SAMMA TOLKNING SOM VERIFIERINGEN, INTE EN EGEN (fixrunda 1, uppgift 14b).
 *
 * Förut godtog schemat varje följd av siffror, utan längdgräns, och
 * verifieringen tolkade på sitt eget sätt, med `BigInt()`. "007" och ett svar
 * plus q gick igenom båda, och ett bevisfält kunde ha hundratusentals siffror.
 * Nu prövar schemat med parseScalar och parseElement i src/lib/crypto/group.ts,
 * samma funktioner som verifieringen använder, och de två säger därför samma
 * sak om varje tal: kanoniskt skrivet, högst 617 siffror, en utmaning eller ett
 * svar i [0, q) och ett chiffer eller ett åtagande i [1, p). Ett annat tal ger
 * ett tydligt 400-svar här, innan något räknas.
 *
 * Om ett chiffer ligger i undergruppen, och om bevisen håller, avgör
 * fortfarande `verifyEncryptedBallot`.
 */
const scalarStringSchema = z
  .string()
  .max(MAX_DECIMAL_DIGITS, 'Ogiltigt talformat.')
  .refine((value) => parseScalar(value) !== null, 'Ogiltigt talformat.')

const elementStringSchema = z
  .string()
  .max(MAX_DECIMAL_DIGITS, 'Ogiltigt talformat.')
  .refine((value) => parseElement(value) !== null, 'Ogiltigt talformat.')

const zeroOrOneProofSchema = z.object({
  a0: elementStringSchema,
  b0: elementStringSchema,
  a1: elementStringSchema,
  b1: elementStringSchema,
  challenge0: scalarStringSchema,
  challenge1: scalarStringSchema,
  response0: scalarStringSchema,
  response1: scalarStringSchema,
})

const equalityProofSchema = z.object({
  a: elementStringSchema,
  b: elementStringSchema,
  challenge: scalarStringSchema,
  response: scalarStringSchema,
})

/** Den krypterade valsedeln, på trådformat — se `EncryptedBallot` i `verify-ballot.ts`. */
export const encryptedBallotSchema = z.object({
  ciphertext: z
    .array(z.object({ c1: elementStringSchema, c2: elementStringSchema }))
    .min(1)
    .max(200),
  proofs: z.object({
    /**
     * Bevisens format (fixrunda 1 av uppgift 14d). En röstsida som laddades
     * före uppdateringen skickar valsedeln utan markören, och bevisen i den är
     * byggda med det gamla transkriptet. Beskedet säger åt väljaren att ladda
     * om sidan, som då hämtar den nya koden.
     */
    format: z.literal(PROOF_FORMAT, {
      errorMap: () => ({
        message: 'Sidan är en äldre version och rösten lades inte. Ladda om sidan och rösta igen.',
      }),
    }),
    components: z.array(zeroOrOneProofSchema).min(1).max(200),
    sum: equalityProofSchema,
  }),
  ciphertextHash: z.string().regex(/^[0-9a-f]{64}$/, 'Ogiltig hash.'),
})

/**
 * Start av signeringen för en krypterad röst.
 *
 * Bär bara det väljaren redan vet: vilken valsedel, och hashen över det
 * chiffer hon just krypterat i webbläsaren. `castSequence` finns INTE här —
 * servern räknar själv fram den, se `nextCastSequence` i
 * `pending-vote.service.ts`. Tog rutten emot den från klienten kunde en
 * angripare ange ett godtyckligt högt tal och senare spela upp ett äldre,
 * lägre kuvert utan att räknarspärren fångade det.
 */
export const signStartSchema = z.object({
  ballotId: z.string().uuid('Ogiltig valsedel.'),
  ciphertextHash: z.string().regex(/^[0-9a-f]{64}$/, 'Ogiltig hash.'),
})

/**
 * Inlämning av den signerade, krypterade valsedeln.
 *
 * INGET SIGNATUR- ELLER CERTIFIKATFÄLT HÄR, OCH DET ÄR AVSIKTLIGT.
 *
 * Servern hämtar signaturen och certifikatet från sin egen BankID-hämtning
 * (`bankIdService.collect(orderRef)`), aldrig från begärans kropp. Zod
 * stryper okända fält som standard, så skickar en klient ändå med
 * `signature`, `certificate` eller `castSequence` försvinner de redan här —
 * innan rutten ens ser dem.
 */
export const castEncryptedBallotSchema = z.object({
  ballotId: z.string().uuid('Ogiltig valsedel.'),
  orderRef: z.string().uuid('Ogiltig referens.'),
  ballot: encryptedBallotSchema,
})

/**
 * Enhetens sparade chifferhashar, en per valsedel, för jämförelsen i
 * /api/vote/compare.
 *
 * I KROPPEN, INTE I URL:EN. En hash i en sökväg eller frågesträng hamnar i
 * accessloggar, proxyloggar och webbläsarhistorik, och den här hashen är
 * precis det handtag spec 10 varnar för tillsammans med läsrätt i votes_db.
 *
 * Högst femtio, samma tak som för valsedlar i en omröstning. En väljare har
 * aldrig fler kuvert än så att fråga om.
 *
 * VARJE VALSEDEL HÖGST EN GÅNG. Rutten svarar ja eller nej på om en hash är
 * väljarens liggande kuvert. En enhet har en hash per valsedel att fråga om,
 * och fick den skicka samma valsedel femtio gånger kunde den pröva femtio
 * kandidater per anrop, förbi hastighetsbegränsningen.
 */
export const compareDeviceVotesSchema = z
  .object({
    ballots: z
      .array(
        z.object({
          ballotId: z.string().uuid('Ogiltig valsedel.'),
          ciphertextHash: z.string().regex(/^[0-9a-f]{64}$/, 'Ogiltig hash.'),
        }),
      )
      .min(1)
      .max(50),
  })
  .refine(
    (value) => new Set(value.ballots.map((entry) => entry.ballotId)).size === value.ballots.length,
    { message: 'Varje valsedel får bara förekomma en gång.' },
  )

/** Avslutad prenumeration. Bara endpointen behövs för att hitta raden. */
export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url('Ogiltig endpoint.').max(2000),
})

/** Observatörens sidindelade hämtning av röstunderlaget. */
export const observerVotesSchema = z.object({
  electionId: z.string().uuid('Ogiltig omröstning.'),
  offset: z.number().int().min(0).max(10_000_000).optional(),
  pageSize: z.number().int().min(1).max(2000).optional(),
})

/** Statistikbegäran. Utan omröstning svarar rutten bara med listan. */
export const statsRequestSchema = z.object({
  electionId: z.string().uuid('Ogiltig omröstning.').optional(),
})

/** Uppslag av en valsedels innehåll. Id:t ligger i kroppen, inte i sökvägen. */
export const ballotLookupSchema = z.object({
  ballotId: z.string().uuid('Ogiltig valsedel.'),
})

/**
 * En förtroendepersons bidrag till en valsedels summa (uppgift 12).
 *
 * Frasen har ingen övre gräns utöver kroppens, som när valet skapas: en lång
 * fras ska aldrig avvisas, och en fras som gick att sätta ska gå att lämna.
 * Den lagras aldrig och loggas aldrig, se src/orchestration/tally.usecase.ts.
 */
export const partialDecryptionRequestSchema = z.object({
  ballotId: z.string().uuid('Ogiltig valsedel.'),
  trusteeIndex: z
    .number()
    .int(`Ange förtroendepersonens nummer, 1 till ${TRUSTEE_COUNT}.`)
    .min(1, `Ange förtroendepersonens nummer, 1 till ${TRUSTEE_COUNT}.`)
    .max(TRUSTEE_COUNT, `Ange förtroendepersonens nummer, 1 till ${TRUSTEE_COUNT}.`),
  passphrase: z.string().min(1, 'Ange förtroendepersonens fras.'),
})

/** Räkningen av en valsedel (uppgift 12). */
export const tallyRequestSchema = z.object({
  ballotId: z.string().uuid('Ogiltig valsedel.'),
})

/** Omröstning att legitimera sig för. */
export const startAuthForElectionSchema = z.object({
  personalNumber: personalNumberSchema,
  electionId: z.string().uuid('Ogiltig omröstning.'),
})

const ballotInputSchema = z
  .object({
    kind: z.enum(['KOMMUN', 'LANDSTING', 'RIKSDAG', 'FRAGA']),
    label: z.string().trim().min(1, 'Valsedeln behöver ett namn.').max(200),
    areaCode: z.string().trim().max(20).optional(),
    allowsCandidateVote: z.boolean().optional(),
    parties: z
      .array(
        z.object({
          // Partierna är förskapade och väljs ur registret. Fritext här vore
          // hur "Socialdemokraterna" och "Socialdemokraterna " blir två
          // partier i rösträkningen.
          partyId: z.string().uuid('Okänt parti.'),
          candidates: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
        }),
      )
      .max(60)
      .optional(),
    options: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  })
  .refine(
    (value) => (value.kind === 'FRAGA' ? (value.options?.length ?? 0) >= 2 : true),
    { message: 'En fråga behöver minst två svarsalternativ.' },
  )
  .refine(
    (value) => (value.kind === 'FRAGA' ? !value.parties?.length : (value.parties?.length ?? 0) > 0),
    { message: 'En partivalsedel behöver minst ett parti, en fråga inga.' },
  )

/**
 * Tre lösenfraser, en per förtroendeman.
 *
 * Endast en minimilängd kontrolleras här — det är administratörsgränssnittet,
 * inte valsedelsformuläret, som ska vägleda förtroendemännen till en stark
 * fras. Ingen övre gräns: en lång fras ska aldrig avvisas.
 */
const trusteePassphrasesSchema = z
  .tuple([
    z.string().min(8, 'Varje lösenfras måste vara minst 8 tecken.'),
    z.string().min(8, 'Varje lösenfras måste vara minst 8 tecken.'),
    z.string().min(8, 'Varje lösenfras måste vara minst 8 tecken.'),
  ])
  .refine((phrases) => new Set(phrases).size === phrases.length, {
    message: 'Förtroendemännens lösenfraser måste vara olika.',
  })

export const createElectionSchema = z
  .object({
    name: z.string().trim().min(1, 'Omröstningen behöver ett namn.').max(200),
    kind: z.enum(['RIKSDAGSVAL', 'ALLMAN_OMROSTNING']),
    opensAt: z.coerce.date(),
    closesAt: z.coerce.date(),
    ballots: z.array(ballotInputSchema).min(1, 'Minst en valsedel krävs.').max(50),
    trusteePassphrases: trusteePassphrasesSchema,
  })
  .refine((value) => value.closesAt > value.opensAt, {
    message: 'Omröstningen måste stänga efter att den öppnat.',
  })

/** En enhets prenumeration på notiser. Innehåller ingenting om vem enheten tillhör. */
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url('Ogiltig endpoint.').max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(200),
  }),
})

/**
 * Token i visningsformat eller utan gruppering.
 * Crockford base32 utan I, L, O och U (tecken som förväxlas vid avläsning).
 */
export const verifyTokenSchema = z.object({
  token: z
    .string()
    .trim()
    .min(1, 'Ange din token.')
    .max(128, 'Ogiltig token.')
    .regex(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ-]+$/i, 'Ogiltigt tokenformat.'),
})

/**
 * Adminlogin.
 *
 * Tar emot en BankID-referens, inte ett lösenord. Behörigheten avgörs av
 * adminflaggan på personens rad i röstlängden — det finns ingen delad
 * hemlighet kvar i systemet att skicka hit.
 */
export const adminLoginSchema = z.object({
  orderRef: z.string().uuid('Ogiltig referens.'),
})

/**
 * Största kropp som läses, i byte.
 *
 * VARFÖR EN GRÄNS (fixrunda 1, uppgift 14b)
 *
 * `request.json()` läser hela kroppen, hur stor den än är, innan schemat får
 * säga något. Granskaren visade att stoppet i händelseslingan växte med
 * omkring 4 s per MB kropp, när talen i en valsedel förlängdes. Talen har nu en
 * egen gräns i schemat, men att läsa och tolka en kropp på hundratals MB
 * kostar minne och tid ändå.
 *
 * VARFÖR JUST 2 MiB
 *
 * Den största kropp någon rutt behöver är en krypterad valsedel med de 200
 * alternativ som schemat tillåter: tio tal om högst 617 siffror per
 * alternativ, omkring 6,3 kB, alltså knappt 1,3 MB. En riksdagsvalsedel med
 * 26 alternativ är omkring 170 kB. De andra rutterna tar emot betydligt
 * mindre: ett id, en hash, eller en omröstning att skapa.
 */
export const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024

/**
 * Kroppen som text, eller null om den är större än gränsen.
 *
 * Content-Length prövas först, så att en för stor kropp inte läses alls. Men
 * rubriken saknas vid chunkad överföring, och den kan ljuga. Därför räknas
 * också varje byte som faktiskt läses, och läsningen avbryts så fort gränsen
 * passerats, i stället för att först läsa allt och sedan mäta.
 */
async function readBodyWithin(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!request.body) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break

    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  // Som `request.json()`: UTF-8, och ett inledande byte order mark tas bort.
  return new TextDecoder().decode(bytes)
}

/** Läser och validerar JSON-body. Kastar aldrig vidare råa parserfel. */
export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  let raw: unknown
  try {
    const text = await readBodyWithin(request, MAX_JSON_BODY_BYTES)
    if (text === null) return { ok: false, message: 'Begäran är för stor.' }
    raw = JSON.parse(text)
  } catch {
    return { ok: false, message: 'Ogiltig begäran.' }
  }

  const result = schema.safeParse(raw)
  if (!result.success) {
    return { ok: false, message: result.error.issues[0]?.message ?? 'Ogiltig begäran.' }
  }
  return { ok: true, data: result.data }
}
