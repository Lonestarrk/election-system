/**
 * VAD SEEDNINGEN FAKTISKT GJORDE MED OMRÖSTNINGEN.
 *
 * Beslutet ligger i en egen fil av ett skäl: så länge det satt inbäddat i
 * seed-skriptet gick det inte att pröva utan att köra skriptet och läsa dess
 * utskrift, och därför kunde skriptet ljuga obemärkt. Det skrev
 * "Omröstning: Valet 2026 med tre valsedlar" oavsett utfall.
 *
 * Det kostade riktig tid. En kvarlämnad omröstning från integrationstesterna
 * gjorde att seedningen hoppade över steget, rapporterade framgång, och appen
 * startade utan någon omröstning att rösta i. Felsökningen började i
 * gränssnittet, eftersom det var där symptomen fanns.
 *
 * Här är beslutet en ren funktion över (finns den, är den öppen, vad är
 * klockan). Den har inga sidoeffekter och kan därför testas direkt — se
 * tests/unit/election-seed-report.test.ts.
 */

export type ExistingElection = { opensAt: Date; closesAt: Date }

export type ElectionSeedReport = {
  /**
   * `existing_closed` är det farliga utfallet. Seedningen har då inte gjort
   * någonting, appen kommer att visa "ingen omröstning är öppen", och
   * `reset:votes` hjälper inte — det skriptet bevarar just Valet 2026 med
   * namn. Anropare som kan avbryta bör göra det på det här värdet.
   */
  status: 'created' | 'existing_open' | 'existing_closed'
  message: string
}

/** Prefix som gör utfallet maskinläsbart för e2e-uppsättningen. */
export const SEED_WARNING_PREFIX = 'VARNING:'

const day = (date: Date) => date.toISOString().slice(0, 10)

export function describeElectionSeed(
  existing: ExistingElection | null,
  now: Date,
): ElectionSeedReport {
  if (!existing) {
    return {
      status: 'created',
      message: 'Omröstning: Valet 2026 skapad med tre valsedlar.',
    }
  }

  // Samma villkor som listOpenElections: öppnad, ännu inte stängd.
  const isOpen = existing.opensAt <= now && existing.closesAt > now

  if (isOpen) {
    return {
      status: 'existing_open',
      message: 'Omröstning: Valet 2026 fanns redan och är öppen — oförändrad.',
    }
  }

  return {
    status: 'existing_closed',
    message:
      `${SEED_WARNING_PREFIX} Valet 2026 fanns redan men är INTE öppen ` +
      `(${day(existing.opensAt)} – ${day(existing.closesAt)}).\n` +
      '  Appen kommer att visa "ingen omröstning är öppen". Ta bort den och seeda om:\n' +
      '  docker exec election-postgres psql -U election -d votes_db ' +
      `-c "delete from election where name = 'Valet 2026'"\n` +
      '  docker exec election-postgres psql -U election -d voters_db ' +
      `-c "delete from election where name = 'Valet 2026'"`,
  }
}
