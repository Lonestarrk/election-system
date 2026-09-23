import { votersDb } from '@/modules/eligibility/db'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import {
  envelopePayload,
  verifySignedPayload,
} from '@/modules/eligibility/bankid/envelope-signature'
import { verifyEncryptedBallot, type EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { getEncryptedBallotShape } from '@/modules/ballot-box'

/**
 * DET ENDA ÖGONBLICK DÅ VARJE RÖST GÅR ATT KNYTA TILL EN VÄLJARE.
 *
 * Före ombyggnaden fanns ingen koppling alls: en felräkning gav ett tal och
 * ingenting mer. Efter skalningen finns ingen väljare kvar att fråga.
 * Däremellan — här, medan `PendingVote` fortfarande pekar på `voterStatusId`
 * — går varje avvikelse att peka ut och utreda.
 *
 * KONTROLLERNAS KARAKTÄR SKILJER SIG ÅT, och det är värt att förstå varför:
 *
 *   Relationella   säger att raden hänger ihop med resten av databasen. En
 *                  angripare med skrivrättighet ordnar det lätt — det räcker
 *                  att peka på en verklig, röstberättigad väljare och en
 *                  valsedel som finns.
 *   Kryptografiska säger att raden bär ett bevis bara väljaren kunde
 *                  framställa. Ingen med databasåtkomst kan förfalska dem.
 *
 * Signaturkontrollen (STALE_SEQUENCE/BAD_SIGNATURE nedan) är den enda som
 * stänger "en röst lagd i någon annans namn", eftersom en sådan rad passerar
 * varje relationell kontroll: väljaren är verklig, röstberättigad enligt
 * radens existens, och pekar på en valsedel som finns.
 *
 * VAD DEN HÄR FILEN INTE GÖR
 *
 * Den kopplar inte in sig i stängningen. Det är uppgift 11:s ansvar
 * (`close-election.usecase.ts`), som äger beslutet att avbryta skalningen när
 * `report.summary.passed` är falskt (spec 7.1: valideringen är en spärr, inte
 * en rapport — men just den inkopplingen sker i den andra filen). Den här
 * filen levererar bara användningsfallet.
 */

export type Anomaly = {
  kind: 'BAD_SIGNATURE' | 'STALE_SEQUENCE' | 'WRONG_BALLOT' | 'BAD_PROOF'
  pendingVoteId: string
  /** Bara för administratörens utredning. Publiceras aldrig. */
  voterStatusId: string
}

export type ValidationReport = {
  /** Publiceras: antal, kategorier, utfall — aldrig vem. */
  summary: { votes: number; voters: number; byKind: Record<string, number>; passed: boolean }
  /** Publiceras inte. Finns för administratören att utreda, och inte längre än så. */
  anomalies: Anomaly[]
}

/**
 * Hur långt bakåt en äkta, tidigare giltig signatur letas efter innan raden
 * hellre klassas som obevisad (BAD_SIGNATURE) än obevisat gammal
 * (STALE_SEQUENCE).
 *
 * `PendingVote` lagrar bara den SENASTE räknaren — ingen historik över tidigare
 * kuvert finns kvar att slå upp. Det enda sättet att avgöra om en rads
 * signatur i själva verket hör till ett LÄGRE, redan överspelat värde är att
 * pröva kryptografiskt: bygg om det signerade innehållet för varje lägre
 * räknarvärde och se om just den signaturen håller för något av dem. Ett
 * äkta gammalt kuvert visar sig då som "denna signatur höll, fast för
 * räknarvärde k, inte för det som står i kolumnen" — omöjligt att förfalska,
 * eftersom det kräver väljarens privata nyckel.
 *
 * Gränsen finns för att en absurt hög (tampererad) räknarkolumn inte ska få
 * valideringen att leta i det oändliga. Ingen verklig väljare ändrar sig
 * hundratals gånger på en och samma valsedel.
 */
const MAX_STALE_LOOKBACK = 500

type SignatureVerdict = 'ok' | 'stale' | 'bad'

/**
 * Avgör om den lagrade signaturen bevisar nuvarande innehåll, ett äldre
 * innehåll (återuppspelning), eller ingetdera.
 *
 * Bygger om det signerade innehållet ur radens EGNA lagrade fält —
 * `ciphertextHash` och `castSequence` — i stället för att förvänta sig
 * `signedData` bevarat ordagrant. Det finns ingen sådan kolumn (se
 * `PendingVote.bankIdPublicKey`s dokumentation för varför bara
 * nyckelmaterialet sparas): kolumnerna som SKREVS av `castEncryptedBallot`
 * kommer själva ur `signedData` vid läggningstillfället, och `envelopePayload`
 * är en entydig, längdprefixerad kodning — samma fält ger alltid samma
 * sträng. Återuppbyggnaden är alltså inte en gissning utan en exakt
 * återskapning av det som en gång verkligen signerades, förutsatt att fälten
 * inte ändrats var för sig sedan dess.
 */
function classifySignature(
  electionId: string,
  vote: {
    ballotId: string
    ciphertextHash: string
    castSequence: number
    bankIdSignature: string
    bankIdPublicKey: string
  },
): SignatureVerdict {
  const current = envelopePayload({
    electionId,
    ballotId: vote.ballotId,
    ciphertextHash: vote.ciphertextHash,
    castSequence: vote.castSequence,
  })

  if (verifySignedPayload(vote.bankIdSignature, vote.bankIdPublicKey, current)) return 'ok'

  const lowerBound = Math.max(1, vote.castSequence - MAX_STALE_LOOKBACK)

  for (let candidate = vote.castSequence - 1; candidate >= lowerBound; candidate -= 1) {
    const older = envelopePayload({
      electionId,
      ballotId: vote.ballotId,
      ciphertextHash: vote.ciphertextHash,
      castSequence: candidate,
    })

    if (verifySignedPayload(vote.bankIdSignature, vote.bankIdPublicKey, older)) return 'stale'
  }

  return 'bad'
}

/**
 * Gäller valsedeln väljarens kommun och region?
 *
 * Samma villkor som `ballotsForVoter` filtrerar med — men här som en spärr
 * mot en rad som redan skrivits, inte som ett filter mot vad väljaren erbjuds.
 * `castEncryptedBallot` kontrollerar aldrig detta (den känner inte ens till
 * väljarens folkbokföring), så en felaktig rad här kan komma från en bugg
 * lika gärna som ett angrepp — se spec avsnitt 7.
 */
function mismatchesVoterArea(
  ballot: { kind: string; areaCode: string | null },
  voter: { municipalityCode: string | null; regionCode: string | null },
): boolean {
  if (ballot.kind === 'KOMMUN') return ballot.areaCode !== voter.municipalityCode
  if (ballot.kind === 'LANDSTING') return ballot.areaCode !== voter.regionCode
  return false
}

/**
 * `ciphertext`/`proofs` lagras som Prisma `Json` och har därför ingen statisk
 * form i klienten. Formen kontrolleras av `verifyEncryptedBallot` självt —
 * precis som vid läggningen — så felaktig form upptäcks som ett underkänt
 * bevis (BAD_PROOF), inte som en krasch här.
 */
function toEncryptedBallot(vote: {
  ciphertext: unknown
  proofs: unknown
  ciphertextHash: string
}): EncryptedBallot {
  return {
    ciphertext: vote.ciphertext as EncryptedBallot['ciphertext'],
    proofs: vote.proofs as EncryptedBallot['proofs'],
    ciphertextHash: vote.ciphertextHash,
  }
}

/**
 * Kör hela valideringen för en omröstning, medan `PendingVote` fortfarande
 * pekar på `voterStatusId`.
 *
 * KONTROLLERNA KÖRS I ORDNING, BILLIGAST FÖRST, OCH STOPPAR VID FÖRSTA
 * TRÄFF PER RAD.
 *
 *   1. WRONG_BALLOT    — en ren uppslagning mot spegeltabellen.
 *   2. STALE_SEQUENCE  — kryptografisk, men en enda `verify` i det vanliga
 *   3. BAD_SIGNATURE      fallet (bara en avvikande rad kostar flera).
 *   4. BAD_PROOF       — dyrast: en handfull modulär exponentiering per
 *                        alternativ på valsedeln.
 *
 * En rad som redan underkänts av en billigare kontroll prövas aldrig mot en
 * dyrare — dels för kostnadens skull, dels för att den redan är förklarad.
 *
 * VALIDERINGEN KONTROLLERAR INTE NUVARANDE RÖSTBERÄTTIGANDE, och det är ett
 * beslut, inte en glömska (spec 7.4). Att rösten var legitim när den lades
 * framgår av signaturen, inte av röstlängdens tillstånd i efterhand. En
 * väljare som strukits efter att ha röstat — dödsfall är det realistiska
 * fallet — ska få sin röst räknad, precis som en svensk förtidsröst. Ingen
 * kontroll här läser `VoterStatus.isEligible`.
 */
export async function validateBeforeClose(electionId: string): Promise<ValidationReport> {
  const ballots = await votersDb.electionBallot.findMany({
    where: { electionId },
    select: { id: true, kind: true, areaCode: true },
  })
  const ballotById = new Map(ballots.map((ballot) => [ballot.id, ballot]))

  const pendingVotes = await votersDb.pendingVote.findMany({
    where: { ballotId: { in: ballots.map((ballot) => ballot.id) } },
    select: {
      id: true,
      voterStatusId: true,
      ballotId: true,
      ciphertext: true,
      proofs: true,
      ciphertextHash: true,
      castSequence: true,
      bankIdSignature: true,
      bankIdPublicKey: true,
      voterStatus: { select: { municipalityCode: true, regionCode: true } },
    },
  })

  const anomalies: Anomaly[] = []
  const shapeCache = new Map<string, Awaited<ReturnType<typeof getEncryptedBallotShape>>>()

  for (const vote of pendingVotes) {
    const anomaly = (kind: Anomaly['kind']): Anomaly => ({
      kind,
      pendingVoteId: vote.id,
      voterStatusId: vote.voterStatusId,
    })

    // 1. WRONG_BALLOT — billigast: en uppslagning, ingen kryptografi.
    const ballot = ballotById.get(vote.ballotId)
    if (!ballot || mismatchesVoterArea(ballot, vote.voterStatus)) {
      anomalies.push(anomaly('WRONG_BALLOT'))
      continue
    }

    // 2–3. STALE_SEQUENCE / BAD_SIGNATURE — kryptografiska, en verifiering i
    // det vanliga (rena) fallet.
    const signatureVerdict = classifySignature(electionId, vote)
    if (signatureVerdict === 'stale') {
      anomalies.push(anomaly('STALE_SEQUENCE'))
      continue
    }
    if (signatureVerdict === 'bad') {
      anomalies.push(anomaly('BAD_SIGNATURE'))
      continue
    }

    // 4. BAD_PROOF — dyrast, och prövas bara på rader som redan klarat allt
    // annat.
    let shape = shapeCache.get(vote.ballotId)
    if (shape === undefined) {
      shape = await getEncryptedBallotShape(vote.ballotId)
      shapeCache.set(vote.ballotId, shape)
    }

    const proofHolds =
      shape !== null &&
      verifyEncryptedBallot(
        shape.publicKey,
        electionId,
        vote.ballotId,
        shape.optionCount,
        toEncryptedBallot(vote),
      )

    if (!proofHolds) {
      anomalies.push(anomaly('BAD_PROOF'))
    }
  }

  const byKind: Record<string, number> = {}
  for (const found of anomalies) {
    byKind[found.kind] = (byKind[found.kind] ?? 0) + 1
  }

  const summary = {
    votes: pendingVotes.length,
    voters: new Set(pendingVotes.map((vote) => vote.voterStatusId)).size,
    byKind,
    passed: anomalies.length === 0,
  }

  /**
   * ATT LÄSA KOPPLINGEN SKA SYNAS (spec 7.2).
   *
   * En tyst läsning är oskiljbar från en obehörig. Loggas utan identiteter
   * eller antal, precis som varje annan revisionshändelse i den här tabellen
   * — se `audit.service.ts` för varför.
   */
  await recordAuditEvent(AUDIT_EVENTS.PRE_CLOSE_VALIDATION)

  return { summary, anomalies }
}
