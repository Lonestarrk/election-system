import { getAdminSession } from '@/lib/admin-auth'
import { isValidCsrfToken } from '@/lib/csrf'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { describeErrorChain, logger } from '@/lib/logger'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, statsRequestSchema } from '@/lib/validation'
import { certifyElection } from '@/orchestration/final-check.usecase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/elections/certify
 *
 * Fastställer valresultatet — om, och bara om, omröstningen står i fasen
 * TALLIED och varje kontroll i slutkontrollen går igenom. Fasen blir då
 * CERTIFIED, med jämför-och-sätt och en revisionspost (uppgift 12b).
 *
 * SPÄRREN KAN INTE KRINGGÅS HÄRIFRÅN.
 *
 * Rutten tar emot ETT fält: vilken omröstning det gäller. Det finns ingen
 * force-parameter, ingen lista över kontroller att hoppa över och ingen väg
 * att skicka med en egen rapport. Kontrollen körs om på servern vid varje
 * anrop, och fallerar något kritiskt sätts omröstningen i UNDER_REVIEW i
 * stället för att fastställas.
 *
 * Det är avsiktligt att administratören inte kan ta sig förbi. En knapp som
 * tvingar igenom ett resultat skulle göra varje annan kontroll i systemet
 * meningslös — den som kan trycka på den behöver inte bry sig om någon av dem.
 *
 * Ett val i UNDER_REVIEW går inte heller att återställa via applikationen i
 * skarpt läge. Avvikelsen kräver mänsklig granskning, och en knapp som markerar
 * den som utredd vore samma spärr med ett extra klick. Det enda undantaget är
 * demovalet, som demoläget kan nollställa i sin helhet, se
 * /api/demo/reset-election.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('certify', getClientIp(request), RATE_LIMITS.createElection)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många försök.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const session = await getAdminSession()
  if (!session) return errorResponse('UNAUTHORISED', 'Inte inloggad.', 401)

  if (!isValidCsrfToken(request, session.csrfSecret)) {
    return errorResponse('CSRF_FAILED', 'Begäran avvisades.', 403)
  }

  const body = await parseJsonBody(request, statsRequestSchema)
  if (!body.ok) return errorResponse('INVALID_INPUT', body.message, 400)

  if (!body.data.electionId) {
    return errorResponse('INVALID_INPUT', 'Ange vilken omröstning som ska fastställas.', 400)
  }

  /**
   * ETT OVÄNTAT FEL ÄR ETT BESKED TILL SIDAN, INTE EN NAKEN 500 (granskningen av
   * 12b). Fastställandet kör hela slutkontrollen, som läser båda databaserna,
   * och ett fel där ska inte nå administratören som ett tomt svar. Beskedet
   * gissar ingen orsak, som stängningens: den står i serverloggen. Fastställandet
   * skriver CERTIFIED med jämför-och-sätt och revisionsposten i en transaktion,
   * så ett kast efter den kan inte lämna en fas utan post. Sidan läser därför om
   * fasen från servern, och säger inte att något är fastställt.
   */
  let outcome: Awaited<ReturnType<typeof certifyElection>>
  try {
    outcome = await certifyElection(body.data.electionId)
  } catch (error) {
    logger.error('Fastställandet avbröts', { reason: describeErrorChain(error) })
    return errorResponse(
      'INTERNAL',
      'Fastställandet kunde inte slutföras, av ett skäl som står i serverloggen. Läs om omröstningens ' +
        'fas för att se om resultatet blev fastställt, och kör slutkontrollen igen innan du försöker på nytt.',
      500,
    )
  }

  if (outcome.status === 'unknown_election') {
    return errorResponse('UNKNOWN_ELECTION', 'Omröstningen finns inte.', 404)
  }

  if (outcome.status === 'not_ready') {
    /**
     * Förutsättningarna är inte uppfyllda — omröstningen pågår, är inte
     * skalad eller inte räknad. Ingenting har markerats som avvikande, och
     * administratören kan komma tillbaka när valet är räknat.
     */
    return jsonResponse(
      {
        status: 'not_ready',
        message:
          'Resultatet kan inte fastställas än. Se vilka förutsättningar som saknas i ' +
          'rapporten. Ingenting har markerats som avvikande.',
        report: outcome.report,
      },
      409,
    )
  }

  if (outcome.status === 'blocked') {
    // 409, inte 403: begäran var behörig, men systemets tillstånd tillåter den
    // inte. Rapporten följer med så att administratören ser exakt vad som
    // stoppade fastställandet.
    return jsonResponse(
      {
        status: 'blocked',
        message:
          'Resultatet kan inte fastställas. Omröstningen är markerad som avvikande och ' +
          'kräver granskning.',
        report: outcome.report,
      },
      409,
    )
  }

  if (outcome.status === 'already_certified') {
    return jsonResponse({
      status: 'already_certified',
      message: 'Resultatet är redan fastställt.',
      report: outcome.report,
    })
  }

  return jsonResponse({
    status: 'certified',
    message: 'Resultatet är fastställt, och omröstningen står i fasen CERTIFIED.',
    report: outcome.report,
  })
}
