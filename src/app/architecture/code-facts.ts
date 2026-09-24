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
 * Kataloger genomsöks efter .ts, .tsx, .sql, .prisma och .bicep, så att också
 * migreringar, scheman och mallarna för Azure kan granskas.
 *
 * AZURE-UPPSÄTTNINGEN ÄGS AV EN ANNAN SESSION (uppgift 11g). Mallarna under
 * infra/azure skrivs av sessionen som distribuerar till Azure, och
 * arkitektursidan ändrar dem aldrig. Markörerna mot dem är valda ur innehåll
 * som fanns både i den committade versionen och i arbetskopian när de
 * skrevs, så att en pågående ändring där inte fäller dem i onödan. Ändrar den
 * sessionen något som ett påstående bygger på går testet rött, och det är
 * meningen: då ska påståendet skrivas om, inte markören tas bort.
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
 * Det gamla flödets röster och kvitton: adresserna till rutterna som lägger
 * en röst med röstintyg och som svarar på en kvittokod, som strängar, och
 * klientmodulen för blindningen.
 *
 * Exporteras för arkitektursidans test, som prövar sidans egna filer med samma
 * mönster (se nedan).
 */
export const OLD_FLOW_VOTES_AND_RECEIPTS =
  /['"`]\/api\/(vote\/cast|vote\/credential|verify)['"`]|@\/lib\/blind-client/

/**
 * Ingen sida lägger röster i det gamla flödet eller frågar efter dess kvitton.
 *
 * Fram till uppgift 14 stod här det motsatta: röstsidan lade röster med
 * röstintyg och fick en kvittokod tillbaka. Mönstret prövas i hela src/app, i
 * kod och kommentarer. Det omfattar också rutterna under src/app/api, som i dag
 * inte nämner varandra, vilket är strängare än påståendet kräver. Behöver en
 * rutt en dag nämna en av adresserna ska markören smalnas av då, inte
 * påståendet. Arkitektursidans egna filer hoppar granskningen alltid över,
 * eftersom de bär påståendena och deras mönster. För dem gör
 * tests/security/architecture-page.test.ts samma prov för sig.
 *
 * Påståendet gäller röster och kvitton, inte allt i det gamla flödet.
 * Adminsidan läser fortfarande dess statistik och fastställer i det; det står
 * i oldFlowLiveResults och finalCheckOldModel.
 */
const NO_PAGE_VOTES_OR_VERIFIES_IN_OLD_FLOW: Marker[] = [
  { nowhereIn: 'src/app', matches: OLD_FLOW_VOTES_AND_RECEIPTS },
]

/**
 * Röstsidan lägger kuvert: krypterar i webbläsaren, låter servern starta en
 * BankID-underskrift över hashen och lämnar in valsedeln när den är klar.
 */
const VOTE_PAGE_LAYS_ENVELOPES: Marker[] = [
  { file: 'src/app/vote/page.tsx', contains: 'await encryptBallotInSteps(' },
  { file: 'src/app/vote/BankIdSigning.tsx', contains: "post('/api/vote/sign-start'" },
  { file: 'src/app/vote/BankIdSigning.tsx', contains: "post('/api/vote/encrypted'" },
  ...NO_PAGE_VOTES_OR_VERIFIES_IN_OLD_FLOW,
]

/**
 * Visningen på enheten, som spec 3.1 punkt 1 och 4 beskriver den.
 *
 * Enheten sparar valet och chifferhashen i en modul och frågar servern om
 * hashen är den som ligger. Servern svarar lika, olika eller ingen röst, och
 * den enda hash röstsidan får tillbaka är den den själv skickat in, när en röst
 * läggs. Enheten raderar allt när sidan ser att fasen lämnat OPEN: när sidan
 * laddas, när en öppen flik frågar igen, och när servern svarar på en röst att
 * röstningen stängt. Faller något av det faller påståendet.
 *
 * Påståendet gäller röstsidan. Livevyn i demoläget visar databasen som en
 * insider ser den, med början av varje kuverts hash, och säger det själv.
 */
const DEVICE_VIEW: Marker[] = [
  { file: 'src/app/vote/device-vote.ts', contains: "const KEY_PREFIX = 'valsystem.enhetens-rost.'" },
  { file: 'src/app/vote/page.tsx', contains: "fetch('/api/vote/compare'" },
  { file: 'src/app/vote/page.tsx', contains: 'forgetIfVotingEnded(storage, current.id, current)' },
  { file: 'src/app/vote/page.tsx', contains: 'return watchVotingPhase({' },
  { file: 'src/app/vote/BankIdSigning.tsx', contains: "if (data.status === 'closed') {" },
  {
    file: 'src/modules/eligibility/pending-vote.service.ts',
    contains: "result: safeEqual(current, entry.ciphertextHash) ? 'same' : 'different',",
  },
  {
    file: 'src/app/api/vote/compare/route.ts',
    contains: 'ballots: results.map((entry) => ({ ballotId: entry.ballotId, result: entry.result })),',
  },
  // Röstsidans övriga rutter. Sessionen och valsedeln nämner ingen hash, och
  // underskriftens start svarar med exakt de här fälten.
  { nowhereIn: 'src/app/api/vote/session/route.ts', matches: /ciphertextHash|pendingVoteFor/ },
  { nowhereIn: 'src/app/api/vote/ballot/route.ts', matches: /ciphertextHash|pendingVoteFor/ },
  {
    file: 'src/app/api/vote/sign-start/route.ts',
    contains: [
      '  return jsonResponse({',
      '    orderRef: order.orderRef,',
      '    launchUrls: {',
      "      ios: launchUrl(order.autoStartToken, 'ios', returnUrl),",
      "      other: launchUrl(order.autoStartToken, 'other', returnUrl),",
      '    },',
      '    qrImage: initialQr ? await renderQrPng(initialQr.qrData) : null,',
      '  })',
    ].join('\n'),
  },
  // Den enda hash röstsidan får tillbaka: den i valsedeln den själv lämnade in.
  {
    file: 'src/modules/eligibility/pending-vote.service.ts',
    contains:
      "return { status: 'recorded', ciphertextHash: ballot.ciphertextHash, replaced: existing !== null }",
  },
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
    '        // Exakt de kuvert som validerades och flyttades, och inga andra.',
    '        const { removed, left } = await clearPendingVotes(electionId, envelopes, tx)',
    '        if (removed !== moved || left !== 0) {',
    '          throw new EnvelopesChangedError({ moved, removed, left })',
    '        }',
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
      '  envelopes: ReadonlyArray<{ id: string; ciphertextHash: string }>,',
      '  client: PendingVoteClient,',
      '): Promise<{ removed: number; left: number }> {',
      '  let removed = 0',
      '',
      '  for (let start = 0; start < envelopes.length; start += CLEAR_BATCH_SIZE) {',
      '    const batch = envelopes.slice(start, start + CLEAR_BATCH_SIZE)',
      '    const result = await client.pendingVote.deleteMany({',
      '      where: { OR: batch.map(({ id, ciphertextHash }) => ({ id, ciphertextHash })) },',
      '    })',
      '    removed += result.count',
      '  }',
      '',
      '  const ballots = await client.electionBallot.findMany({',
      '    where: { electionId },',
      '    select: { id: true },',
      '  })',
      '  const left = await client.pendingVote.count({',
      '    where: { ballotId: { in: ballots.map((ballot) => ballot.id) } },',
      '  })',
      '',
      '  return { removed, left }',
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
// Markörer för hemligheterna i Azure (uppgift 11g)
// ---------------------------------------------------------------------------

/** Pepparn kommer ur valvet och blir en miljövariabel i appen. */
const PEPPER_FROM_VAULT: Marker[] = [
  {
    file: 'infra/azure/app.bicep',
    contains:
      "{ name: 'identity-pepper', keyVaultUrl: '${keyVaultUri}secrets/identity-pepper', identity: appIdentityId }",
  },
  { file: 'infra/azure/app.bicep', contains: "{ name: 'IDENTITY_PEPPER', secretRef: 'identity-pepper' }" },
]

/** Båda databasadresserna kommer ur valvet och blir miljövariabler i appen. */
const DATABASE_URLS_FROM_VAULT: Marker[] = [
  {
    file: 'infra/azure/app.bicep',
    contains:
      "{ name: 'voters-database-url', keyVaultUrl: '${keyVaultUri}secrets/voters-database-url', identity: appIdentityId }",
  },
  {
    file: 'infra/azure/app.bicep',
    contains:
      "{ name: 'votes-database-url', keyVaultUrl: '${keyVaultUri}secrets/votes-database-url', identity: appIdentityId }",
  },
  { file: 'infra/azure/app.bicep', contains: "{ name: 'VOTERS_DATABASE_URL', secretRef: 'voters-database-url' }" },
  { file: 'infra/azure/app.bicep', contains: "{ name: 'VOTES_DATABASE_URL', secretRef: 'votes-database-url' }" },
]

/** Pepparn skapas bara när distributionen inte hittar den, och skälet står bredvid. */
const PEPPER_CREATED_ONCE: Marker[] = [
  {
    file: 'infra/azure/deploy.sh',
    contains:
      'if secret_exists identity-pepper; then echo "   identity-pepper finns redan"; else put_secret identity-pepper "$(random_hex 32)"; fi',
  },
  {
    file: 'infra/azure/deploy.sh',
    contains: '# IDENTITY_PEPPER skapas EN gång och byts aldrig: byts den matchar ingen hash i röstlängden.',
  },
]

/**
 * Ingen mall slår på valvets granskningslogg. Loggen kräver en
 * diagnostikinställning, och ingen fil under infra/azure nämner en.
 */
const NO_VAULT_AUDIT_LOG: Marker = { nowhereIn: 'infra/azure', matches: /diagnosticSettings/i }

/** Rensningsskyddet är inte påslaget i någon mall. */
const NO_PURGE_PROTECTION: Marker = { nowhereIn: 'infra/azure', matches: /enablePurgeProtection/ }

/** Valvet är av typen Standard, utan HSM. */
const VAULT_SKU_STANDARD: Marker = {
  file: 'infra/azure/keyvault.bicep',
  contains: "sku: { family: 'A', name: 'standard' }",
}

/** Appens identitet får läsa hela valvet, inte enskilda hemligheter. */
const APP_READS_WHOLE_VAULT: Marker = {
  file: 'infra/azure/infra.bicep',
  contains: [
    "resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {",
    '  name: guid(kv.id, appIdentity.id, keyVaultSecretsUserRoleId)',
    '  scope: kv',
    '',
  ].join('\n'),
}

/** Inget ord för förtroendemännen eller deras lösenfraser, i mallarna och i distributionen. */
const NO_TRUSTEE_SECRETS_IN_AZURE: Marker[] = [
  { nowhereIn: 'infra/azure', matches: /trustee|förtroende|fortroende|passphrase|lösenfras/i },
  { nowhereIn: 'infra/azure/deploy.sh', matches: /trustee|förtroende|fortroende|passphrase|lösenfras/i },
]

/** Demovalets andelar är krypterade med tre kända fraser, och entrypoint seedar vid varje start. */
const DEMO_PASSPHRASES_SEEDED: Marker[] = [
  { file: 'prisma/seed.ts', contains: "'demo-fortroendeman-ett'," },
  { file: 'prisma/seed.ts', contains: "const existing = await votesDb.election.findFirst({ where: { name: 'Valet 2026' } })" },
  { file: 'docker/entrypoint.sh', contains: 'npx tsx prisma/seed.ts' },
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
      'Ingen sida lägger längre röster i det gamla flödet eller frågar efter dess kvitton, men ' +
      'rutterna finns kvar och tar emot röster till tabellen vote tills flödet tas bort.',
    holdsWhile: [
      ...NO_PAGE_VOTES_OR_VERIFIES_IN_OLD_FLOW,
      { file: 'src/app/api/vote/credential/route.ts', contains: 'export async function POST' },
      { file: 'src/app/api/vote/cast/route.ts', contains: 'export async function POST' },
      { file: 'src/modules/ballot-box/vote.service.ts', contains: 'votesDb.vote.create' },
    ],
  },

  deviceViewBuilt: {
    text:
      'Före stängningen är det byggt: röstsidan visar din nuvarande röst på enheten du röstade ' +
      'från. Enheten skickar den chifferhash den sparade, och servern svarar bara om den stämmer ' +
      'med rösten som ligger. Röstsidan får aldrig någon annan hash än den enheten själv räknat ' +
      'fram. När sidan ser att fasen lämnat OPEN raderar enheten det den sparat, också i en flik ' +
      'som står öppen över stängningen. Efter stängningen visar verifieringssidan ännu ingenting.',
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

  /**
   * Uppgift 14f ersatte "signaturen prövas mot nyckeln som raden själv bär,
   * inte mot BankID:s CA". Markörerna följer prövningen på båda ställena där
   * den görs, och förvalet av attrappens rot i demoläget, som sidan nämner.
   *
   * Fixrunda 1 av uppgift 14f lade till att stängningen validerar den läsning
   * den flyttar. Före den läste valideringen pending_vote för sig, och en rad
   * som försvann mellan läsningarna flyttades utan att ha prövats. Markörerna
   * följer den enda läsningen: stängningen validerar och flyttar `snapshot`,
   * och valideringen tar sina rader ur den.
   */
  validationGatesClose: {
    text:
      'Byggt: stängningen läser kuverten en gång, validerar just den läsningen och stoppar vid en ' +
      'avvikelse, och flyttar och raderar sedan exakt de kuvert som validerats. Varje ' +
      'underskrift prövas mot BankID:s rotcertifikat och varje certifikat mot väljarens ' +
      'identitetshash, både när rösten läggs och i valideringen, och kedjan lagras krypterad i ' +
      'pending_vote. I demoläget är roten attrappens egen, och attrappen utfärdar certifikaten själv.',
    holdsWhile: [
      {
        file: 'src/orchestration/close-election.usecase.ts',
        contains: 'const report = await validateEnvelopes(snapshot)',
      },
      { file: 'src/orchestration/close-election.usecase.ts', contains: 'if (!report.summary.passed)' },
      {
        file: 'src/orchestration/close-election.usecase.ts',
        contains: 'const envelopes: readonly Envelope[] = snapshot.envelopes',
      },
      {
        file: 'src/orchestration/validate-before-close.usecase.ts',
        contains: 'const { electionId, ballots, envelopes: pendingVotes } = snapshot',
      },
      // Valideringen öppnar kedjan, prövar den mot rötterna och jämför lövet med väljaren.
      {
        file: 'src/orchestration/validate-before-close.usecase.ts',
        contains: 'const chain = openCertificateChain(vote.bankIdCertificateChain, {',
      },
      {
        file: 'src/orchestration/validate-before-close.usecase.ts',
        contains: 'const certificate = verifyCertificateChain(chain, {',
      },
      {
        file: 'src/orchestration/validate-before-close.usecase.ts',
        contains: 'if (!safeEqual(identityHash, vote.voterStatus.externalIdentityHash)) {',
      },
      // Läggningen prövar samma kedja, och lagrar den krypterad.
      {
        file: 'src/modules/eligibility/pending-vote.service.ts',
        contains:
          'verifyCertificateChain(chain, { roots: trustedBankIdRoots(), signedDuring: signedAt(new Date()) })',
      },
      {
        file: 'src/modules/eligibility/pending-vote.service.ts',
        contains: 'const bankIdCertificateChain = sealCertificateChain(chain, { voterStatusId, ballotId })',
      },
      // I demoläget är attrappens rot den som kedjan prövas mot.
      {
        file: 'src/modules/eligibility/bankid/trusted-roots.ts',
        contains: 'if (isDemoMode()) return [mockBankIdRoot()]',
      },
    ],
  },

  envelopeRootCommitment: {
    text:
      'Byggt: roten räknas ut innan något raderas och skrivs en enda gång, och stängningen ' +
      'avbryter om antalet som flyttats inte är exakt antalet som fanns, eller om raderingen inte ' +
      'träffar exakt de kuvert som flyttats. Ingen inklusionsväg lagras, och efter stängningen är ' +
      'signaturerna raderade, så ingen utomstående kan räkna om roten.',
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
      // Raderingen efter id och chifferhash, och jämförelsen före COMMIT.
      {
        file: 'src/modules/eligibility/pending-vote.service.ts',
        contains: 'where: { OR: batch.map(({ id, ciphertextHash }) => ({ id, ciphertextHash })) },',
      },
      { file: 'src/orchestration/close-election.usecase.ts', contains: 'if (removed !== moved || left !== 0) {' },
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

  // -------------------------------------------------------------------------
  // Hemligheterna i Azure (uppgift 11g)
  //
  // Påståendena på Tekniska detaljer och Utvecklingsstatus om valvet. Varje
  // mening om vad valvet skyddar är avgränsad till var den gäller, och det
  // valvet inte skyddar mot står lika tydligt. Se kommentaren överst om vem
  // som äger infra/azure.
  // -------------------------------------------------------------------------

  vaultToEnvironment: {
    text:
      'Mallarna bär bara adresserna till hemligheterna i valvet, aldrig värdena, och distributionen ' +
      'genererar värdena själv, så de finns varken i repot eller i imagen. Container Apps hämtar ' +
      'dem med appens identitet och lägger dem i miljövariabler när containern startar. Appen läser ' +
      'dem därifrån och har dem i minnet så länge den kör.',
    holdsWhile: [
      ...PEPPER_FROM_VAULT,
      ...DATABASE_URLS_FROM_VAULT,
      // Ingen hemlig variabel får ett värde direkt i mallen.
      {
        nowhereIn: 'infra/azure/app.bicep',
        matches:
          /name: '(?:IDENTITY_PEPPER|VOTERS_DATABASE_URL|VOTES_DATABASE_URL|VAPID_PUBLIC_KEY|VAPID_PRIVATE_KEY)', value:/,
      },
      { file: 'infra/azure/deploy.sh', contains: 'put_secret identity-pepper "$(random_hex 32)"' },
      { file: 'infra/azure/deploy.sh', contains: 'gen_voters() { local pw; pw="$(random_hex 24)";' },
      { file: 'src/lib/env.ts', contains: 'const value = process.env[name]' },
    ],
  },

  vaultPepper: {
    text:
      'Blir IDENTITY_PEPPER i appen. Pepparn är saltet i identitetshashen, scrypt av personnumret, ' +
      'vid inloggningen och när certifikatet bakom en underskrift knyts till väljaren. Ur den ' +
      'härleds med HKDF nyckeln som krypterar certifikatkedjan i pending_vote, när rösten läggs, och ' +
      'valideringen före stängningen öppnar kedjan med samma nyckel och hashar personnumret i lövet.',
    holdsWhile: [
      ...PEPPER_FROM_VAULT,
      { file: 'src/modules/eligibility/identity.ts', contains: 'scryptHex(normalised, env.identityPepper)' },
      {
        file: 'src/modules/eligibility/voter-status.service.ts',
        contains: 'const identityHash = await hashPersonalNumber(personalNumber)',
      },
      {
        file: 'src/modules/eligibility/pending-vote.service.ts',
        contains: 'await hashPersonalNumber(certificate.personalNumber),',
      },
      { file: 'src/modules/eligibility/sealed-chain.ts', contains: "hkdfSync('sha256', env.identityPepper," },
      {
        file: 'src/modules/eligibility/pending-vote.service.ts',
        contains: 'const bankIdCertificateChain = sealCertificateChain(chain, { voterStatusId, ballotId })',
      },
      {
        file: 'src/orchestration/validate-before-close.usecase.ts',
        contains: 'const chain = openCertificateChain(vote.bankIdCertificateChain, {',
      },
      {
        file: 'src/orchestration/validate-before-close.usecase.ts',
        contains: 'hash = hashPersonalNumber(personalNumber)',
      },
    ],
  },

  vaultDatabaseUrls: {
    text:
      'Blir VOTERS_DATABASE_URL och VOTES_DATABASE_URL. Varje adress bär lösenordet för en egen ' +
      'roll, voters_app respektive votes_app, och ingen av rollerna får ansluta till den andras ' +
      'databas: db-init.sql tar bort rätten att ansluta från PUBLIC på båda databaserna och ger den ' +
      'tillbaka till en roll för var och en. Lokalt och med docker-compose ansluter appen till båda ' +
      'som samma användare.',
    holdsWhile: [
      ...DATABASE_URLS_FROM_VAULT,
      { file: 'infra/azure/deploy.sh', contains: 'postgresql://voters_app:${pw}@${PG_FQDN}:5432/voters_db' },
      { file: 'infra/azure/deploy.sh', contains: 'postgresql://votes_app:${pw}@${PG_FQDN}:5432/votes_db' },
      { file: 'infra/azure/db-init.sql', contains: 'REVOKE CONNECT, TEMPORARY ON DATABASE voters_db FROM PUBLIC;' },
      { file: 'infra/azure/db-init.sql', contains: 'REVOKE CONNECT, TEMPORARY ON DATABASE votes_db FROM PUBLIC;' },
      // Början av GRANT-raderna skiljer sig mellan versionerna; slutet, vem som får vad, gör det inte.
      { file: 'infra/azure/db-init.sql', contains: 'ON DATABASE voters_db TO voters_app;' },
      { file: 'infra/azure/db-init.sql', contains: 'ON DATABASE votes_db TO votes_app;' },
      // Och ingen roll får något på den andras databas.
      {
        nowhereIn: 'infra/azure/db-init.sql',
        matches: /GRANT[^;]*ON DATABASE votes_db[^;]*voters_app|GRANT[^;]*ON DATABASE voters_db[^;]*votes_app/,
      },
      {
        file: '.env.example',
        contains: 'VOTERS_DATABASE_URL="postgresql://election:election@localhost:5432/voters_db?schema=public"',
      },
      {
        file: '.env.example',
        contains: 'VOTES_DATABASE_URL="postgresql://election:election@localhost:5432/votes_db?schema=public"',
      },
      {
        file: 'docker-compose.yml',
        contains: 'VOTERS_DATABASE_URL: postgresql://election:election@postgres:5432/voters_db?schema=public',
      },
      {
        file: 'docker-compose.yml',
        contains: 'VOTES_DATABASE_URL: postgresql://election:election@postgres:5432/votes_db?schema=public',
      },
    ],
  },

  vaultVapid: {
    text:
      'Blir VAPID_PUBLIC_KEY och VAPID_PRIVATE_KEY, nycklarna för pushnotiserna. Den privata ' +
      'signerar utskicken och identifierar systemet mot push-tjänsterna.',
    holdsWhile: [
      {
        file: 'infra/azure/app.bicep',
        contains:
          "{ name: 'vapid-public-key', keyVaultUrl: '${keyVaultUri}secrets/vapid-public-key', identity: appIdentityId }",
      },
      {
        file: 'infra/azure/app.bicep',
        contains:
          "{ name: 'vapid-private-key', keyVaultUrl: '${keyVaultUri}secrets/vapid-private-key', identity: appIdentityId }",
      },
      { file: 'infra/azure/app.bicep', contains: "{ name: 'VAPID_PUBLIC_KEY', secretRef: 'vapid-public-key' }" },
      { file: 'infra/azure/app.bicep', contains: "{ name: 'VAPID_PRIVATE_KEY', secretRef: 'vapid-private-key' }" },
      { file: 'src/lib/env.ts', contains: 'const privateKey = process.env.VAPID_PRIVATE_KEY' },
    ],
  },

  vaultPgAdmin: {
    text:
      'Postgres-administratörens lösenord. Distributionen läser det med getSecret i infra.bicep när ' +
      'servern skapas, och db-init-jobbet får det som miljövariabel för att sätta upp rollerna. ' +
      'Appen får det inte som miljövariabel, men jobbet läser det ur valvet med appens identitet.',
    holdsWhile: [
      { file: 'infra/azure/infra.bicep', contains: "adminPassword: kv.getSecret('pg-admin-password')" },
      {
        file: 'infra/azure/db-init-job.bicep',
        contains:
          "{ name: 'pg-admin-password', keyVaultUrl: '${keyVaultUri}secrets/pg-admin-password', identity: appIdentityId }",
      },
      { file: 'infra/azure/db-init-job.bicep', contains: "{ name: 'PGPASSWORD', secretRef: 'pg-admin-password' }" },
      { nowhereIn: 'infra/azure/app.bicep', matches: /pg-admin-password|PGPASSWORD/ },
    ],
  },

  vaultPgRolePasswords: {
    text:
      'Rollernas lösenord, desamma som i databasadresserna. db-init-jobbet sätter dem på voters_app ' +
      'och votes_app vid varje distribution.',
    holdsWhile: [
      {
        file: 'infra/azure/db-init-job.bicep',
        contains:
          "{ name: 'pg-voters-password', keyVaultUrl: '${keyVaultUri}secrets/pg-voters-password', identity: appIdentityId }",
      },
      {
        file: 'infra/azure/db-init-job.bicep',
        contains:
          "{ name: 'pg-votes-password', keyVaultUrl: '${keyVaultUri}secrets/pg-votes-password', identity: appIdentityId }",
      },
      { file: 'infra/azure/db-init-job.bicep', contains: '-v voters_pw="$VOTERS_PW" -v votes_pw="$VOTES_PW"' },
      { file: 'infra/azure/db-init.sql', contains: "PASSWORD :'voters_pw';" },
      { file: 'infra/azure/db-init.sql', contains: "PASSWORD :'votes_pw';" },
      { file: 'infra/azure/deploy.sh', contains: 'ensure_pair pg-voters-password voters-database-url gen_voters' },
      { file: 'infra/azure/deploy.sh', contains: 'ensure_pair pg-votes-password votes-database-url gen_votes' },
      { file: 'infra/azure/deploy.sh', contains: 'az containerapp job start --name "$JOB_NAME"' },
    ],
  },

  vaultHoldsOnlyThese: {
    text: 'Distributionen skriver just de här åtta hemligheterna i valvet, och mallarna läser inga andra.',
    holdsWhile: [
      ...PEPPER_CREATED_ONCE,
      { file: 'infra/azure/deploy.sh', contains: 'ensure_pair vapid-public-key vapid-private-key gen_vapid' },
      { file: 'infra/azure/deploy.sh', contains: 'ensure_pair pg-voters-password voters-database-url gen_voters' },
      { file: 'infra/azure/deploy.sh', contains: 'ensure_pair pg-votes-password votes-database-url gen_votes' },
      // Ingen annan hemlighet skrivs ...
      {
        nowhereIn: 'infra/azure/deploy.sh',
        matches:
          /(?:put_secret|ensure_pair) (?!(?:pg-admin-password|identity-pepper|pg-voters-password|pg-votes-password|vapid-public-key|"\$a"|"\$b") )[\w"$-]/,
      },
      // ... och ingen annan läses, varken som referens i en container eller med getSecret.
      {
        nowhereIn: 'infra/azure',
        matches:
          /keyVaultUrl: '\$\{keyVaultUri\}secrets\/(?!(?:identity-pepper|voters-database-url|votes-database-url|vapid-public-key|vapid-private-key|pg-admin-password|pg-voters-password|pg-votes-password)')/,
      },
      { nowhereIn: 'infra/azure', matches: /getSecret\('(?!pg-admin-password')/ },
    ],
  },

  vaultSecretsCreatedOnce: {
    text:
      'En hemlighet skrivs bara när distributionen inte hittar den i valvet, och pepparn skapas en ' +
      'gång: byts den stämmer ingen identitetshash i röstlängden längre, så den kan inte roteras ' +
      'utan att röstlängden läses in på nytt.',
    holdsWhile: PEPPER_CREATED_ONCE,
  },

  vaultAccess: {
    text:
      'Appens identitet får läsa hemligheterna i just det här valvet, genom rollen Key Vault ' +
      'Secrets User, och hämta imagen ur registret, genom AcrPull. Mallarna ger den inga andra ' +
      'roller. Rollen gäller hela valvet och inte enskilda hemligheter, så identiteten får läsa också ' +
      'administratörens lösenord, och db-init-jobbet kör med samma identitet.',
    holdsWhile: [
      {
        file: 'infra/azure/infra.bicep',
        contains: "var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'",
      },
      APP_READS_WHOLE_VAULT,
      {
        file: 'infra/azure/infra.bicep',
        contains: [
          "resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {",
          '  name: guid(acr.id, appIdentity.id, acrPullRoleId)',
          '  scope: acr',
          '',
        ].join('\n'),
      },
      // Rolltilldelningar finns bara i infra.bicep, och där bara de två.
      {
        onlyIn: ['infra/azure/infra.bicep'],
        under: 'infra/azure',
        matches: /Microsoft\.Authorization\/roleAssignments/,
      },
      {
        nowhereIn: 'infra/azure/infra.bicep',
        matches: /(?:Microsoft\.Authorization\/roleAssignments@[\s\S]*?){3}/,
      },
      { file: 'infra/azure/db-init-job.bicep', contains: "userAssignedIdentities: { '${appIdentityId}': {} }" },
    ],
  },

  vaultSettings: {
    text:
      'Valvet har RBAC i stället för åtkomstpolicyer, mjuk radering i 90 dagar och SKU Standard, ' +
      'alltså ingen HSM. Rensningsskyddet är inte påslaget, så en raderad hemlighet kan rensas bort ' +
      'för gott innan de 90 dagarna gått. Valvet nås över internet och skyddas av inloggning och ' +
      'roller, inte av nätverket.',
    holdsWhile: [
      { file: 'infra/azure/keyvault.bicep', contains: 'enableRbacAuthorization: true' },
      { file: 'infra/azure/keyvault.bicep', contains: 'enableSoftDelete: true' },
      { file: 'infra/azure/keyvault.bicep', contains: 'softDeleteRetentionInDays: 90' },
      VAULT_SKU_STANDARD,
      NO_PURGE_PROTECTION,
      { file: 'infra/azure/keyvault.bicep', contains: "publicNetworkAccess: 'Enabled'" },
      { nowhereIn: 'infra/azure', matches: /networkAcls|privateEndpoint/i },
    ],
  },

  vaultNoAuditLog: {
    text:
      'Ingen av mallarna slår på valvets granskningslogg. Utan en diagnostikinställning sparas ingen ' +
      'logg över vem som läser en hemlighet, och Log Analytics tar bara emot containrarnas loggar.',
    holdsWhile: [NO_VAULT_AUDIT_LOG, { file: 'infra/azure/infra.bicep', contains: "destination: 'log-analytics'" }],
  },

  azureBackups: {
    text:
      'Databastjänsten sparar säkerhetskopior i sju dagar. En kopia från före stängningen har ' +
      'pending_vote kvar, med kedjorna, och pepparn i valvet öppnar dem också där, eftersom ' +
      'distributionen inte byter den.',
    holdsWhile: [
      {
        file: 'infra/azure/postgres.bicep',
        contains: "backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }",
      },
      ...PEPPER_CREATED_ONCE,
      { file: 'src/modules/eligibility/sealed-chain.ts', contains: "hkdfSync('sha256', env.identityPepper," },
    ],
  },

  appHoldsEverything: {
    text:
      'Appen har pepparn och båda databasadresserna i minnet medan den kör, och den måste ha båda ' +
      'adresserna: stängningen flyttar chiffren till votes_db och raderar kuverten i voters_db. ' +
      'Rollerna per databas skyddar mot att en enskild adress läcker, inte mot appen.',
    holdsWhile: [
      ...PEPPER_FROM_VAULT,
      ...DATABASE_URLS_FROM_VAULT,
      { file: 'src/orchestration/close-election.usecase.ts', contains: 'await votesDb.encryptedVote.createMany({' },
      STRIPPING_DELETES_ENVELOPES,
    ],
  },

  azureOwner: {
    text:
      'Den som distribuerar behöver Owner på resursgruppen, eller Contributor och User Access ' +
      'Administrator, eftersom infra.bicep skapar rolltilldelningar. Med den rätten kan man ge sig ' +
      'själv läsrätt i valvet, så valvet skyddar inte mot den som driver uppsättningen.',
    holdsWhile: [
      {
        file: 'infra/azure/README.md',
        contains: 'Tjänsteprincipalen behöver **Owner** (eller Contributor + User Access Administrator) på',
      },
      APP_READS_WHOLE_VAULT,
    ],
  },

  azureRunsDemo: {
    text:
      'Uppsättningen i Azure kör i demoläget: BankID är attrappen, som utfärdar certifikaten själv. ' +
      'Entrypoint kör seedningen vid varje start, och den skapar demovalet, om det saknas, med ' +
      'förtroendemännens tre kända demofraser. Den som når röstdatabasen kan då öppna andelarna med ' +
      'dem och dekryptera varje chiffer hen kommer åt.',
    holdsWhile: [
      { file: 'infra/azure/README.md', contains: 'Med MockBankID är appen i demoläge' },
      {
        file: 'src/modules/eligibility/bankid/index.ts',
        contains: 'export const bankIdService: IBankIdService = new MockBankIdService()',
      },
      ...DEMO_PASSPHRASES_SEEDED,
      { file: 'src/lib/crypto/share-storage.ts', contains: 'function keyFor(passphrase: string, electionId: string, trusteeIndex: number): Buffer {' },
    ],
  },

  secretsInFilesLocally: {
    text:
      'Lokalt läser appen hemligheterna ur .env, efter mönstret i .env.example, och med ' +
      'docker-compose står de i klartext i docker-compose.yml.',
    holdsWhile: [
      { file: '.env.example', contains: 'IDENTITY_PEPPER="byt-ut-mig-detta-ar-bara-for-lokal-utveckling-0000"' },
      { file: 'docker-compose.yml', contains: 'IDENTITY_PEPPER: byt-ut-mig-detta-ar-bara-for-lokal-utveckling-0000' },
    ],
  },

  sharesNotInVault: {
    text:
      'Förtroendemännens andelar ligger i trustee_share i röstdatabasen, krypterade med AES-256-GCM ' +
      'under en nyckel som scrypt härleder ur förtroendemannens lösenfras. Varken mallarna eller ' +
      'distributionen nämner dem.',
    holdsWhile: [
      {
        file: 'src/lib/crypto/share-storage.ts',
        contains: "createCipheriv('aes-256-gcm', keyFor(passphrase, electionId, trusteeIndex), iv)",
      },
      {
        file: 'src/lib/crypto/share-storage.ts',
        contains: 'return scryptSync(passphrase, `trustee-share-${electionId}-${trusteeIndex}`, 32)',
      },
      { file: 'prisma/votes/schema.prisma', contains: 'encryptedShare String @map("encrypted_share")' },
      ...NO_TRUSTEE_SECRETS_IN_AZURE,
    ],
  },

  electionKeyNotStored: {
    text:
      'Valets privata nyckel lagras inte alls: utdelaren delar den i tre andelar när valet skapas, ' +
      'och röstdatabasen har ingen kolumn för en privat nyckel.',
    holdsWhile: [
      { file: 'src/orchestration/create-election.usecase.ts', contains: 'splitSecret(keys.privateKey' },
      { nowhereIn: 'prisma/votes/schema.prisma', matches: /private/i },
    ],
  },

  mockIssuerInRepo: {
    text: 'Attrappens utfärdande mellannivå är incheckad i repot, med sin privata nyckel, som testnyckel.',
    holdsWhile: [
      {
        file: 'src/modules/eligibility/bankid/MockBankIdService.ts',
        contains: "from './mock-ca/issuing-ca-test-key'",
      },
    ],
  },

  oldSigningKeysInDatabase: {
    text: 'Det gamla flödets signeringsnycklar ligger i election_ballot i röstlängden, en per valsedel.',
    holdsWhile: [
      { file: 'prisma/voters/schema.prisma', contains: 'signingPrivateKeyPem String @map("signing_private_key_pem")' },
      { file: 'prisma/voters/schema.prisma', contains: '@@map("election_ballot")' },
    ],
  },

  // -------------------------------------------------------------------------
  // Azure-uppsättningen på Utvecklingsstatus
  // -------------------------------------------------------------------------

  azureSetupBuilt: {
    text:
      'Azure-uppsättningen finns som Bicep i infra/azure och distribueras med deploy.sh: en Container ' +
      'App med exakt en replika, PostgreSQL Flexible Server utan publik ändpunkt i ett eget ' +
      'virtuellt nätverk, Key Vault för hemligheterna och en roll per databas. Imagen byggs ur git ' +
      'archive av en commit, aldrig ur arbetskatalogen.',
    holdsWhile: [
      { file: 'infra/azure/app.bicep', contains: 'scale: { minReplicas: 1, maxReplicas: 1 }' },
      { file: 'infra/azure/postgres.bicep', contains: "publicNetworkAccess: 'Disabled'" },
      { file: 'infra/azure/postgres.bicep', contains: 'delegatedSubnetResourceId: delegatedSubnetId' },
      { file: 'infra/azure/keyvault.bicep', contains: "resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {" },
      { file: 'infra/azure/db-init.sql', contains: 'CREATE ROLE voters_app LOGIN' },
      { file: 'infra/azure/db-init.sql', contains: 'CREATE ROLE votes_app LOGIN' },
      { file: 'infra/azure/deploy.sh', contains: 'archive "$COMMIT" | tar -x -C "$WORK/src"' },
      { file: 'infra/azure/deploy.sh', contains: 'deploy_retry app app.bicep' },
    ],
  },

  azureNotBuilt: {
    text:
      'Inte byggt i Azure: granskningslogg för valvet, rensningsskydd, att pepparn stannar i en HSM ' +
      'och att identitetshashen och kedjornas nyckel räknas där, och fler än en replika. Fler ' +
      'repliker kräver att attrappens ordrar, hastighetsbegränsningen och antagningskön först flyttar ' +
      'ur processminnet.',
    holdsWhile: [
      NO_VAULT_AUDIT_LOG,
      NO_PURGE_PROTECTION,
      ...PEPPER_FROM_VAULT,
      VAULT_SKU_STANDARD,
      { file: 'infra/azure/app.bicep', contains: 'scale: { minReplicas: 1, maxReplicas: 1 }' },
      {
        file: 'infra/azure/app.bicep',
        contains: '// MockBankID:s ordrar, hastighetsbegränsningen och antagningskön ligger i',
      },
      { file: 'src/lib/admission-queue.ts', contains: 'const waiting: Waiter[] = []' },
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
          contains: 'await validateEnvelopes(snapshot)',
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
