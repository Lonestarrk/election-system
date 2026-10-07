import { describe, expect, it } from 'vitest'
import {
  planElectionSeed,
  SEED_WARNING_PREFIX,
  type ExistingElection,
} from '../../prisma/election-seed-report'
import { demoElectionWindow } from '@/lib/demo-election'

/**
 * SEEDNINGEN FÅR INTE PÅSTÅ ATT DEN GJORT NÅGOT DEN INTE GJORT.
 *
 * Det här är inte en formalitet. Skriptet skrev tidigare "Omröstning: Valet
 * 2026 med tre valsedlar" oavsett utfall, och när en kvarlämnad omröstning
 * från integrationstesterna gjorde att steget hoppades över rapporterade det
 * ändå framgång. Appen startade utan någon omröstning att rösta i, och
 * felsökningen började i gränssnittet — för det var där symptomen fanns.
 *
 * En falsk kvittens är värre än inget besked, eftersom den aktivt styr bort
 * från orsaken.
 *
 * SEDAN HÄRDNINGEN FLYTTAR SEEDNINGEN FRAM TIDERNA på ett demoval som redan
 * finns och inte är stängt. Förut lämnades det orört, och ett demoval som en
 * gång seedats stängde för läggning efter trettio dygn, tills någon tryckte på
 * återställningsknappen. Ett stängt demoval, alltså ett vars fas lämnat OPEN,
 * rörs fortfarande inte: där har stängningen raderat kopplingen, och bara
 * återställningen tömmer urnan och sätter fasen till OPEN.
 */

const NU = new Date('2026-09-22T12:00:00Z')
const FÖNSTRET = demoElectionWindow(NU)

function demoval(fields: Partial<ExistingElection>): ExistingElection {
  return {
    opensAt: new Date('2026-09-01T00:00:00Z'),
    closesAt: new Date('2026-09-30T00:00:00Z'),
    phase: 'OPEN',
    mode: 'DEMO',
    ...fields,
  }
}

describe('när ingen omröstning finns', () => {
  it('skapar den och rapporterar det', () => {
    const plan = planElectionSeed(null, NU)

    expect(plan.action).toBe('create')
    expect(plan.report.status).toBe('created')
    expect(plan.report.message).toContain('skapad')
  })
})

describe('när demovalet finns och inte är stängt', () => {
  it('flyttar fram tiderna till demovalets fönster från idag', () => {
    const plan = planElectionSeed(demoval({}), NU)

    expect(plan.action).toBe('advance')
    if (plan.action !== 'advance') return
    expect(plan.window).toEqual(FÖNSTRET)
    expect(plan.report.status).toBe('existing_advanced')
    expect(plan.report.message).toContain('fanns redan')
    expect(plan.report.message).toContain(FÖNSTRET.closesAt.toISOString().slice(0, 10))
    // Frågan skapas bara tillsammans med omröstningen, och det ska beskedet säga.
    expect(plan.report.message).toMatch(/frågan skapas inte/i)
    expect(plan.report.message).not.toContain('skapad')
  })

  it('flyttar fram tiderna också när closesAt har passerat men fasen står i OPEN', () => {
    const plan = planElectionSeed(
      demoval({ opensAt: new Date('2026-08-01T00:00:00Z'), closesAt: new Date('2026-08-31T00:00:00Z') }),
      NU,
    )

    expect(plan.action).toBe('advance')
    expect(plan.report.message).not.toContain(SEED_WARNING_PREFIX)
  })

  it('flyttar fram ett demoval som ännu inte öppnat', () => {
    const plan = planElectionSeed(
      demoval({ opensAt: new Date('2026-10-01T00:00:00Z'), closesAt: new Date('2026-10-01T12:00:00Z') }),
      NU,
    )

    expect(plan.action).toBe('advance')
  })

  it('flyttar aldrig closesAt bakåt för ett demoval som inte har öppnat än (granskningen av härdningen)', () => {
    // opensAt ligger i framtiden, och closesAt längre fram än demovalets nya fönster.
    const closesAt = new Date('2027-03-31T00:00:00Z')
    const plan = planElectionSeed(demoval({ opensAt: new Date('2026-12-01T00:00:00Z'), closesAt }), NU)

    expect(plan.action).toBe('advance')
    if (plan.action !== 'advance') return
    expect(plan.window.opensAt).toEqual(FÖNSTRET.opensAt)
    expect(plan.window.closesAt).toEqual(closesAt)
    expect(plan.report.message).toContain('2027-03-31')
  })

  it('flyttar aldrig tiderna bakåt: ett fönster som redan räcker längre lämnas', () => {
    const plan = planElectionSeed(
      demoval({ opensAt: new Date('2026-09-22T00:00:00Z'), closesAt: new Date('2026-12-31T00:00:00Z') }),
      NU,
    )

    expect(plan.action).toBe('leave')
    expect(plan.report.status).toBe('existing_open')
    expect(plan.report.message).toContain('oförändrad')
  })
})

describe('när demovalet är stängt', () => {
  /**
   * DET FARLIGA UTFALLET. Seedningen gör då ingenting, och appen visar "ingen
   * omröstning är öppen". Beskedet måste bära åtgärden, och åtgärden är
   * knappen "Återställ demovalet" på adminsidan.
   */
  it.each(['CLOSED', 'VALIDATED', 'STRIPPED', 'TALLIED', 'CERTIFIED'])('rör inte ett demoval i %s', (phase) => {
    const plan = planElectionSeed(demoval({ phase }), NU)

    expect(plan.action).toBe('leave')
    expect(plan.report.status).toBe('existing_closed')
    expect(plan.report.message).toContain(SEED_WARNING_PREFIX)
    expect(plan.report.message).toContain(phase)
    expect(plan.report.message).toContain('Återställ demovalet')
    expect(plan.report.message).toContain('ingen omröstning är öppen')
    expect(plan.report.message).not.toContain('skapad')
  })

  it('rör inte ett demoval utan rad i röstlängden, där fasen inte går att läsa', () => {
    const plan = planElectionSeed(demoval({ phase: null }), NU)

    expect(plan.action).toBe('leave')
    expect(plan.report.status).toBe('existing_closed')
    expect(plan.report.message).toContain(SEED_WARNING_PREFIX)
  })
})

describe('gränserna för när en omröstning räknas som öppen', () => {
  /**
   * Måste stämma med listOpenElections, som filtrerar på `opensAt <= now` och
   * `closesAt > now` (tests/integration/open-elections.test.ts). Bara ett
   * demoval som är öppet enligt det villkoret lämnas med beskedet "öppen".
   */
  const SENT = new Date('2027-01-31T00:00:00Z')

  it('öppningsögonblicket räknas som öppet', () => {
    const plan = planElectionSeed(demoval({ opensAt: NU, closesAt: SENT }), NU)

    expect(plan.report.status).toBe('existing_open')
  })

  it('stängningsögonblicket räknas som stängt i tid, och tiderna flyttas fram', () => {
    const plan = planElectionSeed(demoval({ opensAt: new Date('2026-09-01'), closesAt: NU }), NU)

    expect(plan.action).toBe('advance')
  })
})

describe('när omröstningen med namnet inte är ett demoval', () => {
  it('rör den inte, och varnar', () => {
    const plan = planElectionSeed(demoval({ mode: 'SHARP' }), NU)

    expect(plan.action).toBe('leave')
    expect(plan.report.message).toContain(SEED_WARNING_PREFIX)
  })
})
