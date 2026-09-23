import { describe, expect, it } from 'vitest'
import type {
  DatabaseState,
  EncryptedVoteRow,
  PendingVoteRow,
} from '@/app/api/demo/database-state/route'
import {
  canFollow,
  findInEncryptedVotes,
  followedRow,
  followReducer,
  INITIAL_FOLLOW_STATE,
  lookUpVerificationCode,
  normaliseVerificationCode,
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
 * och en rad i encrypted_vote hittas bara med en kod som besökaren själv har.
 *
 * Värdena är avkortade precis som rutten avkortar dem: tolv tecken och ett
 * utelämningstecken.
 */

const ELECTION = 'omrostning-1'
const ANNA = 'anna-111111…'
const HASH = '3fa2b1c9d0e1'
/** Hela verifikationskoden: 64 hextecken, varav livevyn bara har sett de första tolv. */
const ANNAS_CODE = HASH + 'ab'.repeat(26)

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

describe('verifikationskoden', () => {
  it('före stängningen hittar koden kuvertet i pending_vote, med väljaren', () => {
    const result = lookUpVerificationCode(ANNAS_CODE, BEFORE_CLOSE)

    expect(result).toMatchObject({ status: 'searched', encrypted: [] })
    if (result.status !== 'searched') throw new Error('Koden prövades inte.')
    expect(result.pending.map((row) => row.voterStatusId)).toEqual([ANNA])
  })

  it('efter stängningen hittar koden chiffret i encrypted_vote, och raden bär ingen väljare', () => {
    const result = lookUpVerificationCode(ANNAS_CODE, AFTER_CLOSE)

    if (result.status !== 'searched') throw new Error('Koden prövades inte.')
    expect(result.pending).toEqual([])
    expect(result.encrypted).toHaveLength(1)
    // Samma objekt som i bilden, inte ett nytt som satts ihop av något annat.
    expect(result.encrypted[0]).toBe(AFTER_CLOSE.votesDb.encryptedVote[0])
    expect(Object.keys(result.encrypted[0]!)).not.toContain('voterStatusId')
  })

  it('mitt i en stängning hålls träffarna i de två tabellerna isär', () => {
    // Flytten är gjord men raderingen inte: samma hash i båda tabellerna.
    const midClose = snapshot('OPEN', [pendingRow()], [encryptedRow()])
    const result = lookUpVerificationCode(ANNAS_CODE, midClose)

    if (result.status !== 'searched') throw new Error('Koden prövades inte.')
    expect(result.pending).toHaveLength(1)
    expect(result.encrypted).toEqual([midClose.votesDb.encryptedVote[0]])
    expect(Object.keys(result.encrypted[0]!)).not.toContain('voterStatusId')
  })

  it('letandet i encrypted_vote hittar bara det koden pekar ut', () => {
    const other = encryptedRow({ id: '0000aaaa-000…', ciphertextHash: '0000aaaa0000…' })

    expect(findInEncryptedVotes(ANNAS_CODE, [other, encryptedRow()])).toEqual([encryptedRow()])
  })

  it('en kod som bara delar början med hashen träffar inte', () => {
    // Skiljer sig i det tolfte tecknet, det sista livevyn hämtar.
    const almost = '3fa2b1c9d0e2' + ANNAS_CODE.slice(12)

    expect(lookUpVerificationCode(almost, AFTER_CLOSE)).toMatchObject({
      status: 'searched',
      pending: [],
      encrypted: [],
    })
  })

  it('får klistras in med versaler, mellanslag och bindestreck', () => {
    // Grupper om fyra, versaler och ett bindestreck: "3FA2-B1C9 D0E1 ABAB …".
    const typed = ANNAS_CODE.toUpperCase()
      .replace(/(.{4})/g, '$1 ')
      .trim()
      .replace(' ', '-')

    expect(normaliseVerificationCode(typed)).toBe(ANNAS_CODE)
    expect(lookUpVerificationCode(typed, AFTER_CLOSE)).toMatchObject({ status: 'searched' })
  })

  it('en för kort eller ogiltig kod prövas inte alls', () => {
    // Kortare än det livevyn hämtar skulle träffa mer än den pekar ut.
    expect(normaliseVerificationCode('3fa2b1c9d0e')).toBeNull()
    expect(normaliseVerificationCode('inte en kod alls, bara text')).toBeNull()
    expect(normaliseVerificationCode('a'.repeat(65))).toBeNull()

    expect(lookUpVerificationCode('   ', AFTER_CLOSE)).toEqual({ status: 'empty' })
    expect(lookUpVerificationCode('3fa2', AFTER_CLOSE)).toEqual({ status: 'invalid' })
  })
})
