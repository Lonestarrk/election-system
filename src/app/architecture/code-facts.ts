/**
 * VAD ARKITEKTURSIDAN PÅSTÅR OM KODEN I DAG, MED MARKÖRER.
 *
 * Sidan beskriver en modell som är halvvägs byggd. En del av det den säger
 * handlar därför om kodens nuvarande läge: att det gamla flödets rutter finns
 * kvar, att dekrypteringen inte är byggd, vilka faser som faktiskt skrivs, hur
 * tidsstämplar lagras. Sådana påståenden blir fel av sig själva i
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
 * Tre sorters markörer:
 *
 *   { file, contains }     sann så länge filen innehåller strängen.
 *   { nowhereIn, matches } sann så länge ingen fil under sökvägen (en katalog
 *                          eller en enskild fil) matchar mönstret. För
 *                          påståenden om att något INTE finns.
 *   { onlyIn, under, matches }
 *                          sann så länge mönstret bara finns i de uppräknade
 *                          filerna, och i ingen annan fil under sökvägen. För
 *                          påståenden om att något bara görs på ett ställe.
 *
 * Kataloger genomsöks efter .ts, .tsx, .sql och .prisma, så att också
 * migreringar och scheman kan granskas.
 *
 * Radslut normaliseras till \n innan markörerna prövas, eftersom arbetskopian
 * på Windows har CRLF.
 *
 * Filen importeras både av sidan och av livevyn i webbläsaren, och får därför
 * inte importera något själv.
 */

export type Marker =
  | { file: string; contains: string }
  | { nowhereIn: string; matches: RegExp }
  | { onlyIn: string[]; under: string; matches: RegExp }

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
 * Ingen sida anropar det gamla flödets rutter.
 *
 * Fram till uppgift 14 stod här det motsatta: röstsidan lade röster med
 * röstintyg och fick en kvittokod tillbaka. Mönstret letar efter rutternas
 * adresser som strängar, i kod och kommentarer, i röstsidans och
 * verifieringssidans kataloger, och efter klientmodulen för blindningen.
 */
const NO_PAGE_USES_OLD_FLOW: Marker[] = [
  {
    nowhereIn: 'src/app/vote',
    matches: /['"`]\/api\/(vote\/cast|vote\/credential|verify)['"`]|@\/lib\/blind-client/,
  },
  { nowhereIn: 'src/app/verify', matches: /['"`]\/api\/(vote\/cast|vote\/credential|verify)['"`]/ },
]

/**
 * Röstsidan lägger kuvert: krypterar i webbläsaren, låter servern starta en
 * BankID-underskrift över hashen och lämnar in valsedeln när den är klar.
 */
const VOTE_PAGE_LAYS_ENVELOPES: Marker[] = [
  { file: 'src/app/vote/page.tsx', contains: 'await encryptBallotInSteps(' },
  { file: 'src/app/vote/BankIdSigning.tsx', contains: "post('/api/vote/sign-start'" },
  { file: 'src/app/vote/BankIdSigning.tsx', contains: "post('/api/vote/encrypted'" },
  ...NO_PAGE_USES_OLD_FLOW,
]

/**
 * Visningen på enheten, som spec 3.1 punkt 1 och 4 beskriver den.
 *
 * Enheten sparar valet och chifferhashen i en modul, frågar servern om hashen
 * är den som ligger, och raderar allt när fasen lämnat OPEN. Servern svarar
 * lika, olika eller ingen röst, och ingen av röstsidans rutter lämnar ut den
 * liggande hashen. Faller något av det faller påståendet.
 */
const DEVICE_VIEW: Marker[] = [
  { file: 'src/app/vote/device-vote.ts', contains: "const KEY_PREFIX = 'valsystem.enhetens-rost.'" },
  { file: 'src/app/vote/page.tsx', contains: "fetch('/api/vote/compare'" },
  { file: 'src/app/vote/page.tsx', contains: 'forgetIfVotingEnded(storage, current.id, current)' },
  {
    file: 'src/modules/eligibility/pending-vote.service.ts',
    contains: "result: safeEqual(current, entry.ciphertextHash) ? 'same' : 'different',",
  },
  {
    file: 'src/app/api/vote/compare/route.ts',
    contains: 'ballots: results.map((entry) => ({ ballotId: entry.ballotId, result: entry.result })),',
  },
  { nowhereIn: 'src/app/api/vote/session/route.ts', matches: /ciphertextHash|pendingVoteFor/ },
]

/** Verifieringssidan säger att visningen efter stängningen inte är byggd. */
const AFTER_CLOSE_VIEW_NOT_BUILT: Marker = {
  file: 'src/app/verify/page.tsx',
  contains: 'Den delen är inte byggd än.',
}

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

/**
 * Fälten i de två modeller där en markering per väljare kunde hamna, som de
 * är i dag.
 *
 * En markering kan också bli en ny kolumn i en befintlig modell i stället för
 * en ny tabell. Mönstret matchar ett fält, alltså en rad som börjar med ett
 * namn, som INTE står i listan. Kommentarer och @@-rader börjar inte med ett
 * namn och räknas inte, så en rättad kommentar fäller inte påståendet.
 */
export const VOTER_MODEL_FIELDS_TODAY: Marker[] = [
  {
    nowhereIn: 'prisma/voters/schema.prisma',
    matches:
      /model VoterStatus \{[^}]*\n\s+(?!(?:id|externalIdentityHash|isEligible|isAdmin|municipalityCode|regionCode|sessions|adminSessions|ballotStatuses|pendingVotes)\s)[A-Za-z]\w*\s/,
  },
  {
    nowhereIn: 'prisma/voters/schema.prisma',
    matches:
      /model VoterBallotStatus \{[^}]*\n\s+(?!(?:id|voterStatusId|voterStatus|ballotId|ballot|votedAt)\s)[A-Za-z]\w*\s/,
  },
]

/**
 * Det gamla flödets markering nämns bara i det gamla flödets tre filer.
 *
 * Markeringen i voter_ballot_status skrivs i dag av röstintygen och av
 * `markBallotAsVoted`, och läses när valsedlarna listas. Nämns tabellen i någon
 * annan fil under src, en ny tjänst, en rutt eller något i src/orchestration,
 * fäller det påståendet, oavsett om det är en läsning eller en skrivning.
 */
export const MARKING_ONLY_IN_OLD_FLOW: Marker = {
  under: 'src',
  onlyIn: [
    'src/modules/eligibility/credential.service.ts',
    'src/modules/eligibility/election.service.ts',
    'src/modules/eligibility/voter-status.service.ts',
  ],
  matches: /voterBallotStatus|VoterBallotStatus|voter_ballot_status|markBallotAsVoted/,
}

/**
 * ... och där skrivs den en gång per fil. En ny funktion i en av filerna som
 * skriver markeringen, och som anropas från ett nytt ställe under ett annat
 * namn, hade annars gått förbi mönstret ovan. Mönstret matchar en andra
 * skrivning i samma fil.
 */
const MARKING_WRITE = /voterBallotStatus\.(?:create|createMany|upsert|update|updateMany)\(/.source

export const ONE_MARKING_WRITE_EACH: Marker[] = [
  'src/modules/eligibility/credential.service.ts',
  'src/modules/eligibility/voter-status.service.ts',
].map((file) => ({
  nowhereIn: file,
  matches: new RegExp(`${MARKING_WRITE}[\\s\\S]*${MARKING_WRITE}`),
}))

/**
 * Och ingenting skrivs förbi koden: ingen trigger i någon migrering eller
 * källfil, och ingen rå SQL som skriver. En trigger på pending_vote kunde
 * annars skriva en markering vid raderingen utan att en enda rad TypeScript
 * ändrats.
 */
export const NO_WRITES_BESIDE_THE_CODE: Marker[] = [
  { nowhereIn: 'prisma', matches: /CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER/i },
  { nowhereIn: 'src', matches: /CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER/i },
  { nowhereIn: 'src', matches: /\$executeRaw|\b(?:INSERT\s+INTO|DELETE\s+FROM)\b|\bUPDATE\s+"?\w+"?\s+SET\b/i },
]

// ---------------------------------------------------------------------------
// Läget i stort
// ---------------------------------------------------------------------------

export const CURRENTLY = {
  /**
   * Uppgift 14 ersatte påståendet att röstsidan körde det gamla flödet. Det
   * här är dess efterföljare, och det gamla flödets kvarvarande del står i
   * `oldFlowRoutesRemain` nedan.
   */
  votePageLaysEnvelopes: {
    text:
      'Röstsidan lägger kuvert: rösten låses i webbläsaren, skrivs under med BankID och läggs i ' +
      'pending_vote, där den byts ut om väljaren röstar om.',
    holdsWhile: VOTE_PAGE_LAYS_ENVELOPES,
  },

  oldFlowRoutesRemain: {
    text:
      'Ingen sida använder längre det gamla flödet, men dess rutter finns kvar och tar emot ' +
      'röster till tabellen vote tills flödet tas bort.',
    holdsWhile: [
      ...NO_PAGE_USES_OLD_FLOW,
      { file: 'src/app/api/vote/credential/route.ts', contains: 'export async function POST' },
      { file: 'src/app/api/vote/cast/route.ts', contains: 'export async function POST' },
      { file: 'src/modules/ballot-box/vote.service.ts', contains: 'votesDb.vote.create' },
    ],
  },

  deviceViewBuilt: {
    text:
      'Före stängningen är det byggt: röstsidan visar din nuvarande röst på enheten du röstade ' +
      'från. Enheten skickar den chifferhash den sparade, och servern svarar bara om den stämmer ' +
      'med rösten som ligger, aldrig med sin egen hash. När sidan ser att fasen lämnat OPEN ' +
      'raderar enheten det den sparat. Efter stängningen visar verifieringssidan ännu ingenting.',
    holdsWhile: [...DEVICE_VIEW, AFTER_CLOSE_VIEW_NOT_BUILT],
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
      // Ingen ny tabell i röstlängden, och ingen ny kolumn i de modeller där
      // en markering per väljare kunde stå, var den än skrivs.
      VOTERS_MODELS_TODAY,
      ...VOTER_MODEL_FIELDS_TODAY,
      // Det gamla flödets markering nämns bara i det gamla flödet, också i
      // src/orchestration, och skrivs där en gång per fil.
      MARKING_ONLY_IN_OLD_FLOW,
      ...ONE_MARKING_WRITE_EACH,
      // Och ingen trigger eller rå SQL skriver förbi allt det här.
      ...NO_WRITES_BESIDE_THE_CODE,
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
      'Faserna CLOSED och VALIDATED blir egna tillstånd i stängningen, med övergångar som bara går ' +
      'framåt.',
    holdsWhile: [neverWritten('CLOSED'), neverWritten('VALIDATED')],
  },
  {
    text: 'Markeringen "har röstat" skrivs i röstlängden vid skalningen, utan tidsstämpel.',
    holdsWhile: CURRENTLY.votedMarkerNotKept.holdsWhile,
  },
  {
    text: 'Verifieringssidan visar efter stängningen att du har röstat, men inte vad.',
    holdsWhile: [AFTER_CLOSE_VIEW_NOT_BUILT],
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
