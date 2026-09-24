import type { DiffieHellman } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { encrypt } from '@/lib/crypto/elgamal'
import { G, G_INVERSE, P, Q, randomScalar, registerGroupExponentiation } from '@/lib/crypto/group'
import { nativeModPow } from '@/lib/crypto/native-exponentiation'
import { challengeHash, verifyZeroOrOne, type ZeroOrOneProof } from '@/lib/crypto/proofs'

/**
 * OPENSSL MOT BIGINT.
 *
 * `nativeModPow` räknar bas^exponent mod p i OpenSSL genom Diffie–Hellman, och
 * måste ge exakt samma svar som `bigintModPow` för varje indata. Ett fel här
 * är inte ett prestandafel: räknas en potens fel kan en falsk röst godkännas
 * eller en äkta underkännas, och ingenting annat i systemet märker det.
 *
 * Testet prövar därför tre saker var för sig. Först fällorna i OpenSSL, så som
 * de faktiskt ser ut, så att det syns om en ny Node-version ändrar dem. Sedan
 * varje gränsfall för bas och exponent. Sist tusentals slumpade indata.
 */

// Varje DH-objekt som modulen skapar, fångat här så att testet kan se hur många
// som skapas och vad som ligger kvar i dem mellan anropen. Testets egna objekt
// skapas med den riktiga funktionen och hamnar inte här.
const created = vi.hoisted(() => ({ objects: [] as DiffieHellman[] }))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    createDiffieHellman: (...args: Parameters<typeof actual.createDiffieHellman>) => {
      const object = actual.createDiffieHellman(...args)
      created.objects.push(object)
      return object
    },
  }
})

// Referensen räknas med den riktiga funktionen. Anropen från modulen går genom
// en spion, så att testet kan se vilka indata som faller tillbaka på BigInt.
vi.mock('@/lib/crypto/group', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crypto/group')>()
  return { ...actual, bigintModPow: vi.fn(actual.bigintModPow) }
})

const nodeCrypto = await vi.importActual<typeof import('node:crypto')>('node:crypto')
const { bigintModPow: fallback } = await import('@/lib/crypto/group')

const { bigintModPow } =
  await vi.importActual<typeof import('@/lib/crypto/group')>('@/lib/crypto/group')

function toBytes(value: bigint): Buffer {
  const hex = value.toString(16)
  return Buffer.from(hex.length % 2 === 0 ? hex : '0' + hex, 'hex')
}

function randomBits(bits: number): bigint {
  const bytes = nodeCrypto.randomBytes(Math.ceil(bits / 8))
  return BigInt('0x' + bytes.toString('hex')) >> BigInt(bytes.length * 8 - bits)
}

/**
 * Ett element i undergruppen.
 *
 * Produkten av två element i undergruppen ligger också där, så ett litet
 * förråd av g^x räcker för tusentals nya element, med en multiplikation var i
 * stället för en exponentiering. Annars hade referensen själv tagit det mesta
 * av testets tid.
 */
const SUBGROUP_POOL = Array.from({ length: 24 }, () => bigintModPow(G, randomBits(256), P))

function subgroupElement(): bigint {
  const pick = () => SUBGROUP_POOL[nodeCrypto.randomInt(SUBGROUP_POOL.length)]!
  return (pick() * pick() * pick()) % P
}

describe('fällorna i OpenSSL, som nativeModPow måste gå runt', () => {
  // Rå anrop mot node:crypto, utan modulen. Blir något av de här rött har Node
  // eller OpenSSL ändrat beteende, och kommentaren i native-exponentiation.ts
  // stämmer inte längre. Modulen själv ska klara både det gamla och det nya.
  const dh = nodeCrypto.createDiffieHellman(toBytes(P), toBytes(G))
  const raw = (base: bigint, exponent: bigint): Buffer => {
    dh.setPrivateKey(toBytes(exponent))
    return dh.computeSecret(toBytes(base))
  }

  it('räknar bas^exponent mod p med exponenten som privat nyckel', () => {
    const base = subgroupElement()
    const exponent = randomBits(2047)
    expect(BigInt('0x' + raw(base, exponent).toString('hex'))).toBe(bigintModPow(base, exponent, P))
  })

  it('vägrar baserna 0, 1 och p − 1 och allt från p och uppåt', () => {
    for (const base of [0n, 1n, P - 1n, P, P + 1n]) {
      expect(() => raw(base, 12345n), String(base)).toThrow()
    }
  })

  it('lämnar en tom buffert, utan att kasta, när resultatet är 1', () => {
    // g^q = 1 för varje element i undergruppen, så varje undergruppskontroll
    // skulle träffa det här om den räknades rakt på.
    expect(raw(G, Q).length).toBe(0)
    expect(raw(subgroupElement(), Q).length).toBe(0)
  })

  it('lämnar en tom buffert när resultatet är p − 1', () => {
    // Ett element utanför undergruppen har y^q = −1.
    const outside = P - subgroupElement()
    expect(bigintModPow(outside, Q, P)).toBe(P - 1n)
    expect(raw(outside, Q).length).toBe(0)
  })

  it('med generatorn 2 känns gruppen igen, och då vägras varje bas utanför undergruppen', () => {
    // Skälet till att modulen använder generatorn 4: med den namngivna gruppen
    // prövar OpenSSL själv varje bas, vilket dubblar tiden och gör att
    // p − y inte går att räkna på alls.
    const named = nodeCrypto.createDiffieHellman(toBytes(P), toBytes(2n))
    named.setPrivateKey(toBytes(12345n))
    const outside = P - subgroupElement()

    expect(() => named.computeSecret(toBytes(outside))).toThrow()
    expect(raw(outside, 12345n).length).toBe(256)
  })

  it('fyller ut ett resultat med inledande nollor till full längd', () => {
    // Ett resultat under 2^2040 har en inledande nollbyte. Modulen läser
    // talet som ett tal och bryr sig inte om längden, men en tom buffert får
    // aldrig bli noll.
    let found = false
    for (let attempt = 0; attempt < 4000 && !found; attempt += 1) {
      const exponent = randomBits(64) + 1n
      const shared = raw(G, exponent)
      if (shared[0] === 0) {
        found = true
        expect(shared.length).toBe(256)
        expect(BigInt('0x' + shared.toString('hex'))).toBe(bigintModPow(G, exponent, P))
      }
    }
    expect(found).toBe(true)
  })
})

describe('nativeModPow ger samma svar som BigInt', () => {
  const inside = subgroupElement()
  const outside = P - subgroupElement()

  const bases: Array<[string, bigint]> = [
    ['0', 0n],
    ['1', 1n],
    ['2', 2n],
    ['g', G],
    ['p − 2', P - 2n],
    ['p − 1', P - 1n],
    ['p', P],
    ['p + 1', P + 1n],
    ['2p + 3', 2n * P + 3n],
    ['ett element i undergruppen', inside],
    ['ett element utanför undergruppen', outside],
  ]

  const exponents: Array<[string, bigint]> = [
    ['0', 0n],
    ['1', 1n],
    ['2', 2n],
    ['q − 1', Q - 1n],
    ['q', Q],
    ['q + 1', Q + 1n],
    ['2q', 2n * Q],
    ['p − 1', P - 1n],
    ['p', P],
    ['2^2048', 1n << 2048n],
    ['2^4096 + 5', (1n << 4096n) + 5n],
  ]

  it('för varje kombination av gränsfall för bas och exponent', () => {
    for (const [baseName, base] of bases) {
      for (const [exponentName, exponent] of exponents) {
        expect(nativeModPow(base, exponent), `bas ${baseName}, exponent ${exponentName}`).toBe(
          bigintModPow(base, exponent, P),
        )
      }
    }
  })

  it('för negativa tal, som BigInt räknar på sitt eget sätt', () => {
    // Förekommer aldrig i kryptot, men "samma svar för varje indata" ska vara sant.
    for (const [base, exponent] of [
      [-5n, 3n],
      [-P, 7n],
      [5n, -3n],
      [-2n, -2n],
    ] as const) {
      expect(nativeModPow(base, exponent)).toBe(bigintModPow(base, exponent, P))
    }
  })

  it('när resultatet är 1 eller p − 1, som OpenSSL inte lämnar ut', () => {
    // Här går modulen vägen över bas^(e+1). Exponenter som är multipler av q
    // är vad en klient skulle skicka för att tvinga fram den vägen.
    const cases: Array<[bigint, bigint, bigint]> = [
      [inside, Q, 1n],
      [inside, 5n * Q, 1n],
      [G, Q, 1n],
      [outside, Q, P - 1n],
      [outside, 3n * Q, P - 1n],
      [outside, 2n * Q, 1n],
      [2n, P - 1n, 1n],
    ]
    for (const [base, exponent, expected] of cases) {
      expect(bigintModPow(base, exponent, P)).toBe(expected)
      expect(nativeModPow(base, exponent)).toBe(expected)
    }
  })

  it('på tusentals slumpade indata', () => {
    // De flesta exponenterna är korta, så att referensen i BigInt hinner räkna
    // dem inom en rimlig tid; i OpenSSL går de genom samma kod som de långa.
    // Var femtionde får q adderat, så att också exponenter över q prövas. De
    // fulla exponenterna, som är de vanligaste i drift, är färre här, eftersom
    // varje referens kostar 40 ms. Många fler körs med
    // `npx tsx scripts/measure-crypto.ts --jamfor`.
    let compared = 0

    for (let round = 0; round < 2000; round += 1) {
      const kind = round % 3
      const base =
        kind === 0 ? subgroupElement() : kind === 1 ? P - subgroupElement() : randomBits(2048) % P
      const exponent = randomBits(1 + (round % 256)) + (round % 50 === 0 ? Q : 0n)
      expect(nativeModPow(base, exponent), `bas ${base}, exponent ${exponent}`).toBe(
        bigintModPow(base, exponent, P),
      )
      compared += 1
    }

    for (let round = 0; round < 60; round += 1) {
      const base = round % 2 === 0 ? subgroupElement() : randomBits(2048) % P
      const exponent = randomBits(2047) % Q
      expect(nativeModPow(base, exponent)).toBe(bigintModPow(base, exponent, P))
      compared += 1
    }

    expect(compared).toBe(2060)
  }, 120_000)
})

describe('vad som räknas i OpenSSL och vad som faller tillbaka på BigInt', () => {
  const fellBack = (base: bigint, exponent: bigint): boolean => {
    vi.mocked(fallback).mockClear()
    nativeModPow(base, exponent)
    return vi.mocked(fallback).mock.calls.length > 0
  }

  it('varje vanlig exponentiering, med en bas i [2, p − 2] och en exponent över 0', () => {
    expect(fellBack(subgroupElement(), randomBits(2047))).toBe(false)
    expect(fellBack(P - subgroupElement(), randomBits(2047))).toBe(false)
    expect(fellBack(2n, 5n)).toBe(false)
    expect(fellBack(P - 2n, Q + 1n)).toBe(false)
    // En bas från p och uppåt reduceras först, som BigInt själv gör.
    expect(fellBack(P + 5n, 3n)).toBe(false)
  })

  it('också när resultatet är 1 eller p − 1, genom ett anrop till', () => {
    // Annars hade en klient kunnat tvinga varje exponentiering till BigInt,
    // 25 gånger långsammare, med exponenter som är multipler av q.
    expect(fellBack(subgroupElement(), Q)).toBe(false)
    expect(fellBack(subgroupElement(), 7n * Q)).toBe(false)
    expect(fellBack(P - subgroupElement(), Q)).toBe(false)
  })

  it('bara baserna 0, 1 och p − 1, exponenter under 1 och negativa baser faller tillbaka', () => {
    // I alla dessa fall är BigInt trivial: talen blir 0 eller 1 efter första
    // varvet, eller så räknas ingenting alls.
    for (const [base, exponent] of [
      [0n, Q],
      [1n, Q],
      [P - 1n, Q],
      [P, Q],
      [subgroupElement(), 0n],
      [subgroupElement(), -1n],
      [-3n, 5n],
    ] as const) {
      expect(fellBack(base, exponent), `bas ${base}, exponent ${exponent}`).toBe(true)
    }
  })
})

describe('varför den tomma bufferten aldrig får bli ett tal', () => {
  it('läst som noll hade den godkänt ett förfalskat bevis för ett chiffer av 2', () => {
    /**
     * Den farligaste fällan, konkret. Svaret 1 blir en tom buffert, och en
     * omvandling som läser den som 0 gör g^q och h^q till 0. Ett bevis vars
     * nollgren har svaret q och åtagandena a0 = b0 = 0 uppfyller då båda
     * nollgrenens ekvationer, 0 = 0 · c1^c0, utan att bevisaren vet något. Den
     * andra grenen simuleras som vanligt. Resultatet är ett godkänt
     * 0-eller-1-bevis för ett chiffer som krypterar 2, alltså två röster i ett
     * alternativ.
     */
    const h = bigintModPow(G, randomScalar(), P)
    const ciphertext = encrypt(h, 2n, randomScalar())
    const context = 'val|valsedel|0'

    const challenge1 = randomScalar()
    const response1 = randomScalar()
    const shifted = (ciphertext.c2 * G_INVERSE) % P
    const a1 = (bigintModPow(G, response1, P) * bigintModPow(ciphertext.c1, Q - challenge1, P)) % P
    const b1 = (bigintModPow(h, response1, P) * bigintModPow(shifted, Q - challenge1, P)) % P
    const hash = challengeHash(context, [ciphertext.c1, ciphertext.c2, 0n, 0n, a1, b1])

    const forged: ZeroOrOneProof = {
      a0: 0n,
      b0: 0n,
      a1,
      b1,
      challenge0: (hash - challenge1 + Q) % Q,
      challenge1,
      response0: Q,
      response1,
    }

    const engine = nodeCrypto.createDiffieHellman(toBytes(P), toBytes(G))
    const naive = (base: bigint, exponent: bigint): bigint => {
      if (base <= 1n || base >= P - 1n || exponent <= 0n) return bigintModPow(base, exponent, P)
      engine.setPrivateKey(toBytes(exponent))
      const shared = engine.computeSecret(toBytes(base))
      return shared.length === 0 ? 0n : BigInt('0x' + shared.toString('hex'))
    }

    try {
      registerGroupExponentiation(naive)
      expect(verifyZeroOrOne(h, ciphertext, forged, context)).toBe(true)

      registerGroupExponentiation(nativeModPow)
      expect(verifyZeroOrOne(h, ciphertext, forged, context)).toBe(false)

      registerGroupExponentiation(null)
      expect(verifyZeroOrOne(h, ciphertext, forged, context)).toBe(false)
    } finally {
      registerGroupExponentiation(null)
    }
  })
})

describe('objektet i OpenSSL', () => {
  it('skapas en gång och återanvänds, med generatorn 4', () => {
    // Att skapa det kostar omkring 170 ms, eftersom OpenSSL primtalsprövar p
    // och (p − 1)/2 för en grupp den inte känner igen. Tidigare describe-block
    // har redan räknat, så objektet finns; tjugo anrop till ska inte skapa fler.
    nativeModPow(subgroupElement(), randomBits(2047))
    const before = created.objects.length
    for (let round = 0; round < 20; round += 1) nativeModPow(subgroupElement(), randomBits(2047))

    expect(created.objects.length).toBe(before)
    expect(created.objects).toHaveLength(1)
    expect(created.objects[0]!.getGenerator('hex')).toBe('04')
  })

  it('behåller inte exponenten efter anropet', () => {
    // En förtroendemans andel är en exponent här. Den ska inte ligga kvar i
    // det återanvända objektet till nästa anrop.
    const share = randomBits(2047) % Q
    const base = subgroupElement()
    expect(nativeModPow(base, share)).toBe(bigintModPow(base, share, P))

    expect(created.objects[0]!.getPrivateKey('hex')).toBe('01')
  })
})
