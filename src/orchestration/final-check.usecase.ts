import { verify } from '@/lib/blind-signature'
import { canonicalVoteRecord, hashLeaf, merkleRoot } from '@/lib/merkle'
import { votesDb } from '@/modules/ballot-box/db'
import {
  getElection,
  getElectionResults,
} from '@/modules/ballot-box'
import {
  commitCurrentState,
  latestCommitment,
  verifyCommitmentChain,
} from '@/modules/ballot-box/commitment.service'
import { countIssuedCredentials } from '@/modules/eligibility/credential.service'
import { verifyAuditChain } from '@/modules/eligibility/audit.service'

/**
 * DEN AUTOMATISKA SLUTKONTROLLEN
 *
 * Systemet ska inte bara producera ett resultat — det ska kunna visa varför
 * resultatet kan anses vara korrekt. Den här filen är där det avgörs.
 *
 * Kontrollen körs innan ett resultat får fastställas, och den kan inte
 * kringgås från adminvyn: fastställandet anropar samma funktion och vägrar om
 * någon KRITISK kontroll fallerar. Det finns ingen parameter för att tvinga
 * igenom ett resultat, och det är avsiktligt — en sådan parameter vore exakt
 * det som gör alla andra kontroller meningslösa.
 *
 * VARFÖR FILEN FÅR SE BÅDA DATABASERNA
 *
 * Den läser ANTAL från röstlängden och ANTAL plus röstinnehåll från
 * röstdatabasen. Den läser aldrig en enskild väljare, och kan inte para ihop
 * de två sidorna ens om den ville: det finns ingen gemensam identifierare
 * mellan en väljarrad och en röstrad. Att jämföra "sex godkända röstningar mot
 * sex registrerade röster" avslöjar ingenting om vem som röstade på vad.
 *
 * Filen står därför på undantagslistan i modulgränstestet, med samma
 * motivering som adminstatistiken.
 */

/**
 * TRE KLASSER, OCH SKILLNADEN ÄR AVGÖRANDE.
 *
 *  – CRITICAL: något stämmer inte i underlaget. Röster utan intyg, en bruten
 *    kedja, en rot som inte matchar. Det är tecken på fel eller manipulation,
 *    och omröstningen ska då markeras som avvikande.
 *
 *  – PRECONDITION: valet är inte klart att fastställas än. Omröstningen är
 *    fortfarande öppen, eller inget åtagande har publicerats. Ingenting är fel
 *    — det är bara för tidigt.
 *
 *  – WARNING: värt att förstå innan man fastställer, men inte ett hinder.
 *
 * Distinktionen mellan de två första finns för att ett förhastat klick inte
 * ska förstöra valet. UNDER_REVIEW går inte att lämna via applikationen, och
 * skulle "omröstningen är öppen" räknas som en avvikelse hade en administratör
 * som tryckte en dag för tidigt gjort valet omöjligt att fastställa över
 * huvud taget.
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
  merkleRoot: string
  voteCount: number
  ranAt: string
}

/**
 * Kör hela slutkontrollen.
 *
 * Ingen kontroll är beroende av en annans resultat — alla körs alltid, så att
 * rapporten visar ALLA avvikelser på en gång. En kontroll som avbryter vid
 * första felet skulle dölja att det finns fler, och den som granskar behöver
 * se hela bilden innan hen bedömer om det rör sig om ett fel eller ett angrepp.
 */
export async function runFinalCheck(electionId: string): Promise<FinalCheckReport | null> {
  const election = await getElection(electionId)
  if (!election) return null

  const checks: CheckResult[] = []

  // --- Underlaget --------------------------------------------------------
  const votes = await votesDb.vote.findMany({
    where: { ballot: { electionId } },
    select: {
      tokenHash: true,
      credentialId: true,
      credentialSignature: true,
      ballotId: true,
      ballotPartyId: true,
      candidateId: true,
      optionId: true,
      ballot: { select: { signingPublicKeyPem: true } },
    },
  })

  const issued = await countIssuedCredentials(electionId)
  const issuedByBallot = new Map(issued.map((row) => [row.ballotId, row.issued]))

  const votesByBallot = new Map<string, number>()
  for (const vote of votes) {
    votesByBallot.set(vote.ballotId, (votesByBallot.get(vote.ballotId) ?? 0) + 1)
  }

  // --- 1. Varje godkänd röstning motsvarar exakt en registrerad röst ------
  {
    const mismatches: string[] = []

    for (const ballot of election.ballots) {
      const approved = issuedByBallot.get(ballot.id) ?? 0
      const recorded = votesByBallot.get(ballot.id) ?? 0

      if (approved !== recorded) {
        mismatches.push(
          `${ballot.label}: ${approved} godkända röstningar men ${recorded} registrerade röster ` +
            `(differens ${approved - recorded}).`,
        )
      }
    }

    checks.push({
      id: 'approved_matches_recorded',
      question: 'Motsvarar varje godkänd röstning exakt en registrerad röst?',
      severity: 'CRITICAL',
      passed: mismatches.length === 0,
      detail:
        mismatches.length === 0
          ? 'Antalet godkända röstningar och registrerade röster stämmer på varje valsedel.'
          : mismatches.join(' ') +
            ' En positiv differens betyder utfärdade röstintyg som aldrig lösts in — ' +
            'antingen avbrutna röstningar eller förlorade röster. En negativ differens ' +
            'betyder röster utan motsvarande godkännande, vilket inte ska kunna inträffa.',
    })
  }

  // --- 2. Varje röst bär ett äkta röstintyg -------------------------------
  {
    /**
     * DETTA ÄR KONTROLLEN SOM INTE KAN FÖRFALSKAS INIFRÅN.
     *
     * Övriga kontroller jämför siffror i databaser. Den här verifierar en
     * kryptografisk signatur som bara kan ha skapats med valsedelns privata
     * nyckel. Den som lagt till en röst direkt i databasen kan inte få den
     * att passera, och en observatör kan köra exakt samma kontroll själv med
     * den publika nyckeln.
     */
    const invalid = votes.filter(
      (vote) =>
        !verify(vote.credentialId, vote.credentialSignature, vote.ballot.signingPublicKeyPem),
    )

    checks.push({
      id: 'every_vote_authorised',
      question: 'Har varje registrerad röst skapats genom den auktoriserade processen?',
      severity: 'CRITICAL',
      passed: invalid.length === 0,
      detail:
        invalid.length === 0
          ? `Samtliga ${votes.length} röster bär ett röstintyg signerat av valsedelns nyckel.`
          : `${invalid.length} av ${votes.length} röster saknar giltigt röstintyg. ` +
            'En röst utan giltigt intyg har inte skapats genom röstningsprocessen.',
    })
  }

  // --- 3. Inga röstintyg har använts mer än en gång -----------------------
  {
    const unique = new Set(votes.map((vote) => vote.credentialId))

    checks.push({
      id: 'no_reused_credentials',
      question: 'Har något röstintyg lösts in mer än en gång?',
      severity: 'CRITICAL',
      passed: unique.size === votes.length,
      detail:
        unique.size === votes.length
          ? 'Varje röstintyg förekommer exakt en gång.'
          : `${votes.length - unique.size} röster delar röstintyg med en annan röst. ` +
            'Databasens unika index ska göra detta omöjligt — inträffar det har ' +
            'någon skrivit direkt i databasen.',
    })
  }

  // --- 4. Röstunderlaget stämmer med det senaste åtagandet ----------------
  {
    const leaves = votes.map((vote) => hashLeaf(canonicalVoteRecord(vote)))
    const root = merkleRoot(leaves)
    const commitment = await latestCommitment(electionId)

    /**
     * Två olika utfall, två olika klasser.
     *
     * Saknas ett åtagande helt är det en FÖRUTSÄTTNING som inte är uppfylld —
     * ingen har gjort något fel, det finns bara inget att jämföra mot än.
     * Finns ett åtagande men roten skiljer sig är det en AVVIKELSE: underlaget
     * har ändrats efter att åtagandet publicerades.
     */
    if (commitment === null) {
      checks.push({
        id: 'matches_commitment',
        question: 'Har någon röst ändrats eller tagits bort sedan det senaste åtagandet?',
        severity: 'PRECONDITION',
        passed: false,
        detail:
          'Inget åtagande har publicerats. Utan ett åtagande finns ingenting att ' +
          'jämföra mot, och manipulation av röstunderlaget kan inte uteslutas. ' +
          'Publicera ett åtagande och kör kontrollen igen.',
      })
    } else {
      checks.push({
        id: 'matches_commitment',
        question: 'Har någon röst ändrats eller tagits bort sedan det senaste åtagandet?',
        severity: 'CRITICAL',
        passed: commitment.root === root,
        detail:
          commitment.root === root
            ? `Merkleroten stämmer med åtagande #${commitment.sequence} ` +
              `(${commitment.voteCount} röster).`
            : `Merkleroten ${root.slice(0, 16)}… stämmer inte med åtagande ` +
              `#${commitment.sequence} (${commitment.root.slice(0, 16)}…). ` +
              'Röstunderlaget har ändrats efter att åtagandet publicerades.',
      })
    }
  }

  // --- 5. Åtagandekedjan är obruten ---------------------------------------
  {
    const chain = await verifyCommitmentChain(electionId)

    checks.push({
      id: 'commitment_chain_intact',
      question: 'Är kedjan av publicerade åtaganden obruten?',
      severity: 'CRITICAL',
      passed: chain.intact,
      detail: chain.intact
        ? `${chain.commitments} åtaganden bildar en obruten kedja.`
        : `Kedjan bryts vid åtagande #${chain.brokenAtSequence}: ${chain.reason}`,
    })
  }

  // --- 6. Revisionskedjan är obruten --------------------------------------
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

  // --- 7. Sammanräkningen stämmer med underlaget --------------------------
  {
    /**
     * RÄKNAR OM RESULTATET FRÅN RÅDATA.
     *
     * Kontrollen litar inte på den aggregering som adminvyn visar, utan räknar
     * fram summorna på nytt ur de enskilda rösterna och jämför. Går de isär är
     * antingen aggregeringen fel eller underlaget ändrat mellan de två
     * läsningarna.
     */
    const results = await getElectionResults(electionId)
    const mismatches: string[] = []

    for (const ballot of results) {
      const recounted = votes.filter((vote) => vote.ballotId === ballot.ballotId).length
      const summed = ballot.rows.reduce((total, row) => total + row.votes, 0)

      if (ballot.totalVotes !== recounted) {
        mismatches.push(
          `${ballot.ballot}: redovisat ${ballot.totalVotes} röster, omräkning ger ${recounted}.`,
        )
      }

      if (summed !== recounted) {
        mismatches.push(
          `${ballot.ballot}: summan av alternativen är ${summed} men ${recounted} röster finns. ` +
            'Skillnaden är röster på alternativ som inte längre står på valsedeln.',
        )
      }
    }

    checks.push({
      id: 'tally_matches_ballots',
      question: 'Stämmer det sammanräknade resultatet med det registrerade röstunderlaget?',
      severity: 'CRITICAL',
      passed: mismatches.length === 0,
      detail:
        mismatches.length === 0
          ? 'Omräkning ur de enskilda rösterna ger samma resultat som redovisas.'
          : mismatches.join(' '),
    })
  }

  // --- 8. Omröstningen är stängd ------------------------------------------
  {
    const closed = election.closesAt <= new Date()

    checks.push({
      id: 'election_closed',
      question: 'Är omröstningen stängd?',
      // FÖRUTSÄTTNING, inte avvikelse. Att valet pågår är normalt.
      severity: 'PRECONDITION',
      passed: closed,
      detail: closed
        ? `Omröstningen stängde ${election.closesAt.toISOString()}.`
        : `Omröstningen är öppen till ${election.closesAt.toISOString()}. ` +
          'Ett resultat får inte fastställas medan röster fortfarande kan tillkomma.',
    })
  }

  // --- 9. Utestående röstintyg (varning, inte kritiskt) -------------------
  {
    /**
     * VARFÖR DETTA ÄR EN VARNING OCH INTE ETT KRITISKT FEL
     *
     * Ett utfärdat men aldrig inlöst intyg betyder oftast att någon avbröt
     * mitt i. Det är helt normalt och ska inte hindra att ett val fastställs.
     *
     * Men det är också vad en förlorad röst ser ut som, och skillnaden går
     * inte att avgöra maskinellt: systemet kan inte veta om väljaren ändrade
     * sig eller om något gick sönder. Därför redovisas antalet tydligt i
     * stället för att döljas, så att den som granskar kan bedöma om det är
     * rimligt.
     *
     * Notera att kontroll 1 ändå är kritisk. Den fångar varje differens; den
     * här skiljer ut vilken sorts differens det rör sig om.
     */
    const outstanding = election.ballots.reduce((total, ballot) => {
      const approved = issuedByBallot.get(ballot.id) ?? 0
      const recorded = votesByBallot.get(ballot.id) ?? 0
      return total + Math.max(0, approved - recorded)
    }, 0)

    checks.push({
      id: 'outstanding_credentials',
      question: 'Finns utfärdade röstintyg som aldrig lösts in?',
      severity: 'WARNING',
      passed: outstanding === 0,
      detail:
        outstanding === 0
          ? 'Samtliga utfärdade röstintyg är inlösta.'
          : `${outstanding} utfärdade röstintyg är inte inlösta. Det är normalt när ` +
            'väljare avbryter mitt i, men ser likadant ut som en förlorad röst. ' +
            'Bedöm om antalet är rimligt i förhållande till valdeltagandet.',
    })
  }

  const leaves = votes.map((vote) => hashLeaf(canonicalVoteRecord(vote)))
  const order: Record<CheckSeverity, number> = { CRITICAL: 0, PRECONDITION: 1, WARNING: 2 }

  const failures = checks
    .filter((check) => !check.passed)
    .sort((a, b) => order[a.severity] - order[b.severity])

  const anomalous = checks.some((check) => check.severity === 'CRITICAL' && !check.passed)

  return {
    electionId,
    electionName: election.name,
    status: await currentStatus(electionId),
    checks,
    canCertify: checks.every((check) => check.severity === 'WARNING' || check.passed),
    anomalous,
    failures,
    merkleRoot: merkleRoot(leaves),
    voteCount: votes.length,
    ranAt: new Date().toISOString(),
  }
}

async function currentStatus(electionId: string): Promise<string> {
  const row = await votesDb.election.findUnique({
    where: { id: electionId },
    select: { status: true },
  })
  return row?.status ?? 'OKÄND'
}

export type CertifyOutcome =
  | { status: 'certified'; report: FinalCheckReport; commitmentSequence: number }
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
 * val till normalt vore samma sak som ingen spärr alls.
 *
 * Vid godkänt publiceras ett sista åtagande före fastställandet. Det knyter det
 * fastställda resultatet till exakt det röstunderlag som granskades, så att en
 * senare ändring blir upptäckbar även efter att valet avslutats.
 */
export async function certifyElection(electionId: string): Promise<CertifyOutcome> {
  const existing = await votesDb.election.findUnique({
    where: { id: electionId },
    select: { status: true },
  })

  if (!existing) return { status: 'unknown_election' }

  const report = await runFinalCheck(electionId)
  if (!report) return { status: 'unknown_election' }

  if (existing.status === 'CERTIFIED') {
    return { status: 'already_certified', report }
  }

  if (!report.canCertify) {
    /**
     * BARA EN VERKLIG AVVIKELSE MARKERAR OMRÖSTNINGEN.
     *
     * Har en KRITISK kontroll fallerat stämmer inte underlaget, och det ska
     * synas som avvikande för alla som tittar efteråt — inte bara för den
     * administratör som råkade trycka på knappen.
     *
     * Är det däremot bara en FÖRUTSÄTTNING som inte är uppfylld — omröstningen
     * pågår, eller inget åtagande är publicerat — avvisas begäran utan att
     * något markeras. UNDER_REVIEW går inte att lämna via applikationen, och en
     * administratör som trycker en dag för tidigt ska inte kunna göra valet
     * omöjligt att fastställa.
     */
    if (report.anomalous) {
      await votesDb.election.update({
        where: { id: electionId },
        data: { status: 'UNDER_REVIEW' },
      })

      return { status: 'blocked', report: { ...report, status: 'UNDER_REVIEW' } }
    }

    return { status: 'not_ready', report }
  }

  const commitment = await commitCurrentState(electionId)

  await votesDb.election.update({
    where: { id: electionId },
    data: { status: 'CERTIFIED', certifiedAt: new Date() },
  })

  return {
    status: 'certified',
    report: { ...report, status: 'CERTIFIED' },
    commitmentSequence: commitment.sequence,
  }
}
