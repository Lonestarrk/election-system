import { canonicalOptions } from '@/lib/crypto/ballot-encoding'
import { votesDb } from './db'

/**
 * Omröstningar och valsedlar, sett från den anonyma sidan.
 *
 * Den här filen vet vad man kan rösta PÅ: vilka valsedlar en omröstning har,
 * vilka partier som står på var och en, vilka kandidater som går att kryssa,
 * vilka svarsalternativ en fråga har.
 *
 * Den vet ingenting om vem som får rösta. Röstberättigande avgörs i
 * röstlängdsmodulen, mot en annan databas.
 *
 * Notera att allt i den här filen är OFFENTLIG information. Vilka partier som
 * ställer upp i ett val och vilka kandidater som kan kryssas ska vem som helst
 * kunna läsa utan att legitimera sig — att kräva inloggning för det skulle
 * bara göra systemet svårare att granska, inte säkrare.
 */

export const ELECTION_KINDS = ['RIKSDAGSVAL', 'ALLMAN_OMROSTNING'] as const
export type ElectionKind = (typeof ELECTION_KINDS)[number]

export const BALLOT_KINDS = ['KOMMUN', 'LANDSTING', 'RIKSDAG', 'FRAGA'] as const
export type BallotKind = (typeof BALLOT_KINDS)[number]

export type PartyChoice = {
  /**
   * Notera: detta är BallotParty-id, inte Party-id.
   *
   * Rösten läggs på partiet PÅ EN VISS VALSEDEL. Samma parti på kommun- och
   * riksdagsvalsedeln är två olika val, och att skilja dem åt redan i
   * identifieraren gör det omöjligt att av misstag räkna en kommunröst som en
   * riksdagsröst.
   */
  ballotPartyId: string
  name: string
  abbreviation: string
  color: string
  /**
   * Ordningen på valsedeln, för partiet och för varje kandidat.
   *
   * Röstsidan bygger den kanoniska alternativlistan ur den här ordningen med
   * `canonicalOptions`, precis som servern gör i `getEncryptedBallotShape`.
   * Ordningen står därför utskriven i stället för att bara följa av listans
   * ordning i svaret: skilde sig listorna åt på en enda plats räknades rösten
   * på fel alternativ, och ingenting i bevisen fångar det.
   */
  displayOrder: number
  candidates: Array<{ id: string; name: string; displayOrder: number }>
}

export type BallotChoices =
  | { kind: 'PARTY'; allowsCandidateVote: boolean; parties: PartyChoice[] }
  | { kind: 'QUESTION'; options: Array<{ id: string; label: string }> }

export type Ballot = {
  id: string
  kind: BallotKind
  label: string
  areaCode: string | null
  allowsCandidateVote: boolean
  /** Publiceras öppet — observatörer verifierar röstintyg med den. */
  signingPublicKeyPem: string
  displayOrder: number
}

export type Election = {
  id: string
  name: string
  kind: ElectionKind
  opensAt: Date
  closesAt: Date
  ballots: Ballot[]
}

function toElection(row: {
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
    allowsCandidateVote: boolean
    signingPublicKeyPem: string
    displayOrder: number
  }>
}): Election {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ElectionKind,
    opensAt: row.opensAt,
    closesAt: row.closesAt,
    ballots: row.ballots.map((ballot) => ({
      id: ballot.id,
      kind: ballot.kind as BallotKind,
      label: ballot.label,
      areaCode: ballot.areaCode,
      allowsCandidateVote: ballot.allowsCandidateVote,
      signingPublicKeyPem: ballot.signingPublicKeyPem,
      displayOrder: ballot.displayOrder,
    })),
  }
}

const electionSelect = {
  id: true,
  name: true,
  kind: true,
  opensAt: true,
  closesAt: true,
  ballots: {
    select: {
      id: true,
      kind: true,
      label: true,
      areaCode: true,
      allowsCandidateVote: true,
      signingPublicKeyPem: true,
      displayOrder: true,
    },
    orderBy: { displayOrder: 'asc' },
  },
} as const

export async function listElections(): Promise<Election[]> {
  const rows = await votesDb.election.findMany({
    select: electionSelect,
    orderBy: { opensAt: 'desc' },
  })
  return rows.map(toElection)
}

/** Omröstningar som är öppna just nu. */
export async function listOpenElections(): Promise<Election[]> {
  const now = new Date()
  const rows = await votesDb.election.findMany({
    where: { opensAt: { lte: now }, closesAt: { gt: now } },
    select: electionSelect,
    orderBy: { opensAt: 'desc' },
  })
  return rows.map(toElection)
}

export async function getElection(electionId: string): Promise<Election | null> {
  const row = await votesDb.election.findUnique({
    where: { id: electionId },
    select: electionSelect,
  })
  return row ? toElection(row) : null
}

/** Alternativen på en valsedel. */
export async function getBallotChoices(ballotId: string): Promise<BallotChoices | null> {
  const ballot = await votesDb.electionBallot.findUnique({
    where: { id: ballotId },
    select: {
      kind: true,
      allowsCandidateVote: true,
      parties: {
        select: {
          id: true,
          displayOrder: true,
          party: { select: { name: true, abbreviation: true, color: true } },
          candidates: {
            select: { id: true, name: true, displayOrder: true },
            orderBy: { displayOrder: 'asc' },
          },
        },
        orderBy: { displayOrder: 'asc' },
      },
      options: {
        select: { id: true, label: true },
        orderBy: { displayOrder: 'asc' },
      },
    },
  })

  if (!ballot) return null

  if (ballot.kind === 'FRAGA') {
    return { kind: 'QUESTION', options: ballot.options }
  }

  return {
    kind: 'PARTY',
    allowsCandidateVote: ballot.allowsCandidateVote,
    parties: ballot.parties.map((entry) => ({
      ballotPartyId: entry.id,
      name: entry.party.name,
      abbreviation: entry.party.abbreviation,
      color: entry.party.color,
      displayOrder: entry.displayOrder,
      candidates: entry.candidates,
    })),
  }
}

/** Kryptonyckeln och antalet alternativ på en valsedel i det krypterade röstningsflödet. */
export type EncryptedBallotShape = { publicKey: string; optionCount: number }

/**
 * Formen en krypterad valsedel måste ha för att kunna verifieras.
 *
 * VARFÖR DEN HÄR FUNKTIONEN FINNS HÄR OCH INTE I VÄLJARMODULEN.
 *
 * Röstläggningen (`castEncryptedBallot` i `pending-vote.service.ts`) behöver
 * omröstningens krypteringsnyckel och antalet alternativ på valsedeln för att
 * kunna verifiera bevisen. Bådadera finns bara här — partier, kandidater och
 * `encryptionPublicKey` hör till den anonyma sidan — och väljarmodulen får
 * aldrig importera därifrån (se tests/security/module-boundaries.test.ts,
 * "väljarmodulen importerar ingenting från den anonyma röstmodulen"). Rutten
 * hämtar därför formen HÄR och skickar med den till `castEncryptedBallot` som
 * en parameter, i stället för att den anonyma modulens funktion importeras
 * där rösten läggs.
 *
 * Bara PARTY-formade valsedlar (KOMMUN, LANDSTING, RIKSDAG) stöds av det
 * krypterade flödet — en FRAGA-valsedel har inte någon motsvarande
 * `BallotOption`-variant i den kanoniska kodningen (`ballot-encoding.ts`).
 * Returnerar null för en sådan, för en okänd valsedel, och för en omröstning
 * utan krypteringsnyckel (skulle bara kunna inträffa om tröskelnyckeln av
 * något skäl inte skapades — se uppgift 6).
 */
export async function getEncryptedBallotShape(
  ballotId: string,
): Promise<EncryptedBallotShape | null> {
  const ballot = await votesDb.electionBallot.findUnique({
    where: { id: ballotId },
    select: {
      kind: true,
      allowsCandidateVote: true,
      election: { select: { encryptionPublicKey: true } },
      parties: {
        select: {
          id: true,
          candidates: { select: { id: true }, orderBy: { displayOrder: 'asc' } },
        },
        orderBy: { displayOrder: 'asc' },
      },
    },
  })

  if (!ballot || ballot.kind === 'FRAGA' || !ballot.election.encryptionPublicKey) return null

  /**
   * Frågorna redan sorterade av Prisma (orderBy ovan) — displayOrder byggs
   * bara upp igen av positionen i listan, så att `canonicalOptions` (som
   * kräver fältet för att kunna sortera) får en form den känner igen.
   */
  const options = canonicalOptions({
    allowsCandidateVote: ballot.allowsCandidateVote,
    parties: ballot.parties.map((party, partyIndex) => ({
      id: party.id,
      displayOrder: partyIndex,
      candidates: party.candidates.map((candidate, candidateIndex) => ({
        id: candidate.id,
        displayOrder: candidateIndex,
      })),
    })),
  })

  return { publicKey: ballot.election.encryptionPublicKey, optionCount: options.length }
}

/** Det förskapade partiregistret. */
export async function listRegisteredParties(): Promise<
  Array<{ id: string; name: string; abbreviation: string; color: string }>
> {
  return votesDb.party.findMany({
    orderBy: { displayOrder: 'asc' },
    select: { id: true, name: true, abbreviation: true, color: true },
  })
}

export class BallotValidationError extends Error {}

export type BallotChoiceInput = {
  ballotId: string
  ballotPartyId?: string
  candidateId?: string
  optionId?: string
}

/**
 * Kontrollerar att ett val är giltigt på sin valsedel, INNAN väljaren markeras
 * som röstande.
 *
 * Ordningen är avgörande. Utan den här kontrollen först skulle en felformad
 * begäran kunna bränna någons rösträtt på en valsedel utan att någon röst
 * registrerades — väljaren vore markerad som röstande men ingen röst funnes.
 *
 * Funktionen tar emot ett valsedels-id och ett val. Den tar inte emot, och kan
 * inte ta emot, något som identifierar väljaren.
 */
export async function validateBallotChoice(
  input: BallotChoiceInput,
  expectedElectionId?: string,
): Promise<{ valid: true } | { valid: false; reason: string }> {
  const ballot = await votesDb.electionBallot.findUnique({
    where: { id: input.ballotId },
    select: {
      electionId: true,
      kind: true,
      allowsCandidateVote: true,
      election: { select: { opensAt: true, closesAt: true } },
    },
  })

  if (!ballot) return { valid: false, reason: 'Okänd valsedel.' }

  /**
   * Vid röstning anges ingen förväntad omröstning, och behöver inte anges:
   * röstintyget är signerat med valsedelns egen nyckel och binder därmed
   * rösten till exakt den valsedeln — och därmed till dess omröstning.
   *
   * Vid utfärdande av intyg anges den däremot, för att den som legitimerat sig
   * för en omröstning inte ska kunna begära intyg i en annan som råkar vara
   * öppen samtidigt.
   */
  if (expectedElectionId && ballot.electionId !== expectedElectionId) {
    return { valid: false, reason: 'Valsedeln hör inte till den här omröstningen.' }
  }

  const now = new Date()
  if (ballot.election.opensAt > now) return { valid: false, reason: 'Omröstningen har inte öppnat.' }
  if (ballot.election.closesAt <= now) return { valid: false, reason: 'Omröstningen är stängd.' }

  if (ballot.kind === 'FRAGA') {
    if (input.ballotPartyId || input.candidateId) {
      return { valid: false, reason: 'En fråga besvaras med ett alternativ, inte ett parti.' }
    }
    if (!input.optionId) return { valid: false, reason: 'Inget alternativ valt.' }

    const option = await votesDb.ballotOption.count({
      where: { id: input.optionId, ballotId: input.ballotId },
    })
    return option === 1 ? { valid: true } : { valid: false, reason: 'Ogiltigt alternativ.' }
  }

  if (input.optionId) {
    return { valid: false, reason: 'En partivalsedel besvaras med ett parti, inte ett alternativ.' }
  }
  if (!input.ballotPartyId) return { valid: false, reason: 'Inget parti valt.' }

  const ballotParty = await votesDb.ballotParty.count({
    where: { id: input.ballotPartyId, ballotId: input.ballotId },
  })
  if (ballotParty !== 1) return { valid: false, reason: 'Ogiltigt parti på den här valsedeln.' }

  if (input.candidateId) {
    if (!ballot.allowsCandidateVote) {
      return { valid: false, reason: 'Personröst är inte tillåten på den här valsedeln.' }
    }

    // Kandidaten måste tillhöra det valda partiet på den valda valsedeln. Ett
    // kryss på någon annans kandidat vore annars en röst som inte går att
    // räkna konsekvent.
    const candidate = await votesDb.candidate.count({
      where: { id: input.candidateId, ballotPartyId: input.ballotPartyId },
    })
    if (candidate !== 1) return { valid: false, reason: 'Kandidaten står inte för det partiet.' }
  }

  return { valid: true }
}

export type CreateElectionInput = {
  name: string
  kind: ElectionKind
  opensAt: Date
  closesAt: Date
  ballots: Array<{
    kind: BallotKind
    label: string
    areaCode?: string | null
    allowsCandidateVote?: boolean
    /**
     * Valsedelns publika signeringsnyckel.
     *
     * Skapas av orkestreringslagret, som håller ihop nyckelparet: den privata
     * halvan går till röstlängden, den publika hit. Modulen genererar den inte
     * själv — då skulle den privata nyckeln behöva passera röstdatabasen.
     */
    signingPublicKeyPem: string
    /** Partier med kandidater. Bara för KOMMUN, LANDSTING och RIKSDAG. */
    parties?: Array<{ partyId: string; candidates?: string[] }>
    /** Svarsalternativ. Bara för FRAGA. */
    options?: string[]
  }>
}

export type CreatedElection = {
  id: string
  name: string
  ballotIds: Array<{ id: string; kind: BallotKind; label: string; areaCode: string | null }>
}

/**
 * Skapar omröstningen på den anonyma sidan.
 *
 * Detta är sanningskällan för omröstningens id. Röstlängdens spegling skapas
 * efteråt av orkestreringslagret med exakt de id:n som returneras här — aldrig
 * med egna, eftersom två olika id:n skulle göra speglingen oanvändbar.
 *
 * Hela omröstningen skapas i en transaktion. En halvskapad omröstning med
 * valsedlar men utan partier vore öppen för röstning och omöjlig att rösta i.
 */
export async function createElection(input: CreateElectionInput): Promise<CreatedElection> {
  return votesDb.$transaction(async (tx) => {
    const election = await tx.election.create({
      data: {
        name: input.name,
        kind: input.kind,
        opensAt: input.opensAt,
        closesAt: input.closesAt,
      },
      select: { id: true, name: true },
    })

    const ballotIds: CreatedElection['ballotIds'] = []

    for (const [index, ballot] of input.ballots.entries()) {
      const created = await tx.electionBallot.create({
        data: {
          electionId: election.id,
          kind: ballot.kind,
          label: ballot.label,
          areaCode: ballot.areaCode ?? null,
          allowsCandidateVote: ballot.allowsCandidateVote ?? false,
          signingPublicKeyPem: ballot.signingPublicKeyPem,
          displayOrder: index + 1,
        },
        select: { id: true, kind: true, label: true, areaCode: true },
      })

      for (const [partyIndex, party] of (ballot.parties ?? []).entries()) {
        const ballotParty = await tx.ballotParty.create({
          data: {
            ballotId: created.id,
            partyId: party.partyId,
            displayOrder: partyIndex + 1,
          },
          select: { id: true },
        })

        for (const [candidateIndex, name] of (party.candidates ?? []).entries()) {
          await tx.candidate.create({
            data: {
              ballotPartyId: ballotParty.id,
              name,
              displayOrder: candidateIndex + 1,
            },
          })
        }
      }

      for (const [optionIndex, label] of (ballot.options ?? []).entries()) {
        await tx.ballotOption.create({
          data: { ballotId: created.id, label, displayOrder: optionIndex + 1 },
        })
      }

      ballotIds.push({
        id: created.id,
        kind: created.kind as BallotKind,
        label: created.label,
        areaCode: created.areaCode,
      })
    }

    return { id: election.id, name: election.name, ballotIds }
  })
}

/**
 * Valsedelns publika signeringsnyckel.
 *
 * Används vid inlösen för att verifiera att röstintyget utfärdats av
 * valmyndigheten för just den här valsedeln.
 */
export async function getBallotPublicKey(ballotId: string): Promise<string | null> {
  const ballot = await votesDb.electionBallot.findUnique({
    where: { id: ballotId },
    select: { signingPublicKeyPem: true },
  })
  return ballot?.signingPublicKeyPem ?? null
}

/** Tar bort en omröstning. Finns för att orkestreringen ska kunna backa. */
export async function deleteElection(electionId: string): Promise<void> {
  await votesDb.election.deleteMany({ where: { id: electionId } })
}
