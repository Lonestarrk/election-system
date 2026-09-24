import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MockBankIdService,
  resetMockBankIdOrders,
  selectDemoIdentity,
} from '@/modules/eligibility/bankid/MockBankIdService'
import { computeQrData, launchUrl } from '@/modules/eligibility/bankid/qr'

/**
 * BankID v6 (Secure Start).
 *
 * Det som prövas här är inte att attrappen fungerar, utan att den beter sig
 * som det skarpa API:et på de punkter resten av systemet vilar på — särskilt
 * att den inte tar emot något personnummer, och att QR-koderna räknas fram med
 * rätt algoritm.
 */

const service = new MockBankIdService()

beforeEach(() => {
  resetMockBankIdOrders()
})

describe('auth tar inget personnummer', () => {
  it('startar en order utifrån IP och ändamål, ingenting annat', async () => {
    /**
     * BankID v6 tillåter inte flöden där användaren skriver in sitt
     * personnummer. Att gränssnittet inte ens har fältet är själva skyddet:
     * ett anrop som försöker skicka med det kompilerar inte.
     */
    const order = await service.auth({
      endUserIp: '198.51.100.7',
      userVisibleData: 'Legitimering för att rösta',
    })

    expect(order.orderRef).toMatch(/^[0-9a-f-]{36}$/)
    expect(order.autoStartToken).toMatch(/^[0-9a-f-]{36}$/)

    // Ingen hemlighet i svaret. qrStartSecret delas enligt BankID:s
    // specifikation bara mellan BankID och tjänsten.
    expect(Object.keys(order).sort()).toEqual(['autoStartToken', 'orderRef'])
  })

  it('ger olika orderreferenser och olika QR-koder för varje legitimering', async () => {
    const first = await service.auth({ endUserIp: '198.51.100.7' })
    const second = await service.auth({ endUserIp: '198.51.100.7' })

    expect(first.orderRef).not.toEqual(second.orderRef)
    expect(first.autoStartToken).not.toEqual(second.autoStartToken)

    const firstQr = await service.qrData(first.orderRef)
    const secondQr = await service.qrData(second.orderRef)

    // Olika ordrar har olika qrStartToken och olika hemlighet, så koderna får
    // inte sammanfalla ens vid samma tidpunkt.
    expect(firstQr?.qrData).not.toEqual(secondQr?.qrData)
  })
})

describe('den animerade QR-koden', () => {
  it('följer BankID:s format', async () => {
    const order = await service.auth({ endUserIp: '198.51.100.7' })
    const qr = await service.qrData(order.orderRef)

    // bankid.<qrStartToken>.<sekunder>.<qrAuthCode>
    expect(qr?.qrData).toMatch(/^bankid\.[0-9a-f-]{36}\.\d+\.[0-9a-f]{64}$/)
  })

  it('byter kod när sekunderna går', () => {
    /**
     * Koden är HMAC-SHA256 över antalet sekunder sedan ordern startade. Att
     * den byts är hela skyddet: en fotograferad kod ska vara död innan den
     * hunnit vidarebefordras till någon som luras att skanna den.
     */
    const token = 'abcdef01-2345-6789-abcd-ef0123456789'
    const secret = 'a'.repeat(64)

    const atZero = computeQrData(token, secret, 0)
    const atOne = computeQrData(token, secret, 1)
    const atTwo = computeQrData(token, secret, 2)

    expect(atZero).not.toEqual(atOne)
    expect(atOne).not.toEqual(atTwo)

    // Samma sekund ger samma kod — annars skulle två samtidiga hämtningar ge
    // olika koder och väljaren skanna en som servern inte väntar på.
    expect(computeQrData(token, secret, 1)).toEqual(atOne)
  })

  it('hemligheten går inte att utläsa ur koden', () => {
    const secret = 'hemligt-varde-som-aldrig-far-lacka'
    const qrData = computeQrData('token-1234', secret, 5)

    expect(qrData).not.toContain(secret)
  })

  it('en annan hemlighet ger en annan kod för samma sekund', () => {
    // Det är detta som gör att en angripare inte kan räkna fram giltiga koder
    // utan att ha hemligheten.
    const a = computeQrData('token-1234', 'hemlighet-a', 3)
    const b = computeQrData('token-1234', 'hemlighet-b', 3)

    expect(a).not.toEqual(b)
  })

  it('slutar generera koder när ordern gått ut', async () => {
    const order = await service.auth({ endUserIp: '198.51.100.7' })
    await service.cancel(order.orderRef)

    expect(await service.qrData(order.orderRef)).toBeNull()
  })

  it('ger ingen kod för en okänd order', async () => {
    expect(await service.qrData('00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})

describe('start-URL för samma enhet', () => {
  const RETUR = 'http://localhost:3000/identify'

  it('använder app-schemat för andra plattformar än iOS', () => {
    const url = launchUrl('token-abc', 'other', RETUR)

    expect(url).toBe('bankid:///?autostarttoken=token-abc&redirect=null')
  })

  it('iOS får en riktig returadress, inte null', () => {
    /**
     * Skillnaden är inte kosmetisk. Android återgår till webbläsaren av sig
     * själv efter `redirect=null`, men Safari gör inte det — med null blir
     * väljaren kvar på app.bankid.com och ser aldrig att legitimeringen gick
     * igenom. Det ser ut som att systemet hängt sig.
     */
    const url = launchUrl('token-abc', 'ios', RETUR)

    expect(url).toBe(
      'https://app.bankid.com/?autostarttoken=token-abc' +
        '&redirect=http%3A%2F%2Flocalhost%3A3000%2Fidentify',
    )
    expect(url).not.toContain('redirect=null')
  })

  it('returadressen kan inte styras från begärans kropp', () => {
    /**
     * Den ursprungliga invarianten var "redirect är alltid null". Den håller
     * inte längre för iOS, men den EGENSKAP den skyddade gäller fortfarande:
     * en påverkbar redirect i ett flöde som just legitimerat någon är en
     * omdirigeringssårbarhet med särskilt dålig tajming.
     *
     * Skyddet ligger nu i att anroparen bygger adressen av en origin ur
     * spärrlistan plus en fast sökväg — se auth/bankid/start/route.ts. Det
     * här testet vaktar andra halvan: att ingenting som skickas in kan bryta
     * ut ur URL:en.
     */
    const url = launchUrl('token-abc', 'ios', 'https://angripare.example/&extra=1')

    // Adressen hamnar kodad i EN parameter och kan inte lägga till fler.
    expect(url).not.toContain('&extra=1')
    expect(url.match(/&/g)).toHaveLength(1)
  })

  it('kodar token så att den inte kan bryta ut ur URL:en', () => {
    const url = launchUrl('token&redirect=https://angripare.example', 'other', RETUR)

    expect(url).not.toContain('&redirect=https://angripare.example')
    expect(url).toContain('redirect=null')
  })
})

describe('orderns livscykel', () => {
  it('är utestående tills någon skannar koden', async () => {
    const order = await service.auth({ endUserIp: '198.51.100.7' })

    // Ingen har skannat. BankID svarar att ordern är utestående, inte att den
    // väntar på en säkerhetskod.
    const result = await service.collect(order.orderRef)

    expect(result.status).toBe('pending')
    if (result.status !== 'pending') return
    expect(result.hintCode).toBe('outstandingTransaction')
  })

  it('blir klar efter att koden skannats och några pollningar gjorts', async () => {
    const order = await service.auth({ endUserIp: '198.51.100.7' })

    expect(selectDemoIdentity(order.orderRef, '19900101-1234')).toBe(true)

    let result = await service.collect(order.orderRef)
    while (result.status === 'pending') {
      expect(result.hintCode).toBe('userSign')
      result = await service.collect(order.orderRef)
    }

    expect(result.status).toBe('complete')
    if (result.status !== 'complete') return

    // Personnumret kommer HÄRIFRÅN och ingen annanstans — ur BankID:s svar,
    // efter att personen legitimerat sig.
    expect(result.completionData.personalNumber).toBe('199001011234')
    expect(result.completionData.givenName).toBe('Anna')
    expect(result.completionData.surname).toBe('Lindqvist')
  })

  it('avvisar en okänd orderreferens', async () => {
    const result = await service.collect('00000000-0000-0000-0000-000000000000')

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.hintCode).toBe('expiredTransaction')
  })

  it('kan avbrytas av väljaren', async () => {
    const order = await service.auth({ endUserIp: '198.51.100.7' })
    await service.cancel(order.orderRef)

    const result = await service.collect(order.orderRef)

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.hintCode).toBe('userCancel')
  })

  it('en order kan inte konsumeras två gånger', async () => {
    const order = await service.auth({ endUserIp: '198.51.100.7' })
    selectDemoIdentity(order.orderRef, '19900101-1234')

    let result = await service.collect(order.orderRef)
    while (result.status === 'pending') {
      result = await service.collect(order.orderRef)
    }
    expect(result.status).toBe('complete')

    // Ordern är förbrukad. Ett andra försök ska inte kunna ge en ny
    // legitimering av samma person.
    const again = await service.collect(order.orderRef)
    expect(again.status).toBe('failed')
  })

  it('en avbruten order kan inte skannas', async () => {
    const order = await service.auth({ endUserIp: '198.51.100.7' })
    await service.cancel(order.orderRef)

    expect(selectDemoIdentity(order.orderRef, '19900101-1234')).toBe(false)
  })
})

describe('ordrarna delas mellan upplagor av modulen', () => {
  it('en order som startats i en upplaga hittas i en annan', async () => {
    /**
     * Dev-servern laddar om modulerna för en rutt som byggs på nytt, medan en
     * annan rutt behåller sin gamla upplaga. Låg ordrarna i modulen startade
     * /api/auth/bankid/start en order som /api/auth/bankid/collect inte kunde
     * hitta, och legitimeringen misslyckades. Här laddas modulen en gång till,
     * som en rutt som byggts om, och ordern ska finnas kvar i den.
     */
    const order = await service.auth({ endUserIp: '198.51.100.7' })

    vi.resetModules()
    const reloaded = await import('@/modules/eligibility/bankid/MockBankIdService')
    expect(reloaded.MockBankIdService).not.toBe(MockBankIdService)

    expect(reloaded.selectDemoIdentity(order.orderRef, '19900101-1234')).toBe(true)
    // "failed" är just felet: en order som inte finns ger expiredTransaction.
    const result = await new reloaded.MockBankIdService().collect(order.orderRef)
    expect(result.status).not.toBe('failed')
  })
})
