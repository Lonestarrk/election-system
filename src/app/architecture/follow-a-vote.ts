import type { DatabaseState, PendingVoteRow } from '@/app/api/demo/database-state/route'

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
}

export const INITIAL_FOLLOW_STATE: FollowState = {
  snapshot: null,
  sequence: 0,
  fetchedAt: null,
  followedPendingVoteId: null,
  forgotten: null,
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

export function followReducer(state: FollowState, action: FollowAction): FollowState {
  switch (action.type) {
    case 'snapshot': {
      // Punkt 3: ett svar som skickades före det som redan visas får aldrig
      // ersätta det, hur sent det än kommer fram.
      if (action.sequence <= state.sequence) return state

      const next = action.snapshot
      const replaced = {
        ...state,
        snapshot: next,
        sequence: action.sequence,
        fetchedAt: action.fetchedAt,
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
