import { G, P, Q, isInSubgroup, modPow, randomScalar } from './group'

export type Ciphertext = { c1: bigint; c2: bigint }
export type KeyPair = { privateKey: bigint; publicKey: bigint }

export function generateKeyPair(): KeyPair {
  const privateKey = randomScalar()
  return { privateKey, publicKey: modPow(G, privateKey, P) }
}

/**
 * Exponentiell ElGamal: klartexten läggs i exponenten.
 *
 * Det gör summering möjlig utan dekryptering — priset är att dekrypteringen ger
 * g^m och att m måste sökas fram. Eftersom m är ett röstetal är sökrymden liten.
 */
export function encrypt(publicKey: bigint, message: bigint, nonce: bigint): Ciphertext {
  return {
    c1: modPow(G, nonce, P),
    c2: (modPow(publicKey, nonce, P) * modPow(G, message, P)) % P,
  }
}

/** Komponentvis produkt. Krypterar summan av klartexterna. */
export function multiply(a: Ciphertext, b: Ciphertext): Ciphertext {
  return { c1: (a.c1 * b.c1) % P, c2: (a.c2 * b.c2) % P }
}

/** Endast för tester och för den betrodda utdelaren. Drift använder tröskeln. */
export function decryptWithSecret(privateKey: bigint, ciphertext: Ciphertext): number {
  const shared = modPow(ciphertext.c1, privateKey, P)
  const inverse = modPow(shared, Q - 1n, P)
  return discreteLog((ciphertext.c2 * inverse) % P, 1_000_000)
}

/**
 * Baby-step giant-step över [0, maximum].
 *
 * Kastar hellre än gissar: ett röstetal utanför intervallet betyder att något
 * annat är fel, och ett tyst felaktigt tal vore värre än ett avbrott.
 */
export function discreteLog(target: bigint, maximum: number): number {
  const step = Math.ceil(Math.sqrt(maximum + 1))
  const table = new Map<string, number>()

  let value = 1n
  for (let j = 0; j <= step; j += 1) {
    table.set(value.toString(), j)
    value = (value * G) % P
  }

  const factor = modPow(modPow(G, BigInt(step), P), Q - 1n, P)
  let gamma = target

  for (let i = 0; i <= step; i += 1) {
    const found = table.get(gamma.toString())
    if (found !== undefined) {
      const result = i * step + found
      if (result <= maximum) return result
    }
    gamma = (gamma * factor) % P
  }

  throw new Error(`Diskret logaritm saknas i [0, ${maximum}].`)
}

export { isInSubgroup }
