import { G, P, Q } from '@/lib/crypto/group'
import { serialisePartialDecryptionProof, TRUSTEE_COUNT, TRUSTEE_THRESHOLD } from '@/lib/crypto/threshold'
import { logger } from '@/lib/logger'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { votesDb } from '@/modules/ballot-box/db'
import { votersDb } from '@/modules/eligibility/db'
import { turnoutByBallot } from '@/modules/eligibility/participation.service'
import { optionLabelsOf } from './election-overview.usecase'
import { recountForPublication, TallyAbortedError, type RecountedBallot } from './tally.usecase'

/**
 * PUBLICERINGEN AV RESULTATET, MED BEVIS (uppgift 13, spec 3.1 och 7.2).
 *
 * Efter räkningen publiceras per valsedel:
 *   – den krypterade summan per alternativ, (c1, c2)
 *   – varje förtroendepersons partiella dekryptering med sitt bevis
 *   – resultatet per alternativ
 *   – antalet rader i urnan och antalet markeringar "har röstat"
 * och per omröstning kuvertroten, urnroten, antalet kuvert som skalades, valets
 * publika nyckel och förtroendepersonernas publika andelar. Allt som behövs
 * för att räkna utmaningen i spec 4.5 står med: valets och valsedelns id,
 * alternativens och förtroendepersonernas index och talen.
 *
 * INGENTING PER RÖST. Enskilda chiffer, deras hashar och deras bevis
 * publiceras inte, och inte heller något om en väljare. Allt publicerat per röst
 * är ett handtag som en köpare kan matcha mot (spec 3.1). Har en valsedel bara
 * en röst är summan den rösten, och det går inte att undvika.
 *
 * FÖRST I TALLIED ELLER CERTIFIED. Före det publiceras ingenting, inte heller
 * för en valsedel som redan är räknad: fasen säger att varje valsedel är det.
 *
 * TALEN RÄKNAS OM FÖRE PUBLICERINGEN (från uppgift 12b). Varje valsedel räknas
 * om ur urnan och de sparade, prövade bidragen, och de sparade räkneverken ska
 * vara exakt de omräknade. Stämmer de inte för en enda valsedel publiceras
 * ingenting, svaret säger att resultatet inte stämmer, och varken det sparade
 * eller det omräknade talet lämnas ut. Se `recountForPublication`.
 *
 * VAD PUBLICERINGEN INTE VISAR. Att summan består av exakt de giltiga
 * rösterna: det vilar på valideringen medan kopplingen fanns och på
 * slutkontrollen. Och rötterna kan ingen utanför räkna om, eftersom de enskilda
 * chiffren inte publiceras. De är åtaganden, och skyddar bara om någon sparade
 * dem vid stängningen. Det står också i `notCheckable`, så att publiceringen
 * säger det själv.
 *
 * Filen läser båda databaserna, som räkningen, och står på modulgränstestets
 * undantagslista av samma skäl: ur röstlängden fasen, rötterna och ANTALET
 * markeringar per valsedel, ur röstdatabasen urnan, andelarna och bidragen.
 * Den läser ingen väljare och kan inte para ihop sidorna.
 */

export const PUBLICATION_FORMAT = 'valsystem/publicering/v1'

export type PublishedBallot = {
  ballotId: string
  label: string
  kind: string
  rows: number
  markedAsVoted: number
  options: Array<{ optionIndex: number; label: string; c1: string; c2: string; count: number }>
  contributions: Array<{
    trusteeIndex: number
    partials: Array<{ optionIndex: number; value: string; proof: ReturnType<typeof serialisePartialDecryptionProof> }>
  }>
}

export type Publication = {
  status: 'published'
  format: typeof PUBLICATION_FORMAT
  election: { id: string; name: string; phase: string }
  group: { p: string; q: string; g: string }
  trustees: {
    count: number
    threshold: number
    publicShares: Array<{ trusteeIndex: number; publicShare: string }>
  }
  encryptionPublicKey: string
  envelopeRoot: string
  urnRoot: string
  envelopeCount: number
  ballots: PublishedBallot[]
  notCheckable: string[]
  howToVerify: string
}

export type PublicationOutcome =
  | { status: 'published'; publication: Publication }
  | { status: 'not_published'; phase: string }
  | { status: 'result_mismatch'; phase: string }
  | { status: 'unknown_election' }

/** Det som publiceringen själv säger att ingen utanför kan kontrollera. */
export const NOT_CHECKABLE: readonly string[] = [
  'Att summan består av exakt de giltiga rösterna. De enskilda chiffren publiceras inte, så summan ' +
    'kan inte räknas om. Det vilar på valideringen medan kopplingen mellan väljare och röst fanns, ' +
    'och på slutkontrollen.',
  'Kuvertroten och urnroten kan inte räknas om utan de enskilda kuverten och chiffren. De är ' +
    'åtaganden: den som sparade dem vid stängningen kan jämföra med dem här.',
  'Att antalet rader i urnan, markeringarna och antalet kuvert är riktiga. De går att jämföra med ' +
    'varandra och med räkneverken, inte med något utanför systemet.',
]

const HOW_TO_VERIFY =
  'Spara svaret som en fil, eller ange adressen direkt, och kör node tools/verify-election.mjs ' +
  '<fil eller adress> ur projektets källkod. Verktyget importerar ingenting ur appen.'

export async function publishedResults(electionId: string): Promise<PublicationOutcome> {
  const election = await votersDb.election.findUnique({
    where: { id: electionId },
    select: {
      name: true,
      phase: true,
      envelopeRoot: true,
      urnRoot: true,
      ballots: { select: { id: true, label: true, kind: true }, orderBy: { displayOrder: 'asc' } },
    },
  })
  if (!election) return { status: 'unknown_election' }

  const { phase } = election
  if (phase !== 'TALLIED' && phase !== 'CERTIFIED') return { status: 'not_published', phase }

  const mismatch = (reason: string): PublicationOutcome => {
    logger.warn('Resultatet publicerades inte: omräkningen stämmer inte', { reason })
    return { status: 'result_mismatch', phase }
  }

  if (election.envelopeRoot === null || election.urnRoot === null) {
    return mismatch('kuvertroten eller urnroten saknas')
  }

  const votes = await votesDb.election.findUnique({
    where: { id: electionId },
    select: {
      encryptionPublicKey: true,
      trusteeShares: { select: { trusteeIndex: true, publicShare: true }, orderBy: { trusteeIndex: 'asc' } },
    },
  })
  if (!votes?.encryptionPublicKey) return mismatch('valets publika nyckel saknas i röstdatabasen')

  const turnout = await turnoutByBallot(electionId)
  if (!turnout) return { status: 'unknown_election' }
  const markers = new Map(turnout.ballots.map((ballot) => [ballot.ballotId, ballot.voted]))

  const ballots: PublishedBallot[] = []
  for (const ballot of election.ballots) {
    // En valsedel utan form räknas inte i kuvertmodellen, se `getEncryptedBallotShape`.
    if (!(await getEncryptedBallotShape(ballot.id))) continue

    let recounted: RecountedBallot
    try {
      const outcome = await recountForPublication(ballot.id)
      if (outcome.status === 'wrong_phase') return { status: 'not_published', phase: outcome.phase ?? phase }
      if (outcome.status !== 'recounted') return mismatch('en valsedel finns inte i röstdatabasen')
      recounted = outcome.ballot
    } catch (error) {
      if (error instanceof TallyAbortedError) return mismatch(error.message)
      throw error
    }

    const labels = await optionLabelsOf(ballot.id)
    ballots.push({
      ballotId: ballot.id,
      label: ballot.label,
      kind: ballot.kind,
      rows: recounted.rows,
      markedAsVoted: markers.get(ballot.id) ?? 0,
      options: recounted.sums.map((sum, optionIndex) => ({
        optionIndex,
        label: labels[optionIndex] ?? `Alternativ ${optionIndex + 1}`,
        c1: sum.c1.toString(),
        c2: sum.c2.toString(),
        count: recounted.counts[optionIndex]!,
      })),
      contributions: recounted.contributions.map((contribution) => ({
        trusteeIndex: contribution.trusteeIndex,
        partials: contribution.partials.map((partial, optionIndex) => ({
          optionIndex,
          value: partial.value.toString(),
          proof: serialisePartialDecryptionProof(partial.proof),
        })),
      })),
    })
  }

  return {
    status: 'published',
    publication: {
      status: 'published',
      format: PUBLICATION_FORMAT,
      election: { id: electionId, name: election.name, phase },
      group: { p: P.toString(), q: Q.toString(), g: G.toString() },
      trustees: {
        count: TRUSTEE_COUNT,
        threshold: TRUSTEE_THRESHOLD,
        publicShares: votes.trusteeShares.map((share) => ({
          trusteeIndex: share.trusteeIndex,
          publicShare: share.publicShare,
        })),
      },
      encryptionPublicKey: votes.encryptionPublicKey,
      envelopeRoot: election.envelopeRoot,
      urnRoot: election.urnRoot,
      // En markering per skalat kuvert: skalningen kräver att antalen är lika före COMMIT.
      envelopeCount: turnout.ballots.reduce((total, ballot) => total + ballot.voted, 0),
      ballots,
      notCheckable: [...NOT_CHECKABLE],
      howToVerify: HOW_TO_VERIFY,
    },
  }
}
