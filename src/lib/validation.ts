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

export const startAuthSchema = z.object({
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
  })
  .refine((value) => Boolean(value.ballotPartyId) !== Boolean(value.optionId), {
    message: 'Ange antingen ett parti eller ett svarsalternativ, inte båda.',
  })
  .refine((value) => !(value.candidateId && !value.ballotPartyId), {
    message: 'En personröst kräver att du också valt ett parti.',
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

export const adminLoginSchema = z.object({
  password: z.string().min(1, 'Ange lösenord.').max(256),
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
