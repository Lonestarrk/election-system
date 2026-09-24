import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { ballotLookupSchema, parseJsonBody } from '@/lib/validation'
import { getBallotChoices, getEncryptedBallotShape } from '@/modules/ballot-box'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/vote/ballot
 *
 * Vad som står på en valsedel: partier med sina kandidater, eller frågans
 * svarsalternativ.
 *
 * VARFÖR POST FÖR EN LÄSNING
 *
 * Valsedels-id:t ligger i kroppen, inte i sökvägen. Ett dynamiskt segment
 * (/api/vote/ballot/[ballotId]) hade varit den naturliga formen, men API-trädet
 * har en blankettspärr mot dynamiska segment: ett segment som i dag bär ett
 * ofarligt valsedels-id är nästa år det självklara stället att lägga en token,
 * och då hamnar den i accessloggar, proxyloggar, webbläsarhistorik och
 * Referer-headern. Spärren kostar en aning elegans och tar bort en hel
 * felklass. /api/verify löser det på samma sätt och av samma skäl.
 *
 * Innehållet är i övrigt offentligt och kräver ingen legitimering. Vilka
 * partier som ställer upp och vilka kandidater som går att kryssa är själva
 * valsedeln — inte någons röst.
 *
 * Endpointen ersätter den tidigare /api/vote/parties, som byggde på antagandet
 * att det fanns en enda partilista för hela systemet. Med kommun-, landstings-
 * och riksdagsvalsedlar som kan ha olika partier — och lokala partier som bara
 * står i en kommun — håller inte det antagandet.
 *
 * VALETS PUBLIKA NYCKEL FÖLJER MED
 *
 * Röstsidan krypterar valet i webbläsaren och behöver därför omröstningens
 * publika krypteringsnyckel, och antalet alternativ servern kommer att pröva
 * bevisen mot. Båda är offentliga: nyckeln finns till för att vem som helst
 * ska kunna kryptera till den, och antalet följer av valsedeln. Sidan bygger
 * själv den kanoniska listan ur partiernas och kandidaternas ordning och
 * jämför längden med `optionCount` innan den krypterar, så att en lista som
 * glidit isär stoppas i webbläsaren i stället för som ett underkänt bevis.
 *
 * `encryption` är null för en valsedel som kuvertmodellen inte kan ta emot,
 * i dag en fråga i en allmän omröstning. Se `getEncryptedBallotShape`.
 */
export async function POST(request: Request) {
  // Origin-kontroll och hastighetsbegränsning även här, trots att rutten bara
  // läser offentlig information. Regeln gäller varje POST utan undantag — ett
  // undantag för "den här är ofarlig" är precis hur nästa rutt slinker igenom.
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('ballot-lookup', getClientIp(request), RATE_LIMITS.ballotLookup)
  if (!rate.allowed) {
    // Ingen revisionshändelse här. Revisionsloggen ligger i röstlängdsmodulen,
    // och en rutt som rör den anonyma sidan ska inte importera från
    // väljarsidan bara för att logga — då ser den plötsligt båda sidorna, och
    // ett arkitekturtest fångar det. /api/verify löser det på samma sätt.
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const body = await parseJsonBody(request, ballotLookupSchema)
  if (!body.ok) {
    return errorResponse('INVALID_INPUT', body.message, 400)
  }

  const [choices, shape] = await Promise.all([
    getBallotChoices(body.data.ballotId),
    getEncryptedBallotShape(body.data.ballotId),
  ])

  if (!choices) {
    return errorResponse('UNKNOWN_BALLOT', 'Valsedeln finns inte.', 404)
  }

  return jsonResponse({
    ballotId: body.data.ballotId,
    choices,
    encryption: shape ? { publicKey: shape.publicKey, optionCount: shape.optionCount } : null,
  })
}
