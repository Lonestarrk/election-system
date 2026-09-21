import { z } from 'zod'

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

export const createElectionSchema = z
  .object({
    name: z.string().trim().min(1, 'Omröstningen behöver ett namn.').max(200),
    kind: z.enum(['RIKSDAGSVAL', 'ALLMAN_OMROSTNING']),
    opensAt: z.coerce.date(),
    closesAt: z.coerce.date(),
    ballots: z.array(ballotInputSchema).min(1, 'Minst en valsedel krävs.').max(50),
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

/** Läser och validerar JSON-body. Kastar aldrig vidare råa parserfel. */
export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return { ok: false, message: 'Ogiltig begäran.' }
  }

  const result = schema.safeParse(raw)
  if (!result.success) {
    return { ok: false, message: result.error.issues[0]?.message ?? 'Ogiltig begäran.' }
  }
  return { ok: true, data: result.data }
}
