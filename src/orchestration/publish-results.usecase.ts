import { canonicalOptions } from '@/lib/crypto/ballot-encoding'
import { G, P, Q, parseElement } from '@/lib/crypto/group'
// Ur serverns ingång, som räkningen: kombinationen och undergruppskontrollen
// räknas i OpenSSL. Se src/lib/crypto/server.ts.
import { combine, isInSubgroup } from '@/lib/crypto/server'
import { serialisePartialDecryptionProof, TRUSTEE_COUNT, TRUSTEE_THRESHOLD } from '@/lib/crypto/threshold'
import { logger } from '@/lib/logger'
import { getBallotChoices, getEncryptedBallotShape } from '@/modules/ballot-box'
import { votesDb } from '@/modules/ballot-box/db'
import { votersDb } from '@/modules/eligibility/db'
import { turnoutByBallot } from '@/modules/eligibility/participation.service'
import { recountForPublication, TallyAbortedError, type RecountedBallot } from './tally.usecase'

/**
 * PUBLICERINGEN AV RESULTATET, MED BEVIS (uppgift 13, spec 3.1 och 7.2).
 *
 * Efter räkningen publiceras per valsedel:
 *   – den krypterade summan per alternativ, (c1, c2)
 *   – varje förtroendepersons partiella dekryptering med sitt bevis
 *   – resultatet per alternativ
 *   – antalet rader i urnan och antalet markeringar "har röstat"
 * och per omröstning kuvertroten, urnroten, summan av markeringarna, valets
 * publika nyckel och förtroendepersonernas publika andelar. Allt som behövs
 * för att räkna utmaningen i spec 4.5 står med: valets och valsedelns id,
 * alternativens och förtroendepersonernas index och talen.
 *
 * INGENTING PER RÖST, UTOM PÅ EN VALSEDEL MED EN ENDA RAD. Enskilda chiffer,
 * deras hashar och deras bevis publiceras inte, och inte heller något om en
 * väljare. Allt publicerat per röst är ett handtag som en köpare kan matcha mot
 * (spec 3.1). Har en valsedel bara en rad i urnan är summan den radens chiffer,
 * och då går dess chifferhash att räkna ur det publicerade (ruling 138, posten
 * `single-row-ballot-publishes-the-vote`). Talet avslöjar redan rösten, så
 * chiffret lägger bara till att den som sett just det chiffret kan se att det
 * räknades. Inget skydd byggs.
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
  markedAsVotedTotal: number
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
  'Att antalet rader i urnan och markeringarna är riktiga. De går att jämföra med varandra och med ' +
    'räkneverken, inte med något utanför systemet. Antalet kuvert som skalades publiceras inte för sig.',
  'Vilka valsedlar omröstningen har. En valsedel som saknas i publiceringen syns inte här.',
]

/**
 * ANDELARNA SKA HÖRA TILL VALETS NYCKEL (fixrunda 1, Mindre 2).
 *
 * Omräkningen prövar bara andelarna för de förtroendepersoner som bidrog, och
 * aldrig nyckeln. Publiceringen gick därför ut med status 200 trots en ändrad
 * andel för en som inte bidrog, eller en ändrad nyckel, och först verktyget
 * underkände den. Här prövas samma sak som verktyget prövar: alla tre andelar
 * ligger i undergruppen, och varje par kombineras med Lagrange till nyckeln.
 */
function sharesBelongToKey(
  key: string,
  shares: ReadonlyArray<{ trusteeIndex: number; publicShare: string }>,
): boolean {
  const publicKey = parseElement(key)
  if (publicKey === null || !isInSubgroup(publicKey)) return false
  if (shares.length !== TRUSTEE_COUNT) return false

  const parsed = shares.map((share) => ({ index: share.trusteeIndex, value: parseElement(share.publicShare) }))
  if (parsed.some((share) => share.value === null || !isInSubgroup(share.value))) return false

  // `combine` ger c2 delat med Lagrange-kombinationen av värdena. Med c2 = 1 och
  // andelarna som värden är det inversen av kombinationen, som ska vara nyckeln.
  // Beviset läses inte av kombinationen.
  const unusedProof = { a: 1n, b: 1n, challenge: 0n, response: 0n }
  for (const [position, first] of parsed.entries()) {
    for (const second of parsed.slice(position + 1)) {
      const inverse = combine({ c1: 1n, c2: 1n }, [
        { trusteeIndex: first.index, value: first.value!, proof: unusedProof },
        { trusteeIndex: second.index, value: second.value!, proof: unusedProof },
      ])
      if ((inverse * publicKey) % P !== 1n) return false
    }
  }
  return true
}

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
  if (!sharesBelongToKey(votes.encryptionPublicKey, votes.trusteeShares)) {
    return mismatch('förtroendepersonernas publika andelar hör inte till valets publika nyckel')
  }

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
      // Summan av markeringarna. Skalningen skriver en per flyttat kuvert, men
      // antalet kuvert lagras inte för sig, så fältet heter efter vad det är
      // (fixrunda 1, Mindre 3).
      markedAsVotedTotal: turnout.ballots.reduce((total, ballot) => total + ballot.voted, 0),
      ballots,
      notCheckable: [...NOT_CHECKABLE],
      howToVerify: HOW_TO_VERIFY,
    },
  }
}

// ---------------------------------------------------------------------------
// Adminsidans resultat (12c, omräknat sedan fixrunda 1 av uppgift 13)
// ---------------------------------------------------------------------------

export type BallotResult = {
  ballotId: string
  label: string
  kind: string
  /** Alternativen i valsedelns kanoniska ordning, blankt först. */
  options: Array<{ label: string; count: number }>
  total: number
}

export type ElectionResultOutcome =
  | { status: 'ok'; phase: string; ballots: BallotResult[] }
  | { status: 'not_tallied'; phase: string }
  | { status: 'result_mismatch'; phase: string }
  | { status: 'unknown_election' }

/**
 * Resultatet per valsedel för adminsidan, efter TALLIED och CERTIFIED.
 *
 * SAMMA TAL SOM PUBLICERINGEN (fixrunda 1, Mindre 6). Förut läste rutten de
 * sparade räkneverken direkt, så ett räkneverk som ändrats efter räkningen
 * visades för administratören som valsedelns resultat. Nu är det publiceringens
 * omräkning, och stämmer den inte svarar funktionen `result_mismatch` utan tal.
 */
export async function getElectionTallyResults(electionId: string): Promise<ElectionResultOutcome> {
  const outcome = await publishedResults(electionId)
  if (outcome.status === 'unknown_election') return outcome
  if (outcome.status === 'not_published') return { status: 'not_tallied', phase: outcome.phase }
  if (outcome.status === 'result_mismatch') return outcome

  return {
    status: 'ok',
    phase: outcome.publication.election.phase,
    ballots: outcome.publication.ballots.map((ballot) => ({
      ballotId: ballot.ballotId,
      label: ballot.label,
      kind: ballot.kind,
      options: ballot.options.map((option) => ({ label: option.label, count: option.count })),
      total: ballot.options.reduce((sum, option) => sum + option.count, 0),
    })),
  }
}

/**
 * Alternativens namn i den kanoniska ordning räkningen använder (blankt,
 * partierna, sedan kandidaterna), som `getEncryptedBallotShape` bygger den.
 */
export async function optionLabelsOf(ballotId: string): Promise<string[]> {
  const choices = await getBallotChoices(ballotId)
  if (!choices || choices.kind !== 'PARTY') return []

  const parties = choices.parties.map((party) => ({
    id: party.ballotPartyId,
    displayOrder: party.displayOrder,
    candidates: party.candidates.map((candidate) => ({ id: candidate.id, displayOrder: candidate.displayOrder })),
  }))
  const partyById = new Map(choices.parties.map((party) => [party.ballotPartyId, party]))
  const candidateById = new Map(
    choices.parties.flatMap((party) => party.candidates.map((candidate) => [candidate.id, candidate.name] as const)),
  )

  return canonicalOptions({ allowsCandidateVote: choices.allowsCandidateVote, parties }).map((option) => {
    if (option.kind === 'BLANK') return 'Blankt'
    const party = partyById.get(option.ballotPartyId)
    if (option.kind === 'PARTY') return party?.name ?? 'Okänt parti'
    return `${candidateById.get(option.candidateId) ?? 'Okänd kandidat'} (${party?.abbreviation ?? '?'})`
  })
}
