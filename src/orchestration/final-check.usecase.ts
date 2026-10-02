import { multiply, type Ciphertext } from '@/lib/crypto/elgamal'
import { parseElement } from '@/lib/crypto/group'
// Ur serverns ingång, som räkningen: verifieringen, bidragens bevis, summans
// undergruppskontroller och den diskreta logaritmen räknas i OpenSSL. Se
// src/lib/crypto/server.ts.
import {
  combine,
  discreteLog,
  isInSubgroup,
  verifyEncryptedBallotOnServer,
  verifyPartialDecryption,
} from '@/lib/crypto/server'
import {
  parsePartialDecryptionProof,
  TRUSTEE_THRESHOLD,
  type PartialDecryption,
  type PartialDecryptionBinding,
} from '@/lib/crypto/threshold'
import { hashCiphertext, type EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { merkleRoot } from '@/lib/merkle'
import { urnRootOf, type UrnRow } from '@/lib/urn-root'
import { getEncryptedBallotShape } from '@/modules/ballot-box'
import { votesDb } from '@/modules/ballot-box/db'
import { votersDb } from '@/modules/eligibility/db'
import {
  AUDIT_EVENTS,
  recordAuditEvent,
  urnRootInAuditChain,
  verifyAuditChain,
} from '@/modules/eligibility/audit.service'

/**
 * DEN AUTOMATISKA SLUTKONTROLLEN
 *
 * Systemet ska inte bara producera ett resultat — det ska kunna visa varför
 * resultatet kan anses vara korrekt. Den här filen är där det avgörs.
 *
 * Kontrollen körs innan ett resultat får fastställas, och den kan inte
 * kringgås från adminvyn: fastställandet anropar samma funktion och vägrar om
 * någon kontroll fallerar. Det finns ingen parameter för att tvinga igenom ett
 * resultat, och det är avsiktligt — en sådan parameter vore exakt det som gör
 * alla andra kontroller meningslösa.
 *
 * KUVERTMODELLEN (uppgift 12b). Fram till uppgiften läste åtta av kontrollerna
 * det gamla flödets tabeller: röstintygen, tabellen vote och åtagandena över
 * den. För ett val i kuvertmodellen är de tomma, och kontrollerna passerade på
 * noll mot noll. Spärren som skulle avgöra om ett val får fastställas var alltså
 * grön på tomma tabeller. Varje kontroll här läser nu kuvertmodellens underlag,
 * och vad som hände med varje gammal kontroll står i
 * `WHAT_BECAME_OF_THE_OLD_CHECKS`.
 *
 * VARFÖR FILEN FÅR SE BÅDA DATABASERNA
 *
 * Ur röstlängden läser den omröstningens fas, kuvertroten, urnroten och
 * valsedlarna, ANTALET kuvert som ligger kvar, ANTALET markeringar "har röstat"
 * per valsedel och revisionskedjan. Ur röstdatabasen läser den urnan,
 * förtroendepersonernas publika andelar och bidrag och räkneverken. Den läser
 * aldrig en enskild väljare, och kan inte para ihop de två sidorna:
 * markeringarna räknas per valsedel, och urnan har ingen kolumn som pekar på en
 * väljare.
 *
 * Filen står därför på undantagslistan i modulgränstestet, med samma
 * motivering som adminstatistiken.
 */

/**
 * VAD SOM HÄNDE MED DET GAMLA FLÖDETS KONTROLLER (uppgift 12b).
 *
 * Ingen kontroll försvann tyst. Varje rad säger om den behölls, skrevs om mot
 * kuvertmodellens underlag eller togs bort, och varför.
 */
export const WHAT_BECAME_OF_THE_OLD_CHECKS = {
  approved_matches_recorded:
    'Omskriven till urn_matches_markers. Röstintygen finns inte i kuvertmodellen. Det som räknas är ' +
    'raderna i urnan per valsedel, och de jämförs med markeringarna "har röstat", som skalningen ' +
    'skriver en per flyttat kuvert och prövar antalet av före COMMIT.',
  every_vote_authorised:
    'Omskriven till every_vote_verifies. Röstintygets signatur finns inte i kuvertmodellen, och varje ' +
    'rad i urnan prövas i stället som en valsedel, med sina bevis. Den gamla kommentaren sa att ' +
    'kontrollen inte kunde förfalskas inifrån, fast valsedlarnas signeringsnycklar låg i röstlängden ' +
    '(granskningen av 11g, E5). Den nya säger vad den prövar och vem den inte skyddar mot.',
  no_reused_credentials:
    'Borttagen. Det finns inga röstintyg att återanvända. Högst ett kuvert per väljare och valsedel ' +
    'håller röstlängdens unika index på pending_vote, och valideringen prövar det medan kopplingen ' +
    'finns. Efter skalningen finns ingen väljare att pröva mot, och två rader med samma chiffer är två ' +
    'röster (ruling 130), så en kontroll av att hasharna i urnan är unika vore fel.',
  matches_commitment:
    'Omskriven till urn_root_matches. Åtagandet var en Merklerot över tabellen vote. I kuvertmodellen ' +
    'är åtagandet urnroten, som skalningen skriver i röstlängden och i revisionskedjan, och som räknas ' +
    'om ur urnan.',
  commitment_chain_intact:
    'Borttagen. Åtagandekedjan binder tabellen vote, som är tom i kuvertmodellen, och passerade därför ' +
    'på en tom kedja. Urnroten tar åtagandets plats, och revisionskedjan, där urnroten står, prövas av ' +
    'audit_chain_intact.',
  audit_chain_intact: 'Behållen som den är.',
  tally_matches_ballots:
    'Omskriven till tally_matches. Den räknade om resultatet ur tabellen vote. Nu räknas det om ur ' +
    'urnan och förtroendepersonernas bidrag, och bidragen prövas för sig i partial_decryptions_verify.',
  election_closed:
    'Omskriven till election_tallied. Den jämförde klockan med closesAt. Fasen är ett tillstånd och ' +
    'inte en jämförelse mot klockan (spec 6.1), och ett resultat får fastställas först i TALLIED.',
  link_cleared:
    'Behållen och utökad: kuvertroten ska också vara skriven. Allvarlighetsgraden följer fasen i ' +
    'stället för linkClearedAt, efter samma princip som ruling 42.',
  outstanding_credentials:
    'Borttagen. Den varnade för utfärdade röstintyg som aldrig lösts in, och sådana finns inte i ' +
    'kuvertmodellen. Ett kuvert som inte flyttades fångas av link_cleared och av skalningens egna ' +
    'antal.',
} as const

/**
 * TRE KLASSER, OCH SKILLNADEN ÄR AVGÖRANDE.
 *
 *  – CRITICAL: något stämmer inte i underlaget. En rad i urnan som inte är den
 *    stängningen flyttade, ett bidrag som inte håller, ett kuvert kvar efter
 *    skalningen. Det är tecken på fel eller manipulation, och omröstningen ska
 *    då markeras som avvikande.
 *
 *  – PRECONDITION: valet är inte klart att fastställas än. Omröstningen pågår,
 *    är inte skalad eller inte räknad. Ingenting är fel — det är bara för
 *    tidigt.
 *
 *  – WARNING: värt att förstå innan man fastställer, men inte ett hinder.
 *    Ingen kontroll är en varning sedan uppgift 12b. Den enda var
 *    `outstanding_credentials`, som hörde till det gamla flödet.
 *
 * Distinktionen mellan de två första finns för att ett förhastat klick inte
 * ska förstöra valet (ruling 42). UNDER_REVIEW går inte att lämna via
 * applikationen, och skulle "omröstningen är inte räknad" räknas som en
 * avvikelse hade en administratör som tryckte för tidigt gjort valet omöjligt
 * att fastställa över huvud taget.
 */
export type CheckSeverity = 'CRITICAL' | 'PRECONDITION' | 'WARNING'

export type CheckResult = {
  id: string
  /** Vad kontrollen svarar på, i klartext för den som läser rapporten. */
  question: string
  severity: CheckSeverity
  passed: boolean
  detail: string
}

export type FinalCheckReport = {
  electionId: string
  electionName: string
  /** Omröstningens fas i röstlängden (spec 6.1). */
  phase: string
  /**
   * Fasen, eller UNDER_REVIEW när en tidigare slutkontroll har markerat
   * omröstningen som avvikande.
   */
  status: string
  checks: CheckResult[]
  /** Sant bara om samtliga kritiska kontroller OCH förutsättningar är uppfyllda. */
  canCertify: boolean
  /**
   * Sant om någon KRITISK kontroll fallerat — alltså om underlaget inte
   * stämmer. Falskt när det bara är för tidigt att fastställa.
   */
  anomalous: boolean
  /** Kontroller som fallerat, kritiska först. */
  failures: CheckResult[]
  /** Urnroten räknad ur urnan, eller null när en rad inte går att hasha. */
  urnRoot: string | null
  /** Antalet rader i urnan på omröstningens valsedlar. */
  voteCount: number
  ranAt: string
}

/** Faserna där kopplingen finns kvar (spec 6.1). */
const LINKED_PHASES: readonly string[] = ['OPEN', 'CLOSED', 'VALIDATED']
/** Faserna efter räkningen. Där ska varje valsedel ha bidrag och räkneverk. */
const COUNTED_PHASES: readonly string[] = ['TALLIED', 'CERTIFIED']

/** Kuvertroten för inga kuvert, och urnroten för en tom urna: samma tal. */
const EMPTY_ROOT = merkleRoot([])

/** Hur många rader i urnan som läses per fråga, med chiffer och bevis. */
const URN_READ_BATCH_SIZE = 200

/** Hur många rader ett besked pekar ut, högst. */
const LISTED_ROWS = 5

type Shape = { publicKey: string; optionCount: number }

/** Det slutkontrollen vet om en valsedel efter att ha läst dess rader i urnan. */
type BallotReading = {
  id: string
  label: string
  shape: Shape | null
  rows: number
  markers: number
  /** Urnans rader, med chifferhashen räknad ur chiffret, för urnroten. */
  leaves: UrnRow[]
  /** Rader vars chiffer inte går att hasha. */
  unhashable: string[]
  /** Rader som inte verifierar som valsedlar. */
  notVerifying: string[]
  /** Summan av raderna, alternativ för alternativ, eller null med skälet i `whyNoSum`. */
  sums: Ciphertext[] | null
  whyNoSum: string | null
}

/** En förtroendepersons sparade bidrag för en valsedel, tolkat strikt. */
type Contribution = {
  trusteeIndex: number
  partials: Array<PartialDecryption | undefined>
  /** Ett tolkat bidrag för varje alternativ. Bara ett fullständigt bidrag kan kombineras. */
  complete: boolean
}

/** Kritiska avvikelser, och det som bara inte är klart än. */
type Findings = { critical: string[]; pending: string[] }

/**
 * Kör hela slutkontrollen.
 *
 * Ingen kontroll är beroende av en annans resultat — alla körs alltid, så att
 * rapporten visar ALLA avvikelser på en gång. En kontroll som avbryter vid
 * första felet skulle dölja att det finns fler, och den som granskar behöver
 * se hela bilden innan hen bedömer om det rör sig om ett fel eller ett angrepp.
 *
 * FASEN LÄSES FÖRST. Fastställandet skriver CERTIFIED med jämför-och-sätt från
 * den fas rapporten bygger på, så en fas som ändras medan kontrollen körs skrivs
 * inte över, se `certifyElection`.
 */
export async function runFinalCheck(electionId: string): Promise<FinalCheckReport | null> {
  const election = await votersDb.election.findUnique({
    where: { id: electionId },
    select: {
      name: true,
      phase: true,
      envelopeRoot: true,
      urnRoot: true,
      ballots: { select: { id: true, label: true }, orderBy: { displayOrder: 'asc' } },
    },
  })
  if (!election) return null

  const { phase, envelopeRoot } = election
  const linked = LINKED_PHASES.includes(phase)
  const counted = COUNTED_PHASES.includes(phase)
  const ballotIds = election.ballots.map((ballot) => ballot.id)

  // --- Underlaget ---------------------------------------------------------
  const remaining = await votersDb.pendingVote.count({ where: { ballotId: { in: ballotIds } } })
  const markerCounts = await votersDb.votedMarker.groupBy({
    by: ['ballotId'],
    where: { ballotId: { in: ballotIds } },
    _count: { _all: true },
  })
  const markersByBallot = new Map(markerCounts.map((row) => [row.ballotId, row._count._all]))

  const readings: BallotReading[] = []
  for (const ballot of election.ballots) {
    const shape = await getEncryptedBallotShape(ballot.id)
    readings.push(await readBallotUrn(electionId, ballot, shape, markersByBallot.get(ballot.id) ?? 0))
  }

  const partialRows = await votesDb.partialDecryption.findMany({
    where: { ballotId: { in: ballotIds } },
    select: { ballotId: true, optionIndex: true, trusteeIndex: true, value: true, proof: true },
    orderBy: [{ ballotId: 'asc' }, { trusteeIndex: 'asc' }, { optionIndex: 'asc' }],
  })
  const shares = await votesDb.trusteeShare.findMany({
    where: { electionId },
    select: { trusteeIndex: true, publicShare: true },
  })
  const tallies = await votesDb.ballotTally.findMany({
    where: { ballotId: { in: ballotIds } },
    select: { ballotId: true, optionIndex: true, count: true },
    orderBy: [{ ballotId: 'asc' }, { optionIndex: 'asc' }],
  })

  const contributions = new Map<string, { list: Contribution[]; problems: string[] }>()
  for (const reading of readings) {
    const problems: string[] = []
    const rows = partialRows.filter((row) => row.ballotId === reading.id)
    contributions.set(reading.id, { list: contributionsFor(reading, rows, problems), problems })
  }

  // --- Kontrollerna -------------------------------------------------------
  const checks: CheckResult[] = [
    phaseCheck(phase),
    linkClearedCheck(phase, linked, remaining, envelopeRoot),
    countCheck(linked, readings, envelopeRoot),
    await urnRootCheck(linked, readings, election.urnRoot),
    everyVoteCheck(linked, readings),
    partialsCheck(electionId, counted, readings, contributions, shares),
    tallyCheck(counted, readings, contributions, tallies),
  ]

  // --- Revisionskedjan är obruten (behållen) ------------------------------
  {
    const chain = await verifyAuditChain()

    checks.push({
      id: 'audit_chain_intact',
      question: 'Är revisionsloggen obruten?',
      severity: 'CRITICAL',
      passed: chain.intact,
      detail: chain.intact
        ? `${chain.entries} revisionshändelser bildar en obruten kedja.`
        : `Kedjan bryts vid händelse #${chain.brokenAtSequence}: ${chain.reason}`,
    })
  }

  // --- Ingen tidigare slutkontroll har markerat omröstningen --------------
  const votesSide = await votesDb.election.findUnique({ where: { id: electionId }, select: { status: true } })
  const underReview = votesSide?.status === 'UNDER_REVIEW'
  checks.push(underReviewCheck(underReview))

  const order: Record<CheckSeverity, number> = { CRITICAL: 0, PRECONDITION: 1, WARNING: 2 }

  const failures = checks
    .filter((check) => !check.passed)
    .sort((a, b) => order[a.severity] - order[b.severity])

  const anomalous = checks.some((check) => check.severity === 'CRITICAL' && !check.passed)

  const hashable = readings.every((reading) => reading.unhashable.length === 0)

  return {
    electionId,
    electionName: election.name,
    phase,
    status: underReview ? 'UNDER_REVIEW' : phase,
    checks,
    canCertify: checks.every((check) => check.severity === 'WARNING' || check.passed),
    anomalous,
    failures,
    urnRoot: hashable ? urnRootOf(readings.flatMap((reading) => reading.leaves)) : null,
    voteCount: readings.reduce((total, reading) => total + reading.rows, 0),
    ranAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Urnan
// ---------------------------------------------------------------------------

/** En rad i ett besked: dess chifferhash, avkortad, eller dess id när hashen inte har formen av en. */
function describeRow(row: { id: string; ciphertextHash: string }): string {
  return /^[0-9a-f]{64}$/.test(row.ciphertextHash)
    ? `chifferhash ${row.ciphertextHash.slice(0, 16)}…`
    : `id ${row.id}`
}

function listed(rows: readonly string[]): string {
  const shown = rows.slice(0, LISTED_ROWS).join(', ')
  return rows.length > LISTED_ROWS ? `${shown} och ${rows.length - LISTED_ROWS} till` : shown
}

/**
 * Chifferhashen räknad ur radens chiffer, eller null när chiffret inte är en
 * lista av par med två strängar. Urnroten räknas ur den här hashen och inte ur
 * kolumnen, så att ett chiffer som ändrats utan att hashen ändrats också ger en
 * annan rot.
 */
function hashOfCiphertext(ciphertext: unknown): string | null {
  if (!Array.isArray(ciphertext)) return null
  for (const pair of ciphertext) {
    if (typeof pair !== 'object' || pair === null) return null
    const { c1, c2 } = pair as Record<string, unknown>
    if (typeof c1 !== 'string' || typeof c2 !== 'string') return null
  }
  return hashCiphertext(ciphertext as EncryptedBallot['ciphertext'])
}

/**
 * Radens par, tolkade strikt, eller null. Undergruppen prövas här bara när
 * raden inte redan verifierat som valsedel, eftersom verifieringen prövar varje
 * element.
 */
function pairsOf(ciphertext: unknown, optionCount: number, verified: boolean): Ciphertext[] | null {
  if (!Array.isArray(ciphertext) || ciphertext.length !== optionCount) return null
  const pairs: Ciphertext[] = []
  for (const pair of ciphertext) {
    if (typeof pair !== 'object' || pair === null) return null
    const c1 = parseElement((pair as Record<string, unknown>).c1)
    const c2 = parseElement((pair as Record<string, unknown>).c2)
    if (c1 === null || c2 === null) return null
    if (!verified && (!isInSubgroup(c1) || !isInSubgroup(c2))) return null
    pairs.push({ c1, c2 })
  }
  return pairs
}

/**
 * Verifierar en rad som valsedel, INRAMAD VID ANROPSSTÄLLET (ruling 37).
 *
 * Raden kommer direkt ur databasen, förbi varje schema. Verifieringen tolkar
 * varje tal strikt och svarar nej på det mesta, men den kastar på en trasig
 * nyckel eller ett internt fel. Här blir också ett kast ett nej, så att skräp i
 * databasen blir en avvikelse i rapporten och inte en krasch. `await` står
 * innanför `try`, eftersom kastet kommer som ett avvisat löfte.
 */
async function verifiesAsBallot(
  shape: Shape,
  electionId: string,
  ballotId: string,
  row: { ciphertext: unknown; proofs: unknown; ciphertextHash: string },
): Promise<boolean> {
  try {
    return await verifyEncryptedBallotOnServer(shape.publicKey, electionId, ballotId, shape.optionCount, {
      ciphertext: row.ciphertext as EncryptedBallot['ciphertext'],
      proofs: row.proofs as EncryptedBallot['proofs'],
      ciphertextHash: row.ciphertextHash,
    })
  } catch {
    return false
  }
}

/**
 * Läser valsedelns rader i urnan en gång, i omgångar, och prövar varje rad för
 * de tre kontroller som läser den: urnroten, varje röst och summan som bidragen
 * och omräkningen prövas mot. En enda läsning, så att de tre gäller samma rader.
 */
async function readBallotUrn(
  electionId: string,
  ballot: { id: string; label: string },
  shape: Shape | null,
  markers: number,
): Promise<BallotReading> {
  const reading: BallotReading = {
    ...ballot,
    shape,
    rows: 0,
    markers,
    leaves: [],
    unhashable: [],
    notVerifying: [],
    sums: shape ? Array.from({ length: shape.optionCount }, () => ({ c1: 1n, c2: 1n })) : null,
    whyNoSum: shape ? null : 'valsedeln har ingen form i kuvertmodellen',
  }

  let after: string | null = null
  for (;;) {
    const batch: Array<{ id: string; ciphertext: unknown; proofs: unknown; ciphertextHash: string }> =
      await votesDb.encryptedVote.findMany({
        where: after === null ? { ballotId: ballot.id } : { ballotId: ballot.id, id: { gt: after } },
        select: { id: true, ciphertext: true, proofs: true, ciphertextHash: true },
        orderBy: { id: 'asc' },
        take: URN_READ_BATCH_SIZE,
      })

    for (const row of batch) {
      reading.rows += 1

      const hash = hashOfCiphertext(row.ciphertext)
      if (hash === null) reading.unhashable.push(describeRow(row))
      else reading.leaves.push({ ballotId: ballot.id, ciphertextHash: hash })

      const verified = shape !== null && (await verifiesAsBallot(shape, electionId, ballot.id, row))
      if (!verified) reading.notVerifying.push(describeRow(row))

      if (reading.sums !== null && shape !== null) {
        const pairs = pairsOf(row.ciphertext, shape.optionCount, verified)
        if (pairs === null) {
          reading.sums = null
          reading.whyNoSum = `raden med ${describeRow(row)} har inget chiffer som går att räkna in i summan`
        } else {
          reading.sums = reading.sums.map((sum, optionIndex) => multiply(sum, pairs[optionIndex]!))
        }
      }
    }

    if (batch.length < URN_READ_BATCH_SIZE) break
    after = batch[batch.length - 1]!.id
  }

  return reading
}

// ---------------------------------------------------------------------------
// Kontrollerna, i rapportens ordning
// ---------------------------------------------------------------------------

/** En kontroll som inte kan säga något förrän skalningen körts. */
function beforeStripping(id: string, question: string, what: string): CheckResult {
  return {
    id,
    question,
    severity: 'PRECONDITION',
    passed: false,
    detail: `${what} Det är ingen avvikelse, bara för tidigt.`,
  }
}

/** Kritiskt om något är fel, en förutsättning om något bara inte är klart, annars godkänt. */
function resultOf(id: string, question: string, findings: Findings, passedDetail: string): CheckResult {
  if (findings.critical.length > 0) {
    return { id, question, severity: 'CRITICAL', passed: false, detail: findings.critical.join(' ') }
  }
  if (findings.pending.length > 0) {
    return {
      id,
      question,
      severity: 'PRECONDITION',
      passed: false,
      detail: `${findings.pending.join(' ')} Det är ingen avvikelse, bara för tidigt.`,
    }
  }
  return { id, question, severity: 'CRITICAL', passed: true, detail: passedDetail }
}

/**
 * 1. FASEN ÄR TALLIED (uppgift 12b, punkt 6). Omskriven ur `election_closed`.
 *
 * Fasen är ett tillstånd som stängningen och räkningen skriver med
 * jämför-och-sätt, och ett resultat får fastställas först när varje valsedel
 * är räknad. En tidigare fas i specen är en förutsättning som inte är uppfylld,
 * aldrig en avvikelse (ruling 42). En fas som inte finns i specen har koden
 * inte skrivit, och den är en avvikelse. CERTIFIED godkänns också, så att
 * rapporten för ett fastställt val visar vad som gällde, men
 * `certifyElection` fastställer det inte igen.
 */
function phaseCheck(phase: string): CheckResult {
  const id = 'election_tallied'
  const question = 'Står omröstningen i fasen TALLIED, så att resultatet får fastställas?'

  if (phase === 'TALLIED') {
    return {
      id,
      question,
      severity: 'CRITICAL',
      passed: true,
      detail: 'Fasen står i TALLIED. Räkningen skriver den när varje valsedel i röstlängdens lista är räknad.',
    }
  }
  if (phase === 'CERTIFIED') {
    return { id, question, severity: 'CRITICAL', passed: true, detail: 'Fasen står i CERTIFIED: resultatet är fastställt.' }
  }
  if (LINKED_PHASES.includes(phase) || phase === 'STRIPPED') {
    const where =
      phase === 'OPEN'
        ? 'Röstningen pågår, och fasen står i OPEN.'
        : phase === 'STRIPPED'
          ? 'Kopplingen är raderad, och fasen står i STRIPPED. Räkningen skriver TALLIED när varje valsedel är räknad.'
          : `Omröstningen är stängd men inte skalad, och fasen står i ${phase}.`
    return {
      id,
      question,
      severity: 'PRECONDITION',
      passed: false,
      detail: `${where} Resultatet får fastställas först i TALLIED. Det är ingen avvikelse, bara för tidigt.`,
    }
  }
  return {
    id,
    question,
    severity: 'CRITICAL',
    passed: false,
    detail:
      `Fasen står i ${phase}, som inte är någon av specens faser. Koden skriver bara specens faser, så ` +
      'någon har skrivit i röstlängden förbi den.',
  }
}

/**
 * 2. KOPPLINGEN ÄR RADERAD OCH KUVERTROTEN SKRIVEN (punkt 5). Behållen ur det
 * gamla flödet och utökad.
 *
 * RADERINGEN BLIR ETT KONTROLLERAT VILLKOR I STÄLLET FÖR ETT LÖFTE. Skalningen
 * raderar kopplingen, men att den körde säger ingenting om att den lyckades,
 * eller om en rad skrivits tillbaka efteråt. Kontrollen läser därför efter.
 * Antalet är det enda som står i beskedet. Vilka väljare det gällde finns i
 * raderna, och stannar där.
 *
 * SEVERITETEN FÖLJER FASEN (ruling 42). Före skalningen har ett val liggande
 * kopplingar, och det är normaltillståndet under röstningen. Vore kontrollen
 * då kritisk hade `certifyElection` satt valet i UNDER_REVIEW, som inte går att
 * lämna via applikationen. Från STRIPPED har raderingen påståtts vara gjord, och
 * ett kuvert som ändå ligger kvar, eller en kuvertrot som saknas, är en
 * avvikelse. Fram till uppgift 12b avgjorde `linkClearedAt` det. Nu gör fasen
 * det, som i resten av filen.
 *
 * VAD DEN INTE SKYDDAR MOT (fixrunda 1, granskningens Mindre 5). Kontrollen
 * läser röstlängden som den är nu. Säkerhetskopior, läsreplikor och WAL-loggen
 * omfattas inte av raderingen, och med riktig BankID finns kopplingen kvar i
 * BankID-ordern (spec 10). Frågan säger därför "ur röstlängden".
 */
function linkClearedCheck(
  phase: string,
  linked: boolean,
  remaining: number,
  envelopeRoot: string | null,
): CheckResult {
  const id = 'link_cleared'
  const question = 'Är kopplingen mellan väljare och röst raderad ur röstlängden, och kuvertroten skriven?'

  if (linked) {
    const lying = remaining > 0 ? `${remaining} kuvert ligger i röstlängden, och fasen står i ${phase}.` : `Fasen står i ${phase}.`
    return beforeStripping(id, question, `${lying} Skalningen har inte körts, så kopplingen finns kvar och kuvertroten är inte skriven.`)
  }

  const critical: string[] = []
  if (remaining > 0) {
    critical.push(
      `${remaining} kuvert ligger i röstlängden fast fasen står i ${phase}. Skalningen raderar kuverten i ` +
        'samma transaktion som den skriver STRIPPED, så de har skrivits dit förbi den, bredvid väljarnas ' +
        'namn. Valet får inte fastställas.',
    )
  }
  if (envelopeRoot === null) {
    critical.push(
      `Kuvertroten saknas fast fasen står i ${phase}. STRIPPED skrivs bara tillsammans med roten, så ` +
        'någon har skrivit i röstlängden förbi stängningen.',
    )
  }

  return resultOf(
    id,
    question,
    { critical, pending: [] },
    'Inga kuvert ligger kvar i röstlängden, och kuvertroten är skriven. Kontrollen läser röstlängden som ' +
      'den är nu. Säkerhetskopior, läsreplikor och WAL-loggen omfattas inte av raderingen, och med riktig ' +
      'BankID finns kopplingen kvar i BankID-ordern (spec 10).',
  )
}

/**
 * 3. ANTALET STÄMMER (punkt 1). Omskriven ur `approved_matches_recorded`.
 *
 * Raderna i urnan per valsedel jämförs med markeringarna "har röstat", som
 * skalningen skriver i röstlängden, en per flyttat kuvert, och vars antal den
 * prövar före COMMIT (uppgift 11d). En rad som tagits bort ur urnan, eller en
 * markering som tagits bort ur röstlängden, ger olika tal.
 *
 * INTE PÅ TVÅ TOMMA MÄNGDER. Är både urnan och markeringarna tomma räcker det
 * inte att talen är lika: har kuvert flyttats har båda tagits bort. Kuvertroten
 * avgör det, eftersom den tomma mängdens rot är ett känt tal och roten binder
 * antalet kuvert. Ett val där ingen röstade passerar, och ett där båda tömts
 * efteråt gör det inte.
 *
 * VAD DEN INTE SÄGER. Att raderna är de flyttade kuverten prövar urnroten. Den
 * som kan skriva i båda databaserna kan ändra båda talen lika mycket.
 */
function countCheck(linked: boolean, readings: readonly BallotReading[], envelopeRoot: string | null): CheckResult {
  const id = 'urn_matches_markers'
  const question = 'Har urnan lika många rader som markeringar "har röstat", på varje valsedel?'

  if (linked) {
    return beforeStripping(id, question, 'Skalningen fyller urnan och skriver markeringarna, och den har inte körts.')
  }

  const critical = readings
    .filter((reading) => reading.rows !== reading.markers)
    .map((reading) => `${reading.label}: ${reading.rows} rader i urnan men ${reading.markers} markeringar.`)
  if (critical.length > 0) {
    critical.push(
      'Skalningen skriver en markering per flyttat kuvert och prövar antalet före COMMIT, så en rad i urnan ' +
        'eller en markering har lagts till eller tagits bort efteråt.',
    )
  }

  const empty = readings.every((reading) => reading.rows === 0 && reading.markers === 0)
  if (empty && envelopeRoot !== null && envelopeRoot !== EMPTY_ROOT) {
    critical.push(
      'Urnan och markeringarna är båda tomma, men kuvertroten är inte den tomma mängdens. Skalningen ' +
        'flyttade alltså kuvert, och både raderna och markeringarna har tagits bort efteråt.',
    )
  }

  return resultOf(
    id,
    question,
    { critical, pending: [] },
    `Varje valsedel har lika många rader i urnan som markeringar: ` +
      `${readings.map((reading) => `${reading.label} ${reading.rows}`).join('; ')}. Kontrollen säger inte ` +
      'att raderna är de flyttade kuverten, det prövar urnroten, och den som kan skriva i båda databaserna ' +
      'kan ändra båda antalen.',
  )
}

/**
 * 4. URNROTEN STÄMMER (punkt 5b, ruling 134). Omskriven ur `matches_commitment`.
 *
 * Skalningen räknade urnroten ur de validerade kuverten och skrev den i
 * röstlängden, i samma sats som STRIPPED, och i posten LINK_CLEARED. Här räknas
 * den om ur urnan, med chifferhashen räknad ur varje rads chiffer, och ska vara
 * densamma, och en post LINK_CLEARED ska bära den. Se src/lib/urn-root.ts.
 *
 * Kuvertroten går inte att räkna om efter skalningen, eftersom signaturerna är
 * raderade, och fram till uppgiften kunde den som skriver i röstdatabasen byta
 * ut en rad mot en ny, självkonsekvent rad med giltiga bevis utan att någonting
 * märkte det. Räkningen prövar samma rot innan något dekrypteras.
 *
 * EN OMRÖSTNING UTAN URNROT är en förutsättning som inte är uppfylld, inte en
 * avvikelse. Den skalades antingen innan roten fanns, eller så har roten tagits
 * bort förbi koden, och det ena går inte att skilja från det andra. Ett
 * oskyldigt val får inte låsas i UNDER_REVIEW (ruling 42), och valet kan inte
 * fastställas i någotdera fallet.
 *
 * VEM DEN INTE SKYDDAR MOT. Den som kan skriva i båda databaserna kan skriva om
 * roten i omröstningens rad och i posten, och räkna om revisionskedjan därifrån.
 */
async function urnRootCheck(
  linked: boolean,
  readings: readonly BallotReading[],
  stored: string | null,
): Promise<CheckResult> {
  const id = 'urn_root_matches'
  const question = 'Är urnan exakt de rader som skalningen flyttade, enligt urnroten?'

  if (linked) return beforeStripping(id, question, 'Urnroten skrivs vid skalningen, och den har inte körts.')

  if (stored === null) {
    return {
      id,
      question,
      severity: 'PRECONDITION',
      passed: false,
      detail:
        'Omröstningen saknar urnrot. Antingen skalades den innan skalningen började skriva en, eller så har ' +
        'roten tagits bort ur röstlängden förbi koden, och det ena går inte att skilja från det andra. Urnan ' +
        'går då inte att pröva mot det som flyttades, så resultatet kan inte fastställas. Valet markeras inte ' +
        'som avvikande för det.',
    }
  }

  const rows = readings.reduce((total, reading) => total + reading.rows, 0)
  const unhashable = readings.flatMap((reading) => reading.unhashable)
  const critical: string[] = []

  if (unhashable.length > 0) {
    critical.push(`${unhashable.length} rader i urnan har inget chiffer som går att hasha: ${listed(unhashable)}.`)
  } else {
    const recomputed = urnRootOf(readings.flatMap((reading) => reading.leaves))
    if (recomputed !== stored) {
      critical.push(
        `Urnroten räknad ur urnan är ${recomputed.slice(0, 16)}…, men skalningen skrev ${stored.slice(0, 16)}… ` +
          'i röstlängden. En rad har lagts till, tagits bort, flyttats till en annan valsedel eller fått ett ' +
          'annat chiffer efter skalningen.',
      )
    } else if (!(await urnRootInAuditChain(stored))) {
      critical.push(
        'Urnroten i röstlängden stämmer med urnan, men ingen post LINK_CLEARED i revisionskedjan bär den. ' +
          'Skalningen skriver roten på båda ställena i samma transaktion, så någon av dem har skrivits förbi ' +
          'koden.',
      )
    }
  }

  return resultOf(
    id,
    question,
    { critical, pending: [] },
    `Urnroten räknad ur de ${rows} raderna i urnan är den som skalningen skrev, i röstlängden och i posten ` +
      'LINK_CLEARED. Den binder valsedel och chifferhash för varje rad, också kopior, så den som bara kan ' +
      'skriva i röstdatabasen kan inte lägga till, ta bort eller flytta en rad, eller byta ut ett chiffer, ' +
      'utan att det syns här. Bevisen ingår inte i roten, dem prövar kontrollen av varje röst. Den som kan ' +
      'skriva i båda databaserna kan skriva om roten och räkna om revisionskedjan.',
  )
}

/**
 * 5. VARJE RÖST VERIFIERAR (punkt 2). Omskriven ur `every_vote_authorised`.
 *
 * VAD DEN PRÖVAR. Varje rad i urnan verifieras som en valsedel för sin valsedel
 * i omröstningen, med `verifyEncryptedBallot` i serverns ingång: att chiffret
 * ger sin chifferhash, att varje tal ligger i gruppens undergrupp, att varje
 * alternativ krypterar 0 eller 1 och att deras produkt krypterar 1, med bevis
 * bundna till omröstningen, valsedeln, valets nyckel och chifferlistan (spec
 * 4.4). En rad med fler röster än en, eller med en negativ röst, underkänns.
 *
 * VEM DEN INTE SKYDDAR MOT. Den gamla kontrollen sa att den inte kunde
 * förfalskas inifrån, och det var fel: valsedlarnas signeringsnycklar låg i
 * röstlängden (granskningen av 11g, E5). Den här säger ingenting om vem som
 * lade en rad. Valets publika nyckel är offentlig, och den som har den kan göra
 * en valsedel som verifierar. Att raderna är de kuvert som validerades och
 * flyttades prövar urnroten, och att varje kuvert lades av sin väljare prövade
 * valideringen medan kopplingen fanns.
 *
 * Verifieringen är inramad vid anropsstället, se `verifiesAsBallot`.
 */
function everyVoteCheck(linked: boolean, readings: readonly BallotReading[]): CheckResult {
  const id = 'every_vote_verifies'
  const question =
    'Är varje rad i urnan en valsedel med exakt ett val, med bevis som håller för omröstningen och valsedeln?'

  if (linked) return beforeStripping(id, question, 'Urnan fylls vid skalningen, och den har inte körts.')

  const rows = readings.reduce((total, reading) => total + reading.rows, 0)
  const notVerifying = readings.flatMap((reading) => reading.notVerifying)
  const critical: string[] = []

  if (notVerifying.length > 0) {
    critical.push(
      `${notVerifying.length} av ${rows} rader i urnan verifierar inte som valsedlar: ${listed(notVerifying)}. ` +
        'Stängningen verifierade varje kuvert innan det flyttades, så raderna, valsedeln eller valets nyckel ' +
        'har ändrats förbi den.',
    )
  }

  return resultOf(
    id,
    question,
    { critical, pending: [] },
    rows === 0
      ? 'Urnan har inga rader att pröva.'
      : `Samtliga ${rows} rader i urnan verifierar: chiffret ger sin chifferhash, varje tal ligger i ` +
          'gruppen, varje alternativ krypterar 0 eller 1 och summan av dem 1, och bevisen är bundna till ' +
          'omröstningen, valsedeln och valets nyckel. Kontrollen säger inte vem som lade en rad: den som har ' +
          'valets publika nyckel kan göra en valsedel som verifierar. Att raderna är de kuvert som validerades ' +
          'och flyttades prövar urnroten.',
  )
}

/** Förtroendepersonernas sparade bidrag för en valsedel, tolkade strikt. Det som inte går att tolka står i `problems`. */
function contributionsFor(
  ballot: BallotReading,
  rows: ReadonlyArray<{ optionIndex: number; trusteeIndex: number; value: string; proof: unknown }>,
  problems: string[],
): Contribution[] {
  const optionCount = ballot.shape?.optionCount ?? 0
  const byTrustee = new Map<number, Contribution>()

  for (const row of rows) {
    let contribution = byTrustee.get(row.trusteeIndex)
    if (!contribution) {
      contribution = {
        trusteeIndex: row.trusteeIndex,
        partials: new Array<PartialDecryption | undefined>(optionCount),
        complete: false,
      }
      byTrustee.set(row.trusteeIndex, contribution)
    }

    if (row.optionIndex < 0 || row.optionIndex >= optionCount) {
      problems.push(
        `${ballot.label}: förtroendeperson ${row.trusteeIndex}:s bidrag har ett alternativ ${row.optionIndex}, ` +
          'som inte finns på valsedeln.',
      )
      continue
    }
    const value = parseElement(row.value)
    const proof = parsePartialDecryptionProof(row.proof)
    if (value === null || proof === null) {
      problems.push(
        `${ballot.label}: förtroendeperson ${row.trusteeIndex}:s bidrag för alternativ ${row.optionIndex} går ` +
          'inte att tolka.',
      )
      continue
    }
    contribution.partials[row.optionIndex] = { trusteeIndex: row.trusteeIndex, value, proof }
  }

  for (const contribution of byTrustee.values()) {
    contribution.complete = [...contribution.partials.keys()].every(
      (index) => contribution.partials[index] !== undefined,
    )
    if (!contribution.complete) {
      problems.push(
        `${ballot.label}: förtroendeperson ${contribution.trusteeIndex}:s bidrag saknar ett eller flera ` +
          'alternativ, fast bidrag sparas hela, i en enda sats.',
      )
    }
  }

  return [...byTrustee.values()].sort((a, b) => a.trusteeIndex - b.trusteeIndex)
}

/** Bevisets prövning, inramad: skräp i databasen blir ett nej och inte en krasch. */
function partialHolds(
  publicShare: bigint,
  sum: Ciphertext,
  partial: PartialDecryption,
  binding: PartialDecryptionBinding,
): boolean {
  try {
    return verifyPartialDecryption(publicShare, sum, partial, binding)
  } catch {
    return false
  }
}

/**
 * 6. VARJE PARTIELL DEKRYPTERING VERIFIERAR (punkt 3). Ny.
 *
 * Varje sparat bidrag prövas mot förtroendepersonens publika andel och mot
 * summan av valsedelns rader i urnan, med beviset som binder valet, valsedeln,
 * alternativet och förtroendepersonen (ruling 133). Räkningen prövade bidraget
 * när det sparades, och en gång till före kombinationen. Här prövas det mot
 * det som ligger i databaserna nu.
 *
 * INTE PÅ TOMMA MÄNGDER. En räknad omröstning ska ha minst två fullständiga
 * bidrag per valsedel. Saknas de har de tagits bort efter räkningen, och det är
 * en avvikelse. Före räkningen är det en förutsättning som inte är uppfylld.
 *
 * VAD DEN INTE SÄGER. Bidragen hör till summan av det som ligger i urnan. Att
 * urnan är de flyttade kuverten prövar urnroten. Och de publika andelarna ligger
 * i röstdatabasen, bredvid bidragen (fixrunda 1, granskningens Mindre 5). Den som
 * byter ut en andel och ett bidrag tillsammans, med ett bevis för den nya
 * andelen, får kontrollen att passera. Bara omräkningen i `tallyCheck` fångar
 * det, eftersom det nya värdet inte kombineras till räkneverken.
 */
function partialsCheck(
  electionId: string,
  counted: boolean,
  readings: readonly BallotReading[],
  contributions: ReadonlyMap<string, { list: Contribution[]; problems: string[] }>,
  shares: ReadonlyArray<{ trusteeIndex: number; publicShare: string }>,
): CheckResult {
  const id = 'partial_decryptions_verify'
  const question =
    'Håller varje förtroendepersons partiella dekryptering mot hennes publika andel och valsedelns summa?'

  const publicShares = new Map(shares.map((share) => [share.trusteeIndex, parseElement(share.publicShare)]))
  const findings: Findings = { critical: [], pending: [] }
  let verified = 0

  for (const reading of readings) {
    const { list, problems } = contributions.get(reading.id)!
    findings.critical.push(...problems)

    for (const contribution of list) {
      const share = publicShares.get(contribution.trusteeIndex) ?? null
      if (share === null || !isInSubgroup(share)) {
        findings.critical.push(
          `${reading.label}: förtroendeperson ${contribution.trusteeIndex} har ingen publik andel i ` +
            'omröstningen som ligger i gruppens undergrupp, så hennes bidrag går inte att pröva.',
        )
        continue
      }
      if (reading.sums === null) {
        findings.critical.push(
          `${reading.label}: summan går inte att räkna, eftersom ${reading.whyNoSum}, och förtroendeperson ` +
            `${contribution.trusteeIndex}:s bidrag går inte att pröva mot den.`,
        )
        continue
      }
      for (const [optionIndex, partial] of contribution.partials.entries()) {
        if (!partial) continue
        const binding = { electionId, ballotId: reading.id, optionIndex }
        if (partialHolds(share, reading.sums[optionIndex]!, partial, binding)) {
          verified += 1
        } else {
          findings.critical.push(
            `${reading.label}: förtroendeperson ${contribution.trusteeIndex}:s bidrag för alternativ ` +
              `${optionIndex} håller inte mot hennes publika andel och valsedelns summa. Det prövades innan ` +
              'det sparades, så bidraget, andelen eller urnan har ändrats förbi räkningen.',
          )
        }
      }
    }

    const complete = list.filter((contribution) => contribution.complete).length
    if (complete < TRUSTEE_THRESHOLD) {
      const have = `${reading.label}: ${complete} av ${TRUSTEE_THRESHOLD} förtroendepersoners bidrag finns.`
      if (counted) {
        findings.critical.push(
          `${have} Omröstningen är räknad, och räkningen kräver ${TRUSTEE_THRESHOLD} bidrag, så bidrag har ` +
            'tagits bort efteråt.',
        )
      } else {
        findings.pending.push(have)
      }
    }
  }

  return resultOf(
    id,
    question,
    findings,
    `Varje valsedel har bidrag från minst ${TRUSTEE_THRESHOLD} förtroendepersoner, och vart och ett av de ` +
      `${verified} värdena håller mot förtroendepersonens publika andel och summan av valsedelns rader i ` +
      'urnan, bundet till valet, valsedeln och alternativet. Kontrollen visar att bidragen hör till summan ' +
      'av det som ligger i urnan, inte att urnan är de flyttade kuverten: det prövar urnroten. De publika ' +
      'andelarna ligger i röstdatabasen, så en andel och ett bidrag som byts ut tillsammans passerar ' +
      'kontrollen. Bara omräkningen av räkneverken fångar det.',
  )
}

/** Räkneverken ur summan och de fullständiga bidragen, med antalet rader som tak, eller null. */
function recount(sums: readonly Ciphertext[], usable: readonly Contribution[], rows: number): number[] | null {
  try {
    return sums.map((sum, optionIndex) =>
      discreteLog(
        combine(sum, usable.map((contribution) => contribution.partials[optionIndex]!)),
        rows,
      ),
    )
  } catch {
    return null
  }
}

/**
 * 7. RÄKNINGEN STÄMMER (punkt 4). Omskriven ur `tally_matches_ballots`.
 *
 * Räkneverken per valsedel ska summera till antalet rader i urnan, eftersom
 * varje röst kodar exakt ett alternativ, också blankt. Och en ny kombination av
 * de sparade bidragen, med summan ur urnan och antalet rader som tak för den
 * diskreta logaritmen, ska ge exakt de sparade talen. Två räkneverk som bytt
 * plats har samma summa, och bara omräkningen visar dem.
 *
 * Kombinationen använder bidragens värden och inte deras bevis. Bevisen prövas
 * av kontrollen ovan, så att ett ändrat bevis och ett ändrat tal syns var för
 * sig.
 *
 * INTE PÅ TOMMA MÄNGDER. En räknad omröstning ska ha räkneverk för varje
 * valsedel, och en valsedel utan dem är en avvikelse. En valsedel utan röster
 * har räkneverk med nollor.
 */
function tallyCheck(
  counted: boolean,
  readings: readonly BallotReading[],
  contributions: ReadonlyMap<string, { list: Contribution[]; problems: string[] }>,
  tallies: ReadonlyArray<{ ballotId: string; optionIndex: number; count: number }>,
): CheckResult {
  const id = 'tally_matches'
  const question = 'Stämmer de sparade räkneverken med urnan och förtroendepersonernas bidrag?'
  const findings: Findings = { critical: [], pending: [] }

  for (const reading of readings) {
    const rows = tallies.filter((tally) => tally.ballotId === reading.id)
    if (rows.length === 0) {
      if (counted) findings.critical.push(`${reading.label} saknar räkneverk fast omröstningen är räknad.`)
      else findings.pending.push(`${reading.label} är inte räknad än.`)
      continue
    }

    const optionCount = reading.shape?.optionCount
    const complete =
      optionCount !== undefined &&
      rows.length === optionCount &&
      rows.every((row, index) => row.optionIndex === index && Number.isSafeInteger(row.count) && row.count >= 0)
    if (!complete) {
      findings.critical.push(
        `${reading.label}: de sparade räkneverken är ofullständiga eller har fel form. De sparas alltid hela, ` +
          'en rad per alternativ.',
      )
      continue
    }

    const counts = rows.map((row) => row.count)
    const total = counts.reduce((sum, count) => sum + count, 0)
    if (total !== reading.rows) {
      findings.critical.push(
        `${reading.label}: räkneverken summerar till ${total}, men urnan har ${reading.rows} rader för ` +
          'valsedeln. Varje röst kodar exakt ett alternativ, också blankt, så de två ska vara lika.',
      )
      continue
    }

    const usable = contributions.get(reading.id)!.list.filter((contribution) => contribution.complete)
    if (usable.length < TRUSTEE_THRESHOLD) {
      findings.critical.push(
        `${reading.label}: räkneverken finns, men bara ${usable.length} fullständiga bidrag, så de går inte ` +
          'att räkna om.',
      )
      continue
    }
    if (reading.sums === null) {
      findings.critical.push(`${reading.label}: räkneverken går inte att räkna om, eftersom ${reading.whyNoSum}.`)
      continue
    }

    const recounted = recount(reading.sums, usable, reading.rows)
    if (recounted === null) {
      findings.critical.push(
        `${reading.label}: en ny kombination av de sparade bidragen ger inte en summa i [0, ${reading.rows}] ` +
          'för varje alternativ.',
      )
    } else if (!recounted.every((count, index) => count === counts[index])) {
      findings.critical.push(
        `${reading.label}: en ny kombination av de sparade bidragen ger inte de sparade räkneverken. ` +
          'Räkneverken, bidragen eller urnan har ändrats förbi räkningen.',
      )
    }
  }

  return resultOf(
    id,
    question,
    findings,
    'Varje valsedels räkneverk summerar till antalet rader i urnan, och en ny kombination av de sparade ' +
      'bidragen ger exakt de sparade talen.',
  )
}

/**
 * 9. INGEN MARKERAD AVVIKELSE (ny, uppgift 12b).
 *
 * En slutkontroll som hittar en avvikelse markerar omröstningen UNDER_REVIEW,
 * och markeringen går inte att lämna via applikationen. Fram till uppgiften
 * fastställde `certifyElection` ändå ett markerat val, om kontrollerna senare
 * gick igenom, och markeringen skrevs över. Nu är markeringen en kontroll för
 * sig, så att den syns i rapporten och stoppar fastställandet.
 *
 * VAD DEN PRÖVAR, OCH VAD DEN INTE PRÖVAR (fixrunda 1, granskningens Mindre 2).
 * Kontrollen läser markeringen i röstdatabasen, och inget annat. Den som kan
 * skriva där kan ta bort markeringen, och då passerar kontrollen, men ingen
 * annan kontroll passerar för det. Den gamla texten sa att ingen tidigare
 * slutkontroll hade markerat omröstningen, och det kan kontrollen inte veta.
 * När fastställandet markerar en omröstning skriver det sedan fixrundan också
 * en post i revisionskedjan i röstlängden, så att en borttagen markering syns
 * där, se `markUnderReview`.
 */
function underReviewCheck(underReview: boolean): CheckResult {
  const id = 'not_under_review'
  const question = 'Saknar röstdatabasen en markering om avvikelse från en tidigare slutkontroll?'
  const stored =
    'Markeringen står i röstdatabasen, och den som kan skriva där kan ta bort den. När en slutkontroll ' +
    'markerar en omröstning skrivs också en post i revisionskedjan i röstlängden, så att en borttagen ' +
    'markering syns där. Posten säger inte vilken omröstning det gällde.'

  return underReview
    ? {
        id,
        question,
        severity: 'CRITICAL',
        passed: false,
        detail:
          'Röstdatabasen bär markeringen UNDER_REVIEW: en tidigare slutkontroll fann en avvikelse och ' +
          'markerade omröstningen för granskning. Resultatet fastställs inte så länge markeringen står kvar, ' +
          `och den går bara att ta bort utanför appen, när avvikelsen är utredd. ${stored}`,
      }
    : {
        id,
        question,
        severity: 'CRITICAL',
        passed: true,
        detail: `Röstdatabasen bär ingen markering om avvikelse. ${stored}`,
      }
}

// ---------------------------------------------------------------------------
// Fastställandet
// ---------------------------------------------------------------------------

export type CertifyOutcome =
  | { status: 'certified'; report: FinalCheckReport }
  /** En kritisk kontroll fallerade. Omröstningen är nu markerad som avvikande. */
  | { status: 'blocked'; report: FinalCheckReport }
  /** Förutsättningarna är inte uppfyllda än. Ingenting har markerats. */
  | { status: 'not_ready'; report: FinalCheckReport }
  | { status: 'unknown_election' }
  | { status: 'already_certified'; report: FinalCheckReport }

/**
 * Fastställer ett valresultat.
 *
 * SPÄRREN GÅR INTE ATT KRINGGÅ FRÅN ADMINVYN.
 *
 * Funktionen kör slutkontrollen på nytt — den litar inte på en rapport som
 * klienten skickar med, och tar inte emot någon parameter för att tvinga
 * igenom ett resultat. Administratören kan alltså inte fastställa ett val vars
 * kontroller fallerar, oavsett vad gränssnittet visar eller vilka anrop som
 * skickas.
 *
 * Misslyckas någon kritisk kontroll sätts omröstningen i UNDER_REVIEW. Det är
 * ett tillstånd som kräver mänsklig granskning och som inte går att lämna via
 * applikationen — avsiktligt, eftersom en knapp som återställer ett avvikande
 * val till normalt vore samma sak som ingen spärr alls. Sedan uppgift 12b
 * stoppar markeringen också fastställandet, se `underReviewCheck`.
 *
 * CERTIFIED SKRIVS MED JÄMFÖR-OCH-SÄTT FRÅN TALLIED, I SAMMA TRANSAKTION SOM
 * REVISIONSPOSTEN (uppgift 12b, spec 6.1). Fasen skrivs bara om den står kvar i
 * TALLIED med båda rötterna skrivna, alltså i den fas slutkontrollen läste
 * först. En fas som ändrats under tiden skrivs inte över, och av två samtidiga
 * fastställanden skriver ett CERTIFIED och det andra finner fasen redan där. Går
 * posten ELECTION_CERTIFIED inte att skriva förs fasen tillbaka, så att den ena
 * aldrig finns utan den andra.
 *
 * Det gamla flödets fastställande publicerade ett sista åtagande över tabellen
 * vote och satte ett statusfält i röstdatabasen. Tabellen är tom i
 * kuvertmodellen, och fastställandet är fasen i röstlängden. Statusfältet bär
 * nu bara markeringen UNDER_REVIEW.
 */
export async function certifyElection(electionId: string): Promise<CertifyOutcome> {
  const report = await runFinalCheck(electionId)
  if (!report) return { status: 'unknown_election' }

  if (report.phase === 'CERTIFIED') return { status: 'already_certified', report }

  if (!report.canCertify) return refuse(electionId, report)

  if (await writeCertified(electionId)) {
    return { status: 'certified', report: { ...report, phase: 'CERTIFIED', status: 'CERTIFIED' } }
  }

  /**
   * Fasen hade ändrats när jämför-och-sätt kom fram. En annan anropare kan ha
   * fastställt valet, eller så har fasen skrivits förbi koden. Kontrollen körs
   * om, och svaret följer den nya rapporten som i huvudvägen: en avvikelse
   * markerar valet (fixrunda 1, granskningens Mindre 3 och prob P6a). Förut
   * svarade grenen `not_ready` också på en avvikelse, utan att markera något.
   */
  const now = await runFinalCheck(electionId)
  if (!now) return { status: 'unknown_election' }
  if (now.phase === 'CERTIFIED') return { status: 'already_certified', report: now }
  return refuse(electionId, now)
}

/**
 * Ett val som inte kan fastställas.
 *
 * BARA EN VERKLIG AVVIKELSE MARKERAR OMRÖSTNINGEN.
 *
 * Har en KRITISK kontroll fallerat stämmer inte underlaget, och det ska synas
 * som avvikande för alla som tittar efteråt — inte bara för den administratör
 * som råkade trycka på knappen.
 *
 * Är det däremot bara en FÖRUTSÄTTNING som inte är uppfylld — omröstningen
 * pågår, är inte skalad eller inte räknad — avvisas begäran utan att något
 * markeras. En administratör som trycker för tidigt ska inte kunna göra valet
 * omöjligt att fastställa (ruling 42).
 */
async function refuse(electionId: string, report: FinalCheckReport): Promise<CertifyOutcome> {
  if (report.anomalous) {
    await markUnderReview(electionId)
    return { status: 'blocked', report: { ...report, status: 'UNDER_REVIEW' } }
  }
  return { status: 'not_ready', report }
}

/**
 * Markerar omröstningen som avvikande, och skriver en post om det i
 * revisionskedjan (fixrunda 1, granskningens Mindre 2).
 *
 * Markeringen står i röstdatabasen, där den som kan skriva kan ta bort den
 * utan att något märks. Posten ELECTION_UNDER_REVIEW står i röstlängdens kedja,
 * så att en borttagen markering syns där. Den skrivs bara när markeringen
 * sätts, inte vid varje nytt försök att fastställa ett redan markerat val.
 * Posten har inget omröstnings-id, som ingen post i kedjan har, så den säger
 * att en omröstning markerades och vilken timme, inte vilken.
 *
 * Markeringen skrivs först och posten sedan. Dör processen mellan dem finns
 * markeringen utan post, och ett nytt försök skriver ingen, eftersom valet redan
 * är markerat.
 */
async function markUnderReview(electionId: string): Promise<void> {
  const marked = await votesDb.election.updateMany({
    where: { id: electionId, status: { not: 'UNDER_REVIEW' } },
    data: { status: 'UNDER_REVIEW' },
  })
  if (marked.count === 1) await recordAuditEvent(AUDIT_EVENTS.ELECTION_UNDER_REVIEW)
}

/**
 * CERTIFIED MED JÄMFÖR-OCH-SÄTT, I SAMMA TRANSAKTION SOM POSTEN.
 *
 * Svarar sant om fasen skrevs, och falskt om den inte stod i TALLIED med båda
 * rötterna skrivna.
 *
 * INGEN ANNAN POST KAN TA LÖPNUMRET (fixrunda 1, granskningens Mindre 4 och
 * prob P4c). Posten tar nästa löpnummer i kedjan. Skrevs en annan post, till
 * exempel om en inloggning, mellan att transaktionen läste det senaste numret
 * och skrev sitt, avvisade det unika indexet posten med P2002, PostgreSQL
 * avbröt transaktionen, och nästa läsning svarade 25P02. Fastställandet kastade,
 * och rutten svarade 500 fast ingenting var fel. Skrivningen var ändå odelbar.
 *
 * Därför låses tabellen audit_event mot andra skrivare, efter jämför-och-sätt
 * och före posten, till transaktionens slut. Låset väntar in en post som redan
 * skrivs, och håller nästa post borta tills fasen och posten är skrivna. Andra
 * läsare påverkas inte. Det täcker varje skrivare, också posterna om
 * inloggning, som räkningens lås för revisionsposter inte gör. Att bara försöka
 * igen räckte inte: under granskarens ström av poster krockade fem försök av
 * fem. Låset tas efter jämför-och-sätt, i samma ordning som skalningen och
 * räkningen tar omröstningens rad och sedan skriver sin post.
 *
 * READ COMMITTED, UTTRYCKLIGEN. Läsningen av det senaste numret görs efter att
 * låset tagits och ska se en post som gjorde COMMIT medan låset väntade. Under
 * REPEATABLE READ hade den sett kedjan som den stod vid transaktionens första
 * sats, och krockat ändå.
 */
async function writeCertified(electionId: string): Promise<boolean> {
  return votersDb.$transaction(
    async (tx) => {
      const cas = await tx.election.updateMany({
        where: { id: electionId, phase: 'TALLIED', envelopeRoot: { not: null }, urnRoot: { not: null } },
        data: { phase: 'CERTIFIED' },
      })
      if (cas.count !== 1) return false
      await tx.$queryRaw`LOCK TABLE audit_event IN SHARE ROW EXCLUSIVE MODE`
      await recordAuditEvent(AUDIT_EVENTS.ELECTION_CERTIFIED, tx)
      return true
    },
    { isolationLevel: 'ReadCommitted' },
  )
}
