import { describe, expect, it } from 'vitest'
import {
  failedMessage,
  pendingMessage,
  publicHintCode,
  requestErrorMessage,
  RFA,
} from '@/lib/bankid-messages'

/**
 * BANKID:S REKOMMENDERADE MEDDELANDEN (uppgift 17c).
 *
 * Källa: developers.bankid.com/ui-resources/user-messages och
 * /api-references/auth--sign/collect, hämtade 2026-10-03.
 */

describe('meddelandena är BankID:s', () => {
  it('ordagrant, för de vanligaste', () => {
    expect(RFA.RFA1).toBe('Starta BankID-appen.')
    expect(RFA.RFA3).toBe('Åtgärden avbröts. Försök igen.')
    expect(RFA.RFA4).toBe('En identifiering eller underskrift pågår redan för ditt personnummer. Försök igen.')
    expect(RFA.RFA5).toBe('Något gick fel. Försök igen.')
    expect(RFA.RFA6).toBe('Åtgärden avbröts.')
    expect(RFA.RFA8).toBe(
      'BankID-appen svarar inte. Kontrollera att den är startad och att du har internetanslutning. Försök sedan igen.',
    )
    expect(RFA.RFA9).toBe('Skriv in din säkerhetskod i BankID-appen och välj Identifiera eller Skriv under.')
    expect(RFA.RFA13).toBe('Försöker starta BankID-appen.')
    expect(RFA.RFA16).toBe(
      'Ditt BankID är för gammalt eller spärrat. Använd ett annat BankID eller skaffa ett nytt hos din bank.',
    )
    expect(RFA.RFA21).toBe('En identifiering eller underskrift pågår.')
    expect(RFA.RFA22).toBe('Något gick fel. Försök igen.')
  })
})

describe('pågående order', () => {
  it.each([
    ['outstandingTransaction', false, RFA.RFA1],
    ['outstandingTransaction', true, RFA.RFA13],
    ['noClient', false, RFA.RFA1],
    ['noClient', true, RFA.RFA1],
    ['started', true, RFA.RFA15B],
    ['userSign', false, RFA.RFA9],
    ['userMrtd', false, RFA.RFA23],
    ['processing', false, RFA.RFA21],
    ['userStepUp', false, RFA.RFA25],
    ['userFace', false, RFA.RFA24],
    ['enOkandKod', false, RFA.RFA21],
  ])('%s (autostart %s)', (hintCode, autoStarted, message) => {
    expect(pendingMessage(hintCode, { autoStarted })).toBe(message)
  })
})

describe('misslyckad order', () => {
  it.each([
    ['expiredTransaction', RFA.RFA8],
    ['certificateErr', RFA.RFA16],
    ['userCancel', RFA.RFA6],
    ['cancelled', RFA.RFA3],
    ['startFailed', RFA.RFA17B],
    ['mrtdVerificationFailed', RFA.RFA26],
    ['facialRecognitionFailed', RFA.RFA27],
    ['nfcNotSupportedByDevice', RFA.RFA28],
    ['multipleBankIdsOnDevice', RFA.RFA29],
    ['stepUpFailed', RFA.RFA30],
    ['enOkandKod', RFA.RFA22],
  ])('%s', (hintCode, message) => {
    expect(failedMessage(hintCode)).toBe(message)
  })
})

describe('felkoderna', () => {
  it.each([
    ['alreadyInProgress', RFA.RFA4],
    ['requestTimeout', RFA.RFA5],
    ['internalError', RFA.RFA5],
    ['maintenance', RFA.RFA5],
    ['invalidParameters', RFA.RFA22],
    ['unauthorized', RFA.RFA22],
    ['notFound', RFA.RFA22],
    ['network', RFA.RFA5],
    ['timeout', RFA.RFA5],
    ['enOkandKod', RFA.RFA22],
  ])('%s', (code, message) => {
    expect(requestErrorMessage(code)).toBe(message)
  })
})

describe('hintCode som lämnas till webbläsaren', () => {
  it('bara en kod av bokstäver, aldrig något annat', () => {
    expect(publicHintCode('userSign')).toBe('userSign')
    expect(publicHintCode('<script>')).toBeNull()
    expect(publicHintCode('a'.repeat(65))).toBeNull()
    expect(publicHintCode(42)).toBeNull()
  })
})
