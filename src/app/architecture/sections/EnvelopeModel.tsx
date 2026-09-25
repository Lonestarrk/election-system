import { CURRENTLY } from '../code-facts'

/**
 * Kuvertmodellen tekniskt: vad kuverten motsvarar i databaserna, och flödet
 * från legitimering till publicerade summor.
 *
 * Liknelsen med brevrösten står på huvudsidan, på vardagsspråk. Här står
 * samma modell med sina tekniska namn.
 */
export function EnvelopeModel() {
  return (
    <section className="card" aria-labelledby="kuverten">
      <h2 id="kuverten">Dubbla kuvert</h2>
      <p>
        Ytterkuvertet är en rad i tabellen <span className="mono">pending_vote</span> i röstlängden,{' '}
        <span className="mono">voters_db</span>: vem du är, din BankID-signatur och ett chiffer.
        Innerkuvertet är chiffret, ditt val krypterat i webbläsaren under valets publika nyckel. Den
        privata nyckeln finns inte hel någonstans. Den är delad mellan tre förtroendemän, och två
        av dem måste medverka för att något ska kunna öppnas. Vid stängningen flyttas chiffren till{' '}
        <span className="mono">encrypted_vote</span> i röstdatabasen,{' '}
        <span className="mono">votes_db</span>, sorterade på innehåll, och ytterkuverten raderas.
      </p>
      <p className="muted small">
        Den som tar emot kuverten ser att du har röstat, men inte på vad. Skickar du en ny röst före
        stängningen byts den gamla ut. Det är samma egenskaper som en brevröst har, och modellen är
        Estlands, i drift sedan 2005.
      </p>

      <div className="flow" style={{ marginTop: '1.5rem' }}>
        <div className="flow-node identity">Legitimering med BankID</div>
        <div className="flow-label">
          väljaren ser sina valsedlar · enligt designen också om hon redan har röstat
        </div>
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
          enskilda chiffer dekrypteras aldrig · {CURRENTLY.decryptionBuilt.short}
        </div>
        <div className="flow-arrow">↓</div>
        <div className="flow-node anonymous">Bara summorna publiceras, med bevis</div>
        <div className="flow-label">
          ingenting per röst · {CURRENTLY.sumsNotPublished.short}
        </div>
      </div>

      <div className="notice info" style={{ marginTop: '1.5rem' }}>
        <strong>En skillnad mot brevrösten är avgörande: innerkuverten öppnas aldrig ett och ett.</strong>
        <div style={{ marginTop: '0.35rem' }}>
          Chiffren multipliceras ihop till ett chiffer av summan, och bara summan dekrypteras. Så
          är det tänkt, och {CURRENTLY.decryptionBuilt.short}.
        </div>
      </div>
    </section>
  )
}
