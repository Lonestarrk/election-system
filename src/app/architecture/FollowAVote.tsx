import type { Dispatch } from 'react'
import type { DatabaseState } from '@/app/api/demo/database-state/route'
import { CURRENTLY } from './code-facts'
import { detailListStyle, detailTermStyle, detailValueStyle, rowCount } from './db-table'
import {
  canFollow,
  followedRow,
  strippedElections,
  type FollowAction,
  type FollowState,
} from './follow-a-vote'

/**
 * "FÖLJ EN RÖST".
 *
 * Före stängningen: besökaren väljer ett kuvert i pending_vote och ser att
 * kopplingen finns, men att chiffret inte går att läsa. Efter stängningen: raden
 * är borta, sidan har glömt vilken den var, och det enda som går att säga är
 * att chiffret är en av N anonyma rader i encrypted_vote.
 *
 * Här finns ingen sökning på verifikationskod. Den fanns i en tidigare version
 * och var köparens verktyg: den som sett en röst läggas kunde efter
 * stängningen se om koden fanns kvar, och alltså om väljaren ändrat sig
 * (spec 3.1). I kuvertmodellen visas ingen kod, och ingenting per röst
 * publiceras.
 *
 * Tillståndet ägs av `followReducer`. Den här komponenten läser bara den
 * aktuella bilden och skickar vidare besökarens val.
 */
export function FollowAVote({
  state,
  snapshot,
  dispatch,
  linkLimitationTitle,
}: {
  state: FollowState
  snapshot: DatabaseState
  dispatch: Dispatch<FollowAction>
  /** Rubriken på begränsningen link-exists-during-voting, läst ur listan av sidan. */
  linkLimitationTitle: string
}) {
  const followed = followedRow(state)
  const followable = snapshot.votersDb.pendingVote.filter((row) => canFollow(snapshot, row))
  const stripped = strippedElections(snapshot)

  return (
    <section className="card" aria-labelledby="folj-en-rost">
      <h2 id="folj-en-rost">Följ en röst</h2>
      <p className="muted small">
        Före stängningen ligger rösten i pending_vote, där kopplingen syns men chiffret inte går att
        läsa. Efter stängningen är raden borta, och chiffret är en av många anonyma rader i
        encrypted_vote. Ingen kan då säga vilken av dem som var väljarens, inte heller väljaren
        själv: i kuvertmodellen får hon ingen kod, och ingenting per röst publiceras.
      </p>

      <h3 style={{ marginTop: '1.25rem' }}>Före stängningen</h3>
      {followable.length > 0 ? (
        <div>
          <label htmlFor="folj-kuvert">Följ ett kuvert i pending_vote</label>
          <select
            id="folj-kuvert"
            value={state.followedPendingVoteId ?? ''}
            onChange={(event) =>
              event.target.value
                ? dispatch({ type: 'follow', pendingVoteId: event.target.value })
                : dispatch({ type: 'unfollow' })
            }
          >
            <option value="">Välj ett kuvert …</option>
            {followable.map((row) => (
              <option key={row.id} value={row.id}>
                {row.id} · {row.ballotLabel ?? row.ballotId} · väljare {row.voterStatusId}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="muted small">
          Inget kuvert i en öppen omröstning finns att följa just nu.{' '}
          {snapshot.votersDb.pendingVote.length === 0 &&
            stripped.length === 0 &&
            CURRENTLY.votePageUsesOldFlow.text}
        </p>
      )}

      {followed && (
        <div className="notice warning" style={{ marginTop: '1rem' }} role="status">
          <strong>
            Du följer kuvertet <span className="mono">{followed.id}</span>. Kopplingen syns.
          </strong>
          <dl style={detailListStyle}>
            <dt style={detailTermStyle}>väljare</dt>
            <dd style={detailValueStyle} className="mono">
              voter_status.id = {followed.voterStatusId}
            </dd>
            <dt style={detailTermStyle}>valsedel</dt>
            <dd style={detailValueStyle}>{followed.ballotLabel ?? followed.ballotId}</dd>
            <dt style={detailTermStyle}>räknare</dt>
            <dd style={detailValueStyle}>
              {followed.castSequence}, ökar varje gång väljaren ändrar sig
            </dd>
            <dt style={detailTermStyle}>chiffer</dt>
            <dd style={detailValueStyle}>
              {followed.ciphertext ? (
                <>
                  {followed.ciphertext.pairs} par (c1, c2), tal på {followed.ciphertext.digits}{' '}
                  siffror, till exempel <span className="mono">c1 = {followed.ciphertext.c1}</span>.
                  Ingen kan läsa det utan två av tre förtroendemäns andelar.
                </>
              ) : (
                'Okänt format. Värdet i databasen har inte chiffrets form.'
              )}
            </dd>
          </dl>
          <div style={{ marginTop: '0.5rem' }}>
            Vid stängningen flyttas chiffret till encrypted_vote och raden här raderas. Då slutar
            sidan följa den och glömmer vilken rad det var.
          </div>
          <div className="button-row" style={{ marginTop: '0.75rem' }}>
            <button
              type="button"
              className="secondary"
              onClick={() => dispatch({ type: 'unfollow' })}
            >
              Sluta följa
            </button>
          </div>
        </div>
      )}

      {state.forgotten && (
        <div className="notice info" style={{ marginTop: '1rem' }} role="status">
          <strong>
            {state.forgotten === 'row-gone'
              ? 'Kuvertet du följde finns inte längre i pending_vote.'
              : 'Omröstningen har lämnat OPEN, så sidan slutar följa kuvertet.'}
          </strong>
          <div style={{ marginTop: '0.35rem' }}>
            Sidan har kastat allt den hämtade före stängningen, också vilket kuvert du följde. Den
            kan inte peka ut vilket chiffer i encrypted_vote som var det, och den ska inte kunna
            det.
          </div>
        </div>
      )}

      <h3 style={{ marginTop: '1.5rem' }}>Efter stängningen</h3>
      {stripped.length === 0 ? (
        <p className="muted small">Ingen omröstning har stängts än.</p>
      ) : (
        stripped.map((election) => {
          /**
           * Kopplingen står som raderad, men kuvert ligger ändå kvar. Då finns
           * kopplingen för dem, och rutan får inte säga motsatsen i grönt. Det
           * ska inte kunna hända efter en stängning, eftersom raderingen och
           * fasövergången sker i samma transaktion, och därför är det värt en
           * varning och inte en fotnot.
           */
          const linkRemains = election.remainingEnvelopes > 0

          return (
            <div
              key={election.electionId}
              className={linkRemains ? 'notice warning' : 'notice success'}
              style={{ marginTop: '0.75rem' }}
              role="status"
            >
              <strong>
                {election.name}: {rowCount(election.anonymousRows)} i encrypted_vote,{' '}
                {rowCount(election.remainingEnvelopes)} kvar i pending_vote.
              </strong>
              <div style={{ marginTop: '0.35rem' }}>
                {linkRemains ? (
                  <>
                    Kopplingen står som raderad, men{' '}
                    {election.remainingEnvelopes === 1
                      ? 'ett kuvert ligger'
                      : `${election.remainingEnvelopes} kuvert ligger`}{' '}
                    ändå kvar i pending_vote. För{' '}
                    {election.remainingEnvelopes === 1 ? 'det' : 'dem'} finns kopplingen kvar:
                    varje sådan rad pekar på en väljare och bär ett chiffer. Det ska inte kunna
                    hända efter en stängning, och det behöver utredas.
                  </>
                ) : (
                  <>
                    Ingen av raderna i encrypted_vote pekar på en väljare, och sidan märker ingen av
                    dem. Vilken som var en viss väljares går inte att säga ur databasen längre, inte
                    heller för väljaren själv.
                  </>
                )}
              </div>
            </div>
          )
        })
      )}

      <div className="notice danger" style={{ marginTop: '1.5rem' }}>
        <strong>Livevyn är en insiders vy, och den som antecknar ur den har kopplingen.</strong>
        <div style={{ marginTop: '0.35rem' }}>
          Den visar databasen inifrån, som den som driver systemet ser den, och finns bara i
          demoläget. Den som antecknade en chifferhash i pending_vote före stängningen hittar samma
          hash i encrypted_vote efteråt, och vet då vems chiffret är. Detsamma gäller en backup, en
          läsreplik och WAL-loggen från före stängningen, och BankID:s kopia av det väljaren
          signerade. Det är begränsningen «{linkLimitationTitle}» i praktiken. Sidan kan låta bli att
          minnas, men den kan inte få någon annan att glömma.
        </div>
      </div>
    </section>
  )
}
