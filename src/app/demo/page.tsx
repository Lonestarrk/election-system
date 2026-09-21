'use client'

import { useEffect, useState } from 'react'
import { KNOWN_LIMITATIONS } from '@/lib/known-limitations'

/**
 * Arkitektursidan.
 *
 * Sidan ska kunna läsas av någon som misstror systemet. Den visar därför
 * databasernas faktiska innehåll och räknar fram slutsatserna ur det som
 * hämtas — ingenting är hårdkodat. En demonstration som bara påstår att
 * listorna är tomma vore värdelös.
 *
 * Den redovisar också vad som INTE är löst. En arkitektursida som bara listar
 * styrkor är marknadsföring, och i ett valsystem är marknadsföring farligt: den
 * som tror att systemet klarar mer än det gör fattar sämre beslut än den som
 * inte känner till det alls.
 */

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
      isEligible: boolean
      isAdmin: boolean
    }>
    foreignKeys: ForeignKey[]
  }
  voteDatabase: {
    name: string
    columns: string[]
    rows: Array<{ id: string; tokenHash: string; ballotId: string; createdAt: string }>
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
            <div className="flow-label">QR-kod eller autostart — inget personnummer skrivs in</div>
            <div className="flow-arrow">↓</div>
            <div className="flow-node identity">Röstberättigande</div>
            <div className="flow-label">röstberättigad + har inte röstat på valsedeln</div>
            <div className="flow-arrow">↓</div>
            <div className="flow-node identity">Blint signerat röstintyg</div>
            <div className="flow-label">myndigheten signerar utan att se vad den signerar</div>

            <div className="barrier">
              <span>Här slutar identiteten</span>
            </div>

            <div className="flow-label">röstintyg + valt alternativ — ingen session, ingen cookie</div>
            <div className="flow-arrow">↓</div>
            <div className="flow-node anonymous">Anonym röst</div>
            <div className="flow-arrow">↓</div>
            <div className="flow-node anonymous">Slumpad token</div>
            <div className="flow-arrow">↓</div>
            <div className="flow-node anonymous">Register över anonyma röster</div>
          </div>

          <div className="notice success" style={{ marginTop: '1.5rem' }}>
            <strong>Röstläggningen har ingen session.</strong>
            <div style={{ marginTop: '0.35rem' }}>
              Rutten som tar emot rösten läser ingen cookie, slår inte upp någon session och
              importerar ingenting från röstlängdsmodulen. Den <em>kan</em> alltså inte veta vem som
              röstar — det är en egenskap hos koden, inte en regel någon lovat följa. Ett
              arkitekturtest läser källkoden och misslyckas om importen någonsin läggs tillbaka.
            </div>
          </div>

          <p className="muted small" style={{ marginTop: '1rem' }}>
            Det som passerar gränsen är ett röstintyg och ett valt alternativ. Funktionen som tar
            emot det har signaturen{' '}
            <span className="mono">
              castAnonymousVote({'{ ballotId, ballotPartyId, candidateId, optionId, credentialId, credentialSignature }'})
            </span>{' '}
            — sex identifierare som alla pekar på rader i röstdatabasen, och ingen parameter för
            identitet. En utvecklare kan inte skicka med sådant ens av misstag; kompilatorn stoppar
            det.
          </p>
        </div>

        {/* --- Blinda signaturer -------------------------------------------- */}
        <div className="card">
          <h2>Varför intyget inte går att spåra</h2>
          <p className="muted small">
            Kravet är att en observatör ska kunna verifiera att varje röst skapats genom den
            auktoriserade processen. Det går inte att lösa med en flagga i databasen: den som inte
            litar på databasen kan inte verifiera en flagga i samma databas.
          </p>

          <ol className="muted small" style={{ marginTop: '1rem', paddingLeft: '1.25rem' }}>
            <li>Din webbläsare skapar ett hemligt röstintyg: 32 slumpbytes.</li>
            <li>
              Webbläsaren <strong>blindar</strong> intyget genom att multiplicera in en slumpfaktor
              som aldrig lämnar din enhet.
            </li>
            <li>
              Du legitimerar dig. Myndigheten markerar din rösträtt som använd och signerar det
              blindade värdet — <strong>utan att se vad den signerar</strong>.
            </li>
            <li>Webbläsaren avblindar signaturen och kontrollerar att den är giltig.</li>
            <li>Rösten lämnas in anonymt med intyget. Ingen session är inblandad.</li>
          </ol>

          <div className="notice info" style={{ marginTop: '1rem' }}>
            <strong>Obundenheten är informationsteoretisk, inte beräkningsmässig.</strong>
            <div style={{ marginTop: '0.35rem' }}>
              Blindningsfaktorn är likformigt slumpad, så det myndigheten ser vid signeringen är
              statistiskt oberoende av intyget. Det är inte <em>svårt</em> att koppla ihop utfärdande
              och inlösen — det är omöjligt, även för den som sparat allt servern sett.
            </div>
          </div>

          <p className="muted small" style={{ marginTop: '1rem' }}>
            Samma mekanism tog bort ett tidigare problem. Förr skedde två skrivningar i följd —
            markera som röstad, sedan registrera rösten — och en krasch emellan kunde ge en förlorad
            röst. Nu sker markering och utfärdande i <em>en</em> transaktion, och inlösen är
            engångs: samma intyg kan inte lösas in två gånger, oavsett hur många parallella
            försök som görs. Ordningen mellan databaserna spelar ingen roll längre.
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
                    <th>röstberättigad</th>
                    <th>admin</th>
                  </tr>
                </thead>
                <tbody>
                  {state?.voterDatabase.rows.map((row) => (
                    <tr key={row.id}>
                      <td className="mono">{row.id}</td>
                      <td className="mono">{row.externalIdentityHash}</td>
                      <td>{row.isEligible ? 'ja' : 'nej'}</td>
                      <td>{row.isAdmin ? 'ja' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ marginTop: '0.75rem' }}>
              &quot;Har röstat&quot; står inte här utan i en egen tabell, per person och valsedel —
              att ha röstat i riksdagsvalet men inte i kommunvalet är ett giltigt tillstånd som en
              boolean inte kan uttrycka. Tidpunkten lagras med dygnsupplösning.
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
                    <th>valsedel</th>
                    <th>tidpunkt</th>
                  </tr>
                </thead>
                <tbody>
                  {state?.voteDatabase.rows.map((row) => (
                    <tr key={row.id}>
                      <td className="mono">{row.id}</td>
                      <td className="mono">{row.tokenHash}</td>
                      <td className="mono">{row.ballotId}</td>
                      <td className="mono">{row.createdAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ marginTop: '0.75rem' }}>
              Partiet visas inte här. Demovyn ska visa att tabellerna saknar gemensamma värden — den
              behöver inte avslöja vad någon röstat på för att göra den poängen. Tidpunkten lagras
              med timupplösning, och raderna visas sorterade på id, inte i skrivordning.
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

              <div className="notice warning" style={{ marginTop: '1rem' }}>
                <strong>Ett värde ÄR dock delat, och det ska sägas rakt ut.</strong>
                <div style={{ marginTop: '0.35rem' }}>
                  Omröstningen och dess valsedlar finns i <em>båda</em> databaserna med samma UUID.
                  En foreign key mellan två PostgreSQL-databaser är fysiskt omöjlig, och
                  alternativet — att den ena sidan frågar den andra — skulle kräva just den
                  läsvägen som konstruktionen finns till för att omöjliggöra. Speglingen låter
                  varje relation stanna inom sin egen databas.
                  <div style={{ marginTop: '0.5rem' }}>
                    Vad det kostar: med en enda omröstning ingenting. Med flera partitioneras
                    rösterna, och &quot;har röstat&quot;-tabellen visar vem som röstat i vilken
                    omröstning — anonymitetsmängden krymper per omröstning i stället för att omfatta
                    alla röster i systemet. För en valsedel med få röstande är det en verklig
                    försämring. Jämförelsen ovan gäller väljarrader mot röstrader, som fortfarande
                    saknar varje gemensamt värde.
                  </div>
                </div>
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
                {' '}förekommer i båda.
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
{`SELECT v.external_identity_hash, a.ballot_party_id
FROM voter_status v
JOIN anonymous_vote a ON ??? = ???;`}
              </pre>
              <div className="notice danger" style={{ marginTop: '0.75rem' }}>
                Frågan går inte att skriva färdigt. Det finns inget villkor att sätta i JOIN:en —
                inga gemensamma kolumner, ingen foreign key, inget delat id. Dessutom ligger
                tabellerna i olika databaser, så en och samma anslutning ser aldrig båda samtidigt.
                <div style={{ marginTop: '0.5rem' }}>
                  Röstintyget är det enda värdet som passerat båda sidorna — men det bar väljaren
                  själv över gränsen, och myndigheten såg det aldrig i klartext. Det finns ingen rad
                  i röstlängden att matcha det mot.
                </div>
              </div>
            </div>
          )}
        </div>

        {/* --- Verifierbarhet ----------------------------------------------- */}
        <div className="card">
          <h2>Hur valet kan granskas utan att valhemligheten bryts</h2>
          <p className="muted small">
            Det ska inte räcka att lita på att administratören säger att databasen är korrekt. En
            oberoende part måste kunna kontrollera hela kedjan själv:
          </p>
          <p className="mono small" style={{ marginTop: '0.5rem' }}>
            legitim röstning → exakt en anonym röst → rösten finns kvar → rösten räknades korrekt
          </p>

          <div className="table-wrap" style={{ marginTop: '1rem' }}>
            <table className="prose-table">
              <thead>
                <tr>
                  <th>Fråga</th>
                  <th>Hur den besvaras utan tillit</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Har rösten skapats genom den auktoriserade processen?</td>
                  <td>
                    Varje röst bär en signatur som bara valsedelns privata nyckel kan ha skapat.
                    Vem som helst verifierar den med den publika nyckeln.
                  </td>
                </tr>
                <tr>
                  <td>Har någon röst ändrats eller tagits bort?</td>
                  <td>
                    Merkleträd över rösterna, sorterade på <em>innehåll</em> och inte på tid.
                    Publicerade rötter binder underlaget vid en tidpunkt.
                  </td>
                </tr>
                <tr>
                  <td>Motsvarar antalet godkända röstningar antalet röster?</td>
                  <td>Båda talen publiceras per valsedel och kan jämföras.</td>
                </tr>
                <tr>
                  <td>Räknades rösterna korrekt?</td>
                  <td>Hela röstunderlaget publiceras. Vem som helst kan räkna om det.</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="muted small" style={{ marginTop: '1rem' }}>
            Merkleträdet sorteras på innehåll av ett skäl som är värt att förstå. En hashkedja i
            skrivordning vore den självklara lösningen — men ett löpnummer <em>är</em> en ordning,
            och hela poängen med grova tidsstämplar är att rösterna inte ska gå att sortera i samma
            följd som väljarna legitimerade sig. En kedja hade rivit ned tidsskyddet för att bygga
            upp manipulationsskyddet.
          </p>

          <p className="muted small">
            Öppet utan inloggning: <span className="mono">POST /api/observer/election</span> och{' '}
            <span className="mono">POST /api/observer/votes</span>. Att publicera röstunderlaget
            hotar inte valhemligheten — det är <em>möjligt</em> just därför att underlaget inte bär
            någon identitet.
          </p>
        </div>

        {/* --- Metadata ----------------------------------------------------- */}
        <div className="card">
          <h2>Metadata som skulle kunna underminera anonymiteten</h2>
          <p className="muted small">
            Separationen i databasen är den lätta delen. Det som faktiskt hotar valhemligheten är
            spåren runtomkring.
          </p>
          <div className="table-wrap">
            <table className="prose-table">
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
                  <td>Slumpade UUID:n; Merkleträdet sorteras på innehåll, inte på tid</td>
                </tr>
                <tr>
                  <td>IP-adress</td>
                  <td>IP plus tidpunkt är i praktiken en identitet</td>
                  <td>Används till hastighetsbegränsning, hashas, lagras aldrig</td>
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
                  <td>Personröst på liten kandidat</td>
                  <td>Ett kryss som delas med tio personer är nästan en identitet</td>
                  <td>
                    Ingen geografisk markering på rösten, ingen finare tidsstämpel — men mängden är
                    liten i sig. Inte löst.
                  </td>
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

        {/* --- Vad som inte är löst ----------------------------------------- */}
        <div className="card">
          <h2>Varför detta inte räcker för ett riktigt val</h2>
          <p className="muted small">
            Modellen visar principen: legitimera väljaren separat, låt väljaren själv bära ett blint
            signerat intyg över gränsen, registrera rösten anonymt, och publicera underlaget så att
            vem som helst kan räkna om valet. Den visar inte ett valsystem redo för drift.
          </p>

          <div className="table-wrap" style={{ marginTop: '1rem' }}>
            <table className="prose-table">
              <thead>
                <tr>
                  <th>Kvarstående problem</th>
                  <th>Varför det är allvarligt</th>
                </tr>
              </thead>
              <tbody>
                {/*
                  Läses ur src/lib/known-limitations.ts och står inte skriven här.

                  Skälet är erfarenhet: listan fanns tidigare som prosa på tre
                  ställen, och ordningsproblemet mellan de två databasskrivningarna
                  stod kvar som olöst långt efter att röstintygen löst det. En sida
                  som påstår att systemet är sämre än det är underminerar tilliten
                  lika säkert som en som påstår motsatsen.

                  Varje post bär en markör i källkoden. Löser någon problemet
                  försvinner markören och ett säkerhetstest failar tills posten
                  tagits bort — ett test som går sönder när systemet blir bättre.
                */}
                {KNOWN_LIMITATIONS.map((limitation) => (
                  <tr key={limitation.id}>
                    <td>
                      <strong>{limitation.title}</strong>
                    </td>
                    <td>{limitation.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="muted small" style={{ marginTop: '1rem' }}>
            Samtliga är beskrivna i <span className="mono">SECURITY.md</span> och{' '}
            <span className="mono">VERIFIABILITY.md</span>, med resonemanget bakom varje avvägning.
            Listan är avsiktligt fullständig: den som tror att systemet klarar mer än det gör fattar
            sämre beslut än den som inte känner till det alls.
          </p>
        </div>
      </div>
    </main>
  )
}
