import { canonicalOptions, type BallotShape } from '../src/lib/crypto/ballot-encoding'
import { buildFixedBaseTable, type FixedBaseTable } from '../src/lib/crypto/fixed-base'
import {
  FIXED_BASE_WINDOW_BITS,
  G,
  P,
  Q,
  bigintModPow,
  randomScalar,
  registerGroupExponentiation,
} from '../src/lib/crypto/group'
import { encryptBallot } from '../src/lib/encrypt-client'

/**
 * MÄTNINGARNA I WEBBLÄSAREN. Buntas och körs av scripts/measure-crypto.ts --chromium.
 *
 * Allt räknas här, i sidan, med samma kod som röstsidan kör. Resultatet går
 * tillbaka till Node som en lista rader att skriva ut.
 */

export type Row = { label: string; value: number; unit: string }

const SHAPE: BallotShape = {
  allowsCandidateVote: true,
  parties: Array.from({ length: 5 }, (_, party) => ({
    id: `parti-${party + 1}`,
    displayOrder: party + 1,
    candidates: Array.from({ length: 4 }, (_, candidate) => ({
      id: `kandidat-${party + 1}-${candidate + 1}`,
      displayOrder: candidate + 1,
    })),
  })),
}

function timed(run: () => void, rounds: number): number {
  const start = performance.now()
  for (let round = 0; round < rounds; round += 1) run()
  return (performance.now() - start) / rounds
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function measure(): Row[] {
  const rows: Row[] = []
  const exponents = Array.from({ length: 30 }, () => randomScalar())
  const h = bigintModPow(G, randomScalar(), P)
  const bases = exponents.map((exponent) => bigintModPow(G, exponent, P))
  const options = canonicalOptions(SHAPE)
  const choice = { kind: 'CANDIDATE', ballotPartyId: 'parti-3', candidateId: 'kandidat-3-2' } as const
  const encryptOnce = () =>
    encryptBallot(h.toString(), 'val-mätning', 'valsedel-mätning', options, choice)

  let index = 0
  const next = () => exponents[index++ % exponents.length]!
  rows.push({ label: 'modexp i BigInt, bas g', value: timed(() => bigintModPow(G, next(), P), 30), unit: 'ms' })
  rows.push({ label: 'modexp i BigInt, bas h', value: timed(() => bigintModPow(h, next(), P), 30), unit: 'ms' })
  rows.push({
    label: 'modexp i BigInt, godtycklig bas',
    value: timed(() => bigintModPow(bases[index % bases.length]!, next(), P), 30),
    unit: 'ms',
  })

  // Kryptering före uppgift 14b: varje potens i BigInt, utan tabeller.
  registerGroupExponentiation((base, exponent) => bigintModPow(base, exponent, P))
  rows.push({
    label: 'kryptering 26 alternativ, bara BigInt (som före 14b)',
    value: median([0, 1, 2].map(() => timed(encryptOnce, 1))),
    unit: 'ms',
  })

  // Varje fönsterbredd: tabellens storlek, byggtid och en exponentiering, och
  // en hel kryptering med tabeller av den bredden för g och h.
  const exponentBits = P.toString(2).length
  for (let window = 2; window <= 8; window += 1) {
    let table: FixedBaseTable | null = null
    const build = timed(() => {
      table = buildFixedBaseTable(h, P, exponentBits, window)
    }, 1)
    const pow = timed(() => table!.pow(next()), 60)

    rows.push({ label: `fönster ${window}: tabellens tal`, value: table!.entries, unit: 'st' })
    rows.push({ label: `fönster ${window}: tabellens storlek`, value: (table!.entries * 256) / 1e6, unit: 'MB' })
    rows.push({ label: `fönster ${window}: byggtid`, value: build, unit: 'ms' })
    rows.push({ label: `fönster ${window}: modexp med tabell`, value: pow, unit: 'ms' })

    // Första valsedeln bygger tabellerna, de följande återanvänder dem.
    const tables = new Map<bigint, FixedBaseTable>()
    registerGroupExponentiation((base, exponent) => {
      if (base === G || base === h) {
        let fixed = tables.get(base)
        if (!fixed) {
          fixed = buildFixedBaseTable(base, P, exponentBits, window)
          tables.set(base, fixed)
        }
        const viaTable = fixed.pow(exponent)
        if (viaTable !== null) return viaTable
      }
      return bigintModPow(base, exponent, P)
    })
    rows.push({ label: `fönster ${window}: första valsedeln, med byggen`, value: timed(encryptOnce, 1), unit: 'ms' })
    rows.push({
      label: `fönster ${window}: följande valsedlar`,
      value: median([0, 1, 2].map(() => timed(encryptOnce, 1))),
      unit: 'ms',
    })
  }

  // Den riktiga vägen, som röstsidan kör den: inget registrerat, tabellerna i
  // group.ts med den valda bredden.
  registerGroupExponentiation(null)
  rows.push({
    label: `röstsidans väg (fönster ${FIXED_BASE_WINDOW_BITS}): första valsedeln`,
    value: timed(encryptOnce, 1),
    unit: 'ms',
  })
  rows.push({
    label: `röstsidans väg (fönster ${FIXED_BASE_WINDOW_BITS}): följande valsedlar`,
    value: median([0, 1, 2].map(() => timed(encryptOnce, 1))),
    unit: 'ms',
  })
  rows.push({ label: 'kontroll: q har bitar', value: Q.toString(2).length, unit: 'st' })

  return rows
}

;(globalThis as { measureCrypto?: () => Row[] }).measureCrypto = measure
