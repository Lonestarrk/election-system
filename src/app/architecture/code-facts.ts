/**
 * VAD ARKITEKTURSIDAN PÅSTÅR OM KODEN I DAG, MED MARKÖRER.
 *
 * Sidan beskriver en modell som är halvvägs byggd. En del av det den säger
 * handlar därför om kodens nuvarande läge: att röstsidan fortfarande kör det
 * gamla flödet, att dekrypteringen inte är byggd, vilka faser som faktiskt
 * skrivs, hur tidsstämplar lagras. Sådana påståenden blir fel av sig själva i
 * samma stund som en senare uppgift ändrar något, och den som ändrar det har
 * ingen anledning att öppna arkitektursidan.
 *
 * Lösningen är densamma som i src/lib/known-limitations.ts. Varje påstående
 * bär en eller flera markörer i källkoden som är sanna SÅ LÄNGE påståendet är
 * sant, och tests/security/architecture-page.test.ts går rött när en markör
 * inte längre håller. Sidan läser texterna härifrån och skriver dem inte
 * själv, så det finns en enda plats att rätta. Det som står på sidan utan att
 * komma härifrån är design, och står som design.
 *
 * Två sorters markörer:
 *
 *   { file, contains }     sann så länge filen innehåller strängen.
 *   { nowhereIn, matches } sann så länge ingen fil under sökvägen (en katalog
 *                          eller en enskild fil) matchar mönstret. För
 *                          påståenden om att något INTE finns.
 *
 * Radslut normaliseras till \n innan markörerna prövas, eftersom arbetskopian
 * på Windows har CRLF.
 *
 * Filen importeras både av sidan och av livevyn i webbläsaren, och får därför
 * inte importera något själv.
 */

export type Marker = { file: string; contains: string } | { nowhereIn: string; matches: RegExp }

export type CodeFact = {
  /** Påståendet, som det står på sidan. */
  text: string
  /** En kortare form, där sidan bara har plats för några ord. */
  short?: string
  holdsWhile: Marker[]
}

// ---------------------------------------------------------------------------
// Markörer som flera påståenden delar
// ---------------------------------------------------------------------------

/**
 * Ingen kod skriver några partiella dekrypteringar eller räkneverk.
 *
 * Mönstret gäller skrivningar, inte läsningar: livevyn läser båda tabellerna
 * med `findMany`, och det ska inte räknas som att dekrypteringen finns.
 */
const DECRYPTION_NOT_BUILT: Marker = {
  nowhereIn: 'src',
  matches: /\b(partialDecryption|ballotTally)\.(create|createMany|upsert)\(/,
}

/**
 * Röstsidan anropar det gamla flödets rutt och inte kuvertmodellens, och det
 * gamla flödet har de två egenskaper sidan säger att det har: en röst per
 * väljare och valsedel, och ett kvitto som visar valet.
 */
const VOTE_PAGE_OLD_FLOW: Marker[] = [
  { file: 'src/app/vote/page.tsx', contains: "fetch('/api/vote/cast'" },
  { nowhereIn: 'src/app/vote', matches: /\/api\/vote\/encrypted/ },
  // Dubbelröstningsspärren: ett röstintyg per väljare och valsedel.
  { file: 'src/modules/eligibility/credential.service.ts', contains: 'tx.voterBallotStatus.create' },
  // Verifieringen svarar med valet, och det är vad som gör kvittot till ett bevis.
  { file: 'src/modules/ballot-box/vote.service.ts', contains: 'choice: string' },
]

/** Raden i pending_vote raderas vid stängningen, med signatur och räknare. */
const STRIPPING_DELETES_ENVELOPES: Marker = {
  file: 'src/modules/eligibility/pending-vote.service.ts',
  contains: 'client.pendingVote.deleteMany(',
}

/**
 * SKALNINGENS TRANSAKTION, ORD FÖR ORD.
 *
 * Spec 3.1 punkt 6 säger att markeringen "har röstat" skrivs i skalningens
 * transaktion, och uppgift 11d ska bygga den. Markören som fanns före den här
 * letade bara efter två namn, `voterBallotStatus` och `markBallotAsVoted`, i
 * tre filer. En markering i en ny modell, eller via en ny hjälpfunktion, hade
 * gått förbi den, och påståendet att ingenting markerar en kuvertröst hade
 * stått kvar grönt när det blivit falskt.
 *
 * Markören låser därför transaktionens hela text, kommentarerna inräknade. En
 * ny rad var som helst i den, en skrivning eller ett anrop med `tx`, fäller
 * påståendet. En ändrad kommentar fäller det också, i onödan, och det är priset
 * för att ingen skrivning kan glida förbi. Exporteras för testet som visar att
 * markören faktiskt slår fel.
 */
export const STRIPPING_TRANSACTION: Marker = {
  file: 'src/orchestration/close-election.usecase.ts',
  contains: [
    '      async (tx) => {',
    '        // Skriv-en-gång: en redan publicerad rot får aldrig ersättas.',
    '        // `updateMany` och inte `update`, eftersom en träfflös `update` kastar',
    '        // — här ska en redan satt rot hoppas över, inte fälla körningen.',
    '        await tx.election.updateMany({',
    '          where: { id: electionId, envelopeRoot: null },',
    '          data: { envelopeRoot },',
    '        })',
    '',
    '        const removed = await clearPendingVotes(electionId, tx)',
    '',
    '        await tx.election.update({',
    '          where: { id: electionId },',
    "          data: { phase: 'STRIPPED', linkClearedAt: new Date() },",
    '        })',
    '',
    '        await recordAuditEvent(AUDIT_EVENTS.LINK_CLEARED, tx)',
    '',
    '        return removed',
    '      },',
  ].join('\n'),
}

/**
 * De två funktioner transaktionen lämnar `tx` till, låsta på samma sätt.
 *
 * `clearPendingVotes` låses ord för ord, och båda klienttyperna låses: en
 * funktion som bara får `pendingVote` och `electionBallot`, respektive
 * `auditEvent`, kan inte skriva i någon annan tabell genom transaktionen utan
 * att typen ändras först.
 */
export const STRIPPING_HELPERS: Marker[] = [
  {
    file: 'src/modules/eligibility/pending-vote.service.ts',
    contains: [
      'export async function clearPendingVotes(',
      '  electionId: string,',
      '  client: PendingVoteClient = votersDb,',
      '): Promise<number> {',
      '  const ballots = await client.electionBallot.findMany({',
      '    where: { electionId },',
      '    select: { id: true },',
      '  })',
      '',
      '  const result = await client.pendingVote.deleteMany({',
      '    where: { ballotId: { in: ballots.map((ballot) => ballot.id) } },',
      '  })',
      '',
      '  return result.count',
      '}',
    ].join('\n'),
  },
  {
    file: 'src/modules/eligibility/pending-vote.service.ts',
    contains: "export type PendingVoteClient = Pick<typeof votersDb, 'electionBallot' | 'pendingVote'>",
  },
  {
    file: 'src/modules/eligibility/audit.service.ts',
    contains: "export type AuditClient = Pick<typeof votersDb, 'auditEvent'>",
  },
]

/**
 * Röstlängdens modeller, som de är i dag.
 *
 * En markering kan också hamna i en ny tabell som skrivs någon annanstans än i
 * transaktionen. Därför fäller varje ny modell i röstlängden påståendet, och
 * den som lägger till en får pröva om den är en sådan markering. Mönstret
 * matchar en modell som INTE står i listan.
 */
export const VOTERS_MODELS_TODAY: Marker = {
  nowhereIn: 'prisma/voters/schema.prisma',
  matches:
    /^model (?!(?:VoterStatus|Election|ElectionBallot|VoterBallotStatus|VotingSession|AdminSession|PushSubscription|AuditEvent|PendingVote) \{)/m,
}

// ---------------------------------------------------------------------------
// Läget i stort
// ---------------------------------------------------------------------------

export const CURRENTLY = {
  votePageUsesOldFlow: {
    text:
      'Röstsidan lägger fortfarande röster med det gamla flödet, röstintyg och blinda ' +
      'signaturer, och skriver dem till tabellen vote. I det flödet går en röst inte att ' +
      'ändra, och kvittot visar vad du röstat på.',
    holdsWhile: VOTE_PAGE_OLD_FLOW,
  },

  deviceViewNotBuilt: {
    text:
      'Visningen på enheten är inte byggd: röstsidan kör fortfarande det gamla flödet, där en ' +
      'röst inte går att ändra och kvittot visar vad du röstat på.',
    holdsWhile: VOTE_PAGE_OLD_FLOW,
  },

  decryptionNotBuilt: {
    text:
      'Tröskeldekrypteringen är inte byggd, så partial_decryption och ballot_tally förblir ' +
      'tomma.',
    short: 'steget är inte byggt än',
    holdsWhile: [DECRYPTION_NOT_BUILT],
  },

  decryptionGateNotBuilt: {
    text: 'Dekrypteringen är inte byggd, så spärren finns inte än.',
    holdsWhile: [DECRYPTION_NOT_BUILT],
  },

  sumsNotPublished: {
    text:
      'Ingenting ur kuvertmodellen publiceras än, varken summor eller bevis. ' +
      'Observatörsgränssnittet lämnar fortfarande ut det gamla flödets röster, en och en.',
    short: 'publiceringen är inte byggd än',
    holdsWhile: [
      { file: 'src/app/api/observer/votes/route.ts', contains: 'votesDb.vote.findMany' },
      // Rör observatörsgränssnittet kuvertmodellens tabeller publiceras något ur den.
      { nowhereIn: 'src/app/api/observer', matches: /encryptedVote|partialDecryption|ballotTally/ },
    ],
  },

  envelopeRootNotPublished: {
    text:
      'Kuvertroten publiceras inte utanför systemet än. Administratören får den i ' +
      'stängningens svar.',
    holdsWhile: [
      { nowhereIn: 'src/app/api/observer', matches: /envelopeRoot/ },
      {
        file: 'src/app/api/admin/elections/close/route.ts',
        contains: 'envelopeRoot: outcome.envelopeRoot',
      },
    ],
  },

  finalCheckOldModel: {
    text:
      'Slutkontrollen granskar i dag det gamla flödets röster. Av kuvertmodellen prövar den bara ' +
      'att kopplingen är raderad; chiffren i encrypted_vote ingår inte i någon kontroll.',
    holdsWhile: [
      { file: 'src/orchestration/final-check.usecase.ts', contains: "id: 'every_vote_authorised'" },
      { file: 'src/orchestration/final-check.usecase.ts', contains: "id: 'link_cleared'" },
      { nowhereIn: 'src/orchestration/final-check.usecase.ts', matches: /encryptedVote/ },
    ],
  },

  oldFlowLiveResults: {
    text:
      'Det gamla flödet räknar i klartext medan röstningen pågår: observatörsgränssnittet, som ' +
      'är öppet utan inloggning, lämnar ut antalet röster per parti, och adminvyn visar samma ' +
      'siffror. Samma gränssnitt lämnar dessutom ut varje röst i det gamla flödet med sitt ' +
      'innehåll, alltså parti, kandidat eller svarsalternativ, också medan röstningen pågår.',
    holdsWhile: [
      { file: 'src/app/api/observer/election/route.ts', contains: 'getElectionResults(election.id)' },
      { file: 'src/app/api/admin/stats/route.ts', contains: 'getElectionResults(electionId)' },
      // Varje röst lämnas ut med sitt val.
      { file: 'src/app/api/observer/votes/route.ts', contains: 'ballotPartyId: true,' },
      { file: 'src/app/api/observer/votes/route.ts', contains: 'candidateId: true,' },
      { file: 'src/app/api/observer/votes/route.ts', contains: 'optionId: true,' },
      // ... och rutten frågar inte om röstningen har stängt. Ett villkor på
      // fas, stängningstid eller status behöver ett av de här orden.
      {
        nowhereIn: 'src/app/api/observer/votes/route.ts',
        matches: /\b(phase|closesAt|linkClearedAt|tallyCompletedAt|status)\b/,
      },
    ],
  },

  votedMarkerNotKept: {
    text:
      'Efter stängningen finns i dag ingenting i röstlängden som säger att en väljare lagt ett ' +
      'kuvert: raden i pending_vote raderas, och markeringen i voter_ballot_status görs bara av ' +
      'det gamla flödet.',
    holdsWhile: [
      // Skalningens transaktion och det den lämnar `tx` till är orörda. Här
      // skulle markeringen skrivas enligt spec 3.1 punkt 6, och varje ny rad
      // i dem fäller påståendet.
      STRIPPING_TRANSACTION,
      ...STRIPPING_HELPERS,
      // Ingen ny tabell i röstlängden, var den än skrivs.
      VOTERS_MODELS_TODAY,
      // Och varken stängningen, läggningen eller revisionsloggen rör det
      // gamla flödets markering.
      ...[
        'src/modules/eligibility/pending-vote.service.ts',
        'src/modules/eligibility/audit.service.ts',
        'src/orchestration/close-election.usecase.ts',
        'src/app/api/admin/elections/close/route.ts',
        'src/app/api/vote/encrypted/route.ts',
      ].map((file): Marker => ({ nowhereIn: file, matches: /voterBallotStatus|markBallotAsVoted/ })),
      STRIPPING_DELETES_ENVELOPES,
    ],
  },

  castOnlyWhileOpen: {
    text: 'Läggningen avvisar en röst i varje fas utom OPEN, och efter closesAt även i OPEN.',
    holdsWhile: [
      { file: 'src/modules/eligibility/pending-vote.service.ts', contains: "election.phase !== 'OPEN'" },
      {
        file: 'src/modules/eligibility/pending-vote.service.ts',
        contains: 'election.closesAt <= new Date()',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Granskningstabellen
  // -------------------------------------------------------------------------

  validationGatesClose: {
    text:
      'Byggt: valideringen körs inuti stängningen och stoppar den vid en avvikelse. Men ' +
      'signaturen prövas mot nyckeln som raden själv bär, inte mot BankID:s CA.',
    holdsWhile: [
      {
        file: 'src/orchestration/close-election.usecase.ts',
        contains: 'const report = await validateBeforeClose(electionId)',
      },
      { file: 'src/orchestration/close-election.usecase.ts', contains: 'if (!report.summary.passed)' },
      {
        file: 'src/orchestration/validate-before-close.usecase.ts',
        contains: 'verifySignedPayload(vote.bankIdSignature, vote.bankIdPublicKey',
      },
    ],
  },

  envelopeRootCommitment: {
    text:
      'Byggt: roten räknas ut innan något raderas och skrivs en enda gång, och stängningen ' +
      'avbryter om antalet som flyttats inte är exakt antalet som fanns. Ingen inklusionsväg ' +
      'lagras, och efter stängningen är signaturerna raderade, så ingen utomstående kan räkna om ' +
      'roten.',
    holdsWhile: [
      {
        file: 'src/orchestration/close-election.usecase.ts',
        contains: 'const envelopeRoot = envelopeRootOf(envelopes)',
      },
      {
        file: 'src/orchestration/close-election.usecase.ts',
        contains: 'where: { id: electionId, envelopeRoot: null }',
      },
      { file: 'src/orchestration/close-election.usecase.ts', contains: 'if (moved !== envelopes.length) {' },
      { nowhereIn: 'src/lib/merkle.ts', matches: /export function \w*(Proof|Path|Inclusion)/ },
      STRIPPING_DELETES_ENVELOPES,
    ],
  },

  auditChain: {
    text:
      'Byggt, och slutkontrollen prövar kedjan. Posterna bär händelsetyp och timme, men varken ' +
      'vem eller hur många. Kedjan hindrar inte den som har skrivrätt i databasen från att räkna ' +
      'om den från början.',
    holdsWhile: [
      { file: 'src/orchestration/final-check.usecase.ts', contains: "id: 'audit_chain_intact'" },
      {
        file: 'src/orchestration/validate-before-close.usecase.ts',
        contains: 'recordAuditEvent(AUDIT_EVENTS.PRE_CLOSE_VALIDATION)',
      },
      {
        file: 'src/orchestration/close-election.usecase.ts',
        contains: 'recordAuditEvent(AUDIT_EVENTS.LINK_CLEARED, tx)',
      },
      {
        file: 'src/modules/eligibility/audit.service.ts',
        contains: 'entryHash: auditEntryHash({ sequence, eventType, occurredAt, previousHash })',
      },
      // Inget fält i posten som säger vem eller hur många. `[^}]*` håller
      // mönstret inom modellen, och fältnamnet måste stå först på raden, så en
      // kommentar i modellen matchar inte.
      {
        nowhereIn: 'prisma/voters/schema.prisma',
        matches: /model AuditEvent \{[^}]*\n\s+(actor\w*|admin\w*|voterStatusId|count\w*|electionId)\s/,
      },
    ],
  },

  certifyBlockedWhileLinked: {
    text: 'Byggt: fastställandet kräver att kontrollen av liggande kuvert har passerat.',
    holdsWhile: [
      { file: 'src/orchestration/final-check.usecase.ts', contains: "id: 'link_cleared'" },
      {
        file: 'src/orchestration/final-check.usecase.ts',
        contains: "canCertify: checks.every((check) => check.severity === 'WARNING' || check.passed)",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Metadatatabellen
  // -------------------------------------------------------------------------

  copiesKeepLink: {
    text:
      'Ingenting. Raderingen når bara den levande databasen, och det väljaren signerar i BankID ' +
      'bär chifferhashen bredvid hennes identitet.',
    holdsWhile: [
      { file: 'prisma/voters/schema.prisma', contains: 'model PendingVote' },
      { file: 'src/app/api/vote/sign-start/route.ts', contains: 'ciphertextHash: body.data.ciphertextHash' },
    ],
  },

  timestamps: {
    text:
      'Dygn i röstlängden, också på pending_vote. encrypted_vote har ingen tidsstämpel alls. ' +
      'Revisionsloggen och det gamla flödets röster har timupplösning.',
    holdsWhile: [
      {
        file: 'src/modules/eligibility/pending-vote.service.ts',
        contains: 'updatedAt: truncateToDay(new Date())',
      },
      { nowhereIn: 'prisma/votes/schema.prisma', matches: /model EncryptedVote \{[^}]*DateTime/ },
      {
        file: 'src/modules/eligibility/audit.service.ts',
        contains: 'const occurredAt = truncateToHour(new Date())',
      },
      { file: 'src/modules/ballot-box/vote.service.ts', contains: 'createdAt: truncateToHour(new Date())' },
    ],
  },

  writeOrder: {
    text:
      'Kuverten flyttas i en enda sats vid stängningen, sorterade på chifferhash, och id:t ' +
      'härleds ur hashen. Tabellens ordning är innehållets.',
    holdsWhile: [
      {
        file: 'src/orchestration/close-election.usecase.ts',
        contains: 'const sorted = [...envelopes].sort(byCiphertextHash)',
      },
      {
        file: 'src/orchestration/close-election.usecase.ts',
        contains: 'id: idForEnvelope(envelope.ciphertextHash)',
      },
      { file: 'src/orchestration/close-election.usecase.ts', contains: 'await votesDb.encryptedVote.createMany({' },
    ],
  },

  castSequenceStays: {
    text:
      'Finns bara i pending_vote, följer aldrig med till votes_db och raderas med kopplingen.',
    holdsWhile: [
      { nowhereIn: 'prisma/votes/schema.prisma', matches: /castSequence|cast_sequence/ },
      STRIPPING_DELETES_ENVELOPES,
    ],
  },

  ipAddresses: {
    text:
      'Används till hastighetsbegränsning och hålls hashad i processminnet. Lagras aldrig i en ' +
      'databas.',
    holdsWhile: [
      { file: 'src/lib/rate-limit.ts', contains: 'const key = `${scope}:${sha256Hex(rawKey)}`' },
      { nowhereIn: 'prisma/voters/schema.prisma', matches: /\n\s+(ip|ipAddress|ipHash|clientIp)\s/i },
      { nowhereIn: 'prisma/votes/schema.prisma', matches: /\n\s+(ip|ipAddress|ipHash|clientIp)\s/i },
    ],
  },

  requestIds: {
    text: 'Systemet skapar inget request-id.',
    holdsWhile: [{ nowhereIn: 'src', matches: /x-request-id|\brequestId\b|\brequest_id\b/i }],
  },

  applicationLogs: {
    text:
      'All loggning går genom ett filter som maskerar kända mönster, bland dem 64 hextecken, ' +
      'alltså chifferhashar. Ett test stoppar direkta anrop till konsolen.',
    holdsWhile: [
      { file: 'src/lib/logger.ts', contains: 'pattern: /\\b[a-f0-9]{64}\\b/gi,' },
      {
        file: 'tests/security/module-boundaries.test.ts',
        contains: 'ingen källfil loggar direkt till console utom loggern själv',
      },
    ],
  },

  outboundCalls: {
    text: 'Finns inte. CSP:n tillåter inga utgående anrop.',
    holdsWhile: [{ file: 'src/middleware.ts', contains: `"connect-src 'self'",` }],
  },

  databaseLogs: {
    text:
      'Prismas frågeloggning är avstängd i båda klienterna. WAL-loggen bär kuverten även efter ' +
      'raderingen, se SECURITY.md avsnitt 4.6.',
    holdsWhile: [
      { file: 'src/modules/eligibility/db.ts', contains: "log: ['error']," },
      { file: 'src/modules/ballot-box/db.ts', contains: "log: ['error']," },
    ],
  },

  identityHash: {
    text:
      'Identitetshashen är scrypt av personnumret med peppret som salt. Personnumret lagras aldrig ' +
      'i klartext.',
    holdsWhile: [
      { file: 'src/modules/eligibility/identity.ts', contains: 'scryptHex(normalised, env.identityPepper)' },
    ],
  },
} satisfies Record<string, CodeFact>

// ---------------------------------------------------------------------------
// Faserna
// ---------------------------------------------------------------------------

export type Phase = 'OPEN' | 'CLOSED' | 'VALIDATED' | 'STRIPPED' | 'TALLIED' | 'CERTIFIED'

export type PhaseRow = {
  phase: Phase
  /** Spec 6.1: om kopplingen väljare↔röst finns i den levande databasen. */
  linkExists: boolean
  /** Spec 6.1: om en röst tas emot. */
  acceptsVotes: boolean
  /** Spec 6.1: vad som får hända härnäst. */
  next: string
  /** Vad koden gör med fasen i dag. */
  today: CodeFact
}

/**
 * Ingen källfil skriver fasen.
 *
 * `phase: 'X'` fångar både en skrivning och ett villkor i en fråga. Ett villkor
 * på en fas som aldrig skrivs vore i sig värt att titta på, så båda får testet
 * att gå rött. Uppgifter som skriver fasen via en konstant i stället för en
 * sträng glider förbi, och det står här så att ingen litar på mer än så.
 */
export function neverWritten(phase: Phase): Marker {
  return { nowhereIn: 'src', matches: new RegExp(`\\bphase:\\s*['"\`]${phase}['"\`]`) }
}

export const PHASES: PhaseRow[] = [
  {
    phase: 'OPEN',
    linkExists: true,
    acceptsVotes: true,
    next: 'tiden passerar closesAt',
    today: {
      text: 'Förvald när omröstningen skapas.',
      holdsWhile: [{ file: 'prisma/voters/schema.prisma', contains: 'phase String @default("OPEN")' }],
    },
  },
  {
    phase: 'CLOSED',
    linkExists: true,
    acceptsVotes: false,
    next: 'validering',
    today: {
      text:
        'Skrivs aldrig. Efter closesAt står fasen kvar i OPEN tills stängningen körs, men rösten ' +
        'avvisas ändå, eftersom läggningen prövar både fasen och klockan.',
      holdsWhile: [
        neverWritten('CLOSED'),
        {
          file: 'src/modules/eligibility/pending-vote.service.ts',
          contains: 'election.closesAt <= new Date()',
        },
      ],
    },
  },
  {
    phase: 'VALIDATED',
    linkExists: true,
    acceptsVotes: false,
    next: 'skalning',
    today: {
      text:
        'Skrivs aldrig. Valideringen körs som en spärr inuti stängningen, i samma körning som ' +
        'skalningen.',
      holdsWhile: [
        neverWritten('VALIDATED'),
        {
          file: 'src/orchestration/close-election.usecase.ts',
          contains: 'await validateBeforeClose(electionId)',
        },
      ],
    },
  },
  {
    phase: 'STRIPPED',
    linkExists: false,
    acceptsVotes: false,
    next: 'partiella dekrypteringar',
    today: {
      text:
        'Skrivs av stängningen, i samma transaktion som raderar kopplingen och skriver ' +
        'kuvertroten.',
      holdsWhile: [
        {
          file: 'src/orchestration/close-election.usecase.ts',
          contains: "data: { phase: 'STRIPPED', linkClearedAt: new Date() }",
        },
      ],
    },
  },
  {
    phase: 'TALLIED',
    linkExists: false,
    acceptsVotes: false,
    next: 'slutkontroll och fastställande',
    today: {
      text: 'Skrivs aldrig, eftersom dekrypteringen inte är byggd.',
      holdsWhile: [neverWritten('TALLIED'), DECRYPTION_NOT_BUILT],
    },
  },
  {
    phase: 'CERTIFIED',
    linkExists: false,
    acceptsVotes: false,
    next: 'ingenting',
    today: {
      text:
        'Skrivs aldrig. Fastställandet som finns hör till det gamla flödet och sätter ett eget ' +
        'statusfält i votes_db.',
      holdsWhile: [
        neverWritten('CERTIFIED'),
        { file: 'src/orchestration/final-check.usecase.ts', contains: "data: { status: 'CERTIFIED'" },
      ],
    },
  },
]

// ---------------------------------------------------------------------------
// Vad som återstår
// ---------------------------------------------------------------------------

/**
 * Det som återstår att bygga, i den ordning en läsare behöver det.
 *
 * Varje punkt är ett påstående om att något INTE finns, och bär samma markörer
 * som påståendena ovan om samma sak. Byggs något försvinner markören, testet
 * går rött, och punkten ska strykas härifrån. Listan kan därför bli kortare av
 * sig själv, men aldrig påstå att något återstår som redan är byggt.
 */
export const REMAINING: CodeFact[] = [
  {
    text:
      'Röstsidan lägger kuvert i stället för röster i det gamla flödet, och visar din nuvarande ' +
      'röst på den enhet du röstade från.',
    holdsWhile: VOTE_PAGE_OLD_FLOW,
  },
  {
    text:
      'Faserna CLOSED och VALIDATED blir egna tillstånd i stängningen, med övergångar som bara går ' +
      'framåt.',
    holdsWhile: [neverWritten('CLOSED'), neverWritten('VALIDATED')],
  },
  {
    text: 'Markeringen "har röstat" skrivs i röstlängden vid skalningen, utan tidsstämpel.',
    holdsWhile: CURRENTLY.votedMarkerNotKept.holdsWhile,
  },
  {
    text: 'Tröskeldekrypteringen av summorna, med spärren som kräver att fasen är STRIPPED.',
    holdsWhile: [DECRYPTION_NOT_BUILT, neverWritten('TALLIED')],
  },
  {
    text:
      'Publiceringen av summorna, förtroendemännens bidrag med bevis och kuvertroten, utanför ' +
      'systemet.',
    holdsWhile: [
      ...CURRENTLY.sumsNotPublished.holdsWhile,
      ...CURRENTLY.envelopeRootNotPublished.holdsWhile,
    ],
  },
  {
    text: 'Slutkontrollen och fastställandet för kuvertmodellen, med fasen CERTIFIED.',
    holdsWhile: [...CURRENTLY.finalCheckOldModel.holdsWhile, neverWritten('CERTIFIED')],
  },
  {
    text: 'Att det gamla flödet tas bort, med sina röstintyg, blinda signaturer och kvitton.',
    holdsWhile: [
      { file: 'src/lib/blind-client.ts', contains: 'createBlindedCredential' },
      { file: 'src/modules/ballot-box/vote.service.ts', contains: 'choice: string' },
    ],
  },
]
