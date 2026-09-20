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
})

export const castVoteSchema = z.object({
  partyId: z.string().uuid('Ogiltigt parti.'),
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
