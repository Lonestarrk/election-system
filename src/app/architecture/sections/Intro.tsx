import { CURRENTLY } from '../code-facts'

/**
 * Sidans inledning och beskedet att ombyggnaden pågår.
 *
 * Beskedet läser sina påståenden om koden ur code-facts.ts, så att det ändras
 * i samma stund som koden gör.
 */
export function Intro({ demo }: { demo: boolean }) {
  return (
    <>
      <div>
        <h1>Arkitektur</h1>
        <p className="muted">
          Systemet byggs om till dubbla kuvert, efter Estlands modell. I den modellen vet systemet
          under röstningen att du har röstat men inte på vad, och rösten går att ändra fram till
          stängningen. Vid stängningen skalas identiteten bort, och efteråt publiceras bara
          summorna. Här står hur det är tänkt att fungera, vad som är byggt, vad det skyddar mot
          och vad det inte skyddar mot.
          {demo &&
            ' I demoläget kan du dessutom se båda databaserna som de ser ut just nu, och följa en röst genom stängningen.'}
        </p>
      </div>

      <div className="notice warning">
        <strong>Ombyggnaden pågår.</strong>
        <div style={{ marginTop: '0.35rem' }}>
          Kuvertmodellen finns på serversidan: röstläggning med BankID-signatur, validering och
          stängning. {CURRENTLY.votePageUsesOldFlow.text} {CURRENTLY.decryptionNotBuilt.text}{' '}
          {CURRENTLY.sumsNotPublished.text} Sidan beskriver kuvertmodellen och säger för varje del
          om den är byggd.
        </div>
      </div>
    </>
  )
}
