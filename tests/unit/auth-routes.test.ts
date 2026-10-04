import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RFA } from '@/lib/bankid-messages'
import { resetRateLimits } from '@/lib/rate-limit'
import { BankIdRequestError } from '@/modules/eligibility/bankid/BankIdRpClient'

/**
 * INLOGGNINGENS RUTTER MED BANKID:S MEDDELANDEN OCH FELKODER (uppgift 17c).
 *
 * BankID, databaserna och röstlängden är utbytta. Det som prövas är att varje
 * hintCode ger BankID:s rekommenderade text, och att ett fel från BankID ger
 * BankID:s text för felet och inget annat.
 */

const state = vi.hoisted(() => ({ auth: vi.fn(), collect: vi.fn(), cancel: vi.fn() }))

vi.mock('@/modules/eligibility/audit.service', () => ({
  AUDIT_EVENTS: new Proxy({}, { get: (_target, name) => String(name) }),
  recordAuditEvent: async () => undefined,
}))
vi.mock('@/modules/eligibility/bankid', () => ({
  bankIdService: {
    auth: (...args: unknown[]) => state.auth(...args),
    collect: (...args: unknown[]) => state.collect(...args),
    cancel: (...args: unknown[]) => state.cancel(...args),
    qrData: async () => null,
  },
}))
vi.mock('@/modules/eligibility/voter-status.service', () => ({ evaluateEligibility: vi.fn(), identifyAdmin: vi.fn() }))
vi.mock('@/modules/eligibility/voting-session.service', () => ({ createVotingSession: vi.fn() }))
vi.mock('@/modules/eligibility/admin-session.service', () => ({ createAdminSession: vi.fn(), destroyAdminSession: vi.fn() }))

import { POST as start } from '@/app/api/auth/bankid/start/route'
import { POST as collect } from '@/app/api/auth/bankid/collect/route'
import { POST as adminLogin } from '@/app/api/admin/login/route'

const ORIGIN = 'http://localhost:3000'
const ORDER = '5a0f3c1e-8f2d-4b6a-9c11-0d2e4f6a8b10'

function post(path: string, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  resetRateLimits()
  state.auth.mockReset().mockResolvedValue({ orderRef: ORDER, autoStartToken: 'auto' })
  state.collect.mockReset()
  state.cancel.mockReset().mockRejectedValue(new BankIdRequestError('network', null))
})

describe('start', () => {
  it('ett fel från BankID ger BankID:s text och 502', async () => {
    state.auth.mockRejectedValue(new BankIdRequestError('maintenance', 503))

    const response = await start(post('/api/auth/bankid/start', { purpose: 'vote' }))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: { code: 'BANKID_ERROR', message: RFA.RFA5 } })
  })

  it('ett annat fel kastas vidare, som förut', async () => {
    state.auth.mockRejectedValue(new Error('något annat'))
    await expect(start(post('/api/auth/bankid/start', { purpose: 'vote' }))).rejects.toThrow('något annat')
  })
})

describe.each([
  ['/api/auth/bankid/collect', collect, { orderRef: ORDER, electionId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' }],
  ['/api/admin/login', adminLogin, { orderRef: ORDER }],
] as const)('%s', (path, route, body) => {
  it('en väntande order ger hintCode och BankID:s text', async () => {
    state.collect.mockResolvedValue({ status: 'pending', hintCode: 'outstandingTransaction' })
    expect(await (await route(post(path, body))).json()).toEqual({
      status: 'pending',
      hintCode: 'outstandingTransaction',
      message: RFA.RFA1,
    })
  })

  it('en okänd hintCode i en otillåten form når inte webbläsaren', async () => {
    state.collect.mockResolvedValue({ status: 'pending', hintCode: '<b>' })
    expect(await (await route(post(path, body))).json()).toEqual({ status: 'pending', hintCode: null, message: RFA.RFA21 })
  })

  it('en misslyckad order ger BankID:s text för koden', async () => {
    state.collect.mockResolvedValue({ status: 'failed', hintCode: 'expiredTransaction' })
    expect(await (await route(post(path, body))).json()).toEqual({
      status: 'failed',
      hintCode: 'expiredTransaction',
      message: RFA.RFA8,
    })
  })

  it('ett fel från BankID ger BankID:s text och 502, och ordern avbryts hos BankID', async () => {
    state.collect.mockRejectedValue(new BankIdRequestError('invalidParameters', 400))
    const response = await route(post(path, body))
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ status: 'failed', message: RFA.RFA22 })
    expect(state.cancel).toHaveBeenCalledWith(ORDER)
  })

  it('ett tillfälligt fel avslutar inte ordern: svaret är pending', async () => {
    state.collect.mockRejectedValue(new BankIdRequestError('timeout', null))
    const response = await route(post(path, body))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'pending' })
    expect(state.cancel).not.toHaveBeenCalled()
  })
})
