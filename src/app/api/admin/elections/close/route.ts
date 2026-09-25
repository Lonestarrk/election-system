import { getAdminSession, isAdminAuthenticated } from '@/lib/admin-auth'
import { isValidCsrfToken } from '@/lib/csrf'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { describeErrorChain, logger } from '@/lib/logger'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, statsRequestSchema } from '@/lib/validation'
import { getMirroredElection } from '@/modules/eligibility/election.service'
import {
  abortedMessageFor,
  closeElection,
  linkStateOf,
  urnRowsReplacedOf,
} from '@/orchestration/close-election.usecase'

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

  /**
   * ETT KAST HÄR ÄR INTE ETT OKÄNT FEL — DET ÄR SKYDDSMEKANISMEN SOM LÖSTE UT.
   *
   * `closeElection` kastar hellre än att gå vidare när ett antagande brustit:
   * när urnan inte är exakt de validerade kuverten, när raderingen inte
   * träffar exakt de kuvert som flyttats, och när skrivningarna i röstlängden
   * inte finns kvar efter transaktionen. Gemensamt för de vägarna är att DEN
   * HÄR KÖRNINGEN INTE HAR RADERAT NÅGOT KUVERT — och det är det
   * administratören behöver veta. Att ingen annan körning har gjort det följer
   * inte av det ensamt. Före uppgift 11d kunde en andra stängning som läste
   * fasen innan den första hann göra COMMIT, men kuverten efteråt, beskriva
   * kopplingen som orörd, fast den första redan raderat den. Sedan 11d kör bara
   * en stängning åt gången, och fasen läses innan "orörd" sägs. Sedan fixrunda
   * 1 av 11d frågas också låset efter läsningen, eftersom en stängning som
   * tagit över ett förlorat lås kan radera kopplingen.
   * En naken 500 hade sagt minst precis där beskedet betyder mest.
   *
   * SVARET PÅSTÅR INGEN ORSAK. Rutten kan inte veta vilken av vägarna som
   * löste ut, och en gissning som råkar peka fel skickar utredningen åt fel
   * håll. Orsaken står i loggen, säkerhetspåståendet i svaret.
   *
   * OCH SÄKERHETSPÅSTÅENDET FORMULERAS INTE HÄR. Att den här körningen inte
   * raderat något är känt bara på de vägar som bryter innan eller under
   * transaktionen, aldrig på den där efterkontrollens egen läsning fallerade —
   * då kan kopplingen mycket väl vara borta. Skillnaden bärs av felet självt
   * (`CloseAbortedError.linkState`), och `abortedMessageFor` översätter den
   * till besked. Rutten väljer bara statuskod.
   */
  let outcome: Awaited<ReturnType<typeof closeElection>>

  try {
    outcome = await closeElection(body.data.electionId)
  } catch (error) {
    const linkState = linkStateOf(error)

    /**
     * HELA ORSAKSKEDJAN, INTE BARA DET YTTERSTA LAGRET.
     *
     * `closeElection` paketerar om det underliggande felet och lägger det i
     * `cause`. Loggas bara `error.message` försvinner det verkliga felet —
     * och det gör det på den väg där administratören redan har minst att gå
     * på. `describeErrorChain` följer kedjan, och `abortedMessageFor`s löfte
     * om att orsaken framgår av serverloggen blir därmed sant.
     */
    logger.error('Stängningen avbröts', { linkState, reason: describeErrorChain(error) })

    /**
     * `linkState` följer med i svaret, inte bara i prosan.
     *
     * `status: 'aborted'` säger bara att något gick fel. En klient som ska
     * avgöra om den får köra om utan att först titta i databasen behöver veta
     * OM kopplingen är orörd — och den uppgiften ska inte behöva läsas ut ur
     * en svensk mening.
     */
    const urnRowsReplaced = urnRowsReplacedOf(error)

    return jsonResponse(
      {
        status: 'aborted',
        linkState,
        message: `${abortedMessageFor(error)}${replacedNote(urnRowsReplaced)}`,
        ...(urnRowsReplaced.length === 0 ? {} : { urnRowsReplaced }),
      },
      409,
    )
  }

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

  if (outcome.status === 'in_progress') {
    /**
     * En annan stängning av samma omröstning pågår, till exempel efter ett
     * dubbelklick eller i en annan process. Den här har inte rört något, och
     * beskedet säger inget om kopplingen, eftersom den andra kan radera den
     * när som helst. 409, som för ett för tidigt försök: begäran var behörig,
     * men omröstningen kan inte stängas av den just nu.
     */
    return jsonResponse(
      {
        status: 'in_progress',
        message:
          'En annan stängning av omröstningen pågår, och den här har inte gjort något. Den ' +
          'andra svarar själv med sitt utfall. Kör om när den är klar, så svarar en stängd ' +
          'omröstning att den är stängd.',
      },
      409,
    )
  }

  if (outcome.status === 'validation_failed') {
    /**
     * SPÄRREN, INTE RAPPORTEN.
     *
     * Ingenting har flyttats och ingenting har raderats. Bara sammanfattningen
     * går ut: antal, kategorier och utfall. Vilka väljare avvikelserna gällde
     * stannar i användningsfallet — se `ValidationReport`.
     *
     * LÄGGNINGEN ÄR ÄNDÅ STÄNGD (uppgift 11d). Stängningen skriver CLOSED innan
     * den läser kuverten, och fasen går inte tillbaka. Före 11d stod fasen kvar
     * i OPEN efter en avvikelse, och beskedet "stängningen avbröts" kunde läsas
     * som att röstningen pågick. Nu säger det vad som gäller. Beskedet gäller
     * kuverten: det gamla flödets rutter prövar ingen fas, se `oldFlowRoutesRemain`
     * i src/app/architecture/code-facts.ts.
     */
    return jsonResponse(
      {
        status: 'validation_failed',
        message:
          'Läggningen tar inte längre emot kuvert, men skalningen avbröts. Valideringen hittade ' +
          'avvikelser, och kopplingen mellan väljare och röst är kvar så att de går att utreda.',
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
          'Läggningen tar inte längre emot kuvert, men skalningen avbröts. En valsedel verifierar ' +
          'inte längre, och kopplingen mellan väljare och röst är kvar så att den går att utreda.',
        ciphertextHash: outcome.ciphertextHash,
      },
      409,
    )
  }

  /**
   * RESTERNA SYNS I SVARET (uppgift 11d).
   *
   * Stängningen tar före infogningen bort chiffer i röstdatabasen som inte hör
   * till något av de validerade kuverten, till exempel från en stängning som
   * avbrutits sedan ett kuvert tagits bort. Administratören ska se att det
   * skett och vilka det gällde. Chifferhasharna står i svaret till den
   * inloggade administratören, men inte i loggen, som maskerar dem och bara
   * får antalet.
   */
  const residue =
    outcome.residueRemoved.length === 0
      ? ''
      : ` Före flytten togs ${outcome.residueRemoved.length} chiffer bort ur röstdatabasen som inte ` +
        'hörde till något av de validerade kuverten, till exempel efter en stängning som ' +
        'avbrutits.'

  return jsonResponse({
    status: 'closed',
    message:
      'Omröstningen är stängd. Kopplingen mellan väljare och röst är raderad.' +
      `${residue}${replacedNote(outcome.urnRowsReplaced)}`,
    moved: outcome.moved,
    cleared: outcome.cleared,
    envelopeRoot: outcome.envelopeRoot,
    residueRemoved: outcome.residueRemoved,
    urnRowsReplaced: outcome.urnRowsReplaced,
  })
}

/**
 * ERSÄTTNINGARNA SYNS I SVARET, MED CHIFFERHASH (fixrunda 1 av 11d, ruling 126).
 *
 * Stängningen tar bort en rad i röstdatabasen som tagit ett validerat kuverts
 * plats med ett annat innehåll, och infogar det validerade i stället. Ingen
 * legitim väg skriver en sådan rad, så det tyder på ett angrepp. Svaret säger
 * det och pekar ut kuverten, också när stängningen sedan avbröts, eftersom en
 * omkörning inte hittar raderna igen. Loggen får bara antalet, som för
 * resterna.
 */
function replacedNote(urnRowsReplaced: readonly string[]): string {
  if (urnRowsReplaced.length === 0) return ''
  return (
    ` LARM: ${urnRowsReplaced.length} rader i röstdatabasen hade ett validerat kuverts ` +
    'chifferhash eller id men ett annat innehåll. Stängningen tog bort dem för att infoga det ' +
    'validerade i stället. Ingen legitim väg skriver en sådan rad, så någon har skrivit i ' +
    'röstdatabasen förbi stängningen. Chifferhasharna står i urnRowsReplaced.'
  )
}
