'use client'

import { useEffect, useState } from 'react'

type ForeignKey = {
  table_name: string
  column_name: string
  foreign_table_name: string
  foreign_column_name: string
}

type DatabaseState = {
  voterDatabase: {
    name: string
    columns: string[]
    rows: Array<{
      id: string
      externalIdentityHash: string
      hasVoted: boolean
      votedAt: string | null
    }>
    foreignKeys: ForeignKey[]
  }
  voteDatabase: {
    name: string
    columns: string[]
    rows: Array<{ id: string; tokenHash: string; party: string; createdAt: string }>
    foreignKeys: ForeignKey[]
  }
  analysis: {
    sharedColumnNames: string[]
    overlappingValues: string[]
    valuesCompared: number
    crossDatabaseForeignKeys: ForeignKey[]
  }
}

export default function DemoPage() {
  const [state, setState] = useState<DatabaseState | null>(null)
  const [showAttempt, setShowAttempt] = useState(false)

  useEffect(() => {
    fetch('/api/demo/database-state')
      .then((response) => response.json())
      .then(setState)
      .catch(() => setState(null))
  }, [])

  const analysis = state?.analysis

  return (
    <main>
      <div className="stack">
        <div>
          <h1>Arkitektur</h1>
          <p className="muted">
            Systemet består av två delar som aldrig delar data. Här kan du se dem sida vid sida och
            själv kontrollera att det inte finns någon koppling mellan dem.
          </p>
        </div>

        {/* --- Dataflöde ---------------------------------------------------- */}
        <div className="card">
          <h2>Dataflöde</h2>
          <div className="flow">
            <div className="flow-node identity">BankID</div>
            <div className="flow-arrow">↓</div>
            <div className="flow-node identity">Röstberättigande</div>
            <div className="flow-label">röstberättigad + har inte röstat</div>
            <div className="flow-arrow">↓</div>
            <div className="flow-node identity">Röstsession</div>

            <div className="barrier">
              <span>Här slutar identiteten</span>
            </div>

            <div className="flow-label">endast parti-id passerar</div>
            <div className="flow-arrow">↓</div>
            <div className="flow-node anonymous">Anonym röst</div>
            <div className="flow-arrow">↓</div>
            <div className="flow-node anonymous">Slumpad token</div>
            <div className="flow-arrow">↓</div>
            <div className="flow-node anonymous">Register över anonyma röster</div>
          </div>

          <p className="muted small" style={{ marginTop: '1.5rem' }}>
            Det enda som passerar gränsen är ett parti-id. Funktionen som tar emot det har
            signaturen <span className="mono">castAnonymousVote({'{ partyId }'})</span> och har
            ingen parameter för identitet — så en utvecklare kan inte skicka med sådant ens av
            misstag. Kompilatorn stoppar det.
          </p>
        </div>

        {/* --- Databaserna -------------------------------------------------- */}
        <div className="split">
          <div className="card">
            <h2>voters_db</h2>
            <p className="muted small">Vet vem du är. Vet inte vad du röstat på.</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>id</th>
                    <th>identitetshash</th>
                    <th>har röstat</th>
                    <th>röstade</th>
                  </tr>
                </thead>
                <tbody>
                  {state?.voterDatabase.rows.map((row) => (
                    <tr key={row.id}>
                      <td className="mono">{row.id}</td>
                      <td className="mono">{row.externalIdentityHash}</td>
                      <td>{row.hasVoted ? 'ja' : 'nej'}</td>
                      <td className="mono">{row.votedAt ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ marginTop: '0.75rem' }}>
              Tidpunkten lagras med dygnsupplösning.
            </p>
          </div>

          <div className="card">
            <h2>votes_db</h2>
            <p className="muted small">Vet vad som röstats. Vet inte vem som röstat.</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>id</th>
                    <th>token-hash</th>
                    <th>parti</th>
                    <th>tidpunkt</th>
                  </tr>
                </thead>
                <tbody>
                  {state?.voteDatabase.rows.map((row) => (
                    <tr key={row.id}>
                      <td className="mono">{row.id}</td>
                      <td className="mono">{row.tokenHash}</td>
                      <td>{row.party}</td>
                      <td className="mono">{row.createdAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ marginTop: '0.75rem' }}>
              Tidpunkten lagras med timupplösning. Raderna visas sorterade på id, inte i den ordning
              de skapades.
            </p>
          </div>
        </div>

        {/* --- Bevisning ---------------------------------------------------- */}
        <div className="card">
          <h2>Finns det någon koppling?</h2>

          {analysis && (
            <>
              <div
                className={
                  analysis.overlappingValues.length === 0 ? 'notice success' : 'notice danger'
                }
              >
                {analysis.overlappingValues.length === 0 ? (
                  <>
                    <strong>Inget värde förekommer i båda databaserna.</strong>
                    <div style={{ marginTop: '0.35rem' }}>
                      {analysis.valuesCompared} id:n och hashvärden jämfördes. Noll träffar. Det
                      finns alltså inget värde att koppla ihop en väljare och en röst med — inte
                      ens manuellt, för den som har båda databaserna framför sig.
                    </div>
                  </>
                ) : (
                  <>
                    <strong>Överlappande värden hittades.</strong>
                    <div className="mono" style={{ marginTop: '0.35rem' }}>
                      {analysis.overlappingValues.join(', ')}
                    </div>
                  </>
                )}
              </div>

              <p className="muted small" style={{ marginTop: '1rem' }}>
                Kolumnnamn som finns i båda tabellerna:{' '}
                <span className="mono">
                  {analysis.sharedColumnNames.length > 0
                    ? analysis.sharedColumnNames.join(', ')
                    : 'inga'}
                </span>
                . Att båda tabellerna har en kolumn som heter <span className="mono">id</span> är
                ingen koppling — det är två oberoende primärnycklar som råkar ha samma namn, med
                slumpade värden ur skilda serier. Det som avgör är om något <em>värde</em>
                {' '}förekommer i båda, och det gör det inte.
              </p>
            </>
          )}

          <h3 style={{ marginTop: '1.5rem' }}>Foreign keys i databaserna</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>databas</th>
                  <th>från</th>
                  <th>till</th>
                </tr>
              </thead>
              <tbody>
                {state &&
                  [
                    ...state.voterDatabase.foreignKeys.map((key) => ({ db: 'voters_db', key })),
                    ...state.voteDatabase.foreignKeys.map((key) => ({ db: 'votes_db', key })),
                  ].map(({ db, key }) => (
                    <tr key={`${db}.${key.table_name}.${key.column_name}`}>
                      <td className="mono">{db}</td>
                      <td className="mono">
                        {key.table_name}.{key.column_name}
                      </td>
                      <td className="mono">
                        {key.foreign_table_name}.{key.foreign_column_name}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="muted small" style={{ marginTop: '0.75rem' }}>
            Samtliga relationer går till en tabell i samma databas. PostgreSQL tillåter inte foreign
            keys över databasgränser, så en relation mellan <span className="mono">voter_status</span>{' '}
            och <span className="mono">anonymous_vote</span> kan inte skapas — varken av en
            utvecklare, en migration eller en administratör.
          </p>

          <div className="button-row" style={{ marginTop: '1.25rem' }}>
            <button type="button" className="secondary" onClick={() => setShowAttempt(!showAttempt)}>
              {showAttempt ? 'Dölj' : 'Försök koppla en väljare till en röst'}
            </button>
          </div>

          {showAttempt && (
            <div style={{ marginTop: '1.25rem' }}>
              <p className="muted small">Frågan man skulle vilja ställa:</p>
              <pre
                className="mono small"
                style={{
                  background: 'var(--surface-muted)',
                  padding: '1rem',
                  borderRadius: 'var(--radius)',
                  overflowX: 'auto',
                }}
              >
{`SELECT v.external_identity_hash, a.party_id
FROM voter_status v
JOIN anonymous_vote a ON ??? = ???;`}
              </pre>
              <div className="notice danger" style={{ marginTop: '0.75rem' }}>
                Frågan går inte att skriva färdigt. Det finns inget villkor att sätta i JOIN:en —
                inga gemensamma kolumner, ingen foreign key, inget delat id. Dessutom ligger
                tabellerna i olika databaser, så en och samma anslutning ser aldrig båda samtidigt.
              </div>
            </div>
          )}
        </div>

        {/* --- Metadata ----------------------------------------------------- */}
        <div className="card">
          <h2>Metadata som skulle kunna underminera anonymiteten</h2>
          <p className="muted small">
            Separationen i databasen är den lätta delen. Det som faktiskt hotar valhemligheten är
            spåren runtomkring.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Risk</th>
                  <th>Hur den skulle avslöja</th>
                  <th>Vad systemet gör</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Exakta tidsstämplar</td>
                  <td>Rad matchas mot rad på millisekund</td>
                  <td>Dygn i röstlängden, timme i röstdatabasen</td>
                </tr>
                <tr>
                  <td>Skrivordning i databasen</td>
                  <td>Rader i samma kronologiska ordning kan paras ihop</td>
                  <td>Slumpad fördröjning mellan skrivningarna, slumpade UUID:n</td>
                </tr>
                <tr>
                  <td>IP-adress</td>
                  <td>IP plus tidpunkt är i praktiken en identitet</td>
                  <td>Används bara till hastighetsbegränsning, hashas, lagras aldrig</td>
                </tr>
                <tr>
                  <td>Request-id</td>
                  <td>Samma id i båda delarnas loggar kopplar ihop dem</td>
                  <td>Request-id skickas aldrig in i röstmodulen</td>
                </tr>
                <tr>
                  <td>Applikationsloggar</td>
                  <td>En token eller ett personnummer i loggen river hela modellen</td>
                  <td>All loggning går genom ett filter som maskerar kända mönster</td>
                </tr>
                <tr>
                  <td>Analys och felrapportering</td>
                  <td>Tredjepartstjänst får både identitet och beteende</td>
                  <td>Finns inte i systemet; CSP tillåter inga utgående anrop</td>
                </tr>
                <tr>
                  <td>Databasens revisionsloggar</td>
                  <td>PostgreSQL-loggning kan återskapa skrivordningen</td>
                  <td>Prismas frågeloggning avstängd — men serverns WAL är kvar, se SECURITY.md</td>
                </tr>
                <tr>
                  <td>Lågt röstantal</td>
                  <td>Är du ensam om att rösta en timme är tidsbucketen unik</td>
                  <td>Inte löst. Kräver garanterad anonymitetsmängd, se SECURITY.md</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h2>Varför detta inte räcker för ett riktigt val</h2>
          <p className="muted small">
            Modellen här visar principen: legitimera väljaren separat, registrera rösten anonymt,
            och ge väljaren ett kvitto som bara hen kan lösa in. Den visar inte ett valsystem redo
            för drift.
          </p>
          <p className="muted small">
            Den som tar över servern medan valet pågår kan se både legitimering och röst i samma
            process, eftersom båda delarna körs i samma applikation. Ordningen mellan de två
            databasskrivningarna kan i sällsynta fall leda till en förlorad röst. Och en väljare som
            kan visa upp sin token för någon annan kan också bevisa hur hen röstat, vilket öppnar för
            röstköp. Alla tre är kända och beskrivna i SECURITY.md — de är gränserna för vad en
            proof of concept kan visa.
          </p>
        </div>
      </div>
    </main>
  )
}
