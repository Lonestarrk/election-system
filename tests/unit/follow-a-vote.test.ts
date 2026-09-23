import { describe, expect, it } from 'vitest'
import type {
  DatabaseState,
  EncryptedVoteRow,
  PendingVoteRow,
} from '@/app/api/demo/database-state/route'
import {
  canFollow,
  followedRow,
  followReducer,
  INITIAL_FOLLOW_STATE,
  strippedElections,
  type FollowState,
} from '@/app/architecture/follow-a-vote'

/**
 * "FÖLJ EN RÖST" FÅR INTE SJÄLV BLI KOPPLINGEN SOM MODELLEN RADERAR.
 *
 * Före stängningen syns kopplingen i databasen, och sidan visar den. Efter
 * stängningen är raden i pending_vote borta. En sida som mindes vad den såg
 * före stängningen, också bara i React-tillstånd i fliken, kunde då peka ut
 * vilket chiffer i encrypted_vote som var vems. Testerna här prövar att
 * tillståndet inte kan göra det: en ny bild ersätter den förra helt, det följda
 * kuvertet glöms, ett gammalt svar kan inte väcka de raderade raderna till liv,
 * och efter stängningen säger sidan bara hur många anonyma rader som finns.
 *
 * Någon sökning på verifikationskod finns inte längre. Den var köparens
 * verktyg: den som sett en röst läggas kunde efter stängningen se om koden fanns
 * kvar, och alltså om väljaren ändrat sig (spec 3.1).
 *
 * Värdena är avkortade precis som rutten avkortar dem: tolv tecken och ett
 * utelämningstecken.
 */

const ELECTION = 'omrostning-1'
const ANNA = 'anna-111111…'
const HASH = '3fa2b1c9d0e1'

function pendingRow(overrides: Partial<PendingVoteRow> = {}): PendingVoteRow {
  return {
    id: 'kuvert-1111…',
    voterStatusId: ANNA,
    electionId: ELECTION,
    ballotId: 'valsedel-11…',
    ballotLabel: 'Riksdagen',
    ciphertextHash: `${HASH}…`,
    castSequence: 2,
    updatedAt: '2026-09-23',
    ciphertext: { pairs: 3, c1: '182364591027…', c2: '998124570013…', digits: 617 },
    ...overrides,
  }
}

function encryptedRow(overrides: Partial<EncryptedVoteRow> = {}): EncryptedVoteRow {
  return {
    id: '3fa2b1c9-d0e…',
    electionId: ELECTION,
    ballotId: 'valsedel-11…',
    ballotLabel: 'Riksdagen',
    ciphertextHash: `${HASH}…`,
    ciphertext: { pairs: 3, c1: '182364591027…', c2: '998124570013…', digits: 617 },
    ...overrides,
  }
}

function snapshot(
  phase: string,
  pending: PendingVoteRow[],
  encrypted: EncryptedVoteRow[],
): DatabaseState {
  return {
    elections: [
      {
        id: ELECTION,
        name: 'Testvalet',
        phase,
        closesAt: '2026-09-30T18:00:00.000Z',
        linkClearedAt: phase === 'STRIPPED' ? '2026-09-30T18:05:00.000Z' : null,
        envelopeRoot: phase === 'STRIPPED' ? '9e1f00aa4b2c…' : null,
        encryptionPublicKey: '449896240390…',
        tallyCompletedAt: null,
      },
    ],
    votersDb: {
      name: 'voters_db',
      // Väljaren finns kvar i röstlängden efter stängningen. Det är kuvertet
      // som raderas, inte hon.
      voterStatus: [
        { id: ANNA, externalIdentityHash: '34232956a3bb…', isEligible: true, isAdmin: false },
      ],
      pendingVote: pending,
      pendingVoteColumns: [],
      foreignKeys: [],
    },
    votesDb: {
      name: 'votes_db',
      encryptedVote: encrypted,
      encryptedVoteColumns: [],
      trusteeShare: [],
      partialDecryption: [],
      ballotTally: [],
      legacyVote: [],
      foreignKeys: [],
    },
    analysis: {
      linkQuery: { sql: '', rows: pending.length },
      identityValuesCompared: 0,
      identityValuesInVotesDb: [],
      ciphertextHashesInBoth: [],
      foreignKeysChecked: 0,
      foreignKeysAcrossDatabases: [],
    },
  }
}

const BEFORE_CLOSE = snapshot('OPEN', [pendingRow()], [])
const AFTER_CLOSE = snapshot('STRIPPED', [], [encryptedRow()])

function receive(state: FollowState, next: DatabaseState, sequence: number): FollowState {
  return followReducer(state, { type: 'snapshot', snapshot: next, sequence, fetchedAt: '20:00:00' })
}

function followAnnaBeforeClose(): FollowState {
  const loaded = receive(INITIAL_FOLLOW_STATE, BEFORE_CLOSE, 1)
  return followReducer(loaded, { type: 'follow', pendingVoteId: 'kuvert-1111…' })
}

/**
 * Varje objekt, var som helst i tillståndet, som bär BÅDE väljarens id och
 * chifferhashen. Det är vad en koppling är, oavsett vad fälten heter.
 */
function objectsLinking(value: unknown, voterId: string, hash: string): unknown[] {
  if (typeof value !== 'object' || value === null) return []

  const own = Object.values(value as Record<string, unknown>)
  const found =
    own.includes(voterId) && own.some((field) => typeof field === 'string' && field.startsWith(hash))
      ? [value]
      : []

  return [...found, ...own.flatMap((child) => objectsLinking(child, voterId, hash))]
}

describe('Följ en röst: sidan blir aldrig själv kopplingen', () => {
  it('före stängningen finns kopplingen i bilden, eftersom den finns i databasen', () => {
    // Kontrasten mot testen nedan. Utan den kunde en hjälpfunktion som aldrig
    // hittar något få alla de andra att passera.
    const following = followAnnaBeforeClose()

    expect(objectsLinking(following, ANNA, HASH)).toHaveLength(1)
    expect(followedRow(following)?.voterStatusId).toBe(ANNA)
  })

  it('efter stängningen finns ingenting i tillståndet som parar ihop väljaren och chiffret', () => {
    const after = receive(followAnnaBeforeClose(), AFTER_CLOSE, 2)

    // Väljaren finns kvar, och chiffret finns kvar. Men inget objekt bär båda.
    expect(JSON.stringify(after)).toContain(ANNA)
    expect(JSON.stringify(after)).toContain(HASH)
    expect(objectsLinking(after, ANNA, HASH)).toEqual([])
  })

  it('en ny bild ersätter den förra helt i stället för att slås ihop med den', () => {
    const after = receive(followAnnaBeforeClose(), AFTER_CLOSE, 2)

    expect(after.snapshot).toBe(AFTER_CLOSE)
    // Kuvertets id fanns bara i bilden från före stängningen.
    expect(JSON.stringify(after)).not.toContain('kuvert-1111')
  })

  it('det följda kuvertet glöms när raden försvinner, och sidan säger det', () => {
    const after = receive(followAnnaBeforeClose(), AFTER_CLOSE, 2)

    expect(after.followedPendingVoteId).toBeNull()
    expect(followedRow(after)).toBeNull()
    expect(after.forgotten).toBe('row-gone')
  })

  it('det följda kuvertet glöms när omröstningen lämnar OPEN, även om raden finns kvar', () => {
    /**
     * Specens CLOSED och VALIDATED: röstningen har stängt, men kopplingen
     * finns kvar tills skalningen körs. Från och med stängningen ska en röst
     * bara hittas med sin kod, så sidan slutar följa den redan här.
     */
    const closed = snapshot('CLOSED', [pendingRow()], [])
    const after = receive(followAnnaBeforeClose(), closed, 2)

    expect(after.followedPendingVoteId).toBeNull()
    expect(after.forgotten).toBe('left-open')
  })

  it('ett svar som skickades före ett nyare kan aldrig ersätta det', () => {
    /**
     * Två hämtningar i luften samtidigt: den från före stängningen är
     * långsam och kommer fram sist. Fick den ersätta den nyare bilden skulle
     * de raderade raderna dyka upp igen i fliken, och kunna följas.
     */
    const afterClose = receive(INITIAL_FOLLOW_STATE, AFTER_CLOSE, 2)
    const lateStaleAnswer = receive(afterClose, BEFORE_CLOSE, 1)

    expect(lateStaleAnswer).toBe(afterClose)
    expect(lateStaleAnswer.snapshot?.votersDb.pendingVote).toEqual([])
  })

  it('ett kuvert kan inte börja följas när dess omröstning inte är öppen', () => {
    const closed = receive(INITIAL_FOLLOW_STATE, snapshot('VALIDATED', [pendingRow()], []), 1)

    expect(canFollow(closed.snapshot!, pendingRow())).toBe(false)
    expect(followReducer(closed, { type: 'follow', pendingVoteId: 'kuvert-1111…' })).toBe(closed)
  })

  it('ett kuvert som inte finns i den aktuella bilden kan inte följas', () => {
    const after = receive(INITIAL_FOLLOW_STATE, AFTER_CLOSE, 1)

    expect(followReducer(after, { type: 'follow', pendingVoteId: 'kuvert-1111…' })).toBe(after)
  })

  it('att sluta följa tar bort både raden och beskedet', () => {
    const forgotten = receive(followAnnaBeforeClose(), AFTER_CLOSE, 2)
    const cleared = followReducer(forgotten, { type: 'unfollow' })

    expect(cleared.followedPendingVoteId).toBeNull()
    expect(cleared.forgotten).toBeNull()
  })
})

describe('efter stängningen', () => {
  it('säger hur många anonyma rader omröstningen har, och ingenting om vilken som är vems', () => {
    const other = encryptedRow({ id: '0000aaaa-000…', ciphertextHash: '0000aaaa0000…' })
    const closed = snapshot('STRIPPED', [], [encryptedRow(), other])

    const summaries = strippedElections(closed)

    expect(summaries).toEqual([
      { electionId: ELECTION, name: 'Testvalet', remainingEnvelopes: 0, anonymousRows: 2 },
    ])
    // Bara antal. Ingen rad, ingen hash, inget id följer med.
    expect(JSON.stringify(summaries)).not.toContain(HASH)
    expect(JSON.stringify(summaries)).not.toContain(ANNA)
  })

  it('en omröstning vars koppling finns kvar räknas inte som stängd', () => {
    expect(strippedElections(BEFORE_CLOSE)).toEqual([])
  })

  it('ett kuvert som ändå finns kvar efter raderingen syns i sammanställningen', () => {
    // Raderingen påstås gjord, men en rad ligger kvar, till exempel skriven
    // tillbaka efteråt. Då ska sidan inte säga noll.
    const inconsistent = snapshot('STRIPPED', [pendingRow()], [encryptedRow()])

    expect(strippedElections(inconsistent)[0]).toMatchObject({ remainingEnvelopes: 1 })
  })
})
