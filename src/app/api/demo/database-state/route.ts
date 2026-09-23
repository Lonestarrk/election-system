import { isDemoMode } from '@/lib/demo-mode'
import { errorResponse, jsonResponse } from '@/lib/http'
import { votesDb } from '@/modules/ballot-box/db'
import { votersDb } from '@/modules/eligibility/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/demo/database-state
 *
 * Underlaget till arkitektursidans livevy: båda databasernas innehåll som det
 * ser ut just nu, tabellerna från båda röstmodellerna, och några slutsatser
 * som räknas fram ur det som hämtats.
 *
 * FINNS BARA I DEMOLÄGET.
 *
 * Svaret visar röstlängden: varje väljares id och identitetshash, och medan
 * röstningen pågår vilken väljare som lagt vilket kuvert. Det är en insiders
 * vy av databasen, och den får ingen sida visa i skarpt läge. Rutten svarar
 * därför 404 utanför demoläget, med samma villkor och av samma skäl som de
 * andra rutterna under /api/demo: `isDemoMode()` i src/lib/demo-mode.ts, det
 * enda ställe där läget avgörs. 404 och inte 403: en rutt som inte finns ska
 * inte gå att skilja från en som finns men nekar.
 *
 * Villkoret saknades här fram till uppgift 11c, fast rutten redan då lämnade
 * ut röstlängden. Arkitektursidan anropar den bara i demoläget, men en sida som
 * låter bli att fråga är inget skydd. Skyddet är att svaret inte finns.
 *
 * VAD SOM VISAS HAR BYTT KARAKTÄR
 *
 * Den gamla demonstrationen gick ut på att det inte fanns någon koppling att
 * se. I kuvertmodellen finns kopplingen med flit medan röstningen pågår, i
 * kolumnen `pending_vote.voter_status_id`. Rutten visar den i stället för att
 * dölja den, eftersom en livevy som döljer den påstår mer än modellen ger. Den
 * visar samtidigt det som skyddar innehållet: att chiffret bredvid inte går att
 * läsa.
 *
 * FYRA SAKER GÖRS ÄNDÅ RÄTT, eftersom ett dåligt exempel är sämre än inget:
 *
 * 1. Id:n, hashar och stora tal kortas till sina första tolv tecken. Det
 *    räcker för att se att två värden är samma, till exempel att en rad i
 *    pending_vote pekar på en viss väljare, men svaret blir ingen fullständig
 *    kopia av röstlängden.
 *
 * 2. Raderna sorteras på id, inte i den ordning de skrevs. Databasens
 *    naturliga radordning speglar i vilken ordning saker hände, och två listor
 *    i tidsordning går att para ihop rad för rad. `pending_vote` har slumpade
 *    id:n, så sorteringen blandar bort tidsordningen. `encrypted_vote` har
 *    id:n härledda ur chifferhashen, så där ÄR id-ordningen innehållets ordning.
 *
 * 3. Främmande nycklar och kolumner hämtas ur information_schema i båda
 *    databaserna, och frågan som visar kopplingen körs på riktigt. Påståendena
 *    ska gå att kontrollera, inte behöva tros på.
 *
 * 4. Det hemliga väljs aldrig ut: väljarens BankID-signatur och nyckeln ur
 *    certifikatet, bevisen, förtroendemännens krypterade andelar och
 *    valsedlarnas privata signeringsnycklar. Kolumnerna finns, men ingenting ur
 *    dem lämnar databasen här.
 */

// ---------------------------------------------------------------------------
// Svarets form
//
// Exporteras som typer och inget annat. Arkitektursidan läser samma typer, så
// att en kolumn som tas bort här (till exempel den gamla tabellen `vote` när
// det gamla flödet raderas) blir ett kompileringsfel på sidan i stället för en
// tabell som tyst blir tom. Next.js tillåter bara vissa värden som export från
// en ruttfil, men typer syns inte för den kontrollen.
// ---------------------------------------------------------------------------

export type ForeignKey = {
  table_name: string
  column_name: string
  foreign_table_name: string
  foreign_column_name: string
}

/**
 * Hur ett chiffer visas: hur många par (c1, c2) det har, början på det första
 * paret och hur många siffror talen har.
 *
 * Mer behövs inte för att se att innehållet inte går att läsa. Null betyder
 * att det lagrade värdet inte har chiffrets form, vilket bara kan hända om
 * någon skrivit direkt i databasen.
 */
export type CiphertextPreview = { pairs: number; c1: string; c2: string; digits: number }

export type ElectionState = {
  /** Omröstningens id är offentligt och visas helt. */
  id: string
  name: string
  /** Ur röstlängden: OPEN | CLOSED | VALIDATED | STRIPPED | TALLIED | CERTIFIED. */
  phase: string
  closesAt: string
  /** När kopplingen raderades. Null medan röstningen pågår. */
  linkClearedAt: string | null
  /** Kuvertroten, avkortad. Null tills stängningen skrivit den. */
  envelopeRoot: string | null
  /** Ur röstdatabasen: valets publika krypteringsnyckel, avkortad. */
  encryptionPublicKey: string | null
  tallyCompletedAt: string | null
}

export type VoterStatusRow = {
  id: string
  externalIdentityHash: string
  isEligible: boolean
  isAdmin: boolean
}

/** Det yttre kuvertet. Här syns kopplingen, och den ska synas. */
export type PendingVoteRow = {
  id: string
  /** Kopplingen: samma avkortade värde som väljarens id i voter_status. */
  voterStatusId: string
  electionId: string | null
  ballotId: string
  ballotLabel: string | null
  ciphertextHash: string
  castSequence: number
  /** Dygnsupplöst, precis som det lagras. */
  updatedAt: string
  ciphertext: CiphertextPreview | null
}

/** Det inre kuvertet, efter stängningen. Har ingen kolumn som pekar på en väljare. */
export type EncryptedVoteRow = {
  id: string
  electionId: string | null
  ballotId: string
  ballotLabel: string | null
  ciphertextHash: string
  ciphertext: CiphertextPreview | null
}

export type TrusteeShareRow = { electionId: string; trusteeIndex: number; publicShare: string }

export type PartialDecryptionRow = {
  ballotId: string
  ballotLabel: string | null
  optionIndex: number
  trusteeIndex: number
  value: string
}

export type BallotTallyRow = {
  ballotId: string
  ballotLabel: string | null
  optionIndex: number
  count: number
}

/** GAMLA MODELLEN: en röst lagd med röstintyg och blind signatur. */
export type LegacyVoteRow = { id: string; tokenHash: string; ballotId: string; createdAt: string }

export type DatabaseState = {
  elections: ElectionState[]
  votersDb: {
    name: 'voters_db'
    voterStatus: VoterStatusRow[]
    pendingVote: PendingVoteRow[]
    /** Kolumnerna i pending_vote, ur information_schema. */
    pendingVoteColumns: string[]
    foreignKeys: ForeignKey[]
  }
  votesDb: {
    name: 'votes_db'
    encryptedVote: EncryptedVoteRow[]
    /** Kolumnerna i encrypted_vote, ur information_schema. */
    encryptedVoteColumns: string[]
    trusteeShare: TrusteeShareRow[]
    partialDecryption: PartialDecryptionRow[]
    ballotTally: BallotTallyRow[]
    /** Tabellen `vote`, som röstsidan fortfarande skriver till med det gamla flödet. */
    legacyVote: LegacyVoteRow[]
    foreignKeys: ForeignKey[]
  }
  analysis: {
    /** Frågan "vem röstade på vad", så som den går att ställa, och hur många rader den gav nyss. */
    linkQuery: { sql: string; rows: number }
    /** Hur många identitetsbärande värden ur röstlängden som jämfördes mot röstdatabasen. */
    identityValuesCompared: number
    /** Identitetsvärden som ändå finns i röstdatabasen. Ska vara tom. */
    identityValuesInVotesDb: string[]
    /**
     * Chifferhashar som just nu finns i BÅDA databaserna.
     *
     * Tom före stängningen, då hashen bara ligger i röstlängden bredvid
     * väljaren, och tom efter, då den bara ligger i röstdatabasen utan väljare.
     * Inte tom under själva stängningen, eller om en stängning avbrutits efter
     * flytten men före raderingen.
     */
    ciphertextHashesInBoth: string[]
    foreignKeysChecked: number
    /** Främmande nycklar som pekar ut ur sin egen databas. PostgreSQL tillåter inga. */
    foreignKeysAcrossDatabases: ForeignKey[]
  }
}

// ---------------------------------------------------------------------------
// Frågor
// ---------------------------------------------------------------------------

const FOREIGN_KEY_QUERY = `
  SELECT
    tc.table_name::text   AS table_name,
    kcu.column_name::text AS column_name,
    ccu.table_name::text  AS foreign_table_name,
    ccu.column_name::text AS foreign_column_name
  FROM information_schema.table_constraints AS tc
  JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage AS ccu
    ON ccu.constraint_name = tc.constraint_name
   AND ccu.table_schema = tc.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
  ORDER BY tc.table_name, kcu.column_name
`

const TABLE_QUERY = `
  SELECT table_name::text AS table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
`

/**
 * Frågan man skulle vilja ställa: vem röstade på vad.
 *
 * I den gamla modellen gick den inte att skriva färdigt. Nu går den att
 * skriva, och den körs mot röstlängden varje gång rutten anropas. Under
 * röstningen ger den en rad per kuvert: väljaren, och ett chiffer ingen kan
 * läsa. Efter stängningen ger den inga rader alls, eftersom pending_vote är
 * tom och encrypted_vote ligger i en annan databas utan någon kolumn att
 * joina på.
 *
 * Texten skickas med i svaret, så att sidan visar exakt den fråga som kördes.
 */
const LINK_QUERY = [
  'SELECT v.external_identity_hash, p.ballot_id, p.ciphertext',
  'FROM voter_status v',
  'JOIN pending_vote p ON p.voter_status_id = v.id',
].join('\n')

function columnsQuery(table: 'pending_vote' | 'encrypted_vote'): string {
  // Tabellnamnet är en av två konstanter, aldrig indata.
  return `
    SELECT column_name::text AS column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = '${table}'
    ORDER BY ordinal_position
  `
}

// ---------------------------------------------------------------------------
// Formatering
// ---------------------------------------------------------------------------

const SHOWN_CHARACTERS = 12

function shorten(value: string): string {
  return `${value.slice(0, SHOWN_CHARACTERS)}…`
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Timupplösning, precis som det gamla flödet lagrar sina röster. */
function hour(date: Date): string {
  return `${date.toISOString().slice(0, 13).replace('T', ' ')}:00`
}

/**
 * Chiffret som det lagras är en lista med par av decimalsträngar.
 *
 * Värdet kommer direkt ur databasen, förbi varje schema, och tolkas därför
 * försiktigt. En rad som inte har chiffrets form ska synas som det den är, inte
 * krascha livevyn.
 */
function previewCiphertext(value: unknown): CiphertextPreview | null {
  if (!Array.isArray(value) || value.length === 0) return null

  const first: unknown = value[0]
  if (typeof first !== 'object' || first === null) return null

  const { c1, c2 } = first as { c1?: unknown; c2?: unknown }
  if (typeof c1 !== 'string' || typeof c2 !== 'string') return null

  return { pairs: value.length, c1: shorten(c1), c2: shorten(c2), digits: c1.length }
}

// ---------------------------------------------------------------------------
// Rutten
// ---------------------------------------------------------------------------

/**
 * Väntar in ett objekt av frågor och ger tillbaka svaren under samma namn.
 *
 * Arton frågor körs samtidigt. Med `Promise.all` över en lista packas svaren
 * upp på position, och två svar av samma typ, till exempel de två listorna
 * med främmande nycklar, kan byta plats utan att kompilatorn märker något.
 * Med namn kan de inte det.
 */
async function awaitAll<T extends Record<string, PromiseLike<unknown>>>(
  queries: T,
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const entries = await Promise.all(
    Object.entries(queries).map(async ([name, query]) => [name, await query] as const),
  )
  return Object.fromEntries(entries) as { [K in keyof T]: Awaited<T[K]> }
}

export async function GET() {
  if (!isDemoMode()) {
    return errorResponse('NOT_FOUND', 'Rutten finns inte.', 404)
  }

  const {
    elections,
    voterBallots,
    voters,
    pendingVotes,
    pendingVoteColumns,
    voterKeys,
    voterTables,
    linkRows,
    voteElections,
    voteBallots,
    encryptedVotes,
    encryptedVoteColumns,
    trusteeShares,
    partialDecryptions,
    ballotTallies,
    legacyVotes,
    voteKeys,
    voteTables,
  } = await awaitAll({
    // --- voters_db ---------------------------------------------------------
    elections: votersDb.election.findMany({
      orderBy: { closesAt: 'asc' },
      select: {
        id: true,
        name: true,
        phase: true,
        closesAt: true,
        linkClearedAt: true,
        envelopeRoot: true,
      },
    }),
    // Bara id, omröstning och etikett. Spegeln bär också valsedelns privata
    // signeringsnyckel, och den väljs aldrig ut.
    voterBallots: votersDb.electionBallot.findMany({
      select: { id: true, electionId: true, label: true },
    }),
    voters: votersDb.voterStatus.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, externalIdentityHash: true, isEligible: true, isAdmin: true },
    }),
    pendingVotes: votersDb.pendingVote.findMany({
      orderBy: { id: 'asc' },
      // Varken signaturen, nyckeln ur certifikatet eller bevisen. Se punkt 4 ovan.
      select: {
        id: true,
        voterStatusId: true,
        ballotId: true,
        ciphertext: true,
        ciphertextHash: true,
        castSequence: true,
        updatedAt: true,
      },
    }),
    pendingVoteColumns: votersDb.$queryRawUnsafe<Array<{ column_name: string }>>(
      columnsQuery('pending_vote'),
    ),
    voterKeys: votersDb.$queryRawUnsafe<ForeignKey[]>(FOREIGN_KEY_QUERY),
    voterTables: votersDb.$queryRawUnsafe<Array<{ table_name: string }>>(TABLE_QUERY),
    linkRows: votersDb.$queryRawUnsafe<Array<{ rows: number }>>(
      `SELECT count(*)::int AS rows FROM (${LINK_QUERY}) AS link`,
    ),

    // --- votes_db ----------------------------------------------------------
    voteElections: votesDb.election.findMany({
      select: { id: true, encryptionPublicKey: true, tallyCompletedAt: true },
    }),
    voteBallots: votesDb.electionBallot.findMany({
      select: { id: true, electionId: true, label: true },
    }),
    encryptedVotes: votesDb.encryptedVote.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, ballotId: true, ciphertext: true, ciphertextHash: true },
    }),
    encryptedVoteColumns: votesDb.$queryRawUnsafe<Array<{ column_name: string }>>(
      columnsQuery('encrypted_vote'),
    ),
    // Den publika andelen, aldrig den krypterade.
    trusteeShares: votesDb.trusteeShare.findMany({
      orderBy: [{ electionId: 'asc' }, { trusteeIndex: 'asc' }],
      select: { electionId: true, trusteeIndex: true, publicShare: true },
    }),
    partialDecryptions: votesDb.partialDecryption.findMany({
      orderBy: [{ ballotId: 'asc' }, { optionIndex: 'asc' }, { trusteeIndex: 'asc' }],
      select: { ballotId: true, optionIndex: true, trusteeIndex: true, value: true },
    }),
    ballotTallies: votesDb.ballotTally.findMany({
      orderBy: [{ ballotId: 'asc' }, { optionIndex: 'asc' }],
      select: { ballotId: true, optionIndex: true, count: true },
    }),
    legacyVotes: votesDb.vote.findMany({
      orderBy: { id: 'asc' },
      // Bara valsedeln, inte partiet. Livevyn behöver inte avslöja vad någon
      // röstat på för att visa hur tabellen ser ut.
      select: { id: true, tokenHash: true, ballotId: true, createdAt: true },
    }),
    voteKeys: votesDb.$queryRawUnsafe<ForeignKey[]>(FOREIGN_KEY_QUERY),
    voteTables: votesDb.$queryRawUnsafe<Array<{ table_name: string }>>(TABLE_QUERY),
  })

  const voterBallotById = new Map(voterBallots.map((ballot) => [ballot.id, ballot]))
  const voteBallotById = new Map(voteBallots.map((ballot) => [ballot.id, ballot]))
  const voteElectionById = new Map(voteElections.map((election) => [election.id, election]))

  /**
   * Analysen räknas fram ur det som faktiskt hämtades. Ingenting är
   * hårdkodat: siffrorna kommer från databaserna och kan bli något annat än
   * noll om någon bröt separationen, eller om en stängning avbrutits mitt i.
   *
   * De fullständiga värdena används bara här och lämnar aldrig rutten.
   */
  const identityValues = new Set<string>()
  for (const voter of voters) {
    identityValues.add(voter.id)
    identityValues.add(voter.externalIdentityHash)
  }
  for (const pending of pendingVotes) {
    // Det yttre kuvertets id är bundet till väljaren lika mycket som väljarens eget.
    identityValues.add(pending.id)
    identityValues.add(pending.voterStatusId)
  }

  const votesDbValues = new Set<string>()
  for (const row of encryptedVotes) {
    votesDbValues.add(row.id)
    votesDbValues.add(row.ciphertextHash)
  }
  for (const row of legacyVotes) {
    votesDbValues.add(row.id)
    votesDbValues.add(row.tokenHash)
  }
  for (const row of partialDecryptions) votesDbValues.add(row.value)
  for (const row of trusteeShares) votesDbValues.add(row.publicShare)

  const encryptedHashes = new Set(encryptedVotes.map((row) => row.ciphertextHash))

  const voterTableNames = new Set(voterTables.map((table) => table.table_name))
  const voteTableNames = new Set(voteTables.map((table) => table.table_name))

  const state: DatabaseState = {
    elections: elections.map((election) => {
      const mirrored = voteElectionById.get(election.id)
      return {
        id: election.id,
        name: election.name,
        phase: election.phase,
        closesAt: election.closesAt.toISOString(),
        linkClearedAt: election.linkClearedAt?.toISOString() ?? null,
        envelopeRoot: election.envelopeRoot === null ? null : shorten(election.envelopeRoot),
        encryptionPublicKey: mirrored?.encryptionPublicKey
          ? shorten(mirrored.encryptionPublicKey)
          : null,
        tallyCompletedAt: mirrored?.tallyCompletedAt?.toISOString() ?? null,
      }
    }),

    votersDb: {
      name: 'voters_db',
      voterStatus: voters.map((voter) => ({
        id: shorten(voter.id),
        externalIdentityHash: shorten(voter.externalIdentityHash),
        isEligible: voter.isEligible,
        isAdmin: voter.isAdmin,
      })),
      pendingVote: pendingVotes.map((pending) => {
        const ballot = voterBallotById.get(pending.ballotId)
        return {
          id: shorten(pending.id),
          voterStatusId: shorten(pending.voterStatusId),
          electionId: ballot?.electionId ?? null,
          ballotId: shorten(pending.ballotId),
          ballotLabel: ballot?.label ?? null,
          ciphertextHash: shorten(pending.ciphertextHash),
          castSequence: pending.castSequence,
          updatedAt: day(pending.updatedAt),
          ciphertext: previewCiphertext(pending.ciphertext),
        }
      }),
      pendingVoteColumns: pendingVoteColumns.map((column) => column.column_name),
      foreignKeys: voterKeys,
    },

    votesDb: {
      name: 'votes_db',
      encryptedVote: encryptedVotes.map((row) => {
        const ballot = voteBallotById.get(row.ballotId)
        return {
          id: shorten(row.id),
          electionId: ballot?.electionId ?? null,
          ballotId: shorten(row.ballotId),
          ballotLabel: ballot?.label ?? null,
          ciphertextHash: shorten(row.ciphertextHash),
          ciphertext: previewCiphertext(row.ciphertext),
        }
      }),
      encryptedVoteColumns: encryptedVoteColumns.map((column) => column.column_name),
      trusteeShare: trusteeShares.map((share) => ({
        electionId: share.electionId,
        trusteeIndex: share.trusteeIndex,
        publicShare: shorten(share.publicShare),
      })),
      partialDecryption: partialDecryptions.map((row) => ({
        ballotId: shorten(row.ballotId),
        ballotLabel: voteBallotById.get(row.ballotId)?.label ?? null,
        optionIndex: row.optionIndex,
        trusteeIndex: row.trusteeIndex,
        value: shorten(row.value),
      })),
      ballotTally: ballotTallies.map((row) => ({
        ballotId: shorten(row.ballotId),
        ballotLabel: voteBallotById.get(row.ballotId)?.label ?? null,
        optionIndex: row.optionIndex,
        count: row.count,
      })),
      legacyVote: legacyVotes.map((vote) => ({
        id: shorten(vote.id),
        tokenHash: shorten(vote.tokenHash),
        ballotId: shorten(vote.ballotId),
        createdAt: hour(vote.createdAt),
      })),
      foreignKeys: voteKeys,
    },

    analysis: {
      linkQuery: { sql: LINK_QUERY, rows: linkRows[0]?.rows ?? 0 },
      identityValuesCompared: identityValues.size,
      identityValuesInVotesDb: [...identityValues]
        .filter((value) => votesDbValues.has(value))
        .map(shorten),
      ciphertextHashesInBoth: pendingVotes
        .filter((pending) => encryptedHashes.has(pending.ciphertextHash))
        .map((pending) => shorten(pending.ciphertextHash)),
      foreignKeysChecked: voterKeys.length + voteKeys.length,
      /**
       * Räknas fram mot tabellistan ur samma databas, inte mot en handskriven
       * lista. Den tidigare listan hade hunnit bli fel: den räknade upp
       * `anonymous_vote`, som bytt namn till `vote`, och saknade tabellerna
       * kuvertmodellen lade till.
       */
      foreignKeysAcrossDatabases: [
        ...voterKeys.filter((key) => !voterTableNames.has(key.foreign_table_name)),
        ...voteKeys.filter((key) => !voteTableNames.has(key.foreign_table_name)),
      ],
    },
  }

  return jsonResponse(state)
}
