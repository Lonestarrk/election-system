import { inject } from 'vitest'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/ballot-box/db'
import { hashPersonalNumber } from '@/modules/eligibility/identity'
import { issueCredential } from '@/modules/eligibility/credential.service'
import { castVote } from '@/modules/ballot-box'
import { createElection } from '@/orchestration/create-election.usecase'
import {
  createBlindedCredential,
  unblindSignature,
} from '@/lib/blind-client'
import { TEST_DATABASE_SUFFIX, isTestDatabaseName } from '../test-databases'

/**
 * Hjälpfunktioner för integrationstesterna.
 *
 * OBSERVERA: `resetElectionData` tömmer röstlängd, sessioner, omröstningar,
 * röster och revisionslogg. Partiregistret lämnas kvar eftersom det är
 * referensdata. Funktionen vägrar köra om inte båda klienterna är anslutna till
 * testdatabaser — se `assertConnectedToTestDatabases` nedan.
 */

/**
 * Avgör om de databasberoende testerna ska köras, hoppas över eller fallera.
 *
 * Beskedet kommer från tests/global-setup.ts, som redan har försökt migrera
 * testdatabaserna. Bara två lägen får bli ett hoppat test, och i båda har
 * någon valt det: ingen databasadress är satt alls, eller SKIP_DB_TESTS=1 ber
 * uttryckligen om det. Allt annat kastar, så att det syns som ett rött test i
 * stället för ett grönt som aldrig kördes: en satt adress vars server inte
 * svarar, en testdatabas som saknas, en migrering som inte gick, eller klienter
 * som hamnade i fel databas.
 *
 * Tidigare räckte ett misslyckat `SELECT 1` för att allt skulle hoppas över,
 * och en körning utan testdatabas såg då likadan ut som en lyckad.
 */
export async function isDatabaseAvailable(): Promise<boolean> {
  const status = inject('testDatabases')

  if (status?.state === 'skip') return false
  if (status?.state === 'broken') throw new Error(status.reason)

  // 'ready' — eller inget besked alls, om global-setup inte har körts. I båda
  // fallen ska databasen finnas, och saknas den är det ett fel.
  try {
    await votersDb.$queryRaw`SELECT 1`
    await votesDb.$queryRaw`SELECT 1`
  } catch (error) {
    throw new Error(
      'Testdatabaserna ska finnas men går inte att nå. Kontrollera att databasservern kör ' +
        'och att voters_test och votes_test finns (tests/global-setup.ts skapar och migrerar ' +
        'dem före varje körning).',
      { cause: error },
    )
  }

  // Vakten redan här, och inte bara i resetElectionData: då fallerar hela
  // testfilen innan något test hunnit skriva — även ett test som raderar på
  // egen hand, som "rösterna överlever att hela röstlängden raderas".
  await assertConnectedToTestDatabases()

  return true
}

type DatabaseClients = {
  voters: Pick<typeof votersDb, '$queryRaw'>
  votes: Pick<typeof votesDb, '$queryRaw'>
}

async function connectedDatabaseName(
  client: DatabaseClients[keyof DatabaseClients],
): Promise<string> {
  // `::text` eftersom current_database() är av typen `name`, som Prisma inte
  // lovar att kunna läsa ur en rå fråga.
  const rows = await client.$queryRaw<Array<{ name: string }>>`SELECT current_database()::text AS name`
  const name = rows[0]?.name
  if (!name) throw new Error('Databasservern svarade inte på vilken databas anslutningen gäller.')
  return name
}

/**
 * Vägrar fortsätta om inte BÅDA klienterna är anslutna till testdatabaser.
 *
 * Kontrollen frågar servern vilken databas anslutningen faktiskt hamnade i
 * (`current_database()`) i stället för att läsa miljövariabeln. En adress kan
 * innehålla "_test" i lösenordet, värdnamnet eller frågesträngen och ändå leda
 * till utvecklingsdatabasen; det enda som avgör vad en radering träffar är
 * vilken databas servern kopplade upp oss mot.
 *
 * Båda måste klara kontrollen, inte bara den ena. Tömningen rör båda
 * databaserna, och en halvt omdirigerad körning skulle radera röstlängden men
 * lämna rösterna — eller tvärtom — i någons riktiga data.
 *
 * Klienterna går att skicka in, så att vakten kan provas mot en anslutning som
 * inte är en testdatabas utan att något raderas.
 */
export async function assertConnectedToTestDatabases(
  clients: DatabaseClients = { voters: votersDb, votes: votesDb },
): Promise<void> {
  const connections = [
    {
      label: 'röstlängden',
      variable: 'VOTERS_DATABASE_URL',
      name: await connectedDatabaseName(clients.voters),
    },
    {
      label: 'röstdatabasen',
      variable: 'VOTES_DATABASE_URL',
      name: await connectedDatabaseName(clients.votes),
    },
  ]

  const wrong = connections.filter((connection) => !isTestDatabaseName(connection.name))
  if (wrong.length === 0) return

  const described = connections
    .map((connection) => `${connection.label} → "${connection.name}"`)
    .join(', ')

  throw new Error(
    `Testerna vägrar röra databaserna: klienterna är anslutna till ${described}. ` +
      `Bara databaser vars namn slutar på "${TEST_DATABASE_SUFFIX}" får tömmas av testerna, ` +
      `eftersom allt annat antas vara riktig data — till exempel den som utvecklingsservern ` +
      `visar. Ingenting har raderats.\n` +
      `Åtgärd: kör testerna via vitest, så att tests/setup.ts hinner peka om ` +
      `${wrong.map((connection) => connection.variable).join(' och ')} till testdatabaserna ` +
      `(voters_test och votes_test på samma server) innan någon klient skapas, eller sätt ` +
      `TEST_VOTERS_DATABASE_URL och TEST_VOTES_DATABASE_URL till databaser vars namn slutar ` +
      `på "${TEST_DATABASE_SUFFIX}".`,
  )
}

export async function resetElectionData(): Promise<void> {
  // Vakten FÖRST, före den första raderingen. En kontroll efteråt, eller mellan
  // två tömningar, skulle bara kunna berätta vad som redan gått förlorat.
  await assertConnectedToTestDatabases()

  // Ordningen följer beroendena: rösterna först, sedan valsedlarna de pekar på.
  await votesDb.vote.deleteMany()
  await votesDb.election.deleteMany()

  await votersDb.adminSession.deleteMany()
  await votersDb.votingSession.deleteMany()
  await votersDb.voterBallotStatus.deleteMany()
  // Markeringen "har röstat" har RESTRICT mot väljaren, som kuverten nedan.
  await votersDb.votedMarker.deleteMany()
  /**
   * MÅSTE TÖMMAS FÖRE voterStatus.
   *
   * PendingVote.voterStatusId är RESTRICT, inte CASCADE (spec 7.4: en struken
   * väljares röst ska räknas, en radering får aldrig tyst ta rösten med sig).
   * Ligger en liggande röst kvar när voterStatus.deleteMany() körs avvisar
   * databasen raderingen med ett främmande nyckel-fel i stället för att bara
   * städa upp — så den här raden måste köras innan, inte efteråt.
   */
  await votersDb.pendingVote.deleteMany()
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
      externalIdentityHash: await hashPersonalNumber(personalNumber),
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
    trusteePassphrases: ['test-fras-ett', 'test-fras-tva', 'test-fras-tre'],
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

  const cast = await castVote({
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
