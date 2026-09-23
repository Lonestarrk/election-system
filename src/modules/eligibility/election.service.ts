import { votersDb } from './db'

/**
 * Omröstningar sett från röstlängden.
 *
 * Det här är SPEGLINGEN: samma omröstnings-id och samma valsedels-id som i
 * röstdatabasen, men bara det som röstlängden behöver för att svara på sina
 * två frågor — vilka valsedlar gäller den här personen, och vilka har hen
 * redan röstat på.
 *
 * Vad speglingen medvetet INTE innehåller: partier, kandidater,
 * svarsalternativ. Röstlängden ska inte kunna formulera frågan "vad fanns att
 * välja mellan?", eftersom nästa steg därifrån vore att lagra svaret. Ett
 * säkerhetstest misslyckas om en sådan modell dyker upp i det här schemat.
 */

export type MirroredBallot = {
  id: string
  kind: string
  label: string
  areaCode: string | null
  displayOrder: number
}

export type MirroredElection = {
  id: string
  name: string
  kind: string
  opensAt: Date
  closesAt: Date
  ballots: MirroredBallot[]
}

const electionSelect = {
  id: true,
  name: true,
  kind: true,
  opensAt: true,
  closesAt: true,
  ballots: {
    select: { id: true, kind: true, label: true, areaCode: true, displayOrder: true },
    orderBy: { displayOrder: 'asc' },
  },
} as const

export async function getMirroredElection(electionId: string): Promise<MirroredElection | null> {
  return votersDb.election.findUnique({ where: { id: electionId }, select: electionSelect })
}

export async function listOpenMirroredElections(): Promise<MirroredElection[]> {
  const now = new Date()
  return votersDb.election.findMany({
    where: { opensAt: { lte: now }, closesAt: { gt: now } },
    select: electionSelect,
    orderBy: { opensAt: 'desc' },
  })
}

export type MirrorElectionInput = {
  id: string
  name: string
  kind: string
  opensAt: Date
  closesAt: Date
  ballots: Array<{
    id: string
    kind: string
    label: string
    areaCode: string | null
    /** Valsedelns signeringsnyckel. Den privata halvan lämnar aldrig den här databasen. */
    signingPrivateKeyPem: string
    signingPublicKeyPem: string
  }>
}

/**
 * Skriver speglingen.
 *
 * Id:na kommer utifrån och skapas ALDRIG här. De är samma UUID som
 * röstdatabasen redan tilldelat. Ett eget id på den här sidan skulle göra
 * speglingen oanvändbar: "har röstat på valsedel X" skulle peka på en valsedel
 * som inte finns i röstdatabasen.
 */
export async function mirrorElection(input: MirrorElectionInput): Promise<void> {
  await votersDb.$transaction(async (tx) => {
    await tx.election.create({
      data: {
        id: input.id,
        name: input.name,
        kind: input.kind,
        opensAt: input.opensAt,
        closesAt: input.closesAt,
      },
    })

    for (const [index, ballot] of input.ballots.entries()) {
      await tx.electionBallot.create({
        data: {
          id: ballot.id,
          electionId: input.id,
          kind: ballot.kind,
          label: ballot.label,
          areaCode: ballot.areaCode,
          signingPrivateKeyPem: ballot.signingPrivateKeyPem,
          signingPublicKeyPem: ballot.signingPublicKeyPem,
          displayOrder: index + 1,
        },
      })
    }
  })
}

/** Omröstningens skalningstillstånd, som det står i röstlängden. */
export type CloseState = { phase: string; envelopeRoot: string | null }

/**
 * Läser fasen och kuvertroten.
 *
 * Finns som en egen, namngiven fråga i stället för en inline-läsning hos
 * anroparen, eftersom den är ETT PÅSTÅENDE OM UTFALLET av den oåterkalleliga
 * skalningen: `closeElection` använder den för att kontrollera att dess egen
 * transaktion verkligen commitade innan den säger att kopplingen är raderad
 * (se steg 7 där). Att läsningen har ett namn gör också att dess EGET
 * misslyckande går att prova — och de två fallen "transaktionen rullade
 * tillbaka" och "jag kunde inte kontrollera utfallet" kräver helt olika besked
 * till administratören.
 *
 * Ingår inte i `MirroredElection`: fas och rot är skalningens arbetsmaterial,
 * inte den publika metadata speglingen finns för.
 */
export async function closeStateOf(electionId: string): Promise<CloseState | null> {
  return votersDb.election.findUnique({
    where: { id: electionId },
    select: { phase: true, envelopeRoot: true },
  })
}

/** Tar bort speglingen. Finns för att orkestreringen ska kunna backa. */
export async function removeMirroredElection(electionId: string): Promise<void> {
  await votersDb.election.deleteMany({ where: { id: electionId } })
}

export type BallotForVoter = MirroredBallot & { hasVoted: boolean }

/**
 * Vilka valsedlar den här personen ska rösta på, och vilka som redan är
 * avklarade.
 *
 * KOMMUN- och LANDSTINGSVALSEDLAR gäller bara den som är folkbokförd i rätt
 * område — man röstar i sin egen kommun, inte i alla. RIKSDAG och FRAGA gäller
 * alla.
 *
 * Funktionen returnerar ingenting om VAD som står på valsedlarna. Den vet inte
 * det, och kan inte ta reda på det.
 */
export async function ballotsForVoter(
  voterStatusId: string,
  electionId: string,
): Promise<BallotForVoter[]> {
  const [voter, election, voted] = await Promise.all([
    votersDb.voterStatus.findUnique({
      where: { id: voterStatusId },
      select: { municipalityCode: true, regionCode: true },
    }),
    getMirroredElection(electionId),
    votersDb.voterBallotStatus.findMany({
      where: { voterStatusId, ballot: { electionId } },
      select: { ballotId: true },
    }),
  ])

  if (!voter || !election) return []

  const votedBallotIds = new Set(voted.map((row) => row.ballotId))

  return election.ballots
    .filter((ballot) => {
      if (ballot.kind === 'KOMMUN') return ballot.areaCode === voter.municipalityCode
      if (ballot.kind === 'LANDSTING') return ballot.areaCode === voter.regionCode
      return true
    })
    .map((ballot) => ({ ...ballot, hasVoted: votedBallotIds.has(ballot.id) }))
}

/**
 * Valsedelns privata signeringsnyckel.
 *
 * Lämnar aldrig röstlängdsmodulen. Den används för att signera blindade
 * röstintyg medan väljaren är legitimerad, och den som har den kan skapa
 * röstintyg som ser auktoriserade ut.
 */
export async function getBallotSigningKey(
  ballotId: string,
): Promise<{ privateKeyPem: string; publicKeyPem: string } | null> {
  const ballot = await votersDb.electionBallot.findUnique({
    where: { id: ballotId },
    select: { signingPrivateKeyPem: true, signingPublicKeyPem: true },
  })

  if (!ballot) return null

  return {
    privateKeyPem: ballot.signingPrivateKeyPem,
    publicKeyPem: ballot.signingPublicKeyPem,
  }
}

/**
 * Hör valsedeln till den här omröstningen?
 *
 * Används för att avvisa en begäran som pekar på en valsedel i en annan
 * omröstning än den sessionen gäller.
 */
export async function ballotBelongsToElection(
  ballotId: string,
  electionId: string,
): Promise<boolean> {
  const count = await votersDb.electionBallot.count({ where: { id: ballotId, electionId } })
  return count === 1
}
