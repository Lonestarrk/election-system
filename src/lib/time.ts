/**
 * Grovkorniga tidsstämplar.
 *
 * Detta är den enskilt viktigaste motåtgärden mot tidskorrelation.
 *
 * Om röstlängden sparar "person X röstade 14:32:07.412" och röstdatabasen
 * sparar "en röst på parti Y lades 14:32:07.598", så kan den som har båda
 * databaserna para ihop raderna på tid — rad för rad, med hög säkerhet. Den
 * fysiska separationen av databaserna spelar då ingen roll alls: kopplingen
 * ligger i datan, inte i schemat.
 *
 * Genom att avrunda uppåt i granularitet hamnar många röster i samma bucket
 * och blir inbördes oskiljbara.
 *
 * VIKTIG BEGRÄNSNING: detta hjälper bara om det finns tillräckligt många
 * röster per bucket. Vid ett val med tre röster per timme är en timbucket
 * fortfarande unik nog för att peka ut individen. Ett riktigt system behöver
 * garanterad anonymitetsmängd (mix-nets, batchning med tröskelvärde).
 * Se SECURITY.md.
 */

/** Avrundar nedåt till hel timme. Används för anonyma röster. */
export function truncateToHour(date: Date): Date {
  const result = new Date(date)
  result.setUTCMinutes(0, 0, 0)
  return result
}

/** Avrundar nedåt till dygn. Används för "har röstat"-tidpunkten. */
export function truncateToDay(date: Date): Date {
  const result = new Date(date)
  result.setUTCHours(0, 0, 0, 0)
  return result
}
