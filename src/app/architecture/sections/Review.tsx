import type { ReactNode } from 'react'
import { CURRENTLY } from '../code-facts'
import { LimitationReference, type PageLimitations } from './shared'

/**
 * Hur valet kan granskas: designens svar på varje fråga, och vad koden gör i
 * dag. Den andra kolumnen läses ur code-facts.ts och bär markörer.
 */
export function Review({ limitations }: { limitations: PageLimitations }) {
  const { chain } = limitations

  return (
    <section className="card" aria-labelledby="granskning">
      <h2 id="granskning">Hur valet kan granskas utan att valhemligheten bryts</h2>
      <p className="muted small">
        Det ska inte räcka att lita på att administratören säger att databasen är korrekt. En
        oberoende part ska kunna kontrollera så mycket som möjligt själv, och den här tabellen
        säger vilka delar som finns i koden i dag.
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
            <ReviewRow
              question="Är varje kuvert lagt av väljaren själv?"
              design={<>
                Varje rad bär väljarens BankID-signatur över chifferhashen och räknaren.
                Valideringen före stängningen prövar signatur, räknare, valsedel och bevis medan
                kopplingen finns, och stoppar stängningen vid en avvikelse.
              </>}
              today={<>
                {CURRENTLY.validationGatesClose.text} <LimitationReference entry={chain} />
              </>}
            />
            <ReviewRow
              question="Har något kuvert tillkommit eller försvunnit vid stängningen?"
              design={<>
                Kuvertroten, en Merklerot över alla par av chifferhash och signatur, binder exakt
                vilka signerade kuvert som fanns. Den är ett åtagande, inte ett inklusionsbevis,
                och den publiceras med summorna.
              </>}
              today={<>
                {CURRENTLY.envelopeRootCommitment.text} {CURRENTLY.envelopeRootNotPublished.text}
              </>}
            />
            <ReviewRow
              question="Kan väljaren kontrollera sin röst?"
              design={<>
                Före stängningen ser hon sin nuvarande röst på enheten hon röstade från,
                kontrollerad mot det servern håller. Efter stängningen ser hon att hon har röstat,
                inte vad. Ingen kod visas, och ingenting per röst publiceras.
              </>}
              today={<>
                {CURRENTLY.deviceViewNotBuilt.text} {CURRENTLY.votedMarkerNotKept.text}
              </>}
            />
            <ReviewRow
              question="Räknades rösterna korrekt?"
              design={<>
                Vem som helst kontrollerar att resultatet är en korrekt dekryptering av den
                publicerade summan och att två av tre förtroendemän bidrog. Att summan består av
                exakt de giltiga rösterna går inte att räkna om utifrån; det vilar på valideringen
                och slutkontrollen.
              </>}
              today={<>
                {CURRENTLY.decryptionNotBuilt.text} {CURRENTLY.sumsNotPublished.text}
              </>}
            />
            <ReviewRow
              question="Har revisionsloggen ändrats?"
              design={<>
                Loggen är en hashkedja: varje rad bär föregående rads hash, så en borttagen eller
                ändrad rad bryter alla senare. Både valideringen och raderingen loggas, så att det
                syns att kopplingen lästs och raderats.
              </>}
              today={<>{CURRENTLY.auditChain.text}</>}
            />
            <ReviewRow
              question="Kan ett resultat fastställas medan kopplingen finns?"
              design={<>Nej. Slutkontrollen vägrar så länge ett enda ytterkuvert finns kvar.</>}
              today={<>
                {CURRENTLY.certifyBlockedWhileLinked.text} {CURRENTLY.finalCheckOldModel.text}
              </>}
            />
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
  )
}

/** En rad i granskningstabellen: designens svar och vad koden gör i dag. */
function ReviewRow({
  question,
  design,
  today,
}: {
  question: string
  design: ReactNode
  today: ReactNode
}) {
  return (
    <tr>
      <td>{question}</td>
      <td data-label="Hur kuvertmodellen svarar">{design}</td>
      <td data-label="I koden i dag">{today}</td>
    </tr>
  )
}
