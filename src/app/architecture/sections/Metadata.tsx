import type { ReactNode } from 'react'
import { CURRENTLY } from '../code-facts'
import { LimitationReference, type PageLimitations } from './shared'

/**
 * Metadata som skulle kunna underminera valhemligheten. Kolumnen "Vad systemet
 * gör" läses ur code-facts.ts där den påstår något om koden; det som är design
 * säger det.
 */
export function Metadata({ limitations }: { limitations: PageLimitations }) {
  const { link, bankIdOrder, liveResults } = limitations

  return (
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
              risk="Kopior utanför den levande databasen"
              reveals="En backup, en läsreplik eller WAL-loggen från före stängningen innehåller pending_vote, med väljare och chifferhash, och BankID sparar det väljaren signerade tillsammans med hennes identitet"
            >
              {CURRENTLY.copiesKeepLink.text} <LimitationReference entry={link} />{' '}
              <LimitationReference entry={bankIdOrder} />
            </MetadataRow>
            <MetadataRow risk="Exakta tidsstämplar" reveals="Rad matchas mot rad på tid">
              {CURRENTLY.timestamps.text}
            </MetadataRow>
            <MetadataRow
              risk="Skrivordning"
              reveals="Rader i samma ordning som väljarna röstade går att para ihop"
            >
              {CURRENTLY.writeOrder.text}
            </MetadataRow>
            <MetadataRow
              risk="Räknaren i ytterkuvertet"
              reveals="Visar hur många gånger väljaren har ändrat sig"
            >
              {CURRENTLY.castSequenceStays.text}
            </MetadataRow>
            <MetadataRow
              risk="Löpande resultat och enskilda röster"
              reveals="Differensen mellan två publicerade summor är rösterna däremellan, och under röstningen vet systemet vem som röstade när. En röst som lämnas ut med sitt innehåll är ett resultat med en enda röst"
            >
              I kuvertmodellens design räknas ingenting under röstningen, och en dekryptering får
              inte beställas förrän fasen är STRIPPED. {CURRENTLY.decryptionGate.text}{' '}
              {CURRENTLY.oldFlowLiveResults.text} <LimitationReference entry={liveResults} />
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
              {CURRENTLY.ipAddresses.text}
            </MetadataRow>
            <MetadataRow
              risk="Request-id"
              reveals="Samma id i båda delarnas loggar kopplar ihop dem"
            >
              {CURRENTLY.requestIds.text}
            </MetadataRow>
            <MetadataRow
              risk="Applikationsloggar"
              reveals="En chifferhash eller ett personnummer i loggen kopplar ihop sidorna"
            >
              {CURRENTLY.applicationLogs.text}
            </MetadataRow>
            <MetadataRow
              risk="Analys och felrapportering"
              reveals="En tredjepartstjänst får både identitet och beteende"
            >
              {CURRENTLY.outboundCalls.text}
            </MetadataRow>
            <MetadataRow
              risk="Databasens egna loggar"
              reveals="PostgreSQL:s WAL innehåller varje skrivning i exakt ordning"
            >
              {CURRENTLY.databaseLogs.text}
            </MetadataRow>
          </tbody>
        </table>
      </div>
    </section>
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
