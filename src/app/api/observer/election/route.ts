import { errorResponse, getClientIp, hasValidOrigin, jsonResponse } from '@/lib/http'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { parseJsonBody, statsRequestSchema } from '@/lib/validation'
import { getElection, getElectionResults, listElections } from '@/modules/anonymous-vote'
import { listCommitments, currentRoot } from '@/modules/anonymous-vote/commitment.service'
import { countIssuedCredentials } from '@/modules/eligibility/credential.service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/observer/election
 *
 * OBSERVATÖRSGRÄNSSNITTET. Öppet, utan inloggning.
 *
 * Kravet är att det inte ska räcka att lita på att administratören säger att
 * databasen är korrekt. En oberoende part måste kunna kontrollera kedjan
 * själv:
 *
 *   en legitim röstning genomfördes → exakt en anonym röst skapades →
 *   rösten finns kvar → rösten räknades korrekt
 *
 * Den här rutten ger de fyra sakerna som krävs för att göra det:
 *
 *   1. VALSEDLARNAS PUBLIKA NYCKLAR. Med dem kan observatören verifiera att
 *      varje röst bär ett äkta röstintyg — alltså att den skapats genom den
 *      auktoriserade processen och inte lagts till vid sidan om. Kontrollen
 *      kräver inte tillit till systemet: den är ren matematik.
 *
 *   2. ANTALET GODKÄNDA RÖSTNINGAR per valsedel. Stämmer det inte med antalet
 *      registrerade röster finns röster utan godkännande, eller godkännanden
 *      utan röster.
 *
 *   3. ÅTAGANDEKEDJAN. Varje åtagande är Merkleroten över röstunderlaget vid
 *      en tidpunkt. En observatör som sparat ett tidigare åtagande kan avgöra
 *      om något ändrats sedan dess — utan att fråga systemet.
 *
 *   4. DET SAMMANRÄKNADE RESULTATET, som kan jämföras mot en egen omräkning av
 *      rösterna från /api/observer/votes.
 *
 * VAD SOM INTE FINNS HÄR, OCH ALDRIG KOMMER ATT FINNAS
 *
 * Någon uppgift om vem som röstat. Observatören kan verifiera ATT antalet
 * godkända röstningar stämmer, men får aldrig veta vilka personer det rör sig
 * om — och kan därför inte para ihop en väljare med en röst. Underlaget för en
 * sådan koppling finns inte i någon databas, så begränsningen sitter i datan
 * och inte i det här gränssnittet.
 */
export async function POST(request: Request) {
  if (!hasValidOrigin(request)) {
    return errorResponse('FORBIDDEN_ORIGIN', 'Begäran avvisades.', 403)
  }

  const rate = checkRateLimit('observer', getClientIp(request), RATE_LIMITS.adminStats)
  if (!rate.allowed) {
    return errorResponse('RATE_LIMITED', 'För många förfrågningar.', 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const body = await parseJsonBody(request, statsRequestSchema)
  if (!body.ok) return errorResponse('INVALID_INPUT', body.message, 400)

  if (!body.data.electionId) {
    // Utan vald omröstning: bara listan, så att observatören kan hitta rätt.
    const elections = await listElections()

    return jsonResponse({
      elections: elections.map((election) => ({
        id: election.id,
        name: election.name,
        kind: election.kind,
        opensAt: election.opensAt.toISOString(),
        closesAt: election.closesAt.toISOString(),
      })),
    })
  }

  const election = await getElection(body.data.electionId)
  if (!election) return errorResponse('UNKNOWN_ELECTION', 'Omröstningen finns inte.', 404)

  const [results, commitments, root, approved] = await Promise.all([
    getElectionResults(election.id),
    listCommitments(election.id),
    currentRoot(election.id),
    /**
     * Antalet godkända röstningar per valsedel, hämtat ur röstlängden.
     *
     * Detta är enda anledningen till att rutten rör båda databaserna, och den
     * rör dem som RENA ANTAL. Att veta att sex röstningar godkändes på
     * kommunvalsedeln säger ingenting om vilka sex personer det var — och
     * kopplingen finns inte lagrad någonstans att hämta.
     *
     * Utan siffran kan observatören inte kontrollera kravet att antalet
     * godkända röstningar motsvarar antalet registrerade röster, vilket är en
     * av de viktigaste sakerna hen ska kunna kontrollera.
     */
    countIssuedCredentials(election.id),
  ])

  return jsonResponse({
    election: {
      id: election.id,
      name: election.name,
      kind: election.kind,
      opensAt: election.opensAt.toISOString(),
      closesAt: election.closesAt.toISOString(),
    },
    ballots: election.ballots.map((ballot) => ({
      id: ballot.id,
      kind: ballot.kind,
      label: ballot.label,
      allowsCandidateVote: ballot.allowsCandidateVote,
      // Med den här kan vem som helst verifiera samtliga röstintyg på
      // valsedeln, utan att fråga systemet om lov.
      signingPublicKeyPem: ballot.signingPublicKeyPem,
    })),
    results,
    approvedVotings: approved,
    commitments,
    /**
     * Roten just nu, framräknad ur de röster som finns i detta ögonblick.
     *
     * Stämmer den inte med det senaste åtagandet har underlaget ändrats sedan
     * åtagandet publicerades. Observatören behöver inte lita på oss för att se
     * det — samma rot går att räkna fram ur rösterna från /api/observer/votes.
     */
    currentRoot: root,
    howToVerify: {
      steg1:
        'Hämta samtliga röster från /api/observer/votes och verifiera varje ' +
        'credentialSignature mot valsedelns signingPublicKeyPem (RSA, full-domain ' +
        'hash via MGF1-SHA256 över credentialId).',
      steg2:
        'Kontrollera att varje credentialId förekommer exakt en gång. Ett återanvänt ' +
        'intyg vore en dubbelröst.',
      steg3:
        'Räkna om Merkleroten: hasha varje röst kanoniskt, sortera hashvärdena, ' +
        'bygg trädet. Jämför med currentRoot och med sparade åtaganden.',
      steg4:
        'Räkna rösterna per alternativ och jämför med results. Jämför antalet ' +
        'röster per valsedel med approvedVotings.',
    },
  })
}
