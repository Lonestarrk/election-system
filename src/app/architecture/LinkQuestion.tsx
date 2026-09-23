import type { DatabaseState, ForeignKey } from '@/app/api/demo/database-state/route'
import { ColumnList, DbTable, preStyle, rowCount, type Row } from './db-table'

/**
 * "FINNS DET NÅGON KOPPLING?"
 *
 * I den gamla modellen var svaret nej, och demonstrationen gick ut på att
 * frågan "vem röstade på vad" inte gick att skriva färdigt. I kuvertmodellen
 * är svaret ja, med flit, medan röstningen pågår. Avsnittet visar därför vad
 * frågan faktiskt ger: under röstningen en väljare och ett chiffer som inte går
 * att läsa, efter stängningen ingenting att joina.
 *
 * Allt räknas fram ur den aktuella bilden av databaserna. Frågan är den som
 * rutten körde, och nycklarna och kolumnerna kommer ur information_schema.
 */
export function LinkQuestion({
  snapshot,
  anyStripped,
}: {
  snapshot: DatabaseState
  /** Om någon omröstning har fått sin koppling raderad. */
  anyStripped: boolean
}) {
  const { analysis } = snapshot

  return (
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
        Ingen kolumn i encrypted_vote pekar på en väljare; det vaktas av
        tests/security/schema-separation.test.ts. Tabellerna ligger dessutom i olika databaser, så
        en och samma anslutning ser aldrig båda.
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
              Varje väljares id och identitetshash, och varje ytterkuverts id, jämfördes mot allt som
              hämtades ur röstdatabasen. Invarianten att votes_db aldrig innehåller identitet står
              kvar.
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
              Hashen ligger i röstlängden bredvid väljaren fram till stängningen, och i röstdatabasen
              utan väljare efteråt. I båda samtidigt bara under själva stängningen, eller om den
              avbrutits efter flytten men före raderingen.
            </>
          ) : (
            <>
              Stängningen pågår, eller avbröts efter flytten men före raderingen. Tills den körts om
              finns kopplingen kvar, och samma hash står både bredvid väljaren och i encrypted_vote:{' '}
              <span className="mono">{analysis.ciphertextHashesInBoth.join(', ')}</span>
            </>
          )}
        </div>
      </div>
      <p className="muted small" style={{ marginTop: '0.75rem' }}>
        Ett värde ÄR delat, och det ska sägas rakt ut: omröstningen och dess valsedlar har samma UUID
        i båda databaserna, och <span className="mono">pending_vote.ballot_id</span> pekar på en
        valsedel i den andra databasen utan främmande nyckel. Med en enda omröstning kostar det
        ingenting. Med flera delas rösterna upp per omröstning, och anonymitetsmängden krymper till
        varje omröstnings egna röster.
      </p>
    </section>
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
