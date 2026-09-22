import { canonicalVoteRecord } from '@/lib/merkle'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { observerVotesSchema, parseJsonBody } from '@/lib/validation'
import { votesDb } from '@/modules/ballot-box/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/observer/votes
 *
 * HELA RÖSTUNDERLAGET, ÖPPET FÖR VEM SOM HELST.
 *
 * Det här är valurnan, utlagd på bordet. Varje registrerad röst med sitt
 * röstintyg, sin signatur och sitt val — allt som behövs för att en oberoende
 * part ska kunna räkna om valet från grunden och verifiera varje röst utan att
 * fråga systemet om lov.
 *
 * VARFÖR DET INTE HOTAR VALHEMLIGHETEN
 *
 * Ingenting här kan kopplas till en person.
 *
 *   – credentialId valdes av väljaren själv och blindades innan myndigheten
 *     signerade. Myndigheten har aldrig sett värdet och kan inte känna igen
 *     det. Kopplingen finns inte lagrad någonstans — den existerar inte.
 *   – tokenHash är en hash av väljarens kvitto. Bara den som har kvittot kan
 *     matcha det, och kvittot finns bara hos väljaren.
 *   – Ingen tidsstämpel ingår. Rösterna går därför inte att ordna i tid och
 *     kan inte korreleras mot legitimeringstidpunkter.
 *
 * Att publicera underlaget är alltså inte en eftergift åt granskningen på
 * valhemlighetens bekostnad. Det är möjligt just därför att systemet är byggt
 * så att underlaget inte bär någon identitet.
 *
 * ORDNINGEN ÄR SORTERAD PÅ INNEHÅLL, INTE PÅ TID
 *
 * Svaret sorteras på credentialId. Det är avsiktligt och viktigt: sorterades
 * det på skapandeordning eller id skulle listan avslöja i vilken följd
 * rösterna lades, vilket tillsammans med röstlängden vore en väg tillbaka till
 * väljaren. Samma skäl som Merkleträdet sorteras på innehåll.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('observer-votes', getClientIp(request), RATE_LIMITS.adminStats)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const body = await parseJsonBody(request, observerVotesSchema)
  if (!body.ok) return errorResponse('INVALID_INPUT', body.message, 400)

  const election = await votesDb.election.findUnique({
    where: { id: body.data.electionId },
    select: { id: true },
  })

  if (!election) return errorResponse('UNKNOWN_ELECTION', 'Omröstningen finns inte.', 404)

  const pageSize = body.data.pageSize ?? 500
  const offset = body.data.offset ?? 0

  const [total, votes] = await Promise.all([
    votesDb.vote.count({ where: { ballot: { electionId: election.id } } }),
    votesDb.vote.findMany({
      where: { ballot: { electionId: election.id } },
      // Sortering på innehåll, inte på tid eller insättningsordning.
      orderBy: { credentialId: 'asc' },
      skip: offset,
      take: pageSize,
      select: {
        tokenHash: true,
        credentialId: true,
        credentialSignature: true,
        ballotId: true,
        ballotPartyId: true,
        candidateId: true,
        optionId: true,
      },
    }),
  ])

  return jsonResponse({
    electionId: election.id,
    total,
    offset,
    pageSize,
    votes: votes.map((vote) => ({
      ...vote,
      /**
       * Den kanoniska strängen som hashas till ett Merkleblad.
       *
       * Följer med så att en observatör inte behöver gissa sig till formatet.
       * Att räkna om roten ska inte kräva att man läser vår källkod — men den
       * som vill kontrollera att vi inte fuskar med formatet kan bygga strängen
       * själv ur fälten ovan och jämföra.
       */
      canonical: canonicalVoteRecord(vote),
    })),
  })
}
