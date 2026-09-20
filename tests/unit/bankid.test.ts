import { beforeEach, describe, expect, it } from 'vitest'
import { MockBankIdService, resetMockBankIdOrders } from '@/modules/eligibility/bankid/MockBankIdService'

/** Testpunkt 1: en väljare kan legitimera sig. */

describe('MockBankIdService', () => {
  beforeEach(() => {
    resetMockBankIdOrders()
    process.env.MOCK_BANKID_POLLS_UNTIL_COMPLETE = '2'
  })

  it('startar en order och blir klar efter ett antal pollningar', async () => {
    const service = new MockBankIdService()
    const order = await service.auth({ personalNumber: '199001011234' })

    expect(order.orderRef).toMatch(/^[0-9a-f-]{36}$/)

    expect((await service.collect(order.orderRef)).status).toBe('pending')
    expect((await service.collect(order.orderRef)).status).toBe('pending')

    const final = await service.collect(order.orderRef)
    expect(final.status).toBe('complete')
    if (final.status === 'complete') {
      expect(final.completionData.personalNumber).toBe('199001011234')
      expect(final.completionData.name).toBeTruthy()
    }
  })

  it('ger olika orderreferenser för varje legitimering', async () => {
    const service = new MockBankIdService()
    const first = await service.auth({ personalNumber: '199001011234' })
    const second = await service.auth({ personalNumber: '199001011234' })

    expect(first.orderRef).not.toBe(second.orderRef)
  })

  it('avvisar en okänd orderreferens', async () => {
    const service = new MockBankIdService()
    const result = await service.collect('00000000-0000-0000-0000-000000000000')

    expect(result.status).toBe('failed')
  })

  it('kan avbrytas av väljaren', async () => {
    const service = new MockBankIdService()
    const order = await service.auth({ personalNumber: '199001011234' })

    await service.cancel(order.orderRef)
    const result = await service.collect(order.orderRef)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.hintCode).toBe('userCancel')
    }
  })

  it('en order kan inte konsumeras två gånger', async () => {
    process.env.MOCK_BANKID_POLLS_UNTIL_COMPLETE = '0'
    const service = new MockBankIdService()
    const order = await service.auth({ personalNumber: '199001011234' })

    expect((await service.collect(order.orderRef)).status).toBe('complete')
    // Andra försöket ska misslyckas: annars skulle en avlyssnad orderreferens
    // kunna återanvändas för att skapa en ny röstsession.
    expect((await service.collect(order.orderRef)).status).toBe('failed')
  })
})
