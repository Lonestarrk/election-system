import { jsonResponse } from '@/lib/http'
import { votesDb } from '@/modules/anonymous-vote/db'
import { votersDb } from '@/modules/eligibility/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/demo/database-state
 *
 * Underlag till demonstrationssidan: innehållet i båda databaserna sida vid
 * sida, så att man med egna ögon kan se att det inte finns någon gemensam
 * kolumn att koppla ihop dem med.
 *
 * DEN HÄR ENDPOINTEN SKA INTE FINNAS I ETT SKARPT SYSTEM. Den är med för att
 * POC:ens hela poäng är att gå att granska. Tre saker görs ändå rätt, eftersom
 * ett dåligt exempel är sämre än inget exempel:
 *
 * 1. Hashvärden kortas av. Hela värden skulle göra det möjligt att slå upp en
 *    känd token direkt via demosidan.
 *
 * 2. Raderna sorteras på id, inte på insättningsordning. Databasens naturliga
 *    radordning återspeglar i vilken ordning saker skedde, och två listor i
 *    kronologisk ordning går att para ihop rad för rad — vilket vore precis
 *    den korrelation systemet är byggt för att förhindra. Eftersom id är
 *    slumpade UUID:er blandar sorteringen bort tidsordningen.
 *
 * 3. Foreign keys hämtas ur information_schema i båda databaserna, så att
 *    påståendet "det finns ingen relation" går att kontrollera i stället för
 *    att behöva tros på.
 */

type ForeignKeyRow = {
  table_name: string
  column_name: string
  foreign_table_name: string
  foreign_column_name: string
}

const FOREIGN_KEY_QUERY = `
  SELECT
    tc.table_name        AS table_name,
    kcu.column_name      AS column_name,
    ccu.table_name       AS foreign_table_name,
    ccu.column_name      AS foreign_column_name
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

function shorten(value: string): string {
  return `${value.slice(0, 12)}…`
}

const VOTER_COLUMNS = ['id', 'external_identity_hash', 'is_eligible', 'has_voted', 'voted_at']
const VOTE_COLUMNS = ['id', 'token_hash', 'party_id', 'created_at']

const VOTER_TABLES = ['voter_status', 'voting_session', 'audit_event']
const VOTE_TABLES = ['party', 'anonymous_vote']

export async function GET() {
  const [voters, votes, voterKeys, voteKeys] = await Promise.all([
    votersDb.voterStatus.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, externalIdentityHash: true, hasVoted: true, votedAt: true },
    }),
    votesDb.anonymousVote.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, tokenHash: true, createdAt: true, party: { select: { name: true } } },
    }),
    votersDb.$queryRawUnsafe<ForeignKeyRow[]>(FOREIGN_KEY_QUERY),
    votesDb.$queryRawUnsafe<ForeignKeyRow[]>(FOREIGN_KEY_QUERY),
  ])

  // Samtliga fullständiga värden ur båda tabellerna. Används bara för att
  // räkna fram överlappet nedan och returneras aldrig.
  const voterValues = new Set<string>()
  for (const voter of voters) {
    voterValues.add(voter.id)
    voterValues.add(voter.externalIdentityHash)
  }

  const voteValues = new Set<string>()
  for (const vote of votes) {
    voteValues.add(vote.id)
    voteValues.add(vote.tokenHash)
  }

  return jsonResponse({
    voterDatabase: {
      name: 'voters_db',
      table: 'voter_status',
      columns: VOTER_COLUMNS,
      rows: voters.map((voter) => ({
        id: shorten(voter.id),
        externalIdentityHash: shorten(voter.externalIdentityHash),
        hasVoted: voter.hasVoted,
        // Dygnsupplösning, precis som den lagras.
        votedAt: voter.votedAt ? voter.votedAt.toISOString().slice(0, 10) : null,
      })),
      foreignKeys: voterKeys,
    },
    voteDatabase: {
      name: 'votes_db',
      table: 'anonymous_vote',
      columns: VOTE_COLUMNS,
      rows: votes.map((vote) => ({
        id: shorten(vote.id),
        tokenHash: shorten(vote.tokenHash),
        party: vote.party.name,
        // Timupplösning, precis som den lagras.
        createdAt: vote.createdAt.toISOString().slice(0, 13).replace('T', ' ') + ':00',
      })),
      foreignKeys: voteKeys,
    },
    /**
     * Analysen räknas fram ur det som faktiskt hämtades — ingenting är
     * hårdkodat. En demonstration som bara påstår att listorna är tomma vore
     * värdelös; siffrorna ska komma från databasen och kunna bli något annat
     * än noll om någon bröt separationen.
     */
    analysis: {
      /**
       * Båda tabellerna har en kolumn som heter `id`. Det är ingen koppling —
       * det är två oberoende primärnycklar som råkar ha samma namn. Att
       * redovisa det i stället för att tysta ned det är hela poängen: se
       * `overlappingValues` nedan för vad som faktiskt spelar roll.
       */
      sharedColumnNames: VOTER_COLUMNS.filter((column) => VOTE_COLUMNS.includes(column)),

      /**
       * Det avgörande måttet: hur många värden förekommer i BÅDA databaserna?
       *
       * Jämförelsen görs på fullständiga värden (inte de avkortade som
       * returneras för visning) och täcker varje id och varje hash i båda
       * tabellerna. Är svaret noll finns det inget värde att göra en join på —
       * inte ens manuellt, inte ens av någon med båda databaserna framför sig.
       */
      overlappingValues: [...voterValues].filter((value) => voteValues.has(value)),
      valuesCompared: voterValues.size + voteValues.size,

      crossDatabaseForeignKeys: [
        ...voterKeys.filter((key) => !VOTER_TABLES.includes(key.foreign_table_name)),
        ...voteKeys.filter((key) => !VOTE_TABLES.includes(key.foreign_table_name)),
      ],

      note:
        'Foreign keys ovan pekar alltid på en tabell i samma databas. PostgreSQL ' +
        'tillåter inte foreign keys mellan databaser, så en relation mellan ' +
        'voter_status och anonymous_vote kan inte existera.',
    },
  })
}
