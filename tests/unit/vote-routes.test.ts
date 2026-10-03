import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_CONCURRENT_VERIFICATIONS,
  MAX_WAITING_VERIFICATIONS,
  inVerificationTurn,
  reserveVerification,
  verificationQueueState,
  verificationReservations,
  type VerificationReservation,
} from '@/lib/crypto/server'
import { getOrder, orderCount, putOrder, resetOrders } from '@/lib/order-state'
import { resetRateLimits } from '@/lib/rate-limit'
import fixture from './crypto/fixtures/ballot-26-14d.json'

/**
 * SIGNERINGENS TVÅ RUTTER, med BankID, databaserna och sessionen utbytta
 * (uppgift 14e).
 *
 * Rutterna körs på riktigt, med verifieringskön och orderlagret som de är. Det
 * som byts ut är det som annars kräver en databas eller en Next-begäranskontext:
 * sessionen, BankID och läggningen av kuvertet.
 *
 * Tre egenskaper prövas: att pollningen bara bär orderRef och servern håller
 * valsedeln, att en order är bunden till sin session, och att kön reserverar en
 * plats INNAN BankID-ordern hämtas och släpper den på varje väg.
 */

const state = vi.hoisted(() => ({
  sessionId: 'session-a' as string | undefined,
  collect: vi.fn(),
  cancel: vi.fn(),
  sign: vi.fn(),
  cast: vi.fn(),
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'valsession' && state.sessionId ? { value: state.sessionId } : undefined,
  }),
}))
vi.mock('@/lib/csrf', () => ({ isValidCsrfToken: () => true }))
vi.mock('@/modules/eligibility/audit.service', () => ({
  AUDIT_EVENTS: { CSRF_REJECTED: 'x', RATE_LIMITED: 'y' },
  recordAuditEvent: async () => undefined,
}))
vi.mock('@/modules/eligibility/voting-session.service', () => ({
  getValidVotingSession: async (id: string) =>
    id.startsWith('session-')
      ? { csrfSecret: 's', electionId: 'val-1', voterStatusId: `väljare-${id}` }
      : null,
}))
vi.mock('@/modules/eligibility/election.service', () => ({
  ballotBelongsToElection: async () => true,
}))
vi.mock('@/modules/eligibility/pending-vote.service', () => ({
  nextCastSequence: async () => 1,
  castEncryptedBallot: (...args: unknown[]) => state.cast(...args),
}))
vi.mock('@/modules/ballot-box', () => ({
  getEncryptedBallotShape: async () => ({ publicKey: 'k', optionCount: 26 }),
}))
vi.mock('@/modules/eligibility/bankid', () => ({
  bankIdService: {
    sign: (...args: unknown[]) => state.sign(...args),
    collect: (...args: unknown[]) => state.collect(...args),
    cancel: (...args: unknown[]) => state.cancel(...args),
    qrData: async () => null,
  },
}))
vi.mock('@/modules/eligibility/bankid/qr', () => ({
  launchUrl: () => 'bankid:///',
  renderQrPng: async () => 'data:image/png;base64,',
}))

import { POST as signStart } from '@/app/api/vote/sign-start/route'
import { POST as encrypted } from '@/app/api/vote/encrypted/route'

const BALLOT = fixture.ballot
const BALLOT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const ORDER = '5a0f3c1e-8f2d-4b6a-9c11-0d2e4f6a8b10'
const ORIGIN = 'http://localhost:3000'
const COMPLETE = {
  status: 'complete',
  completionData: { signature: 'sig', certificateChain: ['kedja'], signedData: 'signerat' },
}

function post(path: string, body: unknown, signal?: AbortSignal): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body),
    signal,
  })
}

const startBody = () => ({
  ballotId: BALLOT_ID,
  ciphertextHash: BALLOT.ciphertextHash,
  ballot: BALLOT,
})
const poll = (orderRef = ORDER, signal?: AbortSignal) =>
  post('/api/vote/encrypted', { orderRef }, signal)

beforeEach(() => {
  resetOrders()
  resetRateLimits()
  state.sessionId = 'session-a'
  state.collect
    .mockReset()
    .mockResolvedValue({ status: 'pending', hintCode: 'outstandingTransaction' })
  state.cancel.mockReset().mockResolvedValue(undefined)
  state.sign.mockReset().mockResolvedValue({ orderRef: ORDER, autoStartToken: 'auto' })
  state.cast
    .mockReset()
    .mockResolvedValue({ status: 'recorded', ciphertextHash: 'h', replaced: false })
})

describe('servern håller valsedeln med ordern', () => {
  it('sign-start tar emot valsedeln och lägger den i lagret, bunden till sessionen', async () => {
    const response = await signStart(post('/api/vote/sign-start', startBody()))

    expect(response.status).toBe(200)
    expect(getOrder(ORDER, 'session-a')?.ballotId).toBe(BALLOT_ID)
    expect(getOrder(ORDER, 'session-a')?.ballot.ciphertextHash).toBe(BALLOT.ciphertextHash)
  })

  it('sign-start avvisar en valsedel vars hash inte är den som ska signeras', async () => {
    const response = await signStart(
      post('/api/vote/sign-start', { ...startBody(), ciphertextHash: 'b'.repeat(64) }),
    )

    expect(response.status).toBe(400)
    expect(state.sign).not.toHaveBeenCalled()
    expect(orderCount()).toBe(0)
  })

  it('är lagret fullt avbryts BankID-ordern och väljaren får veta att rösten inte lades', async () => {
    for (let index = 0; index < 500; index += 1) {
      putOrder(`fylld-${index}`, `annan-${index}`, { ballotId: BALLOT_ID, ballot: BALLOT as never })
    }

    const response = await signStart(post('/api/vote/sign-start', startBody()))

    expect(response.status).toBe(503)
    expect(state.cancel).toHaveBeenCalledWith(ORDER)
  })

  it('pollningen bär bara orderRef: det som prövas är valsedeln servern höll', async () => {
    await signStart(post('/api/vote/sign-start', startBody()))

    const response = await encrypted(poll())
    expect(await response.json()).toMatchObject({ status: 'pending' })

    // En valsedel i pollningen ignoreras.
    const other = { ...BALLOT, ciphertextHash: 'c'.repeat(64) }
    state.collect.mockResolvedValue(COMPLETE)
    await encrypted(post('/api/vote/encrypted', { orderRef: ORDER, ballot: other, ballotId: 'x' }))
    expect(state.cast.mock.calls[0]![2]).toBe(BALLOT_ID)
    expect((state.cast.mock.calls[0]![3] as { ciphertextHash: string }).ciphertextHash).toBe(
      BALLOT.ciphertextHash,
    )
  })

  it('en order som inte är klar ligger kvar, och en klar förbrukas en gång', async () => {
    await signStart(post('/api/vote/sign-start', startBody()))

    await encrypted(poll())
    await encrypted(poll())
    expect(getOrder(ORDER, 'session-a')).not.toBeNull()

    state.collect.mockResolvedValue(COMPLETE)
    expect(await (await encrypted(poll())).json()).toMatchObject({ status: 'recorded' })
    expect(getOrder(ORDER, 'session-a')).toBeNull()

    // En andra pollning på samma order kommer inte åt något, och frågar inte BankID.
    state.collect.mockClear()
    expect(await (await encrypted(poll())).json()).toMatchObject({ status: 'failed' })
    expect(state.collect).not.toHaveBeenCalled()
    expect(state.cast).toHaveBeenCalledTimes(1)
  })

  it('en order som misslyckats tas bort', async () => {
    await signStart(post('/api/vote/sign-start', startBody()))
    state.collect.mockResolvedValue({ status: 'failed', hintCode: 'userCancel' })

    expect(await (await encrypted(poll())).json()).toMatchObject({ status: 'failed' })
    expect(getOrder(ORDER, 'session-a')).toBeNull()
  })
})

describe('en order är bunden till väljarens session', () => {
  it('en annan session får inte förbruka en annans order, och ägarens order ligger kvar', async () => {
    await signStart(post('/api/vote/sign-start', startBody()))

    state.sessionId = 'session-b'
    state.collect.mockResolvedValue(COMPLETE)
    const response = await encrypted(poll())

    expect(await response.json()).toMatchObject({ status: 'failed' })
    expect(state.collect).not.toHaveBeenCalled()
    expect(state.cast).not.toHaveBeenCalled()
    expect(getOrder(ORDER, 'session-a')).not.toBeNull()

    // Ägaren kommer åt den som vanligt.
    state.sessionId = 'session-a'
    expect(await (await encrypted(poll())).json()).toMatchObject({ status: 'recorded' })
  })
})

describe('kön reserverar sin plats innan BankID-ordern hämtas', () => {
  /** Fyller kapaciteten utom en plats med reservationer. */
  function fillAllButOne() {
    return Array.from(
      { length: MAX_CONCURRENT_VERIFICATIONS + MAX_WAITING_VERIFICATIONS - 1 },
      () => reserveVerification()!,
    )
  }

  const throughQueue = async (...args: unknown[]) => {
    const signal = args[6] as AbortSignal
    const reservation = args[7] as VerificationReservation | undefined
    return inVerificationTurn(
      async () => ({ status: 'recorded', ciphertextHash: 'h', replaced: false }),
      { signal, reservation },
    )
  }

  it('fem samtidiga röster mot en plats: fyra får kön full FÖRE sin BankID-order', async () => {
    await signStart(post('/api/vote/sign-start', startBody()))
    const filler = fillAllButOne()
    state.collect.mockResolvedValue(COMPLETE)
    state.cast.mockImplementation(throughQueue)

    const replies = await Promise.all(Array.from({ length: 5 }, () => encrypted(poll())))
    const bodies = await Promise.all(replies.map((reply) => reply.json()))

    expect(bodies.filter((body) => body.status === 'recorded')).toHaveLength(1)
    const queued = replies.filter((_, index) => bodies[index].status === 'queued')
    expect(queued).toHaveLength(4)
    expect(queued.every((reply) => reply.status === 503)).toBe(true)

    // BankID-ordern hämtades av den enda som fick plats, och av ingen av de fyra.
    expect(state.collect).toHaveBeenCalledTimes(1)

    for (const reservation of filler) reservation.release()
    expect(verificationReservations()).toBe(0)
    expect(verificationQueueState()).toEqual({ running: 0, waiting: 0 })
  })

  it('en order som nekades för att kön var full ligger kvar, så väljaren slipper skriva under igen', async () => {
    await signStart(post('/api/vote/sign-start', startBody()))
    const filler = [...fillAllButOne(), reserveVerification()!]

    const reply = await encrypted(poll())
    expect((await reply.json()).status).toBe('queued')
    expect(getOrder(ORDER, 'session-a')).not.toBeNull()
    expect(state.collect).not.toHaveBeenCalled()

    for (const reservation of filler) reservation.release()
  })

  it('platsen släpps när BankID inte är klart', async () => {
    await signStart(post('/api/vote/sign-start', startBody()))
    await encrypted(poll())
    expect(verificationReservations()).toBe(0)
  })

  it('platsen släpps när BankID kastar', async () => {
    await signStart(post('/api/vote/sign-start', startBody()))
    state.collect.mockRejectedValue(new Error('BankID nåddes inte'))

    await expect(encrypted(poll())).rejects.toThrow('BankID nåddes inte')
    expect(verificationReservations()).toBe(0)
  })

  it('platsen släpps när läggningen kastar ett oväntat fel', async () => {
    await signStart(post('/api/vote/sign-start', startBody()))
    state.collect.mockResolvedValue(COMPLETE)
    state.cast.mockRejectedValue(new Error('databasen föll'))

    await expect(encrypted(poll())).rejects.toThrow('databasen föll')
    expect(verificationReservations()).toBe(0)
  })

  it('platsen släpps när läggningen avvisas innan verifieringen nåtts', async () => {
    await signStart(post('/api/vote/sign-start', startBody()))
    state.collect.mockResolvedValue(COMPLETE)
    state.cast.mockResolvedValue({ status: 'closed' })

    const reply = await encrypted(poll())
    expect(reply.status).toBe(409)
    expect(verificationReservations()).toBe(0)
  })

  it('platsen släpps när besökaren gett upp', async () => {
    await signStart(post('/api/vote/sign-start', startBody()))
    state.collect.mockResolvedValue(COMPLETE)
    const controller = new AbortController()
    controller.abort()
    state.cast.mockImplementation(throughQueue)

    const reply = await encrypted(poll(ORDER, controller.signal))
    expect(reply.status).toBe(499)
    expect(verificationReservations()).toBe(0)
  })
})
