import type { DatabaseState, PendingVoteRow } from '@/app/api/demo/database-state/route'
import { PHASES } from './code-facts'

/**
 * "FÖLJ EN RÖST" UTAN ATT SIDAN SJÄLV BLIR KOPPLINGEN.
 *
 * Före stängningen syns kopplingen i databasen: en rad i pending_vote pekar på
 * en väljare. Efter stängningen är raden raderad, och chiffret är en av många
 * rader i encrypted_vote utan någon kolumn som pekar tillbaka. Ingen kan då
 * säga vilken som var väljarens, inte heller väljaren själv: i kuvertmodellen
 * får hon ingen kod, och ingenting per röst publiceras (spec 3.1).
 *
 * En sida som mindes vad den såg före stängningen kunde göra exakt det
 * modellen raderar: hämta pending_vote medan kopplingen finns, spara
 * chifferhashen per väljare och efter stängningen peka ut "din" rad i
 * encrypted_vote. Det gäller oavsett var minnet sitter: i databasen, i
 * webbläsarens lagring, i en cache eller i React-tillstånd i fliken. Den här
 * filen är därför byggd så att det inte går.
 *
 * 1. En ny ögonblicksbild ERSÄTTER den förra, helt. Ingenting slås ihop, och
 *    ingen tidigare bild sparas vid sidan av.
 *
 * 2. Det enda som överlever en ny bild är vilken rad i pending_vote besökaren
 *    valt att följa, som ett id och aldrig som en hash, och det prövas mot den
 *    nya bilden. Finns raden inte kvar, eller har dess omröstning lämnat OPEN,
 *    glöms den, och sidan säger att den glömt.
 *
 * 3. Ett äldre svar kan aldrig ersätta ett nyare. Annars kunde en långsam
 *    hämtning från före stängningen landa efter en från efter, och väcka de
 *    raderade raderna till liv i fliken. Löpnumren delas ut av
 *    ./live-refresh.ts när frågan skickas.
 *
 *    Löpnumret säger dock bara i vilken ordning FRÅGORNA skickades, inte i
 *    vilken ordning servern läste databasen. Två frågor i luften samtidigt
 *    kan läsas i omvänd ordning, och då bär den nyare frågan den äldre bilden.
 *    Därför vägras också en bild där en omröstning har gått baklänges i fasen,
 *    eller där kopplingen åter står som oraderad. Faserna går bara framåt och
 *    kopplingen återuppstår aldrig (spec 6.1), så en sådan bild kan bara vara
 *    gammal, hur högt löpnummer den än har.
 *
 * 4. Ingenting märker en rad i encrypted_vote. Det enda sidan säger om den
 *    tabellen efter stängningen är hur många anonyma rader den har.
 *
 * Det sidan inte kan hindra är att någon minns eller kopierar vad livevyn
 * visade. Livevyn är en insiders vy av databasen, och den som antecknade en
 * chifferhash i pending_vote före stängningen hittar den i encrypted_vote
 * efteråt. Det är begränsningen link-exists-during-voting i praktiken, och
 * sidan säger det rakt ut.
 */

export type ForgetReason = 'row-gone' | 'left-open'

export type FollowState = {
  /** Den senaste ögonblicksbilden, eller null innan något hämtats. */
  snapshot: DatabaseState | null
  /** Löpnumret på den hämtning bilden kom från. */
  sequence: number
  /** När bilden hämtades, som klockslag att visa. */
  fetchedAt: string | null
  /** Id på raden i pending_vote som följs. Bara ett id, aldrig en hash. */
  followedPendingVoteId: string | null
  /** Varför sidan senast glömde en rad den följde, så att den kan säga det. */
  forgotten: ForgetReason | null
  /**
   * Om den senaste hämtningen vägrades därför att den gick baklänges (punkt 3).
   * Sidan säger det, i stället för att tyst visa en bild som inte uppdateras.
   */
  refused: boolean
}

export const INITIAL_FOLLOW_STATE: FollowState = {
  snapshot: null,
  sequence: 0,
  fetchedAt: null,
  followedPendingVoteId: null,
  forgotten: null,
  refused: false,
}

export type FollowAction =
  | { type: 'snapshot'; snapshot: DatabaseState; sequence: number; fetchedAt: string }
  | { type: 'follow'; pendingVoteId: string }
  | { type: 'unfollow' }

function phaseOf(snapshot: DatabaseState, electionId: string | null): string | null {
  if (electionId === null) return null
  return snapshot.elections.find((election) => election.id === electionId)?.phase ?? null
}

/**
 * Går raden att följa i den här bilden?
 *
 * Bara så länge dess omröstning står i OPEN. I specens CLOSED och VALIDATED
 * finns raden kvar, men då har röstningen stängt, och från och med då ska
 * ingenting på sidan peka ut en enskild röst.
 */
export function canFollow(snapshot: DatabaseState, row: PendingVoteRow): boolean {
  return phaseOf(snapshot, row.electionId) === 'OPEN'
}

/** Specens ordning, OPEN först. Samma lista som fastabellen på sidan läser. */
const PHASE_ORDER: readonly string[] = PHASES.map((row) => row.phase)

/**
 * Har någon omröstning gått baklänges mellan två bilder?
 *
 * Bara omröstningar som finns i båda bilderna jämförs. Nollställs och seedas
 * databasen får omröstningen ett nytt id, och den nya omröstningen i OPEN är
 * inte den gamla som gått baklänges. En fas som inte står i specens lista går
 * inte att ordna, och vägrar därför ingenting.
 */
export function goesBackwards(previous: DatabaseState, next: DatabaseState): boolean {
  return next.elections.some((after) => {
    const before = previous.elections.find((election) => election.id === after.id)
    if (!before) return false

    if (before.linkClearedAt !== null && after.linkClearedAt === null) return true

    const from = PHASE_ORDER.indexOf(before.phase)
    const to = PHASE_ORDER.indexOf(after.phase)
    return from !== -1 && to !== -1 && to < from
  })
}

export function followReducer(state: FollowState, action: FollowAction): FollowState {
  switch (action.type) {
    case 'snapshot': {
      // Punkt 3: ett svar som skickades före det som redan visas får aldrig
      // ersätta det, hur sent det än kommer fram.
      if (action.sequence <= state.sequence) return state

      // Punkt 3 igen, sedd från databasen: en bild som går baklänges är äldre
      // än den som visas, vad löpnumret än säger. Löpnumret flyttas inte fram,
      // så att ett svar som skickades tidigare men lästes senare fortfarande
      // kan tas emot.
      if (state.snapshot !== null && goesBackwards(state.snapshot, action.snapshot)) {
        return state.refused ? state : { ...state, refused: true }
      }

      const next = action.snapshot
      const replaced = {
        ...state,
        snapshot: next,
        sequence: action.sequence,
        fetchedAt: action.fetchedAt,
        refused: false,
      }

      if (state.followedPendingVoteId === null) return replaced

      // Punkt 2: det följda id:t prövas mot den NYA bilden, aldrig mot den gamla.
      const row = next.votersDb.pendingVote.find(
        (pending) => pending.id === state.followedPendingVoteId,
      )

      if (!row) return { ...replaced, followedPendingVoteId: null, forgotten: 'row-gone' }
      if (!canFollow(next, row)) {
        return { ...replaced, followedPendingVoteId: null, forgotten: 'left-open' }
      }

      return replaced
    }

    case 'follow': {
      const snapshot = state.snapshot
      const row = snapshot?.votersDb.pendingVote.find(
        (pending) => pending.id === action.pendingVoteId,
      )

      if (!snapshot || !row || !canFollow(snapshot, row)) return state

      return { ...state, followedPendingVoteId: row.id, forgotten: null }
    }

    case 'unfollow':
      return { ...state, followedPendingVoteId: null, forgotten: null }
  }
}

/** Raden som följs, ur den senaste bilden. Aldrig ur någon tidigare. */
export function followedRow(state: FollowState): PendingVoteRow | null {
  if (state.snapshot === null || state.followedPendingVoteId === null) return null
  return (
    state.snapshot.votersDb.pendingVote.find(
      (pending) => pending.id === state.followedPendingVoteId,
    ) ?? null
  )
}

export type StrippedElection = {
  electionId: string
  name: string
  /** Kuvert i pending_vote som ändå finns kvar. Ska vara 0. */
  remainingEnvelopes: number
  /** Chiffer i encrypted_vote för omröstningen, utan någon kolumn som pekar på en väljare. */
  anonymousRows: number
}

/**
 * Omröstningar vars koppling raderats, med vad som finns kvar av dem.
 *
 * Räknas bara ur den aktuella bilden, och bara som antal. Punkt 4 ovan: efter
 * stängningen är det enda sidan kan säga om en röst att den är en av så här
 * många.
 */
export function strippedElections(snapshot: DatabaseState): StrippedElection[] {
  return snapshot.elections
    .filter((election) => election.linkClearedAt !== null)
    .map((election) => ({
      electionId: election.id,
      name: election.name,
      remainingEnvelopes: snapshot.votersDb.pendingVote.filter(
        (row) => row.electionId === election.id,
      ).length,
      anonymousRows: snapshot.votesDb.encryptedVote.filter((row) => row.electionId === election.id)
        .length,
    }))
}
