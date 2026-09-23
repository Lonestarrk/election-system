import type { ReactNode } from 'react'
import { KNOWN_LIMITATIONS, type KnownLimitation } from '@/lib/known-limitations'
import { bankIdIsMocked } from '@/modules/eligibility/bankid'
import { CURRENTLY, PHASES } from './code-facts'
import { LiveDatabaseView } from './LiveDatabaseView'

/**
 * Arkitektursidan.
 *
 * Sidan ska kunna läsas av någon som misstror systemet. Den förklarar
 * modellen med dubbla kuvert, visar i demoläget databasernas faktiska innehåll
 * och räknar fram slutsatserna ur det som hämtas. En demonstration som bara
 * påstår att en tabell är tom vore värdelös.
 *
 * Den redovisar också vad som INTE är löst. En arkitektursida som bara listar
 * styrkor är marknadsföring, och i ett valsystem är marknadsföring farligt: den
 * som tror att systemet klarar mer än det gör fattar sämre beslut än den som
 * inte känner till det alls.
 *
 * TRE KÄLLOR, INGEN AV DEM SKRIVEN HÄR
 *
 * Det sidan påstår om kodens nuvarande läge, till exempel vilka faser som
 * faktiskt skrivs, läses ur ./code-facts.ts. De kända begränsningarna läses ur
 * src/lib/known-limitations.ts. Databasernas innehåll hämtas av livevyn. De två
 * första bär markörer i koden och ett test som går rött när en markör
 * försvinner, så sidan kan inte bli inaktuell utan att någon märker det.
 */

/**
 * DEMOLÄGET AVGÖRS HÄR, PÅ ETT STÄLLE.
 *
 * Livevyn och "Följ en röst" visar röstlängden och får bara finnas i
 * demoläget. Sidan är en serverkomponent för att kunna avgöra det innan något
 * skickas till webbläsaren: i skarpt läge renderas livevyn inte alls, och
 * ingen fråga till /api/demo/database-state görs. Förklaringarna visas i båda
 * lägena.
 *
 * Predikatet är detsamma som rutten använder. Uppgift 17 byter det mot
 * lägesväxeln, och bytet är den här raden.
 */
const DEMO_MODE: boolean = bankIdIsMocked

/**
 * En begränsning ur listan, efter id.
 *
 * Kastar om posten saknas. Sidan hänvisar till den i löpande text, och en
 * hänvisning till en post som tagits bort betyder att texten runt omkring också
 * är fel. tests/security/architecture-page.test.ts fångar det innan sidan gör
 * det.
 */
function limitation(id: string): KnownLimitation {
  const found = KNOWN_LIMITATIONS.find((entry) => entry.id === id)
  if (!found) {
    throw new Error(`Arkitektursidan hänvisar till begränsningen "${id}", som inte finns i listan.`)
  }
  return found
}

export default function ArchitecturePage() {
  const link = limitation('link-exists-during-voting')
  const chain = limitation('bankid-chain-not-validated')
  const dealer = limitation('trusted-dealer')

  return (
    <main>
      <div className="stack">
        <div>
          <h1>Arkitektur</h1>
          <p className="muted">
            Systemet bygger på dubbla kuvert, efter Estlands modell. Under röstningen vet systemet
            att du har röstat men inte på vad, och du kan ändra dig fram till stängningen. Vid
            stängningen skalas identiteten bort. Här står hur det går till, vad det skyddar mot och
            vad det inte skyddar mot.
            {DEMO_MODE &&
              ' I demoläget kan du dessutom se båda databaserna som de ser ut just nu, och följa en röst genom stängningen.'}
          </p>
        </div>

        <div className="notice warning">
          <strong>Ombyggnaden pågår.</strong>
          <div style={{ marginTop: '0.35rem' }}>
            Kuvertmodellen finns på serversidan: röstläggning med BankID-signatur, validering och
            stängning. {CURRENTLY.votePageUsesOldFlow.text} {CURRENTLY.decryptionNotBuilt.text} Sidan
            beskriver kuvertmodellen och säger vad som är byggt.
            {DEMO_MODE &&
              ' Livevyn visar vad databaserna faktiskt innehåller, med båda modellernas tabeller märkta.'}
          </div>
        </div>

        {/* --- 1. Kuvertmodellen -------------------------------------------- */}
        <section className="card" aria-labelledby="kuverten">
          <h2 id="kuverten">Dubbla kuvert</h2>
          <p>
            Tänk på en brevröst. Du lägger valsedeln i ett innerkuvert utan namn, och innerkuvertet i
            ett ytterkuvert med ditt namn och din underskrift. Den som tar emot posten ser att du har
            röstat, men inte på vad. Skickar du en ny röst före sista dagen byts den gamla ut. När
            rösterna ska räknas kontrolleras ytterkuverten, sprättas upp och kastas, och
            innerkuverten blandas innan någon öppnar dem.
          </p>
          <p className="muted small">
            Här är ytterkuvertet en rad i tabellen <span className="mono">pending_vote</span> i
            röstlängden, <span className="mono">voters_db</span>: vem du är, din BankID-signatur och
            ett chiffer. Innerkuvertet är chiffret, ditt val krypterat i webbläsaren under valets
            publika nyckel. Den privata nyckeln finns inte hel någonstans. Den är delad mellan tre
            förtroendemän, och två av dem måste medverka för att något ska kunna öppnas. Vid
            stängningen flyttas chiffren till <span className="mono">encrypted_vote</span> i
            röstdatabasen, <span className="mono">votes_db</span>, sorterade på innehåll, och
            ytterkuverten raderas.
          </p>

          <div className="flow" style={{ marginTop: '1.5rem' }}>
            <div className="flow-node identity">Legitimering med BankID</div>
            <div className="flow-label">väljaren ser sina valsedlar och om hon redan har röstat</div>
            <div className="flow-arrow">↓</div>
            <div className="flow-node">Webbläsaren krypterar valet</div>
            <div className="flow-label">
              under valets publika nyckel · bevis för exakt ett kryss · slumptalen kastas
            </div>
            <div className="flow-arrow">↓</div>
            <div className="flow-node identity">Väljaren signerar med BankID</div>
            <div className="flow-label">över chifferhashen, med en räknare inuti det signerade</div>
            <div className="flow-arrow">↓</div>
            <div className="flow-node identity">Ytterkuvert i pending_vote</div>
            <div className="flow-label">voters_db · väljare och chiffer · ersätts om hon röstar igen</div>

            <div className="barrier">
              <span>Här slutar identiteten</span>
            </div>
            <div className="flow-label">stängningen: validera, flytta, radera kopplingen</div>
            <div className="flow-arrow">↓</div>

            <div className="flow-node anonymous">Innerkuvert i encrypted_vote</div>
            <div className="flow-label">
              votes_db · sorterat på innehåll · ingen väljare, ingen tidsstämpel
            </div>
            <div className="flow-arrow">↓</div>
            <div className="flow-node anonymous">Två av tre förtroendemän öppnar summan</div>
            <div className="flow-label">
              enskilda chiffer dekrypteras aldrig · {CURRENTLY.decryptionNotBuilt.short}
            </div>
          </div>

          <div className="notice info" style={{ marginTop: '1.5rem' }}>
            <strong>En skillnad mot brevrösten är avgörande: innerkuverten öppnas aldrig ett och ett.</strong>
            <div style={{ marginTop: '0.35rem' }}>
              Chiffren multipliceras ihop till ett chiffer av summan, och bara summan dekrypteras.
              I kuvertmodellen är kvittot chifferhashen. Den visar att ditt chiffer finns med, men
              inte vad det innehåller, eftersom webbläsaren kastar slumptalen som krypteringen byggde
              på.
            </div>
          </div>

          <p className="muted small" style={{ marginTop: '1rem' }}>
            Skyddet mot röstköp är att rösten kan ändras fram till stängningen. Varje ny röst kräver
            en ny BankID-signatur, och räknaren inuti det signerade måste vara högre än förra
            gången. Utan räknaren kunde den som fångat ditt första kuvert skicka in det igen efter
            att du ändrat dig, och en köpt röst skulle överleva hela ändringsmöjligheten.
          </p>
        </section>

        {/* --- Faserna ----------------------------------------------------- */}
        <section className="card" aria-labelledby="faserna">
          <h2 id="faserna">Faserna</h2>
          <p className="muted small">
            Ordningen ska vara omöjlig att kasta om, inte bara osannolik. Därför är fasen ett fält på
            omröstningen och inte en jämförelse mot klockan: en klocka som går fel ändrar beteendet
            tyst, medan en fasövergång är en händelse som någon utfört. Fasen går bara framåt, och en
            röst avvisas i varje fas utom OPEN.
          </p>

          <div className="table-wrap" style={{ marginTop: '1rem' }}>
            <table className="prose-table stack-on-mobile">
              <thead>
                <tr>
                  <th>Fas</th>
                  <th>Kopplingen finns</th>
                  <th>Röster tas emot</th>
                  <th>Härnäst</th>
                  <th>I koden i dag</th>
                </tr>
              </thead>
              <tbody>
                {PHASES.map((row, index) => {
                  const previous = PHASES[index - 1]
                  return (
                    <tr key={row.phase}>
                      <td className="mono" style={{ width: 'auto', minWidth: 0 }}>
                        {row.phase}
                      </td>
                      <td data-label="Kopplingen finns">
                        {yesNo(row.linkExists, previous?.linkExists)}
                      </td>
                      <td data-label="Röster tas emot">
                        {yesNo(row.acceptsVotes, previous?.acceptsVotes)}
                      </td>
                      <td data-label="Härnäst">{row.next}</td>
                      <td data-label="I koden i dag">{row.today.text}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p className="muted small" style={{ marginTop: '1rem' }}>
            De fyra första kolumnerna är specens tabell. Att CLOSED och STRIPPED är skilda tillstånd
            gör valideringsfönstret synligt: kopplingen finns, men ingen röst tas emot. Och eftersom
            övergången till STRIPPED är villkoret för att något ska få dekrypteras, kan ingen
            dekryptering beställas förrän kopplingen bevisligen är borta.
          </p>
          <p className="muted small">
            &quot;Nej&quot; om kopplingen betyder att raderna är borta ur den levande databasen.
            Backuper, läsreplikor och WAL-loggen omfattas inte av raderingen.
          </p>
        </section>

        {/* --- Vad konstruktionen inte ger ----------------------------------- */}
        <section className="card" aria-labelledby="inte-ger">
          <h2 id="inte-ger">Vad konstruktionen inte ger</h2>
          <p className="muted small">Kuverten skyddar inte mot följande, inte ens när allt är byggt.</p>
          <ul className="small" style={{ paddingLeft: '1.25rem', marginTop: '0.75rem' }}>
            <li style={listItemStyle}>
              <strong>Kopplingen finns medan röstningen pågår.</strong> Den som kan läsa röstlängden
              ser vem som har röstat, hur många gånger hon ändrat sig och vilken dag hon senast
              gjorde det. Innehållet skyddas då bara av att chiffret inte går att läsa utan två av tre
              andelar, och två förtroendemän som samarbetar kan öppna vilket chiffer som helst.
              Raderingen vid stängningen når inte backuper, läsreplikor eller WAL-loggen.{' '}
              <LimitationReference entry={link} />
            </li>
            <li style={listItemStyle}>
              <strong>Signaturen skyddar inte mot den som driver systemet.</strong> Den stoppar en
              klient som skickar in ett eget kuvert. Men certifikatet prövas inte mot BankID:s CA, så
              den som kan skriva i databasen kan förfalska en rad som valideringen godkänner.{' '}
              <LimitationReference entry={chain} />
            </li>
            <li style={listItemStyle}>
              <strong>Nyckeln har funnits hel.</strong> Tröskelnyckeln skapas av en betrodd utdelare
              och finns ett ögonblick på ett ställe innan den delas.{' '}
              <LimitationReference entry={dealer} />
            </li>
            <li style={listItemStyle}>
              <strong>En manipulerad klient kan kryptera något annat än du valde.</strong>{' '}
              Krypteringen sker i webbläsaren med kod som servern levererar. Motmedlet, att väljaren
              kan granska ett kuvert i stället för att lägga det, ingår inte i modellen.
            </li>
            <li style={listItemStyle}>
              <strong>Den som kan bevaka dig fram till stängningen kan fortfarande tvinga dig.</strong>{' '}
              Att rösten går att ändra hjälper bara om du kan ändra den i fred. Estland låter en
              pappersröst upphäva den digitala. Det ingår inte här.
            </li>
          </ul>
        </section>

        {/* --- 2 och 3. Livevyn och "Följ en röst" ----------------------------- */}
        {DEMO_MODE ? (
          <LiveDatabaseView linkLimitationTitle={link.title} />
        ) : (
          <section className="card" aria-labelledby="livevy">
            <h2 id="livevy">Databaserna just nu</h2>
            <p className="muted small">
              Livevyn och &quot;Följ en röst&quot; visas bara i demoläget. De visar röstlängden, och
              den får ingen sida visa i skarpt läge. Sidan frågar därför inte efter den, och rutten
              som lämnar ut den svarar 404 när BankID inte är en attrapp.
            </p>
          </section>
        )}

        {/* --- Granskning ---------------------------------------------------- */}
        <section className="card" aria-labelledby="granskning">
          <h2 id="granskning">Hur valet kan granskas utan att valhemligheten bryts</h2>
          <p className="muted small">
            Det ska inte räcka att lita på att administratören säger att databasen är korrekt. En
            oberoende part ska kunna kontrollera kedjan själv, och den här tabellen säger vilka delar
            av kedjan som finns i koden i dag.
          </p>

          <div className="table-wrap" style={{ marginTop: '1rem' }}>
            <table className="prose-table stack-on-mobile">
              <thead>
                <tr>
                  <th>Fråga</th>
                  <th>Hur kuvertmodellen svarar</th>
                  <th>I koden i dag</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Är varje kuvert lagt av väljaren själv?</td>
                  <td data-label="Hur kuvertmodellen svarar">
                    Varje rad bär väljarens BankID-signatur över chifferhashen och räknaren.
                    Valideringen före stängningen prövar signatur, räknare, valsedel och bevis medan
                    kopplingen finns, och stoppar stängningen vid en avvikelse.
                  </td>
                  <td data-label="I koden i dag">
                    Byggt. Men signaturen prövas mot nyckeln i raden, inte mot BankID:s CA.{' '}
                    <LimitationReference entry={chain} />
                  </td>
                </tr>
                <tr>
                  <td>Har något kuvert tillkommit eller försvunnit vid stängningen?</td>
                  <td data-label="Hur kuvertmodellen svarar">
                    Kuvertroten, en Merklerot över alla par av chifferhash och signatur, räknas ut
                    innan något raderas och skrivs en enda gång. Stängningen avbryter om antalet som
                    flyttats inte är exakt antalet som fanns.
                  </td>
                  <td data-label="I koden i dag">
                    Byggt. {CURRENTLY.envelopeRootNotPublished.text} Ingen inklusionsväg lagras, och
                    efter stängningen är signaturerna raderade, så ingen utomstående kan räkna om
                    roten.
                  </td>
                </tr>
                <tr>
                  <td>Finns min röst med?</td>
                  <td data-label="Hur kuvertmodellen svarar">
                    Väljaren letar upp sin verifikationskod, chifferhashen, i den publicerade mängden.
                  </td>
                  <td data-label="I koden i dag">
                    {CURRENTLY.encryptedVotesNotPublished.text}
                    {DEMO_MODE && ' I demoläget går kontrollen att göra i "Följ en röst" ovan.'}
                  </td>
                </tr>
                <tr>
                  <td>Räknades rösterna korrekt?</td>
                  <td data-label="Hur kuvertmodellen svarar">
                    Vem som helst multiplicerar ihop chiffren till summan och kontrollerar
                    förtroendemännens dekrypteringsbevis.
                  </td>
                  <td data-label="I koden i dag">{CURRENTLY.decryptionNotBuilt.text}</td>
                </tr>
                <tr>
                  <td>Har revisionsloggen ändrats?</td>
                  <td data-label="Hur kuvertmodellen svarar">
                    Loggen är en hashkedja: varje rad bär föregående rads hash, så en borttagen eller
                    ändrad rad bryter alla senare. Både valideringen och raderingen loggas, så att det
                    syns att kopplingen lästs och raderats. Posterna säger vilken timme, men varken
                    vem eller hur många.
                  </td>
                  <td data-label="I koden i dag">
                    Byggt, och slutkontrollen prövar kedjan. Den hindrar inte den som har skrivrätt
                    i databasen från att räkna om hela kedjan från början.
                  </td>
                </tr>
                <tr>
                  <td>Kan ett resultat fastställas medan kopplingen finns?</td>
                  <td data-label="Hur kuvertmodellen svarar">
                    Nej. Slutkontrollen vägrar så länge ett enda ytterkuvert finns kvar.
                  </td>
                  <td data-label="I koden i dag">Byggt. {CURRENTLY.finalCheckOldModel.text}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="muted small" style={{ marginTop: '1rem' }}>
            Kuvertroten sorterar sina löv på innehåll, av ett skäl som är värt att förstå. En
            hashkedja i skrivordning vore den självklara lösningen, men ett löpnummer är en ordning,
            och i den här modellen vore det ordningen väljarna röstade i. Då hade manipulationsskyddet
            byggts upp genom att valhemligheten revs ned.
          </p>
        </section>

        {/* --- 4. Metadata --------------------------------------------------- */}
        <section className="card" aria-labelledby="metadata">
          <h2 id="metadata">Metadata som skulle kunna underminera valhemligheten</h2>
          <p className="muted small">
            Separationen i databasen är den lätta delen. Det som faktiskt hotar valhemligheten är
            spåren runtomkring. Tabellen gäller kuvertmodellen; det gamla flödets egna risker står i
            listan längst ned.
          </p>
          <div className="table-wrap">
            <table className="prose-table stack-on-mobile">
              <thead>
                <tr>
                  <th>Risk</th>
                  <th>Hur den skulle avslöja</th>
                  <th>Vad systemet gör</th>
                </tr>
              </thead>
              <tbody>
                <MetadataRow
                  risk="Kopior av röstlängden"
                  reveals="En backup, en läsreplik eller WAL-loggen från före stängningen innehåller pending_vote, med väljare och chifferhash"
                >
                  Ingenting. Raderingen når bara den levande databasen.{' '}
                  <LimitationReference entry={link} />
                </MetadataRow>
                <MetadataRow risk="Exakta tidsstämplar" reveals="Rad matchas mot rad på tid">
                  Dygn i röstlängden, också på pending_vote. encrypted_vote har ingen tidsstämpel
                  alls. Revisionsloggen och det gamla flödets röster har timupplösning.
                </MetadataRow>
                <MetadataRow
                  risk="Skrivordning"
                  reveals="Rader i samma ordning som väljarna röstade går att para ihop"
                >
                  Kuverten flyttas i en enda sats vid stängningen, sorterade på chifferhash, och id:t
                  härleds ur hashen. Tabellens ordning är innehållets.
                </MetadataRow>
                <MetadataRow
                  risk="Räknaren i ytterkuvertet"
                  reveals="Visar hur många gånger väljaren har ändrat sig"
                >
                  Finns bara i pending_vote, följer aldrig med till votes_db och raderas med
                  kopplingen.
                </MetadataRow>
                <MetadataRow
                  risk="Löpande resultat"
                  reveals="Differensen mellan två publicerade summor är rösterna däremellan, och under röstningen vet systemet vem som röstade när"
                >
                  Ingen summa räknas under röstningen. En dekryptering får inte beställas förrän
                  fasen är STRIPPED, alltså förrän kopplingen är borta.
                </MetadataRow>
                <MetadataRow
                  risk="Personröst och små alternativ"
                  reveals="Ett alternativ som få väljer är nästan en identitet"
                >
                  I designen öppnas bara summan per alternativ, aldrig en enskild röst. Men en summa
                  på ett är fortfarande en summa på ett. Inte löst, och går inte att lösa med
                  kryptografi.
                </MetadataRow>
                <MetadataRow risk="IP-adress" reveals="IP plus tidpunkt är i praktiken en identitet">
                  Används till hastighetsbegränsning och hålls hashad i processminnet. Lagras aldrig
                  i en databas.
                </MetadataRow>
                <MetadataRow
                  risk="Request-id"
                  reveals="Samma id i båda delarnas loggar kopplar ihop dem"
                >
                  Systemet skapar inget request-id.
                </MetadataRow>
                <MetadataRow
                  risk="Applikationsloggar"
                  reveals="En chifferhash eller ett personnummer i loggen kopplar ihop sidorna"
                >
                  All loggning går genom ett filter som maskerar kända mönster, bland dem 64
                  hextecken, alltså chifferhashar. Ett test stoppar direkta anrop till konsolen.
                </MetadataRow>
                <MetadataRow
                  risk="Analys och felrapportering"
                  reveals="En tredjepartstjänst får både identitet och beteende"
                >
                  Finns inte. CSP:n tillåter inga utgående anrop.
                </MetadataRow>
                <MetadataRow
                  risk="Databasens egna loggar"
                  reveals="PostgreSQL:s WAL innehåller varje skrivning i exakt ordning"
                >
                  Prismas frågeloggning är avstängd i båda klienterna. WAL-loggen bär kuverten även
                  efter raderingen, se SECURITY.md avsnitt 4.6.
                </MetadataRow>
              </tbody>
            </table>
          </div>
        </section>

        {/* --- 4. Vad som inte är löst --------------------------------------- */}
        <section className="card" aria-labelledby="begransningar">
          <h2 id="begransningar">Varför detta inte räcker för ett riktigt val</h2>
          <p className="muted small">
            Modellen visar principen: legitimera väljaren, låt henne lägga ett krypterat kuvert som
            bär hennes egen signatur, skala bort identiteten vid stängningen och öppna bara summan. Den
            visar inte ett valsystem redo för drift.
          </p>
          <p className="muted small">
            Listan gäller hela systemet. De tre första posterna hör till kuvertmodellen. Några av de
            övriga beskriver det gamla flödet med röstintyg och blinda signaturer och försvinner ur
            listan när det flödet tas bort, medan andra gäller oavsett modell.
          </p>

          <div className="table-wrap" style={{ marginTop: '1rem' }}>
            <table className="prose-table stack-on-mobile">
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
                  tagits bort, ett test som går sönder när systemet blir bättre.
                */}
                {KNOWN_LIMITATIONS.map((entry) => (
                  <tr key={entry.id} id={`begransning-${entry.id}`}>
                    <td>
                      <strong>{entry.title}</strong>
                    </td>
                    <td>{entry.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="muted small" style={{ marginTop: '1rem' }}>
            Resonemanget bakom kuvertmodellens avvägningar står i specen,{' '}
            <span className="mono">docs/spec/2026-09-22-dubbla-kuvert.md</span>. Listan är den enda
            källan: sidan läser den och skriver den inte, så den blir aldrig mer rätt än listan. Den
            som tror att systemet klarar mer än det gör fattar sämre beslut än den som inte känner
            till det alls.
          </p>
        </section>
      </div>
    </main>
  )
}

/**
 * "ja" eller "nej", i fetstil där värdet skiftar från fasen före. Det är
 * övergångarna specens tabell lyfter fram: röstningen stänger i CLOSED, och
 * kopplingen försvinner i STRIPPED.
 */
function yesNo(value: boolean, previous: boolean | undefined) {
  const text = value ? 'ja' : 'nej'
  return previous !== undefined && previous !== value ? <strong>{text}</strong> : text
}

/** En hänvisning till en post i listan längst ned, med rubriken ur listan. */
function LimitationReference({ entry }: { entry: KnownLimitation }) {
  return (
    <span className="muted">
      Står i listan nedan som <a href={`#begransning-${entry.id}`}>{entry.title}</a>.
    </span>
  )
}

function MetadataRow({
  risk,
  reveals,
  children,
}: {
  risk: string
  reveals: string
  children: ReactNode
}) {
  return (
    <tr>
      <td>{risk}</td>
      <td data-label="Hur den skulle avslöja">{reveals}</td>
      <td data-label="Vad systemet gör">{children}</td>
    </tr>
  )
}

const listItemStyle = { marginBottom: '0.6rem' }
