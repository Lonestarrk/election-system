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
    /**
     * MÖNSTREN MÅSTE MATCHA DEKLARATIONEN, INTE BARA NAMNET.
     *
     * När modellen hette AnonymousVote räckte /model AnonymousVote/, eftersom
     * inget annat började så. Efter namnbytet till Vote gör det inte det:
     * röstlängden har VoterStatus, VoterBallotStatus och VotingSession, och
     * /model Vote/ matchar den första av dem.
     *
     * Testet gick alltså rött av rätt skäl men på fel grund — det påstod att
     * röstlängden innehöll röstmodellen när den innehöll VoterStatus. Ett
     * falskt positivt i ett säkerhetstest är farligt på sikt: det är den
     * sortens rödhet någon "fixar" genom att slappna av assertionen.
     *
     * ` \{` binder mönstret till modellhuvudet och kan inte träffa ett
     * längre namn.
     */
    expect(votersFields).not.toMatch(/model Vote \{/)
    expect(votersFields).not.toMatch(/model Party \{/)
    expect(votersFields).not.toMatch(/@map\("vote"\)/)
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

  it('Vote innehåller ingen identitet och ingen session', () => {
    const model = votesFields.match(/model Vote \{[\s\S]*?\n\}/)?.[0] ?? ''
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
      expect(model, `Vote innehåller ${forbidden}`).not.toContain(forbidden)
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
    const model = votesFields.match(/model Vote \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(model).toBeTruthy()

    for (const forbidden of ['areaCode', 'area_code', 'municipality', 'region']) {
      expect(model, `Vote innehåller ${forbidden}`).not.toContain(forbidden)
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

    const model = votesFields.match(/model Vote \{[\s\S]*?\n\}/)?.[0] ?? ''
    // Ett fält som grupperar flera röster vore samma profil under annat namn.
    for (const forbidden of ['receiptId', 'receipt_id', 'groupId', 'group_id', 'batchId']) {
      expect(model, `Vote innehåller ${forbidden}`).not.toContain(forbidden)
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

  it('PendingVote bär identitet och hör därför hemma i röstlängden', () => {
    expect(votersFields).toMatch(/model PendingVote \{/)
    expect(votesFields).not.toMatch(/model PendingVote \{/)
  })

  it('EncryptedVote innehåller ingen identitet', () => {
    const model = votesFields.match(/model EncryptedVote \{[\s\S]*?\n\}/)?.[0] ?? ''

    expect(model).not.toBe('')
    for (const forbidden of ['voterStatusId', 'personalNumber', 'identityHash', 'sessionId']) {
      expect(model, `EncryptedVote innehåller ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('kopplingen har en unik nyckel per väljare och valsedel', () => {
    // Utan den kan en väljare få två liggande röster på samma valsedel, och
    // skalningen skulle flytta båda.
    const model = votersFields.match(/model PendingVote \{[\s\S]*?\n\}/)?.[0] ?? ''

    expect(model).toContain('@@unique([voterStatusId, ballotId])')
  })

  it('ordningsnumren ar unika, sa den kanoniska ordningen ar total', () => {
    /**
     * Utan detta faller sorteringen tillbaka pa insattningsordning nar tva
     * alternativ delar displayOrder — och klient och server kan da numrera
     * valsedeln olika. Rosten hamnar pa fel alternativ, och inget bevis ser det.
     */
    const ballotParty = votesFields.match(/model BallotParty \{[\s\S]*?\n\}/)?.[0] ?? ''
    const candidate = votesFields.match(/model Candidate \{[\s\S]*?\n\}/)?.[0] ?? ''

    expect(ballotParty).toContain('@@unique([ballotId, displayOrder])')
    expect(candidate).toContain('@@unique([ballotPartyId, displayOrder])')
  })

  it('pending_votes främmande nyckel mot voter_status är RESTRICT i den applicerade SQL:en, inte bara i schemat', () => {
    /**
     * En kaskad hade tyst tagit en struken väljares röst med sig, och det är
     * precis det beslutet avvisar: en struken väljares röst ska räknas
     * (spec 7.4). Schemat säger `onDelete: Restrict`, men det är SQL:en som
     * faktiskt körs mot databasen — och den här migreringen skrevs för hand
     * i stället för att genereras av CLI:t, så den är precis där en
     * felskriven eller ihop-slarvad CASCADE skulle smita förbi ett test som
     * bara läser schema.prisma.
     *
     * Mönstret binder till hela ALTER TABLE-satsen för just
     * pending_vote_voter_status_id_fkey, så det inte kan träffa någon annan
     * RESTRICT eller CASCADE någon annanstans i filen.
     */
    expect(votersMigrations).toMatch(
      /ALTER TABLE "pending_vote" ADD CONSTRAINT "pending_vote_voter_status_id_fkey" FOREIGN KEY \("voter_status_id"\) REFERENCES "voter_status"\("id"\) ON DELETE RESTRICT/,
    )
  })

  it('displayOrder-unikheten finns även i den applicerade SQL:en, inte bara i schemat', () => {
    // Samma skäl som ovan: den kanoniska ordningen är bara total om
    // databasen faktiskt stoppar en dubblett, inte bara om schemat påstår
    // att den gör det. Mönstren binder till index- och tabellnamnet
    // tillsammans, så de inte kan träffa något annat unikt index i filen.
    expect(votesMigrations).toMatch(
      /CREATE UNIQUE INDEX "ballot_party_ballot_id_display_order_key" ON "ballot_party"\("ballot_id", "display_order"\)/,
    )
    expect(votesMigrations).toMatch(
      /CREATE UNIQUE INDEX "candidate_ballot_party_id_display_order_key" ON "candidate"\("ballot_party_id", "display_order"\)/,
    )
  })

  it('ciphertextHash är unik på encrypted_vote i SQL:en, så skalningen blir idempotent', () => {
    // En avbruten skalningskörning kan köras om utan att skapa dubbletter —
    // men bara om databasen faktiskt stoppar en andra insättning av samma
    // chiffer. Ett unikt fält i schema.prisma utan ett unikt index i den
    // körda SQL:en vore ingen spärr alls.
    expect(votesMigrations).toMatch(
      /CREATE UNIQUE INDEX "encrypted_vote_ciphertext_hash_key" ON "encrypted_vote"\("ciphertext_hash"\)/,
    )
  })
})
