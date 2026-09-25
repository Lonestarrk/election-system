import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { merkleRoot } from '@/lib/merkle'
import { URN_LEAF_PREFIX, urnLeaf, urnRootOf } from '@/lib/urn-root'

/**
 * URNROTEN RÄKNAD OBEROENDE AV KODEN (uppgift 12b).
 *
 * Uppgift 13 ska kunna räkna om roten utan att importera något ur src, och
 * specen ska kunna beskriva den exakt. Testet räknar därför fram bladen och
 * trädet här, med node:crypto och beskrivningen i src/lib/urn-root.ts, och
 * jämför med koden:
 *
 *   – bladet är SHA-256 över byten 0x00 och UTF-8 av
 *     "valsystem/urnrot/v1|<valsedelns id>|<chifferhash>"
 *   – bladen sorteras stigande på sina hashar, som hex med gemener, och varje
 *     blad är med, också två likadana
 *   – nivå för nivå hashas par från vänster, SHA-256 över 0x01, vänster och
 *     höger som 32 byte vardera, och en udda sista nod lyfts upp oförändrad
 *   – roten är SHA-256 över 0x02, antalet blad som 8 byte big-endian och den
 *     översta noden. Utan blad är den översta noden SHA-256 över bara 0x00.
 */

function sha256(...parts: Buffer[]): Buffer {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest()
}

function leafOf(ballotId: string, ciphertextHash: string): Buffer {
  return sha256(Buffer.from([0x00]), Buffer.from(`valsystem/urnrot/v1|${ballotId}|${ciphertextHash}`, 'utf8'))
}

function rootOf(leaves: Buffer[]): string {
  const count = Buffer.alloc(8)
  count.writeBigUInt64BE(BigInt(leaves.length))
  if (leaves.length === 0) return sha256(Buffer.from([0x02]), count, sha256(Buffer.from([0x00]))).toString('hex')

  let level = [...leaves].sort(Buffer.compare)
  while (level.length > 1) {
    const next: Buffer[] = []
    for (let index = 0; index < level.length; index += 2) {
      const right = level[index + 1]
      next.push(right ? sha256(Buffer.from([0x01]), level[index]!, right) : level[index]!)
    }
    level = next
  }
  return sha256(Buffer.from([0x02]), count, level[0]!).toString('hex')
}

const FIRST = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'
const hash = (digit: string) => digit.repeat(64)

describe('urnroten', () => {
  it('bladet är SHA-256 över 0x00 och prefixet, valsedeln och chifferhashen', () => {
    expect(URN_LEAF_PREFIX).toBe('valsystem/urnrot/v1')
    expect(urnLeaf({ ballotId: FIRST, ciphertextHash: hash('a') })).toBe(leafOf(FIRST, hash('a')).toString('hex'))
  })

  it.each([0, 1, 2, 3, 5, 8])('roten över %i rader räknas som beskrivet', (count) => {
    const rows = Array.from({ length: count }, (_, index) => ({
      ballotId: index % 2 === 0 ? FIRST : SECOND,
      ciphertextHash: hash('0123456789abcdef'[index]!),
    }))
    expect(urnRootOf(rows)).toBe(rootOf(rows.map((row) => leafOf(row.ballotId, row.ciphertextHash))))
  })

  it('ordningen raderna kommer i spelar ingen roll', () => {
    const rows = ['c', 'a', 'e', 'b'].map((digit) => ({ ballotId: FIRST, ciphertextHash: hash(digit) }))
    expect(urnRootOf(rows)).toBe(urnRootOf([...rows].reverse()))
  })

  it('en kopia räknas: två likadana rader ger en annan rot än en (ruling 130)', () => {
    const row = { ballotId: FIRST, ciphertextHash: hash('a') }
    const other = { ballotId: FIRST, ciphertextHash: hash('b') }
    expect(urnRootOf([row, row, other])).not.toBe(urnRootOf([row, other]))
    expect(urnRootOf([row, row, other])).toBe(rootOf([leafOf(FIRST, hash('a')), leafOf(FIRST, hash('a')), leafOf(FIRST, hash('b'))]))
  })

  it('samma chiffer på en annan valsedel ger en annan rot', () => {
    // Utan valsedeln i bladet hade en rad kunnat flyttas mellan två valsedlar
    // med lika många alternativ utan att roten ändrades.
    expect(urnRootOf([{ ballotId: FIRST, ciphertextHash: hash('a') }])).not.toBe(
      urnRootOf([{ ballotId: SECOND, ciphertextHash: hash('a') }]),
    )
  })

  it('en tom urna har den tomma mängdens rot, samma som för inga kuvert', () => {
    expect(urnRootOf([])).toBe(merkleRoot([]))
    expect(urnRootOf([])).toBe(rootOf([]))
  })
})
