import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/anonymous-vote/db'
import { evaluateEligibility } from '@/modules/eligibility/voter-status.service'
import {
  createVotingSession,
  getValidVotingSession,
} from '@/modules/eligibility/voting-session.service'
import { verifyToken } from '@/modules/anonymous-vote'
import { hashToken } from '@/modules/anonymous-vote/token.service'
import { castVote } from '@/orchestration/cast-vote.usecase'
import {
  createVoter,
  disconnect,
  firstPartyId,
  isDatabaseAvailable,
  resetElectionData,
} from './helpers'

const databaseAvailable = await isDatabaseAvailable()

if (!databaseAvailable) {
  console.warn('\n  Ingen databas tillgänglig — integrationstesterna hoppas över.\n')
}

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

describe.skipIf(!databaseAvailable)('röstningsflödet mot riktig databas', () => {
  beforeEach(async () => {
    await resetElectionData()
  })

  /** Testpunkt 2: en röstberättigad väljare kan rösta. */
  it('en röstberättigad väljare kan rösta och får en token', async () => {
    const voterId = await createVoter('199001011234')
    const session = await createVotingSession(voterId)
    const partyId = await firstPartyId()

    const outcome = await castVote(session, partyId)

    expect(outcome.status).toBe('success')
    if (outcome.status !== 'success') return

    expect(outcome.token).toMatch(/^[0-9A-Z]{8}(-[0-9A-Z]{8}){5}$/)

    const voter = await votersDb.voterStatus.findUnique({ where: { id: voterId } })
    expect(voter?.hasVoted).toBe(true)

    expect(await votesDb.anonymousVote.count()).toBe(1)
  })

  /** Testpunkt 3: en väljare kan inte rösta två gånger. */
  it('samma väljare kan inte rösta två gånger', async () => {
    const voterId = await createVoter('199001011234')
    const partyId = await firstPartyId()

    const first = await castVote(await createVotingSession(voterId), partyId)
    expect(first.status).toBe('success')

    // Ny session efter att rösten lagts — vilket i praktiken kräver en ny
    // legitimering. Spärren ska ändå hålla.
    const second = await castVote(await createVotingSession(voterId), partyId)
    expect(second.status).toBe('already_voted')

    expect(await votesDb.anonymousVote.count()).toBe(1)
  })

  it('två samtidiga röstförsök från samma väljare ger bara en röst', async () => {
    const voterId = await createVoter('199001011234')
    const partyId = await firstPartyId()

    const sessionA = await createVotingSession(voterId)
    const sessionB = await votersDb.votingSession.create({
      data: {
        voterStatusId: voterId,
        expiresAt: new Date(Date.now() + 600_000),
        csrfSecret: 'test',
      },
      select: { id: true, voterStatusId: true, csrfSecret: true },
    })

    const [resultA, resultB] = await Promise.all([
      castVote(sessionA, partyId),
      castVote(sessionB, partyId),
    ])

    const successes = [resultA, resultB].filter((result) => result.status === 'success')

    // Det villkorade `updateMany ... where hasVoted = false` serialiseras av
    // PostgreSQL. Ett läs-testa-skriv i JavaScript hade släppt igenom båda.
    expect(successes).toHaveLength(1)
    expect(await votesDb.anonymousVote.count()).toBe(1)
  })

  /** Testpunkt 4: en icke röstberättigad väljare kan inte rösta. */
  it('en icke röstberättigad person avvisas vid röstberättigandekontrollen', async () => {
    await createVoter('201001014567', { isEligible: false })

    const decision = await evaluateEligibility('201001014567')
    expect(decision.outcome).toBe('not_eligible')
    expect(await votesDb.anonymousVote.count()).toBe(0)
  })

  it('en person som inte finns i röstlängden avvisas', async () => {
    const decision = await evaluateEligibility('199912319999')
    expect(decision.outcome).toBe('not_in_roll')
  })

  it('en person som redan röstat avvisas redan vid legitimeringen', async () => {
    await createVoter('194204048901', { hasVoted: true })

    const decision = await evaluateEligibility('194204048901')
    expect(decision.outcome).toBe('already_voted')
  })

  it('röstsessionen raderas när rösten lagts', async () => {
    const voterId = await createVoter('199001011234')
    const session = await createVotingSession(voterId)

    await castVote(session, await firstPartyId())

    // Sessionen är borta, inte markerad som förbrukad. En kvarlämnad rad vore
    // exakt den koppling systemet är byggt för att inte lämna efter sig.
    expect(await getValidVotingSession(session.id)).toBeNull()
    expect(await votersDb.votingSession.count()).toBe(0)
  })

  it('ett ogiltigt parti bränner inte väljarens rösträtt', async () => {
    const voterId = await createVoter('199001011234')
    const session = await createVotingSession(voterId)

    const outcome = await castVote(session, '00000000-0000-0000-0000-000000000000')

    expect(outcome.status).toBe('invalid_party')

    const voter = await votersDb.voterStatus.findUnique({ where: { id: voterId } })
    expect(voter?.hasVoted).toBe(false)
    expect(await votesDb.anonymousVote.count()).toBe(0)
  })
})

describe.skipIf(!databaseAvailable)('verifiering', () => {
  beforeEach(async () => {
    await resetElectionData()
  })

  /** Testpunkt 6: en token verifierar motsvarande anonyma röst. */
  it('en token bekräftar rösten och visar partiet', async () => {
    const voterId = await createVoter('199001011234')
    const partyId = await firstPartyId()
    const party = await votesDb.party.findUniqueOrThrow({ where: { id: partyId } })

    const outcome = await castVote(await createVotingSession(voterId), partyId)
    if (outcome.status !== 'success') throw new Error('Röstningen misslyckades')

    const result = await verifyToken(outcome.token)

    expect(result).toEqual({ registered: true, party: party.name })
  })

  it('en okänd token ger inget svar om någon röst', async () => {
    const result = await verifyToken('ABCDEFGH-JKMNPQRS-TVWXYZ01-23456789-ABCDEFGH-JKMNPQRS')
    expect(result).toEqual({ registered: false })
  })

  /** Testpunkt 12: verifieringen avslöjar inte väljarens identitet. */
  it('svaret innehåller inga andra fält än registrerad och parti', async () => {
    const voterId = await createVoter('199001011234')
    const outcome = await castVote(await createVotingSession(voterId), await firstPartyId())
    if (outcome.status !== 'success') throw new Error('Röstningen misslyckades')

    const result = await verifyToken(outcome.token)

    expect(Object.keys(result).sort()).toEqual(['party', 'registered'])

    const serialised = JSON.stringify(result)
    expect(serialised).not.toContain(voterId)
    expect(serialised).not.toContain('199001011234')
  })

  it('token fungerar även med bindestreck borttagna och i gemener', async () => {
    const voterId = await createVoter('199001011234')
    const outcome = await castVote(await createVotingSession(voterId), await firstPartyId())
    if (outcome.status !== 'success') throw new Error('Röstningen misslyckades')

    const messy = outcome.token.replace(/-/g, '').toLowerCase()
    expect((await verifyToken(messy)).registered).toBe(true)
  })

  /** Testpunkt 13 mot databasen: två väljare får aldrig samma token. */
  it('flera väljare får olika tokens', async () => {
    const partyId = await firstPartyId()
    const tokens = new Set<string>()

    for (let index = 0; index < 25; index += 1) {
      const voterId = await createVoter(`1990010${String(index).padStart(5, '0')}`)
      const outcome = await castVote(await createVotingSession(voterId), partyId)
      if (outcome.status !== 'success') throw new Error('Röstningen misslyckades')
      tokens.add(outcome.token)
    }

    expect(tokens.size).toBe(25)
    expect(await votesDb.anonymousVote.count()).toBe(25)
  })
})

describe.skipIf(!databaseAvailable)('databasens faktiska innehåll efter röstning', () => {
  beforeEach(async () => {
    await resetElectionData()
  })

  /**
   * Testpunkt 9: ingen relation mellan väljaridentitet och röst.
   * Testpunkt 7: en token kan inte avslöja väljarens identitet.
   */
  it('ingen rad i någon databas kopplar väljaren till rösten', async () => {
    const voterId = await createVoter('199001011234')
    const partyId = await firstPartyId()
    const session = await createVotingSession(voterId)

    const outcome = await castVote(session, partyId)
    if (outcome.status !== 'success') throw new Error('Röstningen misslyckades')

    const voter = await votersDb.voterStatus.findUniqueOrThrow({ where: { id: voterId } })
    const vote = await votesDb.anonymousVote.findFirstOrThrow()

    const voterRow = JSON.stringify(voter)
    const voteRow = JSON.stringify(vote)

    // Väljarraden känner inte till rösten.
    expect(voterRow).not.toContain(vote.id)
    expect(voterRow).not.toContain(vote.tokenHash)
    expect(voterRow).not.toContain(vote.partyId)
    expect(voterRow).not.toContain(outcome.token)
    expect(voterRow).not.toContain(session.id)

    // Röstraden känner inte till väljaren.
    expect(voteRow).not.toContain(voter.id)
    expect(voteRow).not.toContain(voter.externalIdentityHash)
    expect(voteRow).not.toContain(session.id)
    expect(voteRow).not.toContain('199001011234')

    // Och det finns inget gemensamt fältnamn att koppla ihop dem på.
    const shared = Object.keys(voter).filter((key) => Object.keys(vote).includes(key))
    expect(shared).toEqual(['id'])
    expect(voter.id).not.toBe(vote.id)
  })

  it('token-hashen finns i röstdatabasen och ingen annanstans', async () => {
    const voterId = await createVoter('199001011234')
    const outcome = await castVote(await createVotingSession(voterId), await firstPartyId())
    if (outcome.status !== 'success') throw new Error('Röstningen misslyckades')

    const tokenHash = hashToken(outcome.token)

    const vote = await votesDb.anonymousVote.findUnique({ where: { tokenHash } })
    expect(vote).not.toBeNull()

    // Sök igenom hela röstlängdsdatabasen efter hashen.
    const voters = await votersDb.voterStatus.findMany()
    const sessions = await votersDb.votingSession.findMany()
    const auditEvents = await votersDb.auditEvent.findMany()

    const everythingInVotersDb = JSON.stringify({ voters, sessions, auditEvents })
    expect(everythingInVotersDb).not.toContain(tokenHash)
    expect(everythingInVotersDb).not.toContain(outcome.token)
  })

  /** Testpunkt 8: en väljaridentitet kan inte leda till en token. */
  it('det går inte att gå från identitetshash till token', async () => {
    const voterId = await createVoter('199001011234')
    const outcome = await castVote(await createVotingSession(voterId), await firstPartyId())
    if (outcome.status !== 'success') throw new Error('Röstningen misslyckades')

    const voter = await votersDb.voterStatus.findUniqueOrThrow({ where: { id: voterId } })

    // Allt som går att hämta ut om väljaren:
    const knownAboutVoter = [voter.id, voter.externalIdentityHash]

    // Inget av det förekommer någonstans i röstdatabasen.
    const allVotes = await votesDb.anonymousVote.findMany()
    const allVotesSerialised = JSON.stringify(allVotes)

    for (const value of knownAboutVoter) {
      expect(allVotesSerialised).not.toContain(value)
    }

    // Och den enda kolumn som skulle kunna peka ut rösten — token_hash — går
    // inte att räkna fram från något väljaren lämnat efter sig.
    expect(allVotes[0]!.tokenHash).not.toBe(voter.externalIdentityHash)
    expect(allVotes[0]!.tokenHash).not.toContain(voter.id)
  })

  /** Testpunkt 16: den anonyma rösttabellen avslöjar inte väljaren. */
  it('hela rösttabellen innehåller inget som pekar mot en person', async () => {
    const partyId = await firstPartyId()

    for (let index = 0; index < 5; index += 1) {
      const voterId = await createVoter(`1985010${String(index).padStart(5, '0')}`)
      await castVote(await createVotingSession(voterId), partyId)
    }

    const votes = await votesDb.anonymousVote.findMany()
    expect(votes).toHaveLength(5)

    const columns = Object.keys(votes[0]!)
    expect(columns.sort()).toEqual(['createdAt', 'id', 'partyId', 'tokenHash'])

    for (const forbidden of ['voter', 'identity', 'personal', 'session', 'ip']) {
      expect(columns.join(' ').toLowerCase()).not.toContain(forbidden)
    }
  })

  /** Testpunkt 15: röstlängdstabellen avslöjar inte rösten. */
  it('hela röstlängdstabellen innehåller inget om vad någon röstat på', async () => {
    const partyId = await firstPartyId()
    const voterId = await createVoter('199001011234')
    await castVote(await createVotingSession(voterId), partyId)

    const voters = await votersDb.voterStatus.findMany()
    const columns = Object.keys(voters[0]!)

    expect(columns.sort()).toEqual([
      'externalIdentityHash',
      'hasVoted',
      'id',
      'isEligible',
      'votedAt',
    ])

    const serialised = JSON.stringify(voters)
    expect(serialised).not.toContain(partyId)

    const parties = await votesDb.party.findMany()
    for (const party of parties) {
      expect(serialised).not.toContain(party.name)
      expect(serialised).not.toContain(party.id)
    }
  })

  it('tidsstämplarna är grovkorniga i båda databaserna', async () => {
    const voterId = await createVoter('199001011234')
    await castVote(await createVotingSession(voterId), await firstPartyId())

    const voter = await votersDb.voterStatus.findUniqueOrThrow({ where: { id: voterId } })
    const vote = await votesDb.anonymousVote.findFirstOrThrow()

    // Röstlängden: dygn. Röstdatabasen: timme. Utan avrundningen skulle de
    // två raderna gå att para ihop på tid.
    expect(voter.votedAt?.toISOString()).toMatch(/T00:00:00\.000Z$/)
    expect(vote.createdAt.toISOString()).toMatch(/:00:00\.000Z$/)
  })

  /** Testpunkt 14: partival påverkar inte röstberättigandedata. */
  it('vilket parti som väljs påverkar inte röstlängden', async () => {
    const parties = await votesDb.party.findMany({ orderBy: { displayOrder: 'asc' } })

    const voterA = await createVoter('199001011234')
    const voterB = await createVoter('198505152345')

    await castVote(await createVotingSession(voterA), parties[0]!.id)
    await castVote(await createVotingSession(voterB), parties[1]!.id)

    const rowA = await votersDb.voterStatus.findUniqueOrThrow({ where: { id: voterA } })
    const rowB = await votersDb.voterStatus.findUniqueOrThrow({ where: { id: voterB } })

    // De två väljarna röstade på olika partier. Deras rader i röstlängden är
    // ändå identiska så när som på id och identitetshash.
    expect(rowA.hasVoted).toBe(rowB.hasVoted)
    expect(rowA.isEligible).toBe(rowB.isEligible)
    expect(rowA.votedAt?.getTime()).toBe(rowB.votedAt?.getTime())

    const { id: _idA, externalIdentityHash: _hashA, ...restA } = rowA
    const { id: _idB, externalIdentityHash: _hashB, ...restB } = rowB
    expect(restA).toEqual(restB)
  })

  /** Testpunkt 15 (andra halvan): att radera röstlängden avslöjar ingen röst. */
  it('rösterna överlever att hela röstlängden raderas', async () => {
    const voterId = await createVoter('199001011234')
    const outcome = await castVote(await createVotingSession(voterId), await firstPartyId())
    if (outcome.status !== 'success') throw new Error('Röstningen misslyckades')

    await votersDb.votingSession.deleteMany()
    await votersDb.voterStatus.deleteMany()

    // Rösten finns kvar och går fortfarande att verifiera. Det visar att
    // röstdatabasen inte är beroende av röstlängden — det finns ingen
    // kaskadering, ingen relation, inget att följa.
    expect(await votesDb.anonymousVote.count()).toBe(1)
    expect((await verifyToken(outcome.token)).registered).toBe(true)
  })

  it('röstlängden överlever att alla röster raderas', async () => {
    const voterId = await createVoter('199001011234')
    await castVote(await createVotingSession(voterId), await firstPartyId())

    await votesDb.anonymousVote.deleteMany()

    const voter = await votersDb.voterStatus.findUniqueOrThrow({ where: { id: voterId } })
    expect(voter.hasVoted).toBe(true)
  })

  it('revisionsloggen innehåller varken identitet, parti eller token', async () => {
    const voterId = await createVoter('199001011234')
    const partyId = await firstPartyId()
    const party = await votesDb.party.findUniqueOrThrow({ where: { id: partyId } })

    const outcome = await castVote(await createVotingSession(voterId), partyId)
    if (outcome.status !== 'success') throw new Error('Röstningen misslyckades')

    const events = await votersDb.auditEvent.findMany()
    expect(events.length).toBeGreaterThan(0)

    const serialised = JSON.stringify(events)
    expect(serialised).not.toContain(voterId)
    expect(serialised).not.toContain(partyId)
    expect(serialised).not.toContain(party.name)
    expect(serialised).not.toContain(outcome.token)
    expect(serialised).not.toContain('199001011234')

    // Tidsstämpeln är avrundad till timme, även i revisionsloggen.
    for (const event of events) {
      expect(event.occurredAt.toISOString()).toMatch(/:00:00\.000Z$/)
    }
  })
})

describe.skipIf(!databaseAvailable)('foreign keys i den faktiska databasen', () => {
  const FOREIGN_KEY_QUERY = `
    SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `

  type Row = { table_name: string; column_name: string; foreign_table_name: string }

  it('röstlängdsdatabasen har ingen relation till röster', async () => {
    const rows = await votersDb.$queryRawUnsafe<Row[]>(FOREIGN_KEY_QUERY)

    for (const row of rows) {
      expect(row.foreign_table_name).not.toBe('anonymous_vote')
      expect(row.foreign_table_name).not.toBe('party')
    }
  })

  it('röstdatabasen har ingen relation till väljare', async () => {
    const rows = await votesDb.$queryRawUnsafe<Row[]>(FOREIGN_KEY_QUERY)

    for (const row of rows) {
      expect(row.foreign_table_name).not.toBe('voter_status')
      expect(row.foreign_table_name).not.toBe('voting_session')
    }
  })

  it('databaserna är fysiskt åtskilda', async () => {
    const [voters] = await votersDb.$queryRaw<Array<{ current_database: string }>>`
      SELECT current_database()
    `
    const [votes] = await votesDb.$queryRaw<Array<{ current_database: string }>>`
      SELECT current_database()
    `

    // Olika databaser i PostgreSQL. En fråga kan inte nå båda, och en foreign
    // key mellan dem går inte att skapa ens med superanvändarrättigheter.
    expect(voters!.current_database).not.toBe(votes!.current_database)
    expect(voters!.current_database).toBe('voters_db')
    expect(votes!.current_database).toBe('votes_db')
  })

  it('röstlängdsdatabasen känner inte till rösttabellen alls', async () => {
    const tables = await votersDb.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `
    const names = tables.map((row) => row.table_name)

    expect(names).not.toContain('anonymous_vote')
    expect(names).not.toContain('party')
    expect(names).toContain('voter_status')
  })

  it('röstdatabasen känner inte till röstlängdstabellen alls', async () => {
    const tables = await votesDb.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `
    const names = tables.map((row) => row.table_name)

    expect(names).not.toContain('voter_status')
    expect(names).not.toContain('voting_session')
    expect(names).toContain('anonymous_vote')
  })
})
