import { describe, expect, it } from 'vitest'
import {
  describeElectionSeed,
  SEED_WARNING_PREFIX,
} from '../../prisma/election-seed-report'

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
 */

const NU = new Date('2026-09-22T12:00:00Z')

describe('när ingen omröstning finns', () => {
  it('rapporterar att den skapades', () => {
    const report = describeElectionSeed(null, NU)

    expect(report.status).toBe('created')
    expect(report.message).toContain('skapad')
  })
})

describe('när omröstningen redan finns och är öppen', () => {
  it('säger att den lämnades orörd — inte att den skapades', () => {
    const report = describeElectionSeed(
      { opensAt: new Date('2026-09-01T00:00:00Z'), closesAt: new Date('2026-09-30T00:00:00Z') },
      NU,
    )

    expect(report.status).toBe('existing_open')
    expect(report.message).toContain('fanns redan')
    // Det gamla felet i en mening: att hävda ett skapande som inte skett.
    expect(report.message).not.toContain('skapad')
  })
})

describe('när omröstningen finns men inte är öppen', () => {
  /**
   * DET FARLIGA UTFALLET.
   *
   * Seedningen har då inte gjort någonting, appen visar "ingen omröstning är
   * öppen", och `npm run reset:votes` hjälper inte — det skriptet bevarar just
   * Valet 2026 med namn. Beskedet måste därför bära åtgärden, inte bara
   * konstaterandet.
   */
  const STÄNGD = {
    opensAt: new Date('2026-09-01T00:00:00Z'),
    closesAt: new Date('2026-09-10T00:00:00Z'),
  }

  it('varnar i stället för att rapportera framgång', () => {
    const report = describeElectionSeed(STÄNGD, NU)

    expect(report.status).toBe('existing_closed')
    expect(report.message).toContain(SEED_WARNING_PREFIX)
    expect(report.message).not.toContain('skapad')
  })

  it('namnger datumen så att orsaken syns direkt', () => {
    const report = describeElectionSeed(STÄNGD, NU)

    expect(report.message).toContain('2026-09-01')
    expect(report.message).toContain('2026-09-10')
  })

  it('talar om vad appen kommer att visa, och hur man rättar det', () => {
    const report = describeElectionSeed(STÄNGD, NU)

    expect(report.message).toContain('ingen omröstning är öppen')
    // Åtgärden måste vara körbar, inte en uppmaning att "kontrollera datan".
    expect(report.message).toContain('delete from election')
  })

  it('varnar också för en omröstning som ännu inte öppnat', () => {
    const report = describeElectionSeed(
      { opensAt: new Date('2026-10-01T00:00:00Z'), closesAt: new Date('2026-10-30T00:00:00Z') },
      NU,
    )

    expect(report.status).toBe('existing_closed')
    expect(report.message).toContain(SEED_WARNING_PREFIX)
  })
})

describe('gränserna för när en omröstning räknas som öppen', () => {
  /**
   * Måste stämma med listOpenElections, som filtrerar på
   * `opensAt <= now` och `closesAt > now`. Glider de isär rapporterar
   * seedningen "öppen" om något appen inte visar, vilket återinför exakt den
   * förvirring den här filen finns för att förhindra.
   */
  it('öppningsögonblicket räknas som öppet', () => {
    const report = describeElectionSeed({ opensAt: NU, closesAt: new Date('2026-09-30') }, NU)

    expect(report.status).toBe('existing_open')
  })

  it('stängningsögonblicket räknas som stängt', () => {
    const report = describeElectionSeed({ opensAt: new Date('2026-09-01'), closesAt: NU }, NU)

    expect(report.status).toBe('existing_closed')
  })
})
