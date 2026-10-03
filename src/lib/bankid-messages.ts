/**
 * BANKID:S REKOMMENDERADE MEDDELANDEN TILL ANVÄNDAREN (uppgift 17c).
 *
 * Texterna är BankID:s egna, ordagrant, och översättningen från hintCode och
 * errorCode följer BankID:s rekommendationer. Källor, hämtade 2026-10-03:
 *   - developers.bankid.com/ui-resources/user-messages (texterna RFA1–RFA30)
 *   - developers.bankid.com/api-references/auth--sign/collect (hintCode)
 *   - developers.bankid.com/api-references/errors (errorCode)
 *
 * Modulen har inga importer, så att både servern och webbläsaren kan läsa den:
 * rutterna sätter meddelandet, och inloggningskomponenten väljer mellan RFA1 och
 * RFA13, som beror på om väljaren startade appen på samma enhet.
 *
 * VARFÖR BANKID:S TEXTER OCH INTE EGNA. Väljaren känner igen dem från andra
 * tjänster, och de säger inget om systemet som en angripare kan använda.
 * Detaljerna i BankID:s felsvar ("details") når aldrig väljaren.
 */

export const RFA = {
  RFA1: 'Starta BankID-appen.',
  RFA2: 'Du verkar inte ha BankID-appen. Installera den och skaffa ett BankID.',
  RFA3: 'Åtgärden avbröts. Försök igen.',
  RFA4: 'En identifiering eller underskrift pågår redan för ditt personnummer. Försök igen.',
  RFA5: 'Något gick fel. Försök igen.',
  RFA6: 'Åtgärden avbröts.',
  RFA8: 'BankID-appen svarar inte. Kontrollera att den är startad och att du har internetanslutning. Försök sedan igen.',
  RFA9: 'Skriv in din säkerhetskod i BankID-appen och välj Identifiera eller Skriv under.',
  RFA13: 'Försöker starta BankID-appen.',
  RFA15A:
    'Söker efter BankID. Säkerställ att du har ett giltigt BankID på den här datorn. Om du har ett BankID på kort, sätt in kortet i kortläsaren.',
  // BankID:s egen text har stavfelet "gitligt". Det rättas här, och är den enda avvikelsen.
  RFA15B: 'Söker efter BankID. Säkerställ att du har ett giltigt BankID på den här enheten.',
  RFA16: 'Ditt BankID är för gammalt eller spärrat. Använd ett annat BankID eller skaffa ett nytt hos din bank.',
  RFA17A: 'Du verkar inte ha BankID-appen/programmet. Installera den och skaffa ett BankID hos din bank.',
  RFA17B: 'Misslyckades att läsa av QR-koden. Starta BankID-appen och läs av QR-koden.',
  RFA19: 'Vill du använda BankID på den här datorn eller ett Mobilt BankID?',
  RFA20: 'Vill du använda BankID på den här enheten eller på en annan enhet?',
  RFA21: 'En identifiering eller underskrift pågår.',
  RFA22: 'Något gick fel. Försök igen.',
  RFA23: 'Fotografera och läs av din ID-handling med BankID-appen.',
  RFA24: 'Gör en ansiktsigenkänning i BankID-appen.',
  RFA25: 'Välj hur du vill bekräfta din identitet i BankID-appen.',
  RFA26: 'Kontrollen av din ID-handling misslyckades. Försök igen.',
  RFA27: 'Ansiktsigenkänningen misslyckades. Försök igen.',
  RFA28: 'Din enhet saknar den läsare som behövs för att kontrollera ID-handlingar.',
  RFA29:
    'Du har flera BankID på din enhet. Du behöver radera alla utom ett BankID för att kunna slutföra identifieringen. Det gör du under Meny - Inställningar i din BankID-app.',
  RFA30: 'Bekräftelsen av din identitet misslyckades. Försök igen.',
} as const

/**
 * Meddelandet medan ordern väntar. Okända koder ger RFA21, som BankID säger.
 *
 * `autoStarted`: väljaren valde "BankID på den här enheten". Då är
 * outstandingTransaction RFA13, annars RFA1.
 */
export function pendingMessage(hintCode: string, options: { autoStarted: boolean }): string {
  switch (hintCode) {
    case 'outstandingTransaction':
      return options.autoStarted ? RFA.RFA13 : RFA.RFA1
    case 'noClient':
      return RFA.RFA1
    case 'started':
      // RFA15A gäller BankID på kort i en dator. Systemet vet inte vilken enhet det är,
      // och B-texten stämmer för båda.
      return RFA.RFA15B
    case 'userSign':
      return RFA.RFA9
    case 'userMrtd':
      return RFA.RFA23
    case 'userFace':
      return RFA.RFA24
    case 'userStepUp':
      return RFA.RFA25
    case 'processing':
      return RFA.RFA21
    default:
      // Också userCallConfirm, som BankID inte har någon text för, och nya koder.
      return RFA.RFA21
  }
}

/** Meddelandet när ordern har misslyckats. Okända koder ger RFA22, som BankID säger. */
export function failedMessage(hintCode: string): string {
  switch (hintCode) {
    case 'expiredTransaction':
      return RFA.RFA8
    case 'certificateErr':
      return RFA.RFA16
    case 'userCancel':
      return RFA.RFA6
    case 'cancelled':
      return RFA.RFA3
    case 'startFailed':
      // QR-koden är systemets förval, och B-texten säger vad väljaren kan göra då.
      return RFA.RFA17B
    case 'mrtdVerificationFailed':
      return RFA.RFA26
    case 'facialRecognitionFailed':
      return RFA.RFA27
    case 'nfcNotSupportedByDevice':
      return RFA.RFA28
    case 'multipleBankIdsOnDevice':
      return RFA.RFA29
    case 'stepUpFailed':
      return RFA.RFA30
    default:
      return RFA.RFA22
  }
}

/**
 * Meddelandet när anropet till BankID misslyckades. BankID:s rekommendationer:
 *   alreadyInProgress                          RFA4
 *   requestTimeout, internalError              RFA5, inget automatiskt omförsök
 *   maintenance                                omförsök utan att väljaren märker det, sedan RFA5
 *   invalidParameters, unauthorized, notFound  ett fel i systemet, inte ett BankID-fel: RFA22
 *   okänd kod                                  RFA22
 * Systemets egna koder: ett nätverksfel och en tidsgräns ger RFA5, allt annat RFA22.
 */
export function requestErrorMessage(code: string): string {
  switch (code) {
    case 'alreadyInProgress':
      return RFA.RFA4
    case 'requestTimeout':
    case 'internalError':
    case 'maintenance':
    case 'network':
    case 'timeout':
      return RFA.RFA5
    default:
      return RFA.RFA22
  }
}

/**
 * hintCode som får lämnas till webbläsaren: bara bokstäver, och kort. Koden kommer
 * från BankID, och en kod i någon annan form har ingen anledning att nå sidan.
 */
export function publicHintCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z]{1,64}$/.test(value) ? value : null
}
