import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Testpunkt 9 (schemadel): det finns ingen relation mellan väljaridentitet och
 * röst — varken i Prisma-schemana eller i den SQL som faktiskt kör.
 */

const votersSchema = readFileSync(join(process.cwd(), 'prisma/voters/schema.prisma'), 'utf8')
const votesSchema = readFileSync(join(process.cwd(), 'prisma/votes/schema.prisma'), 'utf8')

/**
 * Tar bort kommentarer före granskning.
 *
 * Schemafilerna är fulla av prosa som förklarar varför fälten ser ut som de
 * gör, och den prosan nämner med nödvändighet både väljare och röster. Testet
 * ska granska fältdefinitionerna, inte texten runt omkring — annars blir en
 * bra förklaring ett testfel.
 */
function withoutComments(schema: string): string {
  return schema
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const votersFields = withoutComments(votersSchema)
const votesFields = withoutComments(votesSchema)

function readMigrations(directory: string): string {
  const base = join(process.cwd(), directory)
  return readdirSync(base)
    .filter((entry) => entry !== 'migration_lock.toml')
    .map((entry) => readFileSync(join(base, entry, 'migration.sql'), 'utf8'))
    .join('\n')
}

const votersMigrations = readMigrations('prisma/voters/migrations')
const votesMigrations = readMigrations('prisma/votes/migrations')

describe('databasseparation', () => {
  it('schemana pekar på olika databaser', () => {
    expect(votersSchema).toContain('env("VOTERS_DATABASE_URL")')
    expect(votesSchema).toContain('env("VOTES_DATABASE_URL")')
    expect(votersSchema).not.toContain('VOTES_DATABASE_URL')
    expect(votesSchema).not.toContain('VOTERS_DATABASE_URL')
  })

  it('röstlängdsschemat känner inte till röster eller partier', () => {
    expect(votersFields).not.toMatch(/model AnonymousVote/)
    expect(votersFields).not.toMatch(/model Party/)
    expect(votersFields).not.toMatch(/@map\("anonymous_vote"\)/)
  })

  it('röstschemat känner inte till väljare eller sessioner', () => {
    expect(votesFields).not.toMatch(/model VoterStatus/)
    expect(votesFields).not.toMatch(/model VotingSession/)
    expect(votesFields).not.toMatch(/@map\("voter_status"\)/)
  })

  it('VoterStatus innehåller ingen token och inget parti', () => {
    const model = votersFields.match(/model VoterStatus \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(model).toBeTruthy()

    for (const forbidden of ['token', 'Token', 'party', 'Party', 'vote_id', 'voteId']) {
      expect(model, `VoterStatus innehåller ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('AnonymousVote innehåller ingen identitet och ingen session', () => {
    const model = votesFields.match(/model AnonymousVote \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(model).toBeTruthy()

    for (const forbidden of [
      'voter',
      'Voter',
      'identity',
      'Identity',
      'personal',
      'session',
      'Session',
      'ipAddress',
      'ip_address',
    ]) {
      expect(model, `AnonymousVote innehåller ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('ingen migration skapar en foreign key mellan de två tabellerna', () => {
    // voter_status får aldrig nämnas i röstdatabasens SQL, och tvärtom.
    expect(votesMigrations).not.toMatch(/voter_status/)
    expect(votesMigrations).not.toMatch(/voting_session/)
    expect(votersMigrations).not.toMatch(/anonymous_vote/)
    expect(votersMigrations).not.toMatch(/\bparty\b/)
  })

  it('varje foreign key i SQL:en pekar på en tabell i samma databas', () => {
    /**
     * Listorna vidgades när omröstningen blev ett eget begrepp. Det som
     * testas är oförändrat: varje foreign key stannar inom sin egen databas.
     *
     * Notera att `election` och `election_ballot` finns i BÅDA listorna. Det
     * är speglingen — samma UUID i två databaser, utan foreign key emellan,
     * eftersom en sådan är fysiskt omöjlig. Att båda sidor får peka på sin
     * egen kopia är hela poängen med konstruktionen.
     */
    const foreignKeyPattern = /REFERENCES "(\w+)"/g

    const votersTargets = [...votersMigrations.matchAll(foreignKeyPattern)].map((match) => match[1])
    const votesTargets = [...votesMigrations.matchAll(foreignKeyPattern)].map((match) => match[1])

    const votersAllowed = ['voter_status', 'voting_session', 'election', 'election_ballot']
    const votesAllowed = [
      'party',
      'anonymous_vote',
      'election',
      'election_ballot',
      'ballot_party',
      'ballot_option',
      'candidate',
    ]

    expect(votersTargets.every((table) => votersAllowed.includes(table!))).toBe(true)
    expect(votesTargets.every((table) => votesAllowed.includes(table!))).toBe(true)
  })

  it('röstlängden känner inte till partier, kandidater eller svarsalternativ', () => {
    // Speglingen tar med omröstningen och valsedlarna — aldrig vad man kan
    // rösta PÅ. Röstlängden ska kunna svara på "har den här personen röstat
    // på kommunvalsedeln?" men inte kunna formulera frågan "vilka partier
    // fanns att välja mellan?", eftersom nästa steg därifrån är att lagra
    // svaret.
    for (const model of ['model Party', 'model Candidate', 'model BallotParty', 'model BallotOption']) {
      expect(votersFields, `röstlängden innehåller ${model}`).not.toContain(model)
    }
    expect(votersMigrations).not.toMatch(/"candidate"/)
    expect(votersMigrations).not.toMatch(/"ballot_party"/)
  })

  it('rösten bär ingen geografisk markering', () => {
    /**
     * Kommun- och regionkoden står på VALSEDELN och på VÄLJAREN, aldrig på
     * rösten. Vilken kommun en valsedel gäller är offentligt. Vilken kommun
     * en enskild röst kom från vore ett geografiskt filter ovanpå ett
     * partival — och i en liten kommun med ett ovanligt parti räcker det
     * långt mot att peka ut någon.
     */
    const model = votesFields.match(/model AnonymousVote \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(model).toBeTruthy()

    for (const forbidden of ['areaCode', 'area_code', 'municipality', 'region']) {
      expect(model, `AnonymousVote innehåller ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('push-prenumerationen har ingen koppling till en identitet', () => {
    /**
     * En push-endpoint är i praktiken en enhetsidentifierare. Ligger den
     * bredvid ett identitetshash avslöjar en databasdump vilken telefon som
     * hör till vilken person — en ny avanonymiseringsyta införd för en
     * bekvämlighetsfunktion.
     *
     * Tabellen får därför inte ha någon foreign key alls.
     */
    const model = votersFields.match(/model PushSubscription \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(model).toBeTruthy()

    for (const forbidden of ['VoterStatus', 'voterStatusId', 'externalIdentityHash', 'identity']) {
      expect(model, `PushSubscription innehåller ${forbidden}`).not.toContain(forbidden)
    }

    const table = votersMigrations.match(/CREATE TABLE "push_subscription"[\s\S]*?\);/)?.[0] ?? ''
    expect(table).toBeTruthy()
    expect(table, 'push_subscription har en foreign key').not.toMatch(/REFERENCES/)
  })

  it('varje valsedel har en egen token, så de tre rösterna inte bildar en profil', () => {
    // En gemensam token över kommun-, landstings- och riksdagsvalsedeln
    // skulle binda ihop de tre till en profil, och tre partival tillsammans
    // är långt mer identifierande än ett. Unikhetskravet på token_hash är det
    // som gör att en rad aldrig kan delas av flera valsedlar.
    expect(votesMigrations).toMatch(/CREATE UNIQUE INDEX "anonymous_vote_token_hash_key"/)

    const model = votesFields.match(/model AnonymousVote \{[\s\S]*?\n\}/)?.[0] ?? ''
    // Ett fält som grupperar flera röster vore samma profil under annat namn.
    for (const forbidden of ['receiptId', 'receipt_id', 'groupId', 'group_id', 'batchId']) {
      expect(model, `AnonymousVote innehåller ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('token lagras med unikt index, så en kollision blir ett fel', () => {
    expect(votesMigrations).toMatch(/CREATE UNIQUE INDEX "anonymous_vote_token_hash_key"/)
  })

  it('token-kolumnen heter token_hash — inte token', () => {
    // Namnet är en påminnelse om att klartexten aldrig lagras.
    expect(votesSchema).toContain('@map("token_hash")')
    expect(votesSchema).not.toMatch(/@map\("token"\)/)
  })
})
