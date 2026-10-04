import type { NextResponse } from 'next/server'
import { failedMessage, pendingMessage, publicHintCode } from '@/lib/bankid-messages'
import { errorResponse, jsonResponse } from '@/lib/http'
import { logger } from '@/lib/logger'
import { BankIdRequestError } from './BankIdRpClient'

/**
 * SVAREN TILL WEBBLÄSAREN UNDER EN BANKID-ORDER (uppgift 17c).
 *
 * Varje väntande och misslyckad order får BankID:s rekommenderade text, se
 * src/lib/bankid-messages.ts. hintCode följer med, när den har en tillåten form,
 * så att sidan kan välja RFA13 i stället för RFA1 när väljaren startade appen på
 * samma enhet. Ett fel från BankID ger BankID:s text för felet. Felkoden och
 * HTTP-statusen loggas, men aldrig BankID:s detaljer, orderRef eller något om
 * väljaren.
 */

export function pendingReply(hintCode: string) {
  const code = publicHintCode(hintCode)
  return { status: 'pending' as const, hintCode: code, message: pendingMessage(code ?? '', { autoStarted: false }) }
}

export function failedReply(hintCode: string) {
  const code = publicHintCode(hintCode)
  return { status: 'failed' as const, hintCode: code, message: failedMessage(code ?? '') }
}

function logged(error: BankIdRequestError, during: string): string {
  logger.warn(`BankID svarade med ett fel vid ${during}.`, { code: error.code, httpStatus: error.httpStatus })
  return error.userMessage
}

/**
 * Fel som går över av sig själva: nätet, en tidsgräns, och maintenance när klienten
 * redan prövat igen. Ordern lever kvar hos BankID, och nästa pollning frågar igen
 * (fixrunda 1 av 17c, Mindre 2). Ordern går ut hos BankID efter några minuter, så
 * pollningen tar slut också om felet består.
 */
const TRANSIENT = new Set(['network', 'timeout', 'maintenance'])

export type CollectErrorReply = { response: NextResponse; ended: boolean }

/**
 * Svaret när en pollning fick ett fel från BankID, eller null för alla andra fel.
 *
 * Ett tillfälligt fel ger `pending`, och ordern avslutas inte (`ended` är falskt).
 * Varje annat fel avslutar ordern: väljaren får BankID:s text, och ordern avbryts
 * också hos BankID, så att ingen order ligger kvar där som väljaren inte vet om.
 * Ett avbrott som misslyckas ändrar inte svaret.
 */
export function collectErrorReply(error: unknown, cancel: () => Promise<void>): CollectErrorReply | null {
  if (!(error instanceof BankIdRequestError)) return null
  if (TRANSIENT.has(error.code)) {
    logged(error, 'collect, prövas igen vid nästa pollning')
    return { response: jsonResponse(pendingReply('')), ended: false }
  }
  const message = logged(error, 'collect')
  void cancel().catch(() => undefined)
  return { response: jsonResponse({ status: 'failed', message }, 502), ended: true }
}

/** Svaret när en order inte kunde startas, eller null för alla andra fel. */
export function startErrorReply(error: unknown): NextResponse | null {
  if (!(error instanceof BankIdRequestError)) return null
  return errorResponse('BANKID_ERROR', logged(error, 'start av en order'), 502)
}
