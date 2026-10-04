import type { RuntimeMode } from '@/lib/mode-flag'
import { votersDb } from './db'

/**
 * Omröstningar sett från röstlängden.
 *
 * Det här är SPEGLINGEN: samma omröstnings-id och samma valsedels-id som i
 * röstdatabasen, men bara det som röstlängden behöver för att svara på sina
 * frågor — vilka valsedlar gäller den här personen, och vilka valsedlar
 * finns i omröstningen att lägga ett kuvert på.
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

/** Id, namn och fas. Ingenting som räknar, och ingenting per väljare. */
export type ElectionPhase = { id: string; name: string; phase: string }

/** Så många omröstningar fasen listas för, de senast öppnade först. */
const PHASE_LIST_LIMIT = 50

/**
 * Fasen för varje omröstning, till den offentliga listan.
 *
 * Fasen är inte hemlig (spec 6.1). Det som inte får följa med, så länge
 * röstningen pågår, är allt som räknar: antal röster, antal väljare, antal
 * kuvert (spec 6.2). Därför väljs bara de tre fälten ut, och inget av dem är
 * ett tal.
 */
export async function listElectionPhases(): Promise<ElectionPhase[]> {
  return votersDb.election.findMany({
    select: { id: true, name: true, phase: true },
    orderBy: { opensAt: 'desc' },
    take: PHASE_LIST_LIMIT,
  })
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
  /** Samma läge som i röstdatabasen (uppgift 17). */
  mode: RuntimeMode
  opensAt: Date
  closesAt: Date
  ballots: Array<{
    id: string
    kind: string
    label: string
    areaCode: string | null
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
        mode: input.mode,
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

/**
 * Vilka valsedlar den här personen ska rösta på.
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
): Promise<MirroredBallot[]> {
  const [voter, election] = await Promise.all([
    votersDb.voterStatus.findUnique({
      where: { id: voterStatusId },
      select: { municipalityCode: true, regionCode: true },
    }),
    getMirroredElection(electionId),
  ])

  if (!voter || !election) return []

  return election.ballots
    .filter((ballot) => {
      if (ballot.kind === 'KOMMUN') return ballot.areaCode === voter.municipalityCode
      if (ballot.kind === 'LANDSTING') return ballot.areaCode === voter.regionCode
      return true
    })
}

/**
 * Vad väljaren skriver under i BankID: omröstningens namn och valsedelns slag,
 * för texten i appen (uppgift 11e). Null när valsedeln inte hör till
 * omröstningen, så att samma uppslagning också är den prövningen.
 *
 * Slaget och inte etiketten, eftersom etiketten för en kommun- eller
 * regionvalsedel namnger området. Det döljer inget för BankID, som har
 * valsedelns id i det signerade, men texten ska inte säga mer än väljaren
 * behöver läsa.
 */
export async function signingSubject(
  ballotId: string,
  electionId: string,
): Promise<{ electionName: string; ballotKind: string; ballotLabel: string } | null> {
  const ballot = await votersDb.electionBallot.findFirst({
    where: { id: ballotId, electionId },
    select: { kind: true, label: true, election: { select: { name: true } } },
  })
  return ballot
    ? { electionName: ballot.election.name, ballotKind: ballot.kind, ballotLabel: ballot.label }
    : null
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
