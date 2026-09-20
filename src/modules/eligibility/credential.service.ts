import { truncateToDay } from '@/lib/time'
import { signBlinded } from '@/lib/blind-signature'
import { votersDb } from './db'
import { ballotsForVoter } from './election.service'

/**
 * Utfärdande av röstintyg.
 *
 * Detta är den punkt där en väljare "godkänns för röstning". Allt som händer
 * här är knutet till en identitet; allt som händer sedan är det inte.
 *
 * DE TVÅ STEGEN SKER I EN ENDA TRANSAKTION.
 *
 * Markeringen "har röstat på den här valsedeln" och utfärdandet av intyget är
 * odelbara. Antingen markeras väljaren OCH får ett intyg, eller så händer
 * ingetdera. Det går eftersom båda rör samma databas — till skillnad från den
 * tidigare konstruktionen, där markeringen låg i röstlängden och rösten i en
 * annan databas, och ingen transaktion kunde spänna över båda.
 *
 * DET ÄR SÅ TRANSAKTIONSPROBLEMET FÖRSVINNER.
 *
 * Tidigare fanns ett fönster: markera först och krascha gav en förlorad röst,
 * rösta först och krascha gav dubbelröstning. Nu finns inget sådant fönster.
 * Väljaren får ett intyg i en atomisk operation, och kan lösa in det när som
 * helst — direkt, efter en omladdning, eller efter att nätet legat nere en
 * stund. Inlösen är engångs, garanterad av ett unikt index i röstdatabasen.
 *
 * Ett utfärdat men aldrig inlöst intyg är inte en förlorad röst i tysthet: det
 * syns som en avvikelse i slutkontrollen, eftersom antalet utfärdade intyg och
 * antalet registrerade röster då inte stämmer.
 *
 * VAD SOM INTE LAGRAS
 *
 * Varken det blindade värdet, signaturen eller något som kan härledas ur
 * intyget sparas. Raden i voter_ballot_status säger att personen fått ett
 * intyg för valsedeln — ingenting om vilket. Myndigheten har aldrig sett
 * intygets värde, och kan därför inte känna igen det när det kommer tillbaka.
 */

export type IssueCredentialOutcome =
  | { status: 'issued'; blindSignature: string; publicKeyPem: string }
  | { status: 'already_issued' }
  | { status: 'ballot_not_for_voter' }
  | { status: 'unknown_ballot' }

/**
 * Utfärdar ett röstintyg för en valsedel.
 *
 * Tar emot ett BLINDAT värde. Funktionen kan inte se vad den signerar, och det
 * är hela poängen: signaturen blir bevisbart myndighetens, men myndigheten kan
 * inte känna igen den vid inlösen.
 */
export async function issueCredential(
  voterStatusId: string,
  electionId: string,
  ballotId: string,
  blindedHex: string,
): Promise<IssueCredentialOutcome> {
  // Gäller valsedeln den här personen? En kommunvalsedel gäller bara den som
  // är folkbokförd i kommunen. Kontrollen ligger HÄR och inte vid röstningen,
  // eftersom röstningen är anonym och då inte längre vet vem väljaren är.
  const applicable = await ballotsForVoter(voterStatusId, electionId)
  const ballot = applicable.find((entry) => entry.id === ballotId)

  if (!ballot) return { status: 'ballot_not_for_voter' }
  if (ballot.hasVoted) return { status: 'already_issued' }

  const keys = await votersDb.electionBallot.findUnique({
    where: { id: ballotId },
    select: { signingPrivateKeyPem: true, signingPublicKeyPem: true },
  })

  if (!keys) return { status: 'unknown_ballot' }

  try {
    // Markeringen och signeringen hör ihop. Signeringen görs inuti
    // transaktionen så att ett fel i den rullar tillbaka markeringen — annars
    // vore väljaren markerad som röstande utan att ha fått något intyg, och
    // rösträtten vore bränd.
    const blindSignature = await votersDb.$transaction(async (tx) => {
      await tx.voterBallotStatus.create({
        data: {
          voterStatusId,
          ballotId,
          // Dygnsupplösning: se kommentaren om tidskorrelation i lib/time.ts.
          votedAt: truncateToDay(new Date()),
        },
      })

      return signBlinded(blindedHex, keys.signingPrivateKeyPem)
    })

    return {
      status: 'issued',
      blindSignature,
      publicKeyPem: keys.signingPublicKeyPem,
    }
  } catch (error) {
    const isUniqueViolation =
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'

    // DUBBELRÖSTNINGSSPÄRREN. Två samtidiga begäranden kan båda passera
    // kontrollen ovan, men bara en kan skapa raden — det unika indexet på
    // (voter_status_id, ballot_id) avgör, inte koden.
    if (isUniqueViolation) return { status: 'already_issued' }

    throw error
  }
}

/**
 * Antal utfärdade röstintyg per valsedel.
 *
 * Detta är "antalet godkända röstningar" i slutkontrollen. Det ska stämma
 * exakt med antalet registrerade röster i röstdatabasen — och gör det inte
 * det, är valet avvikande.
 */
export async function countIssuedCredentials(
  electionId: string,
): Promise<Array<{ ballotId: string; issued: number }>> {
  const ballots = await votersDb.electionBallot.findMany({
    where: { electionId },
    select: { id: true },
    orderBy: { displayOrder: 'asc' },
  })

  return Promise.all(
    ballots.map(async (ballot) => ({
      ballotId: ballot.id,
      issued: await votersDb.voterBallotStatus.count({ where: { ballotId: ballot.id } }),
    })),
  )
}
