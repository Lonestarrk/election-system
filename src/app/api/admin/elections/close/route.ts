import { getAdminSession, isAdminAuthenticated } from '@/lib/admin-auth'
import { isValidCsrfToken } from '@/lib/csrf'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, statsRequestSchema } from '@/lib/validation'
import { getMirroredElection } from '@/modules/eligibility/election.service'
import { closeElection } from '@/orchestration/close-election.usecase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/elections/close
 *
 * Stänger omröstningen och skalar bort det yttre kuvertet: chiffren flyttas
 * till den anonyma röstdatabasen och kopplingen mellan väljare och röst
 * raderas. Det är den punkt där valhemligheten uppstår.
 *
 * VARFÖR STÄNGNINGEN ÄR EN ADMINÅTGÄRD OCH INTE SKER AV SIG SJÄLV NÄR KLOCKAN
 * SLÅR.
 *
 * Skalningen är den enda oåterkalleliga händelsen i systemet. Före den går
 * varje fel att utreda — kuvertet ligger kvar med väljarens identitet bredvid,
 * en avvikelse går att peka ut och en väljare går att fråga. Efter den finns
 * ingen väljare att fråga och ingen signatur att kontrollera.
 *
 * En sådan åtgärd ska utföras av någon, inte inträffa. En schemalagd
 * stängning hänger på serverklockan, och en klocka som går fel — eller som
 * någon ställer om — skulle utlösa raderingen tyst, medan röstningen
 * fortfarande pågår. Det är samma resonemang som `Election.phase`s egen
 * dokumentation i schemat: en fasövergång ska vara en händelse någon utfört,
 * inte en jämförelse mot klockan.
 *
 * Klockan avgör fortfarande NÄR det får ske — `closeElection` vägrar före
 * `closesAt`. Den avgör bara inte ATT det sker.
 *
 * Kvar att lösa för ett riktigt system: flerpartskontroll. Att en ensam
 * administratör kan utlösa den oåterkalleliga raderingen är den enskilt
 * svagaste punkten i den här rutten — se `admin-auth.ts` och SECURITY.md.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('close-election', getClientIp(request), RATE_LIMITS.createElection)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många försök.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  if (!(await isAdminAuthenticated())) {
    return errorResponse('UNAUTHORISED', 'Inte inloggad.', 401)
  }

  /**
   * Sessionen hämtas separat för CSRF-hemligheten, precis som i
   * certify-rutten. Behörighetsfrågan ställs för sig ovan: den är ett eget
   * krav på just den här rutten och ska inte kunna försvinna av misstag om
   * CSRF-kontrollen någon gång skrivs om.
   */
  const session = await getAdminSession()
  if (!session) return errorResponse('UNAUTHORISED', 'Inte inloggad.', 401)

  if (!isValidCsrfToken(request, session.csrfSecret)) {
    return errorResponse('CSRF_FAILED', 'Begäran avvisades.', 403)
  }

  const body = await parseJsonBody(request, statsRequestSchema)
  if (!body.ok) return errorResponse('INVALID_INPUT', body.message, 400)

  if (!body.data.electionId) {
    return errorResponse('INVALID_INPUT', 'Ange vilken omröstning som ska stängas.', 400)
  }

  /**
   * Att omröstningen finns avgörs här, inte i användningsfallet.
   *
   * `CloseOutcome` har medvetet ingen gren för en okänd omröstning: varje
   * gren där beskriver ett tillstånd hos en verklig omröstning, och en
   * felstavad identifierare är en fråga om begäran — alltså ruttens sak.
   */
  const election = await getMirroredElection(body.data.electionId)
  if (!election) return errorResponse('UNKNOWN_ELECTION', 'Omröstningen finns inte.', 404)

  const outcome = await closeElection(body.data.electionId)

  if (outcome.status === 'too_early') {
    // 409, inte 403: begäran var behörig, men omröstningen pågår fortfarande.
    return jsonResponse(
      {
        status: 'too_early',
        message:
          'Omröstningen kan inte stängas än. Den är öppen till ' +
          `${outcome.closesAt.toISOString()}.`,
        closesAt: outcome.closesAt.toISOString(),
      },
      409,
    )
  }

  if (outcome.status === 'already_closed') {
    // Inte ett fel. En omkörning ska vara ofarlig — det är hela poängen med
    // att idempotensen bärs av databasen och inte av en transaktion.
    return jsonResponse({
      status: 'already_closed',
      message: 'Omröstningen är redan stängd och kopplingen raderad.',
    })
  }

  if (outcome.status === 'validation_failed') {
    /**
     * SPÄRREN, INTE RAPPORTEN.
     *
     * Ingenting har flyttats och ingenting har raderats. Bara sammanfattningen
     * går ut: antal, kategorier och utfall. Vilka väljare avvikelserna gällde
     * stannar i användningsfallet — se `ValidationReport`.
     */
    return jsonResponse(
      {
        status: 'validation_failed',
        message:
          'Stängningen avbröts. Valideringen hittade avvikelser, och kopplingen mellan ' +
          'väljare och röst är kvar så att de går att utreda.',
        summary: outcome.summary,
      },
      409,
    )
  }

  if (outcome.status === 'invalid_ballot') {
    return jsonResponse(
      {
        status: 'invalid_ballot',
        message:
          'Stängningen avbröts. En valsedel verifierar inte längre, och kopplingen mellan ' +
          'väljare och röst är kvar så att den går att utreda.',
        ciphertextHash: outcome.ciphertextHash,
      },
      409,
    )
  }

  return jsonResponse({
    status: 'closed',
    message: 'Omröstningen är stängd. Kopplingen mellan väljare och röst är raderad.',
    moved: outcome.moved,
    cleared: outcome.cleared,
    envelopeRoot: outcome.envelopeRoot,
  })
}
