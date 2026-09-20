import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { castVoteSchema, parseJsonBody } from '@/lib/validation'
import { castAnonymousVote } from '@/modules/anonymous-vote'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/vote/cast
 *
 * Lägger rösten och returnerar token.
 *
 * DEN HÄR RUTTEN HAR INGEN SESSION, OCH DET ÄR HELA POÄNGEN.
 *
 * Tidigare bar röstningsbegäran en sessionscookie som pekade på en rad i
 * röstlängden. Under de millisekunder rösten skrevs fanns alltså en identitet
 * och ett partival i samma anropsstack — den kortaste men känsligaste
 * kopplingen i systemet.
 *
 * Nu auktoriseras rösten enbart av röstintyget: ett värde väljaren själv valt,
 * signerat blint av valmyndigheten, som ingen kan spåra till en väljare. Ingen
 * cookie läses, ingen session slås upp, och rutten importerar ingenting från
 * röstlängdsmodulen. Den KAN alltså inte veta vem som röstar, oavsett hur
 * koden ändras framöver.
 *
 * Följden är att rutten inte heller revisionsloggar — revisionsloggen ligger i
 * röstlängdsdatabasen, och en import därifrån vore precis den koppling som
 * nyss togs bort. Det som behöver loggas om röstningen loggas vid utfärdandet
 * av intyget, där systemet ändå vet vem väljaren är.
 *
 * Token returneras i svarskroppen, en enda gång. Den finns inte i någon URL,
 * skrivs inte till någon logg, sätts inte i någon cookie och sparas inte i
 * webbläsarens lagring. Efter det här svaret existerar klartexten bara på
 * väljarens skärm.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('cast-vote', getClientIp(request), RATE_LIMITS.castVote)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många försök.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const body = await parseJsonBody(request, castVoteSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  const outcome = await castAnonymousVote(body.data)

  if (outcome.status === 'credential_already_used') {
    // Intyget är redan inlöst. Antingen ett dubbelröstningsförsök, eller en
    // väljare som skickade om samma begäran efter ett avbrott — och för den
    // senare är detta rätt svar: rösten ÄR registrerad, den lades bara förra
    // gången.
    return errorResponse(
      'CREDENTIAL_USED',
      'Det här röstintyget är redan inlöst. Din röst är registrerad sedan tidigare.',
      409,
    )
  }

  if (outcome.status === 'invalid_credential') {
    // Samma svar oavsett om signaturen är felaktig, intyget hör till en annan
    // valsedel eller valsedeln inte finns. Skilda svar skulle låta någon
    // kartlägga systemet genom att pröva sig fram.
    return errorResponse('INVALID_CREDENTIAL', 'Röstintyget är inte giltigt.', 403)
  }

  if (outcome.status === 'invalid_choice') {
    return errorResponse('INVALID_CHOICE', outcome.reason, 400)
  }

  if (outcome.status === 'failed') {
    return errorResponse(
      'RECORDING_FAILED',
      'Rösten kunde tyvärr inte registreras. Ditt röstintyg är oförbrukat — försök igen.',
      500,
    )
  }

  return jsonResponse({
    token: outcome.token,
    warning:
      'Detta är enda gången din token visas. Spara den om du vill kunna kontrollera din röst senare.',
  })
}
