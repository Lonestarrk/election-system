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

/** Svaret när en pollning fick ett fel från BankID, eller null för alla andra fel. */
export function collectErrorReply(error: unknown): NextResponse | null {
  if (!(error instanceof BankIdRequestError)) return null
  return jsonResponse({ status: 'failed', message: logged(error, 'collect') }, 502)
}

/** Svaret när en order inte kunde startas, eller null för alla andra fel. */
export function startErrorReply(error: unknown): NextResponse | null {
  if (!(error instanceof BankIdRequestError)) return null
  return errorResponse('BANKID_ERROR', logged(error, 'start av en order'), 502)
}
