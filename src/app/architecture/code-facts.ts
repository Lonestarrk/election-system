/**
 * VAD ARKITEKTURSIDAN PÅSTÅR OM KODEN I DAG, MED MARKÖRER.
 *
 * Sidan beskriver en modell som är halvvägs byggd. En del av det den säger
 * handlar därför om kodens nuvarande läge: att röstsidan fortfarande kör det
 * gamla flödet, att dekrypteringen inte är byggd, vilka faser som faktiskt
 * skrivs. Sådana påståenden blir fel av sig själva i samma stund som en senare
 * uppgift gör klart något, och den som gör klart det har ingen anledning att
 * öppna arkitektursidan.
 *
 * Lösningen är densamma som i src/lib/known-limitations.ts. Varje påstående
 * bär en eller flera markörer i källkoden som är sanna SÅ LÄNGE påståendet är
 * sant, och tests/security/architecture-page.test.ts går rött när en markör
 * inte längre håller. Sidan läser texterna härifrån och skriver dem inte
 * själv, så det finns en enda plats att rätta.
 *
 * Två sorters markörer:
 *
 *   { file, contains }     sann så länge filen innehåller strängen.
 *   { nowhereIn, matches } sann så länge ingen källfil under sökvägen (en
 *                          katalog eller en enskild fil) matchar mönstret.
 *                          För påståenden om att något INTE finns.
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

export const CURRENTLY = {
  votePageUsesOldFlow: {
    text:
      'Röstsidan lägger fortfarande röster med det gamla flödet, röstintyg och blinda ' +
      'signaturer, och skriver dem till tabellen vote.',
    holdsWhile: [{ file: 'src/app/vote/page.tsx', contains: "fetch('/api/vote/cast'" }],
  },

  decryptionNotBuilt: {
    text:
      'Tröskeldekrypteringen är inte byggd, så partial_decryption och ballot_tally förblir ' +
      'tomma.',
    short: 'steget är inte byggt än',
    holdsWhile: [DECRYPTION_NOT_BUILT],
  },

  encryptedVotesNotPublished: {
    text:
      'Chiffren publiceras inte än. Observatörsgränssnittet lämnar fortfarande ut det gamla ' +
      'flödets röster.',
    holdsWhile: [{ file: 'src/app/api/observer/votes/route.ts', contains: 'votesDb.vote.findMany' }],
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
