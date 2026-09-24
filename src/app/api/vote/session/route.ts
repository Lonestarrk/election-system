import { cookies } from 'next/headers'
import { clearVotingCookies, SESSION_COOKIE } from '@/lib/cookies'
import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { ballotsForVoter, getMirroredElection } from '@/modules/eligibility/election.service'
import { envelopeOverview } from '@/modules/eligibility/pending-vote.service'
import { getValidVotingSession } from '@/modules/eligibility/voting-session.service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/vote/session
 *
 * Vilka valsedlar som gäller den inloggade väljaren, och vilka hen redan
 * röstat på.
 *
 * VARFÖR DEN HÄR RUTTEN BEHÖVDES
 *
 * Röstningssidan hämtade tidigare valsedlarna från den publika
 * omröstningslistan. Den innehåller ALLA valsedlar i omröstningen, inte de som
 * gäller en viss person — så en väljare folkbokförd i Falun fick se Stockholms
 * kommunvalsedel.
 *
 * Servern avvisade henne om hon försökte rösta på den, så det var aldrig en
 * säkerhetslucka. Men det var ett gränssnitt som erbjöd något det inte kunde
 * leverera, och det är illa nog i ett valsystem: en väljare som får ett
 * felmeddelande mitt i röstningen har svårt att veta om felet ligger hos
 * henne eller hos systemet.
 *
 * Ett E2E-test hittade det. Ingen av de statiska kontrollerna kunde se det —
 * filtreringen fanns på serversidan hela tiden, den användes bara inte av
 * vyn.
 *
 * KRÄVER SESSION, OCH SVARAR BARA OM DEN EGNA VÄLJAREN
 *
 * Till skillnad från /api/elections, som är öppen eftersom omröstningarnas
 * innehåll är offentligt, är svaret här personligt: det avslöjar var väljaren
 * är folkbokförd genom vilka valsedlar som listas. Därför krävs en giltig
 * session, och rutten kan bara svara om den som äger sessionen — det finns
 * ingen parameter för att fråga om någon annan.
 *
 * FASEN OCH KUVERTEN, MEN INGEN CHIFFERHASH
 *
 * Röstsidan behöver två saker till i kuvertmodellen. Valets fas, för att
 * radera det enheten sparat när fasen lämnat OPEN (spec 3.1 punkt 4). Och per
 * valsedel om väljaren har ett liggande kuvert, för beskedet "Du har en röst
 * registrerad" på en enhet som inte själv lade rösten. Det senare kommer ur
 * pending_vote, inte ur det gamla flödets markering, som bara säger att en
 * röst lades i det gamla flödet och därför heter `votedInOldFlow` här.
 *
 * Hashen för det liggande kuvertet lämnas inte ut, varken här eller av någon
 * annan rutt röstsidan anropar. Enheten som vill veta om dess röst är den som
 * ligger frågar /api/vote/compare, som bara svarar lika, olika eller ingen
 * röst. (Livevyn i demoläget visar databasen som en insider ser den, med
 * början av hashen, och säger det.)
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('vote-session', getClientIp(request), RATE_LIMITS.authCollect)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const cookieStore = await cookies()
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value

  if (!sessionId) {
    return errorResponse('NO_SESSION', 'Din röstsession har upphört. Legitimera dig igen.', 401)
  }

  const session = await getValidVotingSession(sessionId)
  if (!session) {
    const response = errorResponse(
      'SESSION_EXPIRED',
      'Din röstsession har upphört. Legitimera dig igen.',
      401,
    )
    clearVotingCookies(response)
    return response
  }

  const [election, ballots, envelopes] = await Promise.all([
    getMirroredElection(session.electionId),
    ballotsForVoter(session.voterStatusId, session.electionId),
    envelopeOverview(session.voterStatusId, session.electionId),
  ])

  const withEnvelope = new Set(envelopes?.ballotIdsWithEnvelope ?? [])

  return jsonResponse({
    electionId: session.electionId,
    electionName: election?.name ?? null,
    // Saknas omröstningen i röstlängden tas ingen röst emot, och sidan ska
    // behandla den som stängd.
    phase: envelopes?.phase ?? null,
    closesAt: envelopes?.closesAt.toISOString() ?? null,
    acceptsVotes: envelopes?.acceptsVotes ?? false,
    /**
     * Bara valsedlar som gäller väljaren, med status per valsedel.
     *
     * Innehåller ingenting om VAD som står på dem — det hämtas separat från
     * /api/vote/ballot, som är öppen eftersom valsedelns innehåll är
     * offentligt. Och ingenting om vilket kuvert som ligger, bara att ett
     * gör det.
     */
    ballots: ballots.map((ballot) => ({
      id: ballot.id,
      kind: ballot.kind,
      label: ballot.label,
      hasPendingVote: withEnvelope.has(ballot.id),
      votedInOldFlow: ballot.hasVoted,
    })),
  })
}
