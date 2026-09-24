import type { ReactNode } from 'react'
import { CURRENTLY, type Status } from '../code-facts'
import { LimitationReference, type PageLimitations } from './shared'

/**
 * Granskningsfrågorna, en gång.
 *
 * Varje fråga har två svar: hur kuvertmodellen svarar enligt designen, och vad
 * koden gör i dag. Designen står på Tekniska detaljer och dagsläget på
 * Utvecklingsstatus, men frågorna är desamma. De står här, så att en fråga som
 * ändras ändras på båda sidorna samtidigt.
 *
 * Kolumnen `today` läses ur code-facts.ts och bär markörer. Den visas bara på
 * Utvecklingsstatus, och hänvisningarna i den länkar därför till listan på
 * Tekniska detaljer.
 *
 * `statuses` (uppgift 11h) är statusen för de fakta `today` bygger på, hämtad
 * direkt ur samma code-facts.ts-poster i stället för en egen gissning. En rad
 * kan blanda en byggd och en planerad del, som "Kan väljaren kontrollera sin
 * röst?", och bär då båda statusarna.
 */
export type ReviewQuestion = {
  question: string
  design: ReactNode
  today: ReactNode
  statuses: Status[]
}

export function reviewQuestions({ removal }: PageLimitations): ReviewQuestion[] {
  return [
    {
      question: 'Är varje kuvert lagt av väljaren själv?',
      design: (
        <>
          Varje rad bär väljarens BankID-signatur över chifferhashen och räknaren, och
          certifikatkedjan bakom den. Valideringen före stängningen prövar kedjan mot BankID:s rot,
          att certifikatet är väljarens, signatur, räknare, valsedel och bevis medan kopplingen
          finns, och stoppar skalningen vid en avvikelse. Röstningen förblir stängd, och ingenting
          raderas.
        </>
      ),
      today: (
        <>
          {CURRENTLY.validationGatesClose.text} <LimitationReference entry={removal} from="status" />
        </>
      ),
      statuses: [CURRENTLY.validationGatesClose.status!],
    },
    {
      question: 'Har något kuvert tillkommit eller försvunnit vid stängningen?',
      design: (
        <>
          Kuvertroten, en Merklerot över alla par av chifferhash och signatur, binder exakt vilka
          signerade kuvert som fanns. Den är ett åtagande, inte ett inklusionsbevis, och den
          publiceras med summorna.
        </>
      ),
      today: (
        <>
          {CURRENTLY.envelopeRootCommitment.text} {CURRENTLY.envelopeRootNotPublished.text}
        </>
      ),
      statuses: [CURRENTLY.envelopeRootCommitment.status!, CURRENTLY.envelopeRootNotPublished.status!],
    },
    {
      question: 'Kan väljaren kontrollera sin röst?',
      design: (
        <>
          Före stängningen ser hon sin nuvarande röst på enheten hon röstade från, kontrollerad mot
          det servern håller. Efter stängningen ser hon att hon har röstat, inte vad. Ingen kod
          visas, och ingenting per röst publiceras.
        </>
      ),
      today: (
        <>
          {CURRENTLY.deviceViewBuilt.text} {CURRENTLY.votedMarkerWritten.text}{' '}
          {CURRENTLY.votedMarkerNotShown.text}
        </>
      ),
      statuses: [
        CURRENTLY.deviceViewBuilt.status!,
        CURRENTLY.votedMarkerWritten.status!,
        CURRENTLY.votedMarkerNotShown.status!,
      ],
    },
    {
      question: 'Räknades rösterna korrekt?',
      design: (
        <>
          Vem som helst kontrollerar att resultatet är en korrekt dekryptering av den publicerade
          summan och att två av tre förtroendemän bidrog. Att summan består av exakt de giltiga
          rösterna går inte att räkna om utifrån; det vilar på valideringen och slutkontrollen.
        </>
      ),
      today: (
        <>
          {CURRENTLY.decryptionNotBuilt.text} {CURRENTLY.sumsNotPublished.text}
        </>
      ),
      statuses: [CURRENTLY.decryptionNotBuilt.status!, CURRENTLY.sumsNotPublished.status!],
    },
    {
      question: 'Har revisionsloggen ändrats?',
      design: (
        <>
          Loggen är en hashkedja: varje rad bär föregående rads hash, så en borttagen eller ändrad
          rad bryter alla senare. Både valideringen och raderingen loggas, så att det syns att
          kopplingen lästs och raderats.
        </>
      ),
      today: <>{CURRENTLY.auditChain.text}</>,
      statuses: [CURRENTLY.auditChain.status!],
    },
    {
      question: 'Kan ett resultat fastställas medan kopplingen finns?',
      design: <>Nej. Slutkontrollen vägrar så länge ett enda ytterkuvert finns kvar.</>,
      today: (
        <>
          {CURRENTLY.certifyBlockedWhileLinked.text} {CURRENTLY.finalCheckOldModel.text}
        </>
      ),
      statuses: [CURRENTLY.certifyBlockedWhileLinked.status!, CURRENTLY.finalCheckOldModel.status!],
    },
  ]
}
