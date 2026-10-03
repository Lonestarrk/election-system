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
 * valsedeln, att en order är bunden till sin session, och att kön bara rörs när
 * BankID svarar klart. Är kön då full läggs BankID:s svar i orderlagret och
 * svaret blir queued, så att väljaren slipper skriva under igen. Platsen släpps
 * på varje väg (fixrunda 1).
 */

const state = vi.hoisted(() => ({
  sessionId: 'session-a' as string | undefined,
  collect: vi.fn(),
  cancel: vi.fn(),
  sign: vi.fn(),
  cast: vi.fn(),
  shape: { publicKey: 'k', optionCount: 26 } as { publicKey: string; optionCount: number } | null,
}))

vi.mock('next/headers', () => ({
  // Sessionen läses när cookies() anropas, så att samtidiga begäranden från olika
  // sessioner i ett test får var sin.
  cookies: async () => {
    const sessionId = state.sessionId
    return {
      get: (name: string) => (name === 'valsession' && sessionId ? { value: sessionId } : undefined),
    }
  },
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
  getEncryptedBallotShape: async () => state.shape,
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
  state.shape = { publicKey: 'k', optionCount: 26 }
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

  it('sign-start avvisar en valsedel med fel antal chiffer, innan BankID-ordern skapas', async () => {
    state.shape = { publicKey: 'k', optionCount: 25 }

    const response = await signStart(post('/api/vote/sign-start', startBody()))

    expect(response.status).toBe(400)
    expect(state.sign).not.toHaveBeenCalled()
    expect(orderCount()).toBe(0)
  })

  it('sign-start avvisar en valsedel vars chiffer inte ger den angivna hashen', async () => {
    // Samma hash i båda fälten, men chiffret är ett annat än det hashen gäller.
    const tampered = {
      ...BALLOT,
      ciphertext: [
        { ...BALLOT.ciphertext[0]!, c1: BALLOT.ciphertext[1]!.c1 },
        ...BALLOT.ciphertext.slice(1),
      ],
    }

    const response = await signStart(
      post('/api/vote/sign-start', { ...startBody(), ballot: tampered }),
    )

    expect(response.status).toBe(400)
    expect(state.sign).not.toHaveBeenCalled()
    expect(orderCount()).toBe(0)
  })

  it('sign-start avvisar en valsedel med fel antal bevis, innan BankID-ordern skapas', async () => {
    // Hashen gäller chiffret och täcker inte bevisen, så en kortad lista syns bara här.
    const short = {
      ...BALLOT,
      proofs: { ...BALLOT.proofs, components: BALLOT.proofs.components.slice(1) },
    }

    const response = await signStart(post('/api/vote/sign-start', { ...startBody(), ballot: short }))

    expect(response.status).toBe(400)
    expect(state.sign).not.toHaveBeenCalled()
    expect(orderCount()).toBe(0)
  })

  it('sign-start avvisar en valsedel som inte har någon krypteringsform', async () => {
    state.shape = null

    const response = await signStart(post('/api/vote/sign-start', startBody()))

    expect(response.status).toBe(400)
    expect(state.sign).not.toHaveBeenCalled()
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

describe('kön reserveras först när BankID är klart (fixrunda 1)', () => {
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

  /** BankID förbrukar ordern vid första svaret som är klart, som i verkligheten. */
  function consumingBankId() {
    const consumed = new Set<string>()
    state.collect.mockImplementation(async (orderRef: string) => {
      if (consumed.has(orderRef)) return { status: 'failed', hintCode: 'expiredTransaction' }
      consumed.add(orderRef)
      return COMPLETE
    })
  }

  const orderOf = (index: number) => `5a0f3c1e-8f2d-4b6a-9c11-0d2e4f6a8b${10 + index}`

  async function startFive() {
    for (let index = 0; index < 5; index += 1) {
      state.sessionId = `session-${index}`
      state.sign.mockResolvedValueOnce({ orderRef: orderOf(index), autoStartToken: 'auto' })
      await signStart(post('/api/vote/sign-start', startBody()))
    }
  }

  it('fem samtidiga röster mot en plats: fyra får queued, och ingen behöver skriva under igen', async () => {
    await startFive()
    const filler = fillAllButOne()
    consumingBankId()

    // Verifieringen håller sin plats tills testet öppnar grinden, så att de fem
    // verkligen är samtidiga: annars hinner den första bli klar innan nästa kommer.
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => (openGate = resolve))
    state.cast.mockImplementation(async (...args: unknown[]) => {
      const signal = args[6] as AbortSignal
      const reservation = args[7] as VerificationReservation | undefined
      return inVerificationTurn(
        async () => {
          await gate
          return { status: 'recorded', ciphertextHash: 'h', replaced: false }
        },
        { signal, reservation },
      )
    })

    // Fem väljare, var och en med sin session och sin order.
    const pending = [0, 1, 2, 3, 4].map((index) => {
      state.sessionId = `session-${index}`
      return encrypted(poll(orderOf(index)))
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    openGate()
    const replies = await Promise.all(pending)
    const bodies = await Promise.all(replies.map((reply) => reply.json()))

    expect(bodies.filter((body) => body.status === 'recorded')).toHaveLength(1)
    const queuedIndexes = bodies.flatMap((body, index) => (body.status === 'queued' ? [index] : []))
    expect(queuedIndexes).toHaveLength(4)
    expect(queuedIndexes.every((index) => replies[index]!.status === 503)).toBe(true)

    // De fyras BankID-order är förbrukad, men resultatet ligger kvar hos servern.
    for (const index of queuedIndexes) {
      expect(getOrder(orderOf(index), `session-${index}`)?.completion).toBeDefined()
    }

    // När det finns plats lägger nästa pollning rösten, utan ny underskrift och utan
    // ny fråga till BankID.
    for (const reservation of filler) reservation.release()
    const collectCalls = state.collect.mock.calls.length
    for (const index of queuedIndexes) {
      state.sessionId = `session-${index}`
      expect(await (await encrypted(poll(orderOf(index)))).json()).toMatchObject({
        status: 'recorded',
      })
    }
    expect(state.collect.mock.calls.length).toBe(collectCalls)
    expect(state.cast).toHaveBeenCalledTimes(5)
    expect(verificationReservations()).toBe(0)
    expect(verificationQueueState()).toEqual({ running: 0, waiting: 0 })
  })

  it('pollningar som får pending rör aldrig kön, inte ens när den är full', async () => {
    await signStart(post('/api/vote/sign-start', startBody()))
    const filler = [...fillAllButOne(), reserveVerification()!]
    expect(reserveVerification()).toBeNull()

    for (let index = 0; index < 3; index += 1) {
      expect(await (await encrypted(poll())).json()).toMatchObject({ status: 'pending' })
    }
    expect(state.collect).toHaveBeenCalledTimes(3)
    expect(verificationReservations()).toBe(filler.length)

    for (const reservation of filler) reservation.release()
  })

  it('en order med sparat resultat hoppar över BankID, och resultatet loggas inte', async () => {
    await signStart(post('/api/vote/sign-start', startBody()))
    const filler = [...fillAllButOne(), reserveVerification()!]
    state.collect.mockResolvedValue(COMPLETE)
    const logged: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args) => {
        logged.push(args.map(String).join(' '))
      }),
    )

    expect((await (await encrypted(poll())).json()).status).toBe('queued')
    state.collect.mockClear()
    expect((await (await encrypted(poll())).json()).status).toBe('queued')
    expect(state.collect).not.toHaveBeenCalled()

    spies.forEach((spy) => spy.mockRestore())
    expect(logged.join('\n')).not.toMatch(/signerat|kedja/)
    for (const reservation of filler) reservation.release()
  })

  it('en annan session får inte använda det sparade resultatet', async () => {
    await signStart(post('/api/vote/sign-start', startBody()))
    const filler = [...fillAllButOne(), reserveVerification()!]
    state.collect.mockResolvedValue(COMPLETE)
    await encrypted(poll())
    for (const reservation of filler) reservation.release()

    state.sessionId = 'session-b'
    state.cast.mockClear()
    expect((await (await encrypted(poll())).json()).status).toBe('failed')
    expect(state.cast).not.toHaveBeenCalled()
  })

  it('försvinner ordern innan svaret kan sparas får väljaren failed, inte queued', async () => {
    await signStart(post('/api/vote/sign-start', startBody()))
    const filler = [...fillAllButOne(), reserveVerification()!]
    // Ordern förfaller eller tas bort medan BankID svarar.
    state.collect.mockImplementation(async () => {
      resetOrders()
      return COMPLETE
    })

    expect((await (await encrypted(poll())).json()).status).toBe('failed')
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

  it('kön full inne i verifieringen lägger tillbaka resultatet, så ordern inte går förlorad', async () => {
    const { VerificationQueueFull } = await import('@/lib/crypto/server')
    await signStart(post('/api/vote/sign-start', startBody()))
    state.collect.mockResolvedValue(COMPLETE)
    state.cast.mockRejectedValueOnce(new VerificationQueueFull())

    expect((await encrypted(poll())).status).toBe(503)
    expect(getOrder(ORDER, 'session-a')?.completion).toBeDefined()

    expect((await (await encrypted(poll())).json()).status).toBe('recorded')
  })
})
