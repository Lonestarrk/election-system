import { getAdminSession } from '@/lib/admin-auth'
import { isValidCsrfToken } from '@/lib/csrf'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, statsRequestSchema } from '@/lib/validation'
import { getMirroredElection } from '@/modules/eligibility/election.service'
import { checkElectionMode } from '@/orchestration/election-mode'
import { startFinalCheck } from '@/orchestration/final-check-job'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/elections/check
 *
 * Startar den automatiska slutkontrollen i bakgrunden och svarar direkt med 202
 * (uppgift 12c, punkt 7d). Rapporten läses med /api/admin/elections/check-status.
 *
 * Sedan 12b verifierar kontrollen varje rad i urnan, omkring 0,4 s per rad, så
 * ett stort val tar timmar. En HTTP-begäran ska inte vänta så länge. Resultatet
 * sparas i minnet och går förlorat vid en omstart, och då får kontrollen köras
 * om, se src/orchestration/final-check-job.ts.
 *
 * ADMINISTRATÖREN SKA INTE KUNNA KLICKA FRAM ETT RESULTAT OCH GODKÄNNA DET.
 *
 * Rutten finns för att administratören ska se hela bilden INNAN fastställandet:
 * vilka kontroller som gått igenom, vilka som fallerat, vilka avvikelser som
 * finns, och om resultatet över huvud taget får fastställas. Rapporten är
 * läsning. Den ändrar ingenting och ger ingen behörighet, och fastställandet
 * litar inte på den. /api/admin/elections/certify kör en egen kontroll på
 * servern vid varje anrop och vägrar om något kritiskt fallerar.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('final-check', getClientIp(request), RATE_LIMITS.adminStats)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
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
    return errorResponse('INVALID_INPUT', 'Ange vilken omröstning som ska kontrolleras.', 400)
  }

  const election = await getMirroredElection(body.data.electionId)
  if (!election) return errorResponse('UNKNOWN_ELECTION', 'Omröstningen finns inte.', 404)

  // Läget före skrivningen och före starten (uppgift 17, fixrunda 2). En omröstning i det andra läget
  // får ingen slutkontroll startad av den här servern.
  if ((await checkElectionMode(body.data.electionId)) === 'wrong') {
    return jsonResponse(
      {
        status: 'wrong_mode',
        message:
          'Omröstningen skapades i ett annat läge eller mot en annan BankID-miljö än den servern kör i. Ingenting skrevs eller startades. ' +
          'Läget sätts vid driftsättning.',
      },
      409,
    )
  }

  const started = startFinalCheck(body.data.electionId)

  return jsonResponse(
    {
      status: started,
      message:
        started === 'started'
          ? 'Slutkontrollen har startat. Den kan ta lång tid i ett stort val, och sidan läser resultatet när det är klart.'
          : 'Slutkontrollen körs redan för den här omröstningen. Sidan läser resultatet när det är klart.',
    },
    202,
  )
}
