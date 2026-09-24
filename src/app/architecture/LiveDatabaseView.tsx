'use client'

import Link from 'next/link'
import { useEffect, useMemo, useReducer, useState, type Dispatch } from 'react'
import type { DatabaseState, ElectionState } from '@/app/api/demo/database-state/route'
import { CURRENTLY } from './code-facts'
import { Cipher, DbTable, headerRowStyle, PhaseBadge, timestamp } from './db-table'
import { FollowAVote } from './FollowAVote'
import {
  followedRow,
  followReducer,
  INITIAL_FOLLOW_STATE,
  type FollowAction,
  type FollowState,
} from './follow-a-vote'
import { LinkQuestion } from './LinkQuestion'
import {
  createSnapshotLoader,
  documentVisibility,
  startLiveRefresh,
  windowInterval,
} from './live-refresh'

/**
 * LIVEVYN.
 *
 * Visar båda databasernas innehåll som det ser ut just nu. Den finns i två
 * delar som läser samma sorts bild: `LiveDatabaseView` på huvudsidan, med
 * tabellerna och "Följ en röst", och `LiveLinkQuestion` på Tekniska detaljer,
 * med "Finns det någon koppling?". Frågan och databasgränsen är tekniska och
 * hör hemma där; tabellerna och "Följ en röst" är det användaren bad att få
 * behålla på huvudsidan.
 *
 * HÄMTNINGEN FINNS BARA HÄR. Båda delarna hämtar genom `useLiveSnapshot`
 * nedan, och ingen annan fil frågar efter /api/demo/database-state
 * (tests/security/architecture-page.test.ts). Två ställen att hämta från hade
 * varit två ställen där skyddet nedan kunde glömmas.
 *
 * KOMPONENTERNA AVGÖR INTE SJÄLVA OM DE FÅR VISAS. Varje sida renderar dem
 * bara när `isDemoMode()` säger ja, så i skarpt läge finns de inte i sidan
 * alls och ingen hämtning görs. Rutten de hämtar från frågar samma funktion
 * och svarar 404 annars. Ett eget villkor här hade varit ett ställe till att
 * glömma när uppgift 17 byter predikatet.
 *
 * Tillståndet hålls av `followReducer` i follow-a-vote.ts, och hämtningen av
 * live-refresh.ts. Båda är byggda så att sidan inte kan bli kopplingen den
 * visar raderas. Läs deras dokumentation innan du lägger till tillstånd här:
 * allt som sparar något ur en bild från före stängningen återskapar kopplingen
 * i fliken.
 */

/** Hur ofta bilden hämtas om medan fliken syns. */
const REFRESH_INTERVAL_MS = 10_000

type LiveSnapshot = {
  state: FollowState
  dispatch: Dispatch<FollowAction>
  loadError: string | null
  load: () => Promise<void>
}

/**
 * Hämtar bilden direkt, sedan var tionde sekund medan fliken syns, och direkt
 * när den blir synlig igen. Varje bild går genom `followReducer`, som vägrar
 * en bild som är äldre än den som visas.
 */
function useLiveSnapshot(): LiveSnapshot {
  const [state, dispatch] = useReducer(followReducer, INITIAL_FOLLOW_STATE)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useMemo(
    () =>
      createSnapshotLoader<DatabaseState>({
        fetchSnapshot: async () => {
          const response = await fetch('/api/demo/database-state', { cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return (await response.json()) as DatabaseState
        },
        onSnapshot: (snapshot, sequence) => {
          dispatch({
            type: 'snapshot',
            snapshot,
            sequence,
            fetchedAt: new Date().toLocaleTimeString('sv-SE'),
          })
          setLoadError(null)
        },
        onError: () =>
          setLoadError('Kunde inte hämta databasernas innehåll. Nästa försök sker om en stund.'),
      }),
    [],
  )

  useEffect(
    () =>
      startLiveRefresh({
        load: () => void load(),
        intervalMs: REFRESH_INTERVAL_MS,
        visibility: documentVisibility(),
        every: windowInterval,
      }),
    [load],
  )

  return { state, dispatch, loadError, load }
}

/** När bilden hämtades, felet om den senaste hämtningen misslyckades, och en vägrad bild. */
function FetchStatus({ state, loadError }: Pick<LiveSnapshot, 'state' | 'loadError'>) {
  return (
    <>
      <p className="muted small" style={{ marginTop: '0.5rem' }}>
        Hämtad kl {state.fetchedAt}. Uppdateras var tionde sekund medan fliken syns, och direkt
        när den blir synlig igen.
        {loadError && <span style={{ color: 'var(--danger)' }}> {loadError}</span>}
      </p>
      {state.refused && (
        <p className="small" style={{ color: 'var(--warning)' }} role="status">
          Den senaste hämtningen visas inte. I den hade en omröstning gått tillbaka till en tidigare
          fas, eller fått sin koppling oraderad igen, och det kan inte hända: en fas går bara
          framåt. Hämtningen var alltså äldre än det som visas. Har databasen nollställts, ladda om
          sidan.
        </p>
      )}
    </>
  )
}

type Props = {
  /** Rubriken på begränsningen link-exists-during-voting, läst ur listan av sidan. */
  linkLimitationTitle: string
}

export function LiveDatabaseView({ linkLimitationTitle }: Props) {
  const { state, dispatch, loadError, load } = useLiveSnapshot()
  const snapshot = state.snapshot

  if (snapshot === null) {
    return (
      <section className="card" aria-labelledby="livevy">
        <h2 id="livevy">Databaserna just nu</h2>
        <p className="muted small">{loadError ?? 'Hämtar databasernas innehåll …'}</p>
      </section>
    )
  }

  const followed = followedRow(state)
  const anyStripped = snapshot.elections.some((election) => election.linkClearedAt !== null)

  return (
    <>
      <section className="card" aria-labelledby="livevy">
        <div style={headerRowStyle}>
          <h2 id="livevy" style={{ margin: 0 }}>
            Databaserna just nu
          </h2>
          <button type="button" className="secondary" onClick={() => void load()}>
            Uppdatera nu
          </button>
        </div>
        <p style={{ marginTop: '0.75rem' }}>
          De två urnorna i tidslinjen finns här på riktigt, som två databaser: röstlängden, som vet
          vem som har röstat, och röstdatabasen, som aldrig får veta det. Vyn är teknisk, eftersom
          den visar databaserna precis som de ser ut inifrån.
        </p>
        <FetchStatus state={state} loadError={loadError} />

        <div className="notice warning">
          <strong>Det här är en insiders vy.</strong>
          <div style={{ marginTop: '0.35rem' }}>
            Livevyn visar databaserna inifrån, som den som driver systemet eller har läsrätt i
            databasen ser dem. Den finns bara i demoläget: i skarpt läge visas den inte, och rutten
            bakom den svarar inte. Varje tabell är märkt med vilken modell den hör till, och en tom
            tabell är tom på riktigt.
          </div>
        </div>

        <h3 style={{ marginTop: '1.25rem' }}>Omröstningar</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>omröstning</th>
                <th>fas</th>
                <th>stänger</th>
                <th>kopplingen raderad</th>
                <th>kuvertrot</th>
                <th>publik nyckel</th>
                <th>räkningen klar</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.elections.map((election) => (
                <ElectionRow key={election.id} election={election} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small" style={{ marginTop: '0.75rem' }}>
          Fasen och kuvertroten står i röstlängden, nyckeln och räkningen i röstdatabasen.
          Kuvertroten är ett åtagande om exakt vilka kuvert som fanns vid stängningen, se
          granskningen på Tekniska detaljer. {CURRENTLY.envelopeRootNotPublished.text}
        </p>
        <p className="muted small">
          Frågan &quot;vem röstade på vad&quot;, körd mot databaserna just nu, och vad den visar om
          gränsen mellan dem står under{' '}
          <Link href="/architecture/technical#koppling">Finns det någon koppling?</Link> på Tekniska
          detaljer.
        </p>
      </section>

      {/* --- voters_db ------------------------------------------------------ */}
      <section className="card" aria-labelledby="voters-db">
        <h2 id="voters-db">
          <span className="mono">voters_db</span>, röstlängden
        </h2>
        <p className="muted small">
          Vet vem du är. Medan röstningen pågår vet den också att du har röstat, och bär ditt chiffer,
          men den kan inte läsa det.
        </p>

        <DbTable
          name="voter_status"
          model="båda"
          description={
            <>
              En rad per person i röstlängden, röstberättigad eller inte.{' '}
              {CURRENTLY.identityHash.text}
            </>
          }
          headers={['id', 'identitetshash', 'röstberättigad', 'admin']}
          rows={snapshot.votersDb.voterStatus.map((voter) => ({
            key: voter.id,
            mark: followed?.voterStatusId === voter.id ? 'väljaren' : undefined,
            cells: [
              voter.id,
              voter.externalIdentityHash,
              voter.isEligible ? 'ja' : 'nej',
              voter.isAdmin ? 'ja' : '—',
            ],
          }))}
        />

        <DbTable
          name="pending_vote"
          model="kuvert"
          description={
            <>
              Ytterkuvertet: vem som har röstat, i kolumnen{' '}
              <span className="mono">voter_status_id</span>, bredvid ett chiffer som inte går att
              läsa utan två av tre förtroendemäns andelar. Raden ersätts när väljaren röstar igen
              och raderas vid stängningen. Signaturen och den krypterade certifikatkedjan finns i
              raden men visas inte här. Chifferhashen står med sina första tecken, som den som kan läsa
              databasen ser den. Röstsidan får den aldrig: enheten frågar bara om dess egen hash
              stämmer.
            </>
          }
          headers={['id', 'väljare', 'valsedel', 'chifferhash', 'räknare', 'ändrad', 'chiffer']}
          rows={snapshot.votersDb.pendingVote.map((row) => ({
            key: row.id,
            mark: followed?.id === row.id ? 'följs' : undefined,
            cells: [
              row.id,
              row.voterStatusId,
              row.ballotLabel ?? row.ballotId,
              row.ciphertextHash,
              row.castSequence,
              row.updatedAt,
              <Cipher key="chiffer" preview={row.ciphertext} />,
            ],
          }))}
          emptyNote={
            anyStripped
              ? 'Kopplingen är raderad i varje stängd omröstning.'
              : 'Ingen har lagt ett kuvert. ' + CURRENTLY.votePageLaysEnvelopes.text
          }
        />
      </section>

      {/* --- votes_db ------------------------------------------------------- */}
      <section className="card" aria-labelledby="votes-db">
        <h2 id="votes-db">
          <span className="mono">votes_db</span>, röstdatabasen
        </h2>
        <p className="muted small">
          Vet vad som har röstats: som chiffer i kuvertmodellens tabeller, och i klartext i det gamla
          flödets tabell vote. Vet inte vem som har röstat, och har ingen kolumn som skulle kunna
          säga det.
        </p>

        <DbTable
          name="encrypted_vote"
          model="kuvert"
          description={
            <>
              Innerkuvertet, utan väljare. {CURRENTLY.writeOrder.text} Ingen rad här märks av sidan.
            </>
          }
          headers={['id', 'valsedel', 'chifferhash', 'chiffer']}
          rows={snapshot.votesDb.encryptedVote.map((row) => ({
            key: row.id,
            cells: [
              row.id,
              row.ballotLabel ?? row.ballotId,
              row.ciphertextHash,
              <Cipher key="chiffer" preview={row.ciphertext} />,
            ],
          }))}
          emptyNote={
            anyStripped
              ? 'De omröstningar som stängts hade inga kuvert att flytta.'
              : 'Ingen omröstning har stängts, så inga chiffer har flyttats hit.'
          }
        />

        <DbTable
          name="trustee_share"
          model="kuvert"
          description={
            <>
              Tröskelnyckelns andelar, tre per omröstning, varav två krävs. Här visas bara den
              publika delen. Den hemliga andelen är krypterad med en lösenfras som förtroendemannen
              håller och som aldrig lagras.
            </>
          }
          headers={['omröstning', 'förtroendeman', 'publik andel']}
          rows={snapshot.votesDb.trusteeShare.map((share) => ({
            key: `${share.electionId}.${share.trusteeIndex}`,
            cells: [
              electionName(snapshot.elections, share.electionId),
              share.trusteeIndex,
              share.publicShare,
            ],
          }))}
        />

        <DbTable
          name="partial_decryption"
          model="kuvert"
          description="Förtroendemännens bidrag till att öppna summan, ett per alternativ och förtroendeman."
          headers={['valsedel', 'alternativ', 'förtroendeman', 'värde']}
          rows={snapshot.votesDb.partialDecryption.map((row) => ({
            key: `${row.ballotId}.${row.optionIndex}.${row.trusteeIndex}`,
            cells: [row.ballotLabel ?? row.ballotId, row.optionIndex, row.trusteeIndex, row.value],
          }))}
          emptyNote={CURRENTLY.decryptionNotBuilt.text}
        />

        <DbTable
          name="ballot_tally"
          model="kuvert"
          description="Summan per alternativ, när den har öppnats. Ingen enskild röst dekrypteras."
          headers={['valsedel', 'alternativ', 'antal']}
          rows={snapshot.votesDb.ballotTally.map((row) => ({
            key: `${row.ballotId}.${row.optionIndex}`,
            cells: [row.ballotLabel ?? row.ballotId, row.optionIndex, row.count],
          }))}
          emptyNote={CURRENTLY.decryptionNotBuilt.text}
        />

        <DbTable
          name="vote"
          model="gammal"
          description={
            <>
              Det gamla flödets röster, en rad per lagd röst. {CURRENTLY.oldFlowRoutesRemain.text}{' '}
              Tabellen försvinner när det gamla flödet tas bort. Partiet visas inte här: livevyn
              behöver inte avslöja vad någon röstat på för att visa hur tabellen ser ut.
            </>
          }
          headers={['id', 'token-hash', 'valsedel', 'tidpunkt']}
          rows={snapshot.votesDb.legacyVote.map((vote) => ({
            key: vote.id,
            cells: [vote.id, vote.tokenHash, vote.ballotId, vote.createdAt],
          }))}
        />
      </section>

      <FollowAVote
        state={state}
        snapshot={snapshot}
        dispatch={dispatch}
        linkLimitationTitle={linkLimitationTitle}
      />
    </>
  )
}

/**
 * "Finns det någon koppling?", på Tekniska detaljer. Samma hämtning och samma
 * skydd som huvudsidans livevy, men bara frågan och databasgränsen.
 */
export function LiveLinkQuestion() {
  const { state, loadError, load } = useLiveSnapshot()
  const snapshot = state.snapshot

  if (snapshot === null) {
    return (
      <section className="card" aria-labelledby="koppling">
        <h2 id="koppling">Finns det någon koppling?</h2>
        <p className="muted small">{loadError ?? 'Hämtar databasernas innehåll …'}</p>
      </section>
    )
  }

  return (
    <LinkQuestion
      snapshot={snapshot}
      anyStripped={snapshot.elections.some((election) => election.linkClearedAt !== null)}
      status={
        <>
          <div className="button-row" style={{ marginTop: '0.25rem' }}>
            <button type="button" className="secondary" onClick={() => void load()}>
              Uppdatera nu
            </button>
          </div>
          <FetchStatus state={state} loadError={loadError} />
        </>
      }
    />
  )
}

function ElectionRow({ election }: { election: ElectionState }) {
  return (
    <tr>
      <td>{election.name}</td>
      <td>
        <PhaseBadge phase={election.phase} />
      </td>
      <td className="mono">{timestamp(election.closesAt)}</td>
      <td className="mono">{timestamp(election.linkClearedAt)}</td>
      <td className="mono">{election.envelopeRoot ?? 'inte skriven'}</td>
      <td className="mono">{election.encryptionPublicKey ?? 'saknas'}</td>
      <td className="mono">{timestamp(election.tallyCompletedAt)}</td>
    </tr>
  )
}

function electionName(elections: ElectionState[], id: string): string {
  return elections.find((election) => election.id === id)?.name ?? id
}
