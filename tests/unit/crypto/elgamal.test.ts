import { describe, expect, it } from 'vitest'
import { G, P, Q, bigintModPow, isInSubgroup, modPow, randomScalar } from '@/lib/crypto/group'
import {
  decryptWithSecret,
  discreteLog,
  encrypt,
  generateKeyPair,
  multiply,
} from '@/lib/crypto/elgamal'

describe('gruppen', () => {
  it('g har ordning q, inte 2q', () => {
    // Vi använder g = 4 = 2², ett kvadrattal, och ett sådant har ordning q för
    // varje säker prim. Här stod förut att RFC 3526:s g = 2 genererar hela
    // gruppen av ordning 2q. Det stämmer inte för den här gruppen: p ≡ 7
    // (mod 8), så 2 är en kvadratisk rest och har också ordning q, som
    // raden nedan visar. Mot den lilla undergruppen skyddar i stället
    // kontrollen av varje mottaget element.
    expect(modPow(G, Q, P)).toBe(1n)
    expect(G).toBe(4n)
    expect(P % 8n).toBe(7n)
    expect(bigintModPow(2n, Q, P)).toBe(1n)
  })

  it('avvisar element utanför undergruppen', () => {
    expect(isInSubgroup(modPow(G, 12345n, P))).toBe(true)
    expect(isInSubgroup(1n)).toBe(false)
    expect(isInSubgroup(P - 1n)).toBe(false) // ordning 2
    expect(isInSubgroup(0n)).toBe(false)
    expect(isInSubgroup(P)).toBe(false)
  })

  it('slumptal ligger i [1, q-1]', () => {
    for (let i = 0; i < 50; i += 1) {
      const r = randomScalar()
      expect(r > 0n && r < Q).toBe(true)
    }
  })
})

describe('kryptering', () => {
  it('det som krypteras går att dekryptera', () => {
    const keys = generateKeyPair()
    const ciphertext = encrypt(keys.publicKey, 1n, randomScalar())

    expect(decryptWithSecret(keys.privateKey, ciphertext)).toBe(1)
  })

  it('samma klartext ger olika chiffer varje gång', () => {
    // Annars kan vem som helst se vilka väljare som valt samma alternativ
    // genom att jämföra chiffren, och valhemligheten faller utan att någon
    // nyckel läckt.
    const keys = generateKeyPair()
    const first = encrypt(keys.publicKey, 1n, randomScalar())
    const second = encrypt(keys.publicKey, 1n, randomScalar())

    expect(first.c1).not.toBe(second.c1)
    expect(first.c2).not.toBe(second.c2)
  })

  it('chiffer ligger i undergruppen', () => {
    const keys = generateKeyPair()
    const ciphertext = encrypt(keys.publicKey, 1n, randomScalar())

    expect(isInSubgroup(ciphertext.c1)).toBe(true)
    expect(isInSubgroup(ciphertext.c2)).toBe(true)
  })
})

describe('homomorf summering', () => {
  it('produkten av chiffer krypterar summan av klartexterna', () => {
    // Detta är hela grunden: rösterna räknas utan att någon enskild öppnas.
    const keys = generateKeyPair()
    const ones = Array.from({ length: 7 }, () => encrypt(keys.publicKey, 1n, randomScalar()))
    const zeros = Array.from({ length: 3 }, () => encrypt(keys.publicKey, 0n, randomScalar()))

    const sum = [...ones, ...zeros].reduce((a, b) => multiply(a, b))

    expect(decryptWithSecret(keys.privateKey, sum)).toBe(7)
  })

  it('en tom summa ger noll, inte en oändlig loop', () => {
    // REVIEW FOCUS 6. En valsedel utan röster ger g^0 = 1, och en naiv
    // baby-step giant-step som börjar på 1 kan missa fallet.
    const keys = generateKeyPair()
    const zero = encrypt(keys.publicKey, 0n, randomScalar())

    expect(decryptWithSecret(keys.privateKey, zero)).toBe(0)
  })
})

describe('diskret logaritm', () => {
  it('hittar små exponenter', () => {
    for (const m of [0, 1, 2, 17, 500, 4999]) {
      expect(discreteLog(modPow(G, BigInt(m), P), 5000)).toBe(m)
    }
  })

  it('kastar när värdet ligger utanför intervallet', () => {
    // Hellre ett fel än ett tyst felaktigt röstetal.
    expect(() => discreteLog(modPow(G, 9999n, P), 100)).toThrow()
  })
})
