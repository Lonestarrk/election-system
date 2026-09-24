import { createHash } from 'node:crypto'

/**
 * EN FÖRUTSÄGBAR SLUMPKÄLLA, BARA FÖR TESTER.
 *
 * Varje slumptal i kryptot kommer från `crypto.getRandomValues` (se
 * `randomScalar` i src/lib/crypto/group.ts). Byts den ut mot den här blir en
 * kryptering upprepbar: samma frö ger samma slumptal i samma ordning, och
 * därmed samma chiffer och samma bevis, byte för byte.
 *
 * Det är så testerna visar att en snabbare exponentiering inte ändrade något i
 * bevisen. En valsedel krypterades med den gamla koden och ett känt frö, och
 * sparades (fixtures/ballot-26-before-14b.json). Samma frö genom den nya koden
 * ska ge exakt den valsedeln. Skiljer sig ett enda tal har antingen något
 * räknats annorlunda eller hashats i en annan ordning.
 *
 * Byteströmmen är SHA-256 över fröet och en räknare. Den är inte slumpmässig
 * i någon kryptografisk mening, och får aldrig användas utanför tester.
 */
export function seededRandomValues(seed: string): <T extends ArrayBufferView | null>(array: T) => T {
  let counter = 0
  let pool: Buffer = Buffer.alloc(0)

  return <T extends ArrayBufferView | null>(array: T): T => {
    if (!array) return array
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)

    while (pool.length < bytes.length) {
      const block = createHash('sha256').update(`${seed}:${counter}`).digest()
      counter += 1
      pool = Buffer.concat([pool, block])
    }

    bytes.set(pool.subarray(0, bytes.length))
    pool = pool.subarray(bytes.length)
    return array
  }
}
