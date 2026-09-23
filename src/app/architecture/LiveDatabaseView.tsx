'use client'

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type {
  CiphertextPreview,
  DatabaseState,
  ElectionState,
  ForeignKey,
} from '@/app/api/demo/database-state/route'
import { CURRENTLY } from './code-facts'
import {
  canFollow,
  followedRow,
  followReducer,
  INITIAL_FOLLOW_STATE,
  lookUpVerificationCode,
  MINIMUM_CODE_LENGTH,
} from './follow-a-vote'

/**
 * LIVEVYN OCH "FÖLJ EN RÖST".
 *
 * Visar båda databasernas innehåll som det ser ut just nu, och låter besökaren
 * följa ett kuvert genom stängningen.
 *
 * KOMPONENTEN AVGÖR INTE SJÄLV OM DEN FÅR VISAS. Sidan renderar den bara i
 * demoläget (se `DEMO_MODE` i page.tsx), så i skarpt läge finns den inte i
 * sidan alls och ingen hämtning görs. Rutten den hämtar från svarar dessutom
 * 404 utanför demoläget. Ett villkor här också hade varit ett andra ställe att
 * glömma när uppgift 17 byter predikatet.
 *
 * Tillståndet hålls av `followReducer` i follow-a-vote.ts, som är byggd så att
 * sidan inte kan bli kopplingen den visar raderas: en ny bild ersätter den
 * förra helt, och rader i encrypted_vote märks bara med en inklistrad kod. Läs
 * den filens dokumentation innan du lägger till tillstånd här. Allt som sparar
 * något ur en bild från före stängningen, till exempel för att "hjälpsamt"
 * fylla i koden åt besökaren, återskapar kopplingen i fliken.
 */

/** Hur ofta bilden hämtas om medan fliken syns. */
const REFRESH_INTERVAL_MS = 10_000

type Props = {
  /** Rubriken på begränsningen link-exists-during-voting, läst ur listan av sidan. */
  linkLimitationTitle: string
}

type Model = 'kuvert' | 'gammal' | 'båda'

type Mark = 'följs' | 'väljaren' | 'din kod' | 'kopplingen'

type Row = { key: string; cells: ReactNode[]; mark?: Mark }

export function LiveDatabaseView({ linkLimitationTitle }: Props) {
  const [state, dispatch] = useReducer(followReducer, INITIAL_FOLLOW_STATE)
  const [code, setCode] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const requests = useRef(0)

  const load = useCallback(async () => {
    // Löpnumret delas ut när frågan SKICKAS, inte när svaret kommer. Det är
    // vad som låter reducern kasta ett sent svar från före stängningen.
    const sequence = ++requests.current

    try {
      const response = await fetch('/api/demo/database-state', { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const snapshot = (await response.json()) as DatabaseState
      dispatch({
        type: 'snapshot',
        snapshot,
        sequence,
        fetchedAt: new Date().toLocaleTimeString('sv-SE'),
      })
      setLoadError(null)
    } catch {
      setLoadError('Kunde inte hämta databasernas innehåll. Nästa försök sker om en stund.')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  const snapshot = state.snapshot

  if (snapshot === null) {
    return (
      <section className="card" aria-labelledby="livevy">
        <h2 id="livevy">Databaserna just nu</h2>
        <p className="muted small">
          {loadError ?? 'Hämtar databasernas innehåll …'}
        </p>
      </section>
    )
  }

  const followed = followedRow(state)
  const lookup = lookUpVerificationCode(code, snapshot)
  const codePending = lookup.status === 'searched' ? lookup.pending : []
  const codeEncrypted = lookup.status === 'searched' ? lookup.encrypted : []

  /**
   * Vilka väljarrader som ska märkas: den som kuvertet man följer pekar på,
   * och den som ett kuvert funnet med koden pekar på. Båda kommer ur den
   * aktuella bilden av pending_vote, så märkningen försvinner i samma stund
   * som raden gör.
   */
  const linkedVoterIds = new Set<string>(
    [followed, ...codePending].flatMap((row) => (row ? [row.voterStatusId] : [])),
  )

  const followable = snapshot.votersDb.pendingVote.filter((row) => canFollow(snapshot, row))
  const anyStripped = snapshot.elections.some((election) => election.linkClearedAt !== null)
  const { analysis } = snapshot

  return (
    <>
      {/* --- Livevyn -------------------------------------------------------- */}
      <section className="card" aria-labelledby="livevy">
        <div style={headerRowStyle}>
          <h2 id="livevy" style={{ margin: 0 }}>
            Databaserna just nu
          </h2>
          <button type="button" className="secondary" onClick={() => void load()}>
            Uppdatera nu
          </button>
        </div>
        <p className="muted small" style={{ marginTop: '0.5rem' }}>
          Hämtad kl {state.fetchedAt}. Uppdateras var tionde sekund medan sidan är öppen.
          {loadError && <span style={{ color: 'var(--danger)' }}> {loadError}</span>}
        </p>
        <p className="muted small">
          Visas bara i demoläget. Det här är vad databaserna innehåller i detta ögonblick, inte en
          beskrivning av dem. Varje tabell är märkt med vilken modell den hör till, och en tom tabell
          är tom på riktigt.
        </p>

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
                <tr key={election.id}>
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
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small" style={{ marginTop: '0.75rem' }}>
          Fasen och kuvertroten står i röstlängden, nyckeln och räkningen i röstdatabasen. Kuvertroten
          är en Merklerot över alla par av chifferhash och signatur, och den skrivs en enda gång,
          innan kopplingen raderas. {CURRENTLY.envelopeRootNotPublished.text}
        </p>
      </section>

      {/* --- voters_db -------------------------------------------------------- */}
      <section className="card" aria-labelledby="voters-db">
        <h2 id="voters-db">
          <span className="mono">voters_db</span>, röstlängden
        </h2>
        <p className="muted small">
          Vet vem du är. Medan röstningen pågår vet den också att du har röstat, och bär ditt
          chiffer, men den kan inte läsa det.
        </p>

        <DbTable
          name="voter_status"
          model="båda"
          description={
            <>
              En rad per röstberättigad. Identitetshashen är en HMAC av personnumret, som aldrig
              lagras i klartext.
            </>
          }
          headers={['id', 'identitetshash', 'röstberättigad', 'admin']}
          rows={snapshot.votersDb.voterStatus.map((voter) => ({
            key: voter.id,
            mark: linkedVoterIds.has(voter.id) ? 'väljaren' : undefined,
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
              Ytterkuvertet: vem som har röstat, i kolumnen <span className="mono">voter_status_id</span>,
              bredvid ett chiffer som inte går att läsa utan två av tre förtroendemäns andelar. Raden
              ersätts när väljaren röstar igen och raderas vid stängningen. Signaturen och nyckeln ur
              certifikatet finns i raden men visas inte här.
            </>
          }
          headers={['id', 'väljare', 'valsedel', 'chifferhash', 'räknare', 'ändrad', 'chiffer']}
          rows={snapshot.votersDb.pendingVote.map((row) => ({
            key: row.id,
            mark:
              followed?.id === row.id
                ? 'följs'
                : codePending.some((match) => match.id === row.id)
                  ? 'din kod'
                  : undefined,
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
              : 'Ingen har lagt ett kuvert. ' + CURRENTLY.votePageUsesOldFlow.text
          }
        />
      </section>

      {/* --- votes_db --------------------------------------------------------- */}
      <section className="card" aria-labelledby="votes-db">
        <h2 id="votes-db">
          <span className="mono">votes_db</span>, röstdatabasen
        </h2>
        <p className="muted small">
          Vet vad som har röstats, som chiffer. Vet inte vem som har röstat, och har ingen kolumn
          som skulle kunna säga det.
        </p>

        <DbTable
          name="encrypted_vote"
          model="kuvert"
          description={
            <>
              Innerkuvertet, flyttat hit vid stängningen i en enda sats, sorterat på chifferhash.
              Ingen väljare och ingen tidsstämpel. Id:t är härlett ur chifferhashen, så att tabellens
              ordning är innehållets och inte den ordning väljarna röstade i.
            </>
          }
          headers={['id', 'valsedel', 'chifferhash', 'chiffer']}
          rows={snapshot.votesDb.encryptedVote.map((row) => ({
            key: row.id,
            mark: codeEncrypted.some((match) => match.id === row.id) ? 'din kod' : undefined,
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
            cells: [electionName(snapshot.elections, share.electionId), share.trusteeIndex, share.publicShare],
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
              Det gamla flödets röster, en rad per lagd röst. {CURRENTLY.votePageUsesOldFlow.text}{' '}
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

      {/* --- Finns det någon koppling? --------------------------------------- */}
      <section className="card" aria-labelledby="koppling">
        <h2 id="koppling">Finns det någon koppling?</h2>
        <p className="muted small">
          Ja, med flit, medan röstningen pågår. Det är skillnaden mot den gamla modellen, där
          kopplingen inte gick att skapa. Frågan man skulle vilja ställa, vem som röstade på vad, går
          nu att skriva. Den här körs mot röstlängden varje gång livevyn hämtas:
        </p>
        <pre className="mono small" style={preStyle}>
          {analysis.linkQuery.sql}
        </pre>

        {analysis.linkQuery.rows > 0 ? (
          <div className="notice warning">
            <strong>
              Den gav {rowCount(analysis.linkQuery.rows)} nyss: en väljare och ett chiffer per rad.
            </strong>
            <div style={{ marginTop: '0.35rem' }}>
              Kolumnen <span className="mono">p.ciphertext</span> är svaret på &quot;på vad&quot;, och
              det går inte att läsa ur databasen. Det kräver att två av tre förtroendemän lägger ihop
              sina andelar, och designen öppnar bara summan, aldrig ett enskilt chiffer.
            </div>
          </div>
        ) : (
          <div className={anyStripped ? 'notice success' : 'notice info'}>
            <strong>Den gav 0 rader nyss: pending_vote är tom.</strong>
            <div style={{ marginTop: '0.35rem' }}>
              {anyStripped
                ? 'Efter stängningen finns ingenting att joina. Chiffren ligger i encrypted_vote i en annan databas, och ingen av dess kolumner pekar på en väljare.'
                : 'Ingen har lagt ett kuvert i en öppen omröstning.'}
            </div>
          </div>
        )}

        <h3 style={{ marginTop: '1.5rem' }}>Kolumnerna, ur information_schema</h3>
        <p className="small">
          <span className="mono">pending_vote</span>, ytterkuvertet:{' '}
          <ColumnList columns={snapshot.votersDb.pendingVoteColumns} highlight="voter_status_id" />
        </p>
        <p className="small">
          <span className="mono">encrypted_vote</span>, innerkuvertet:{' '}
          <ColumnList columns={snapshot.votesDb.encryptedVoteColumns} />
        </p>
        <p className="muted small">
          Ingen kolumn i encrypted_vote pekar på en väljare. Tabellerna ligger dessutom i olika
          databaser, så en och samma anslutning ser aldrig båda.
        </p>

        <h3 style={{ marginTop: '1.5rem' }}>Främmande nycklar i databaserna</h3>
        <DbTable
          name="information_schema"
          headers={['databas', 'från', 'till']}
          rows={[
            ...snapshot.votersDb.foreignKeys.map((key) => foreignKeyRow('voters_db', key)),
            ...snapshot.votesDb.foreignKeys.map((key) => foreignKeyRow('votes_db', key)),
          ]}
          bare
        />
        {analysis.foreignKeysAcrossDatabases.length === 0 ? (
          <p className="muted small" style={{ marginTop: '0.75rem' }}>
            Ingen av de {analysis.foreignKeysChecked} nycklarna pekar ut ur sin egen databas.
            PostgreSQL kan inte skapa en sådan nyckel. Men det bevisar inte längre att kopplingen
            saknas: den finns inom voters_db, i den markerade raden, så länge röstningen pågår. Det
            som skyddar valhemligheten medan den finns är att chiffret inte går att läsa.
          </p>
        ) : (
          <div className="notice danger" style={{ marginTop: '0.75rem' }}>
            {analysis.foreignKeysAcrossDatabases.length} nycklar pekar på en tabell som inte finns i
            samma databas. Det ska inte kunna hända.
          </div>
        )}

        <h3 style={{ marginTop: '1.5rem' }}>Värden som finns i båda databaserna</h3>
        <div
          className={analysis.identityValuesInVotesDb.length === 0 ? 'notice success' : 'notice danger'}
        >
          <strong>
            Identitetsvärden i votes_db: {analysis.identityValuesInVotesDb.length} av{' '}
            {analysis.identityValuesCompared} jämförda.
          </strong>
          <div style={{ marginTop: '0.35rem' }}>
            {analysis.identityValuesInVotesDb.length === 0 ? (
              <>
                Varje väljares id och identitetshash, och varje ytterkuverts id, jämfördes mot allt
                som hämtades ur röstdatabasen. Invarianten att votes_db aldrig innehåller identitet
                står kvar.
              </>
            ) : (
              <span className="mono">{analysis.identityValuesInVotesDb.join(', ')}</span>
            )}
          </div>
        </div>
        <div
          className={analysis.ciphertextHashesInBoth.length === 0 ? 'notice info' : 'notice warning'}
          style={{ marginTop: '0.75rem' }}
        >
          <strong>
            Chifferhashar i båda databaserna just nu: {analysis.ciphertextHashesInBoth.length}.
          </strong>
          <div style={{ marginTop: '0.35rem' }}>
            {analysis.ciphertextHashesInBoth.length === 0 ? (
              <>
                Hashen ligger i röstlängden bredvid väljaren fram till stängningen, och i
                röstdatabasen utan väljare efteråt. I båda samtidigt bara under själva stängningen,
                eller om den avbrutits efter flytten men före raderingen.
              </>
            ) : (
              <>
                Stängningen pågår, eller avbröts efter flytten men före raderingen. Tills den körts om
                finns kopplingen kvar, och samma hash står både bredvid väljaren och i
                encrypted_vote: <span className="mono">{analysis.ciphertextHashesInBoth.join(', ')}</span>
              </>
            )}
          </div>
        </div>
        <p className="muted small" style={{ marginTop: '0.75rem' }}>
          Ett värde ÄR delat, och det ska sägas rakt ut: omröstningen och dess valsedlar har samma
          UUID i båda databaserna, och <span className="mono">pending_vote.ballot_id</span> pekar på
          en valsedel i den andra databasen utan främmande nyckel. Med en enda omröstning kostar det
          ingenting. Med flera delas rösterna upp per omröstning, och anonymitetsmängden krymper
          till varje omröstnings egna röster.
        </p>
      </section>

      {/* --- Följ en röst ----------------------------------------------------- */}
      <section className="card" aria-labelledby="folj-en-rost">
        <h2 id="folj-en-rost">Följ en röst</h2>
        <p className="muted small">
          Före stängningen ligger rösten i pending_vote, där kopplingen syns men chiffret inte går att
          läsa. Efter stängningen är raden borta, och chiffret ligger i encrypted_vote utan koppling.
          Då kan rösten bara hittas av den som har verifikationskoden: väljaren, och den hon visat
          koden för.
        </p>

        <h3 style={{ marginTop: '1.25rem' }}>Före stängningen: följ ett kuvert</h3>
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
              !anyStripped &&
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
              <dt style={detailTermStyle}>chifferhash</dt>
              <dd style={detailValueStyle} className="mono">
                {followed.ciphertextHash}
              </dd>
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
              <button type="button" className="secondary" onClick={() => dispatch({ type: 'unfollow' })}>
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
              kan därför inte peka ut vilket chiffer i encrypted_vote som var det, och den ska inte
              kunna det. Har du verifikationskoden kan du leta med den nedan.
            </div>
          </div>
        )}

        <h3 style={{ marginTop: '1.5rem' }}>Efter stängningen: leta med din kod</h3>
        <label htmlFor="verifikationskod">Verifikationskod</label>
        <input
          id="verifikationskod"
          type="text"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Chifferhashen du fick när du röstade"
        />
        <p className="muted small" style={{ marginTop: '0.4rem' }}>
          Minst {MINIMUM_CODE_LENGTH} tecken. Livevyn hämtar bara de första {MINIMUM_CODE_LENGTH}{' '}
          tecknen av varje hash, så jämförelsen görs på dem. Koden letas upp i den bild som redan
          hämtats och skickas ingenstans.
        </p>

        {lookup.status === 'invalid' && (
          <div className="notice danger" role="status">
            Koden ska bestå av hextecken, 0–9 och a–f, och vara minst {MINIMUM_CODE_LENGTH} tecken.
          </div>
        )}

        {lookup.status === 'searched' && (
          <div role="status">
            {codePending.map((row) => (
              <div key={row.id} className="notice warning" style={{ marginTop: '0.75rem' }}>
                <strong>Hittad i pending_vote, i röstlängden.</strong>
                <div style={{ marginTop: '0.35rem' }}>
                  Kuvertet <span className="mono">{row.id}</span> pekar på väljaren{' '}
                  <span className="mono">{row.voterStatusId}</span>. Kopplingen finns, eftersom
                  kuvertet inte har skalats än.
                </div>
              </div>
            ))}
            {codeEncrypted.map((row) => (
              <div key={row.id} className="notice success" style={{ marginTop: '0.75rem' }}>
                <strong>Hittad i encrypted_vote, i röstdatabasen.</strong>
                <div style={{ marginTop: '0.35rem' }}>
                  Raden <span className="mono">{row.id}</span> på valsedeln{' '}
                  {row.ballotLabel ?? row.ballotId} har ingen kolumn som pekar på en väljare. Det var
                  koden som hittade den, inte något sidan mindes.
                </div>
              </div>
            ))}
            {codePending.length > 0 && codeEncrypted.length > 0 && (
              <div className="notice warning" style={{ marginTop: '0.75rem' }}>
                Chiffret finns just nu i båda databaserna: stängningen pågår, eller avbröts efter
                flytten men före raderingen.
              </div>
            )}
            {codePending.length === 0 && codeEncrypted.length === 0 && (
              <div className="notice info" style={{ marginTop: '0.75rem' }}>
                Koden finns varken i pending_vote eller i encrypted_vote.
              </div>
            )}
          </div>
        )}

        <div className="notice danger" style={{ marginTop: '1.5rem' }}>
          <strong>Den som kopierade pending_vote före stängningen har kopplingen.</strong>
          <div style={{ marginTop: '0.35rem' }}>
            Raderingen tar bort raderna ur den levande databasen, inte ur en kopia. En backup, en
            läsreplik eller WAL-loggen från före stängningen parar fortfarande ihop väljare och
            chifferhash, och det gör också en export eller en skärmdump av den här sidan. Hashen står
            kvar i encrypted_vote, så kopian pekar ut chiffret. Det är begränsningen «
            {linkLimitationTitle}» i praktiken. Sidan kan låta bli att minnas, men den kan inte få
            någon annan att glömma.
          </div>
        </div>
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Delar
// ---------------------------------------------------------------------------

function DbTable({
  name,
  model,
  description,
  headers,
  rows,
  emptyNote,
  bare = false,
}: {
  name: string
  model?: Model
  description?: ReactNode
  headers: string[]
  rows: Row[]
  emptyNote?: string
  /** Utan rubrik och beskrivning, för en tabell som redan har en rubrik ovanför sig. */
  bare?: boolean
}) {
  return (
    <div style={bare ? undefined : { marginTop: '1.5rem' }}>
      {!bare && (
        <>
          <h3 style={tableHeadingStyle}>
            <span className="mono">{name}</span>
            {model && <ModelBadge model={model} />}
            <span className="muted small" style={{ fontWeight: 400 }}>
              {rowCount(rows.length)}
            </span>
          </h3>
          {description && <p className="muted small">{description}</p>}
        </>
      )}

      {rows.length === 0 ? (
        <p className="small" style={emptyStyle}>
          Tom. {emptyNote}
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {headers.map((header) => (
                  <th key={header}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} style={row.mark ? markedRowStyle(row.mark) : undefined}>
                  {row.cells.map((cell, index) => (
                    <td key={index} className={typeof cell === 'string' ? 'mono' : undefined}>
                      {cell}
                      {index === 0 && row.mark && <MarkTag mark={row.mark} />}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function foreignKeyRow(database: 'voters_db' | 'votes_db', key: ForeignKey): Row {
  const isTheLink =
    database === 'voters_db' &&
    key.table_name === 'pending_vote' &&
    key.column_name === 'voter_status_id'

  return {
    key: `${database}.${key.table_name}.${key.column_name}`,
    mark: isTheLink ? 'kopplingen' : undefined,
    cells: [
      database,
      `${key.table_name}.${key.column_name}`,
      `${key.foreign_table_name}.${key.foreign_column_name}`,
    ],
  }
}

const MODEL_LABELS: Record<Model, string> = {
  kuvert: 'Kuvertmodellen',
  gammal: 'Gamla modellen',
  båda: 'Båda modellerna',
}

function ModelBadge({ model }: { model: Model }) {
  const colours: Record<Model, { background: string; borderColor: string }> = {
    kuvert: { background: 'var(--accent-soft)', borderColor: 'var(--accent)' },
    gammal: { background: 'var(--warning-soft)', borderColor: 'var(--warning)' },
    båda: { background: 'var(--surface-muted)', borderColor: 'var(--border-strong)' },
  }
  return (
    <span style={{ ...badgeStyle, ...colours[model] }} title="Vilken röstmodell tabellen hör till">
      {MODEL_LABELS[model]}
    </span>
  )
}

/**
 * Fasen, färgad efter om kopplingen finns. Orange så länge ytterkuverten kan
 * finnas, grön när de bevisligen ska vara borta.
 */
function PhaseBadge({ phase }: { phase: string }) {
  const linkMayExist = phase === 'OPEN' || phase === 'CLOSED' || phase === 'VALIDATED'
  return (
    <span
      className="mono"
      style={{
        ...badgeStyle,
        background: linkMayExist ? 'var(--warning-soft)' : 'var(--success-soft)',
        borderColor: linkMayExist ? 'var(--warning)' : 'var(--success)',
      }}
    >
      {phase}
    </span>
  )
}

function MarkTag({ mark }: { mark: Mark }) {
  return (
    <span style={{ ...badgeStyle, marginLeft: '0.5rem', fontFamily: 'var(--font)' }}>{mark}</span>
  )
}

function markedRowStyle(mark: Mark): CSSProperties {
  if (mark === 'din kod') return { background: 'var(--success-soft)' }
  if (mark === 'kopplingen') return { background: 'var(--warning-soft)' }
  return { background: 'var(--accent-soft)' }
}

function Cipher({ preview }: { preview: CiphertextPreview | null }) {
  if (!preview) return <span className="muted">okänt format</span>
  return (
    <span className="mono">
      {preview.pairs} × (c1, c2), c1 = {preview.c1}
    </span>
  )
}

function ColumnList({ columns, highlight }: { columns: string[]; highlight?: string }) {
  return (
    <>
      {columns.map((column, index) => (
        <span key={column}>
          <span
            className="mono"
            style={
              column === highlight
                ? { background: 'var(--warning-soft)', padding: '0 0.2rem', borderRadius: 4 }
                : undefined
            }
          >
            {column}
          </span>
          {index < columns.length - 1 ? ', ' : ''}
        </span>
      ))}
    </>
  )
}

function electionName(elections: ElectionState[], id: string): string {
  return elections.find((election) => election.id === id)?.name ?? id
}

function timestamp(iso: string | null): string {
  if (iso === null) return '—'
  return new Date(iso).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })
}

function rowCount(count: number): string {
  return count === 1 ? '1 rad' : `${count} rader`
}

// ---------------------------------------------------------------------------
// Stilar
//
// Inline, som på resten av sidan: CSP:n tillåter inline-stilar, och en egen
// stilmall för en enda sida vore en fil till att hålla i synk.
// ---------------------------------------------------------------------------

const headerRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
}

const tableHeadingStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.5rem',
  marginBottom: '0.35rem',
}

const badgeStyle: CSSProperties = {
  display: 'inline-block',
  fontSize: '0.72rem',
  fontWeight: 600,
  lineHeight: 1.4,
  padding: '0.1rem 0.45rem',
  borderRadius: 999,
  border: '1px solid var(--border-strong)',
  background: 'var(--surface-muted)',
  color: 'var(--text)',
  whiteSpace: 'nowrap',
}

const emptyStyle: CSSProperties = {
  background: 'var(--surface-muted)',
  borderRadius: 'var(--radius)',
  padding: '0.6rem 0.8rem',
  color: 'var(--text-muted)',
}

const preStyle: CSSProperties = {
  background: 'var(--surface-muted)',
  padding: '1rem',
  borderRadius: 'var(--radius)',
  overflowX: 'auto',
}

/**
 * Etiketten ovanför värdet, inte bredvid. På en telefon blev värdekolumnen
 * bredvid etiketterna så smal att ett id bröts mitt i, tecken för tecken.
 */
const detailListStyle: CSSProperties = { margin: '0.75rem 0 0' }

const detailTermStyle: CSSProperties = {
  marginTop: '0.5rem',
  color: 'var(--text-muted)',
  fontSize: '0.72rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
}

const detailValueStyle: CSSProperties = { margin: 0, overflowWrap: 'anywhere' }
