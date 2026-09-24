import Link from 'next/link'
import { STATUS_PATH } from './shared'

/**
 * Från huvudsidans liknelse till tekniken.
 *
 * Huvudsidan förklarar modellen utan ett enda fackord, och tidslinjen visar
 * den med kuvert, ett lås och två urnor. Här står vad var och en av de sakerna
 * är i tekniken, så att den som läst huvudsidan kan hitta vidare. Allt här är
 * design enligt docs/spec/2026-09-22-dubbla-kuvert.md; vad som är byggt står
 * på Utvecklingsstatus.
 */
const ROWS: Array<{ metaphor: string; technology: string }> = [
  {
    metaphor: 'Det inre kuvertet',
    technology:
      'Chiffret. Ditt val kodas som en vektor med en etta för det valda alternativet och nollor ' +
      'för resten, och varje komponent krypteras med exponentiell ElGamal under valets publika ' +
      'nyckel, i webbläsaren. Med följer bevis för att varje komponent är 0 eller 1 och att de ' +
      'tillsammans är 1 (spec 4.2–4.4).',
  },
  {
    metaphor: 'Låset och nyckelns tre delar',
    technology:
      'Tröskelnyckeln. En betrodd utdelare skapar den privata nyckeln när valet skapas, delar den ' +
      'med Shamirs metod i tre andelar, varav två krävs, och raderar originalet. Varje andel är ' +
      'krypterad med en lösenfras som bara förtroendemannen känner (spec 4.5 och 10).',
  },
  {
    metaphor: 'Det yttre kuvertet med ditt namn',
    technology:
      'En rad i pending_vote i röstlängden, voters_db: väljarens id, chiffret, chifferhashen, ' +
      'räknaren, BankID-signaturen och certifikatkedjan bakom den, krypterad (spec 5).',
  },
  {
    metaphor: 'Underskriften',
    technology:
      'BankID /sign över chifferhashen, med räknaren och valsedelns id i det signerade. Kedjan ' +
      'bakom signaturen prövas mot BankID:s rotcertifikat, och personnumret i certifikatet mot ' +
      'väljarens identitetshash (spec 4.6).',
  },
  {
    metaphor: 'Kuvertet byts ut',
    technology:
      'Raden ersätts för samma väljare och valsedel, och räknaren måste vara högre än förra ' +
      'gången, så att ett gammalt kuvert inte kan skickas in igen.',
  },
  {
    metaphor: 'Skärmen som visar din röst',
    technology:
      'Enheten sparar valet och chifferhashen men aldrig slumptalet. Servern jämför hashen med ' +
      'den liggande röstens och svarar bara lika, olika eller ingen röst, så röstsidan får aldrig ' +
      'någon annan hash än sin egen. Utan slumptalet bevisar visningen ingenting (spec 3.1).',
  },
  {
    metaphor: 'Kontrollen',
    technology:
      'Valideringen före stängningen, medan kopplingen finns: signaturen och kedjan mot BankID:s ' +
      'rot, räknaren, att väljaren finns i röstlängden och att certifikatet är hennes, att ' +
      'valsedeln gäller henne, dubbletter och bevis. Den är en spärr och ' +
      'inte en rapport (spec 7 och 7.1). Att hon fick rösta visar signaturen från när rösten lades, ' +
      'inte röstlängden i efterhand (spec 7.4).',
  },
  {
    metaphor: 'Namnen tas bort, och kuverten sorteras',
    technology:
      'Skalningen. Chiffren infogas i encrypted_vote i röstdatabasen, votes_db, sorterade på ' +
      'chifferhash, raderna i pending_vote raderas och fasen blir STRIPPED, i den ordningen ' +
      '(spec 6 och 6.1).',
  },
  {
    metaphor: 'Summakuvertet',
    technology:
      'Den homomorfa summan: den komponentvisa produkten av alla chiffer är ett chiffer av summan, ' +
      'så att ingen enskild röst behöver öppnas (spec 4.2).',
  },
  {
    metaphor: 'Två delar av nyckeln lämnas',
    technology:
      'Två förtroendemän lämnar var för sig en partiell dekryptering med ett Chaum–Pedersen-bevis, ' +
      'och när två finns kombineras de med Lagrange-koefficienter (spec 4.5 och 6.2).',
  },
  {
    metaphor: 'Resultatet med bevis',
    technology:
      'Per valsedel publiceras den krypterade summan, förtroendemännens partiella dekrypteringar ' +
      'med bevis, resultatet och kuvertroten. Ingenting per röst (spec 7.2).',
  },
  {
    metaphor: 'Du ser att du har röstat',
    technology:
      'En markering i röstlängden, skriven i skalningens transaktion ur de kuvert som raderas, ' +
      'utan tidsstämpel (spec 3.1 punkt 6).',
  },
  {
    metaphor: 'En kopia av urnan',
    technology:
      'Backuper, läsreplikor, WAL-loggen och BankID:s kopia av det väljaren signerade. Ingen av ' +
      'dem omfattas av raderingen (spec 10).',
  },
]

export function FromMetaphorToTechnology() {
  return (
    <section className="card" aria-labelledby="liknelsen">
      <h2 id="liknelsen">Från liknelsen till tekniken</h2>
      <p className="muted small">
        <Link href="/architecture">Huvudsidan</Link> förklarar modellen med kuvert, ett lås och två
        urnor. Så här heter sakerna i tekniken. Allt i tabellen är design; vad som är byggt står på{' '}
        <Link href={STATUS_PATH}>Utvecklingsstatus</Link>.
      </p>

      <div className="table-wrap" style={{ marginTop: '1rem' }}>
        <table className="prose-table stack-on-mobile">
          <thead>
            <tr>
              <th>På huvudsidan</th>
              <th>I tekniken</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.metaphor}>
                <td>{row.metaphor}</td>
                <td data-label="I tekniken">{row.technology}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
