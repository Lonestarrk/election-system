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
 * VAD SIGNATURKONTROLLEN (STALE_SEQUENCE/BAD_SIGNATURE NEDAN) FAKTISKT STÄNGER
 * — OCH VAD DEN INTE GÖR.
 *
 * Den stänger i DAG: förvanskat eller på annat sätt manipulerat
 * signaturmaterial i en rad som annars är äkta (ett fält som gått sönder
 * eller bytts ut efter att raden skrevs), och en klient som försöker skicka
 * med ett eget påhittat kuvert i stället för att gå via BankID —
 * `castEncryptedBallot` hämtar signatur och certifikat bara ur BankID:s eget
 * svar, aldrig ur begäran (se `pending-vote.service.ts` och
 * `/api/vote/encrypted`).
 *
 * DEN STÄNGER INTE EN ANGRIPARE MED SKRIVRÄTTIGHET TILL DATABASEN. En sådan
 * angripare kan generera ett eget nyckelpar, signera ett välformat kuvert med
 * sin egen privata nyckel, och skriva nyckeln, signaturen och ett verkligt
 * `voterStatusId` tillsammans i en rad som är fullständigt självkonsekvent.
 * `classifySignature` kan bara pröva att signaturen håller mot NYCKELN SOM
 * STÅR I RADEN — inte att den nyckeln verkligen tillhör väljaren radens
 * `voterStatusId` pekar på. Den bindningen finns inte kvar att kontrollera
 * här: `PendingVote` lagrar bara nyckelmaterialet, aldrig certifikatet (se
 * `PendingVote.bankIdPublicKey`s dokumentation för varför). Se testet
 * "en självkonsekvent förfalskning med eget nyckelpar fångas INTE" i
 * `validate-before-close.test.ts` för en körd demonstration av precis den
 * här luckan — den är känd, inte förbisedd, och ska tas upp som en post i
 * `src/lib/known-limitations.ts` av uppgift 16.
 *
 * Vad som SKULLE stänga den: antingen CA-kedjevalidering av certifikatet vid
 * LÄGGNINGSTILLFÄLLET, så att bara en nyckel utfärdad av BankIDs CA någonsin
 * kan bli en rad (redan utpekat som återstående arbete i
 * `personalNumberFromCertificate`s dokumentation), eller att behålla ett
 * identitetsbundet värde i raden i stället för bara nyckeln — vilket i sin
 * tur återöppnar exakt den avvägning som fick certifikatet att strykas till
 * förmån för bara nyckelmaterialet (samma dokumentation som ovan).
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
 * Gränsen finns för att en absurt hög (tampererad) räknarkolumn på EN rad
 * inte ska få valideringen att leta i det oändliga för just den raden. Ingen
 * verklig väljare ändrar sig hundratals gånger på en och samma valsedel.
 *
 * Den ensam räcker inte mot en angripare som skriver MÅNGA rader, var och en
 * med en absurt hög räknarkolumn — se `MAX_TOTAL_STALE_PROBES` nedan för
 * taket som skyddar mot det.
 */
const MAX_STALE_LOOKBACK = 500

/**
 * Sammanlagt tak för hela körningen på hur många extra signaturverifieringar
 * STALE_SEQUENCE-sökningen får göra, över samtliga rader.
 *
 * `MAX_STALE_LOOKBACK` begränsar kostnaden för EN avvikande rad. Det räcker
 * inte mot en angripare med skrivrättighet som skapar MÅNGA rader, var och en
 * med en manipulerad, hög räknarkolumn: utan ett gemensamt tak skulle
 * kostnaden växa linjärt med antalet sådana rader, upp till
 * `MAX_STALE_LOOKBACK` extra verifieringar VAR — långsamt nog att fördröja
 * stängningen, vilket är precis det valideringen (spec 7.1) inte får göra sig
 * skyldig till själv.
 *
 * Budgeten delas mellan ALLA rader i körningen, inte per rad. Tar den slut
 * mitt i sökningen för en rad avgörs den raden som BAD_SIGNATURE i stället
 * för STALE_SEQUENCE — en försiktig, inte en felaktig, klassificering: raden
 * är fortfarande en avvikelse och gör fortfarande `passed` falskt, bara
 * kategorin kan bli fel under den extrema omständigheten att budgeten tagit
 * slut. Ett normalt val, utan manipulerade rader, förbrukar aldrig budgeten —
 * varje ärlig rad kostar exakt en verifiering (det rena, snabba fallet).
 */
const MAX_TOTAL_STALE_PROBES = 5000

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
  /** Delad mellan alla rader i körningen — se `MAX_TOTAL_STALE_PROBES`. */
  staleProbeBudget: { remaining: number },
): SignatureVerdict {
  const current = envelopePayload({
    electionId,
    ballotId: vote.ballotId,
    ciphertextHash: vote.ciphertextHash,
    castSequence: vote.castSequence,
  })

  if (verifySignedPayload(vote.bankIdSignature, vote.bankIdPublicKey, current)) return 'ok'

  const lowerBound = Math.max(1, vote.castSequence - MAX_STALE_LOOKBACK)

  for (
    let candidate = vote.castSequence - 1;
    candidate >= lowerBound && staleProbeBudget.remaining > 0;
    candidate -= 1
  ) {
    staleProbeBudget.remaining -= 1

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
 * form i klienten. Bara ett typläge — ingen runtime-kontroll sker här. Formen
 * kontrolleras av `verifyEncryptedBallot`, som anropas via `proofHoldsSafely`
 * nedan, INTE direkt: se den funktionens dokumentation för varför.
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
 * BAD_PROOF-kontrollen, skyddad mot kast (fixrunda 2, uppgift 10:s
 * granskning).
 *
 * `verifyEncryptedBallot` (src/lib/crypto/verify-ballot.ts) gör `BigInt(...)`
 * på chiffer- och bevisfälten utan eget felfång. Det är rätt för dess EGNA
 * normala anropskedja: `castEncryptedBallot` når den bara med en valsedel som
 * redan passerat `castEncryptedBallotSchema` (`decimalStringSchema`, se
 * `src/lib/validation.ts`) — fälten är garanterat decimalsträngar innan de
 * når fram, så ett kast där vore ett verkligt programmeringsfel att stanna
 * på.
 *
 * HÄR FINNS INGEN SÅDAN GARANTI. Raden kommer direkt ur databasen, förbi
 * varje Zod-schema, och den här filens dokumentationshuvud handlar
 * genomgående om att en angripare med skrivrättighet kan ha skrivit precis
 * den raden. Ett missformat chiffer (icke-numeriska strängar, `null` i
 * stället för en array, fel längd) är då inte ett programmeringsfel — det ÄR
 * avvikelsen valideringen finns för att hitta, och ska rapporteras som
 * BAD_PROOF precis som ett välformat men matematiskt ogiltigt bevis.
 *
 * VALIDERINGEN ÄR EN SPÄRR (spec 7.1), OCH EN SPÄRR SOM KRASCHAR HAR HJÄLPT
 * ANGRIPAREN I STÄLLET FÖR ATT STOPPA HONOM. Ett okatchat undantag här skulle
 * få hela `validateBeforeClose` att kasta för HELA omröstningen — administratören
 * får en stacktrace i stället för en avvikelserapport, och valet går inte att
 * stänga alls. En enda missformad rad, skriven av vem som helst med
 * skrivrättighet, vore då en spärr mot att någonsin stänga valet — strax
 * effektivare för en angripare än den avvikelse raden annars hade orsakat.
 *
 * Att linda in HELA anropet (i stället för att härda `BigInt(...)` punktvis
 * inne i `verifyEncryptedBallot`) är avsiktligt: den funktionens kryptologik
 * rörs inte alls här, och skyddet täcker varje sätt den kan kasta på skräp —
 * chiffer, bevis eller längder — utan att räkna upp dem en och en.
 */
function proofHoldsSafely(
  shape: { publicKey: string; optionCount: number },
  electionId: string,
  ballotId: string,
  vote: { ciphertext: unknown; proofs: unknown; ciphertextHash: string },
): boolean {
  try {
    return verifyEncryptedBallot(
      shape.publicKey,
      electionId,
      ballotId,
      shape.optionCount,
      toEncryptedBallot(vote),
    )
  } catch {
    return false
  }
}

/**
 * Kör hela valideringen för en omröstning, medan `PendingVote` fortfarande
 * pekar på `voterStatusId`.
 *
 * KONTROLLERNA KÖRS I ORDNING, BILLIGAST FÖRST — MEN ALLA KÖRS, FÖR VARJE
 * RAD, OAVSETT OM EN TIDIGARE REDAN TRÄFFAT.
 *
 *   1. WRONG_BALLOT    — en ren uppslagning mot spegeltabellen.
 *   2. STALE_SEQUENCE  — kryptografisk, men en enda `verify` i det vanliga
 *   3. BAD_SIGNATURE      fallet (bara en avvikande rad kostar flera).
 *   4. BAD_PROOF       — dyrast: en handfull modulär exponentiering per
 *                        alternativ på valsedeln.
 *
 * "Billigast först" avgör bara ORDNINGEN de körs i, inte OM de körs. En rad
 * kan ha flera samtidiga fel — fel valsedel OCH ett förfalskat bevis är inte
 * mer osannolikt än bara det ena — och just den kombinationen betyder mest
 * för en administratörs triage (spec 7.2 finns för att avvikelser ska gå att
 * UTREDA). WRONG_BALLOT-kommentaren ovan säger uttryckligen att en sådan rad
 * "kan komma från en bugg lika gärna som ett angrepp": att i det läget dölja
 * en SAMTIDIG signatur- eller bevisavvikelse, bara för att den redan
 * kategoriserats som fel valsedel, vore att gömma exakt den information som
 * skiljer en bugg från ett angrepp. En rad utan avvikelser kostar fortfarande
 * bara det billiga, vanliga fallet av varje kontroll.
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
  // Delad över hela körningen — se `MAX_TOTAL_STALE_PROBES`.
  const staleProbeBudget = { remaining: MAX_TOTAL_STALE_PROBES }

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
    }

    // 2–3. STALE_SEQUENCE / BAD_SIGNATURE — kryptografiska, en verifiering i
    // det vanliga (rena) fallet. Körs OAVSETT om WRONG_BALLOT redan träffade.
    const signatureVerdict = classifySignature(electionId, vote, staleProbeBudget)
    if (signatureVerdict === 'stale') {
      anomalies.push(anomaly('STALE_SEQUENCE'))
    }
    if (signatureVerdict === 'bad') {
      anomalies.push(anomaly('BAD_SIGNATURE'))
    }

    // 4. BAD_PROOF — dyrast, men körs ändå: en rad kan ha ett ogiltigt bevis
    // OBEROENDE av om valsedeln eller signaturen redan avvek.
    let shape = shapeCache.get(vote.ballotId)
    if (shape === undefined) {
      shape = await getEncryptedBallotShape(vote.ballotId)
      shapeCache.set(vote.ballotId, shape)
    }

    const proofHolds = shape !== null && proofHoldsSafely(shape, electionId, vote.ballotId, vote)

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
