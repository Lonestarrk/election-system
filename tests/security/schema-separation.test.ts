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
    const foreignKeyPattern = /REFERENCES "(\w+)"/g

    const votersTargets = [...votersMigrations.matchAll(foreignKeyPattern)].map((match) => match[1])
    const votesTargets = [...votesMigrations.matchAll(foreignKeyPattern)].map((match) => match[1])

    expect(votersTargets.every((table) => ['voter_status', 'voting_session'].includes(table!))).toBe(
      true,
    )
    expect(votesTargets.every((table) => ['party', 'anonymous_vote'].includes(table!))).toBe(true)
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
