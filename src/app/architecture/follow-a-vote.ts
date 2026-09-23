import type {
  DatabaseState,
  EncryptedVoteRow,
  PendingVoteRow,
} from '@/app/api/demo/database-state/route'

/**
 * "FÖLJ EN RÖST" UTAN ATT SIDAN SJÄLV BLIR KOPPLINGEN.
 *
 * Före stängningen syns kopplingen i databasen: en rad i pending_vote pekar på
 * en väljare. Efter stängningen är raden raderad, och chiffret ligger i
 * encrypted_vote utan någon kolumn som pekar tillbaka. Det enda som då hittar
 * en röst är verifikationskoden, och den har väljaren.
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
 *    raderade raderna till liv i fliken.
 *
 * 4. Rader i encrypted_vote märks bara med en kod som besökaren själv klistrat
 *    in. Funktionen som letar där tar aldrig emot pending_vote.
 *
 * Det sidan inte kan hindra är att en människa minns vad hon såg, eller att
 * någon kopierade tabellen innan den raderades. Den som har en kopia av
 * pending_vote från före stängningen har kopplingen kvar. Det är begränsningen
 * link-exists-during-voting i praktiken, och sidan säger det rakt ut.
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
 * finns raden kvar, men då har röstningen stängt, och från och med då ska en
 * röst bara gå att hitta med sin verifikationskod.
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
      const replaced = { ...state, snapshot: next, sequence: action.sequence, fetchedAt: action.fetchedAt }

      if (state.followedPendingVoteId === null) return replaced

      // Punkt 2: det följda id:t prövas mot den NYA bilden, aldrig mot den gamla.
      const row = next.votersDb.pendingVote.find((pending) => pending.id === state.followedPendingVoteId)

      if (!row) return { ...replaced, followedPendingVoteId: null, forgotten: 'row-gone' }
      if (!canFollow(next, row)) return { ...replaced, followedPendingVoteId: null, forgotten: 'left-open' }

      return replaced
    }

    case 'follow': {
      const snapshot = state.snapshot
      const row = snapshot?.votersDb.pendingVote.find((pending) => pending.id === action.pendingVoteId)

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

// ---------------------------------------------------------------------------
// Verifikationskoden
// ---------------------------------------------------------------------------

/**
 * Kortaste kod som prövas: lika många tecken som livevyn hämtar av varje hash.
 *
 * Rutten skickar bara de första tolv tecknen, så längre än så kan jämförelsen
 * inte gå. Kortare koder vägras, eftersom de skulle träffa mer än de pekar ut.
 */
export const MINIMUM_CODE_LENGTH = 12

/**
 * Koden som väljaren fick är chifferhashen: 64 hextecken. Den får klistras in
 * med versaler, mellanslag eller bindestreck, som när den skrivits av för hand.
 */
export function normaliseVerificationCode(input: string): string | null {
  const compact = input.toLowerCase().replace(/[\s-]/g, '')

  if (!/^[0-9a-f]+$/.test(compact)) return null
  if (compact.length < MINIMUM_CODE_LENGTH || compact.length > 64) return null

  return compact
}

/** Den del av ett avkortat värde som faktiskt kom med, utan utelämningstecknet. */
function prefixOf(shortened: string): string {
  return shortened.endsWith('…') ? shortened.slice(0, -1) : shortened
}

function matchesCode(code: string, shortenedHash: string): boolean {
  const prefix = prefixOf(shortenedHash)
  const length = Math.min(code.length, prefix.length)
  return length >= MINIMUM_CODE_LENGTH && code.slice(0, length) === prefix.slice(0, length)
}

/**
 * Letar efter koden i encrypted_vote.
 *
 * Tar bara emot de raderna. Punkt 4 ovan: en märkning av en rad här ska inte
 * kunna bygga på något annat än koden, och det enklaste sättet att garantera
 * det är att funktionen aldrig får se pending_vote.
 */
export function findInEncryptedVotes(code: string, rows: EncryptedVoteRow[]): EncryptedVoteRow[] {
  return rows.filter((row) => matchesCode(code, row.ciphertextHash))
}

/** Letar efter koden i pending_vote, där kopplingen finns så länge raden finns. */
export function findInPendingVotes(code: string, rows: PendingVoteRow[]): PendingVoteRow[] {
  return rows.filter((row) => matchesCode(code, row.ciphertextHash))
}

export type CodeLookup =
  | { status: 'empty' }
  | { status: 'invalid' }
  | { status: 'searched'; pending: PendingVoteRow[]; encrypted: EncryptedVoteRow[] }

/**
 * Söker koden i den senaste bilden, i båda tabellerna var för sig.
 *
 * Träffarna hålls isär. Under själva stängningen, eller om den avbrutits efter
 * flytten, kan samma hash finnas i båda, och då visar sidan båda träffarna. Den
 * parar aldrig ihop dem till en rad.
 */
export function lookUpVerificationCode(input: string, snapshot: DatabaseState): CodeLookup {
  if (input.trim() === '') return { status: 'empty' }

  const code = normaliseVerificationCode(input)
  if (code === null) return { status: 'invalid' }

  return {
    status: 'searched',
    pending: findInPendingVotes(code, snapshot.votersDb.pendingVote),
    encrypted: findInEncryptedVotes(code, snapshot.votesDb.encryptedVote),
  }
}
