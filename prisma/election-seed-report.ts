import { demoElectionWindow } from '../src/lib/demo-election'

/**
 * VAD SEEDNINGEN GÖR MED DEMOVALET, OCH VAD DEN SÄGER ATT DEN GJORT.
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
 * Här är beslutet en ren funktion över (finns den, vilken fas och vilket läge,
 * vilka tider, vad är klockan). Den har inga sidoeffekter och kan därför testas
 * direkt, se tests/unit/election-seed-report.test.ts. prisma/seed.ts utför
 * planen.
 *
 * TIDERNA FLYTTAS FRAM PÅ ETT DEMOVAL SOM INTE ÄR STÄNGT (härdningen, punkt 4).
 * Seedningen körs vid varje start av containern i demoläget. Förut lämnade den
 * ett befintligt demoval orört, och ett demoval som en gång seedats slutade ta
 * emot röster trettio dygn senare, tills någon tryckte på återställningsknappen.
 * Nu får ett demoval i fasen OPEN demovalets fönster från idag, om det fönstret
 * räcker längre än det gamla eller valet inte är öppet i tid. Tiderna flyttas
 * aldrig bakåt.
 *
 * ETT STÄNGT DEMOVAL RÖRS INTE. Har fasen lämnat OPEN har stängningen börjat,
 * och efter skalningen är kopplingen raderad och urnan fylld. Att flytta tiderna
 * hade inte öppnat valet igen, eftersom läggningen prövar fasen. Bara
 * återställningen tömmer urnan och sätter fasen till OPEN, och beskedet pekar på
 * knappen för den. Seedningen rör inte heller en omröstning med namnet som inte
 * är ett demoval, eller vars fas inte går att läsa.
 */

export type ExistingElection = {
  opensAt: Date
  closesAt: Date
  /** Fasen i röstlängden, eller null när raden där saknas. */
  phase: string | null
  /** Läget i röstdatabasen. */
  mode: string
}

export type ElectionSeedReport = {
  /**
   * `existing_closed` är det farliga utfallet. Seedningen har då inte gjort
   * någonting, och appen kommer att visa "ingen omröstning är öppen".
   * Knappen "Återställ demovalet" på adminsidan rättar det, och beskedet säger
   * det. Anropare som kan avbryta bör göra det på det här värdet.
   */
  status: 'created' | 'existing_open' | 'existing_advanced' | 'existing_closed'
  message: string
}

export type ElectionSeedPlan =
  | { action: 'create'; report: ElectionSeedReport }
  | { action: 'advance'; window: { opensAt: Date; closesAt: Date }; report: ElectionSeedReport }
  | { action: 'leave'; report: ElectionSeedReport }

/** Prefix som gör utfallet maskinläsbart för e2e-uppsättningen. */
export const SEED_WARNING_PREFIX = 'VARNING:'

const day = (date: Date) => date.toISOString().slice(0, 10)

const QUESTION_NOTE =
  'Frågan skapas inte på ett befintligt Valet 2026: ta bort omröstningen och seeda om för att få den.'

/** Samma villkor som listOpenElections: öppnad, ännu inte stängd. */
function isOpenAt(existing: { opensAt: Date; closesAt: Date }, now: Date): boolean {
  return existing.opensAt <= now && existing.closesAt > now
}

/** Beskedet för ett demoval som seedningen inte rör, med åtgärden. */
export function closedElectionReport(existing: ExistingElection): ElectionSeedReport {
  const state =
    existing.phase === null
      ? 'saknar rad i röstlängden, så fasen går inte att läsa'
      : `står i fasen ${existing.phase}`
  return {
    status: 'existing_closed',
    message:
      `${SEED_WARNING_PREFIX} Valet 2026 fanns redan men ${state} ` +
      `(${day(existing.opensAt)} – ${day(existing.closesAt)}). Seedningen rör inte ett demoval som har ` +
      'stängts.\n' +
      '  Appen kommer att visa "ingen omröstning är öppen". Logga in som administratör och tryck på\n' +
      '  "Återställ demovalet" på adminsidan. Den tömmer urnan och sätter fasen till OPEN.',
  }
}

export function planElectionSeed(existing: ExistingElection | null, now: Date): ElectionSeedPlan {
  if (!existing) {
    return {
      action: 'create',
      report: { status: 'created', message: 'Omröstning: Valet 2026 skapad med fyra valsedlar.' },
    }
  }

  if (existing.mode !== 'DEMO') {
    return {
      action: 'leave',
      report: {
        status: 'existing_closed',
        message:
          `${SEED_WARNING_PREFIX} Det finns en omröstning som heter Valet 2026 men som inte är ett ` +
          `demoval (läget är ${existing.mode}). Seedningen rör den inte.`,
      },
    }
  }

  if (existing.phase !== 'OPEN') return { action: 'leave', report: closedElectionReport(existing) }

  /**
   * closesAt flyttas aldrig bakåt (granskningen av härdningen). Det största av det
   * nuvarande och det nya slutdatumet gäller, också för ett demoval som inte har
   * öppnat än och vars closesAt redan ligger längre fram än det nya fönstret.
   */
  const fresh = demoElectionWindow(now)
  const window = {
    opensAt: fresh.opensAt,
    closesAt: fresh.closesAt > existing.closesAt ? fresh.closesAt : existing.closesAt,
  }
  if (!isOpenAt(existing, now) || window.closesAt > existing.closesAt) {
    return {
      action: 'advance',
      window,
      report: {
        status: 'existing_advanced',
        message:
          `Omröstning: Valet 2026 fanns redan och står i OPEN. Tiderna flyttades fram till ` +
          `${day(window.opensAt)} – ${day(window.closesAt)}. ${QUESTION_NOTE}`,
      },
    }
  }

  return {
    action: 'leave',
    report: {
      status: 'existing_open',
      message: `Omröstning: Valet 2026 fanns redan och är öppen till ${day(existing.closesAt)}, oförändrad. ${QUESTION_NOTE}`,
    },
  }
}
