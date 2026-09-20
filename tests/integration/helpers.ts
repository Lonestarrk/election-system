import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/anonymous-vote/db'
import { hashPersonalNumber } from '@/modules/eligibility/identity'
import { issueCredential } from '@/modules/eligibility/credential.service'
import { castAnonymousVote } from '@/modules/anonymous-vote'
import { createElection } from '@/orchestration/create-election.usecase'
import {
  createBlindedCredential,
  unblindSignature,
} from '@/lib/blind-client'

/**
 * Hjälpfunktioner för integrationstesterna.
 *
 * OBSERVERA: `resetElectionData` tömmer röstlängd, sessioner, omröstningar,
 * röster och revisionslogg. Kör testerna mot utvecklingsdatabasen och du
 * förlorar demodatan — kör `npm run seed` efteråt. Partiregistret lämnas kvar
 * eftersom det är referensdata.
 */

export async function isDatabaseAvailable(): Promise<boolean> {
  if (!process.env.VOTERS_DATABASE_URL || !process.env.VOTES_DATABASE_URL) return false

  try {
    await votersDb.$queryRaw`SELECT 1`
    await votesDb.$queryRaw`SELECT 1`
    return true
  } catch {
    return false
  }
}

export async function resetElectionData(): Promise<void> {
  // Ordningen följer beroendena: rösterna först, sedan valsedlarna de pekar på.
  await votesDb.anonymousVote.deleteMany()
  await votesDb.election.deleteMany()

  await votersDb.adminSession.deleteMany()
  await votersDb.votingSession.deleteMany()
  await votersDb.voterBallotStatus.deleteMany()
  await votersDb.election.deleteMany()
  await votersDb.voterStatus.deleteMany()
  await votersDb.auditEvent.deleteMany()

  const partyCount = await votesDb.party.count()
  if (partyCount === 0) {
    await votesDb.party.createMany({
      data: [
        { name: 'Socialdemokraterna', abbreviation: 'S', color: '#E8112D', displayOrder: 1 },
        { name: 'Moderaterna', abbreviation: 'M', color: '#52BDEC', displayOrder: 2 },
        { name: 'Centerpartiet', abbreviation: 'C', color: '#009933', displayOrder: 3 },
      ],
    })
  }
}

export async function createVoter(
  personalNumber: string,
  options: { isEligible?: boolean; isAdmin?: boolean; municipalityCode?: string } = {},
): Promise<string> {
  const voter = await votersDb.voterStatus.create({
    data: {
      externalIdentityHash: hashPersonalNumber(personalNumber),
      isEligible: options.isEligible ?? true,
      isAdmin: options.isAdmin ?? false,
      municipalityCode: options.municipalityCode ?? null,
    },
    select: { id: true },
  })

  return voter.id
}

export async function firstPartyId(): Promise<string> {
  const party = await votesDb.party.findFirst({ orderBy: { displayOrder: 'asc' } })
  if (!party) throw new Error('Inga partier i databasen.')
  return party.id
}

export type TestElection = {
  electionId: string
  ballotId: string
  ballotPartyId: string
}

/**
 * Skapar en enkel omröstning med en riksdagsvalsedel.
 *
 * Går via orkestreringslagret, så att nyckelparet skapas och speglas precis som
 * i drift. Ett test som skrev raderna direkt skulle missa att röstintygen
 * kräver att båda databaserna känner till samma valsedel.
 */
export async function createTestElection(name = 'Testvalet'): Promise<TestElection> {
  const partyId = await firstPartyId()

  const outcome = await createElection({
    name,
    kind: 'RIKSDAGSVAL',
    opensAt: new Date(Date.now() - 60_000),
    closesAt: new Date(Date.now() + 3_600_000),
    ballots: [
      {
        kind: 'RIKSDAG',
        label: 'Riksdagsvalet',
        allowsCandidateVote: false,
        parties: [{ partyId }],
      },
    ],
  })

  if (outcome.status !== 'created') throw new Error('Kunde inte skapa testomröstningen.')

  const ballotId = outcome.election.ballotIds[0]!.id

  const ballotParty = await votesDb.ballotParty.findFirst({
    where: { ballotId },
    select: { id: true },
  })

  if (!ballotParty) throw new Error('Valsedeln saknar partier.')

  return { electionId: outcome.election.id, ballotId, ballotPartyId: ballotParty.id }
}

export type VoteAttempt =
  | { status: 'voted'; token: string }
  | { status: 'blocked'; reason: string }

/**
 * Genomför en fullständig röstning: blindning, utfärdande, avblindning, inlösen.
 *
 * Blindningen körs med klientmodulen — samma kod som webbläsaren använder —
 * så att testet går igenom hela kedjan och inte bara serverdelen av den.
 */
export async function voteOnce(
  voterStatusId: string,
  election: TestElection,
): Promise<VoteAttempt> {
  const keys = await votersDb.electionBallot.findUnique({
    where: { id: election.ballotId },
    select: { signingPublicKeyPem: true },
  })

  if (!keys) throw new Error('Valsedeln saknas i röstlängdens spegling.')

  const credential = await createBlindedCredential(keys.signingPublicKeyPem)

  const issued = await issueCredential(
    voterStatusId,
    election.electionId,
    election.ballotId,
    credential.blinded,
  )

  if (issued.status !== 'issued') return { status: 'blocked', reason: issued.status }

  const signature = await unblindSignature(
    issued.blindSignature,
    credential.blindingFactor,
    keys.signingPublicKeyPem,
  )

  const cast = await castAnonymousVote({
    ballotId: election.ballotId,
    ballotPartyId: election.ballotPartyId,
    credentialId: credential.credentialId,
    credentialSignature: signature,
  })

  if (cast.status !== 'recorded') return { status: 'blocked', reason: cast.status }

  return { status: 'voted', token: cast.token }
}

export async function disconnect(): Promise<void> {
  await votersDb.$disconnect()
  await votesDb.$disconnect()
}
