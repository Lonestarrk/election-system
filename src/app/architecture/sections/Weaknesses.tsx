import Link from 'next/link'
import type { KnownLimitation } from '@/lib/known-limitations'
import { limitationHref, listItemStyle } from './shared'

/**
 * Vad kuverten inte skyddar mot, på vardagsspråk, med länk till hela listan.
 *
 * Tidslinjen ovanför säger att det efter stängningen inte går att se i urnan
 * vilket kuvert som är ditt. Det är sant om urnan, men inte om allt runt
 * omkring den, och en läsare som inte kan kontrollera det själv måste få veta
 * var gränsen går. Den viktigaste luckan står först: den som kopierade urnan
 * medan namnen fanns kvar har kopplingen.
 *
 * Spec 4.6 kräver att det sägs rakt ut att underskriften i dag inte skyddar
 * mot den som driver systemet, och spec 10 räknar upp insidern som både kan
 * läsa databasen och kommer åt en enhet. Båda står här, inte bara på Tekniska
 * detaljer.
 *
 * Där en punkt motsvarar en post i listan över kända begränsningar tar sidan
 * emot posten och länkar dit. Tas posten bort kastar uppslaget i page.tsx, och
 * testet går rött, så att punkten här inte står kvar när problemet är löst.
 * Rubrikerna ur listan visas inte här, eftersom de är skrivna med fackord.
 */
export function Weaknesses({
  copies,
  bankIdOrder,
  chain,
  dealer,
}: {
  /** link-exists-during-voting */
  copies: KnownLimitation
  /** bankid-order-carries-link */
  bankIdOrder: KnownLimitation
  /** bankid-chain-not-validated */
  chain: KnownLimitation
  /** trusted-dealer */
  dealer: KnownLimitation
}) {
  return (
    <section className="card" aria-labelledby="inte-skyddar">
      <h2 id="inte-skyddar">Det här skyddar kuverten inte mot</h2>
      <ul style={{ paddingLeft: '1.25rem', marginTop: '0.75rem' }}>
        <li style={listItemStyle}>
          <strong>En kopia av urnan från före stängningen.</strong> Namnen tas bort ur urnan, men inte
          ur kopior av den. Den som kopierade urnan medan namnen fanns kvar, till exempel via en
          säkerhetskopia, vet fortfarande vilket inre kuvert som är ditt. Det går ändå inte att öppna
          utan två av nyckelns tre delar. <Link href={limitationHref(copies)}>Mer om kopiorna</Link>
        </li>
        <li style={listItemStyle}>
          <strong>BankID:s kopia.</strong> Ett riktigt BankID sparar det du skriver under. I dag
          räcker det för att hitta ditt inre kuvert även efter stängningen.{' '}
          <Link href={limitationHref(bankIdOrder)}>Mer om BankID:s kopia</Link>
        </li>
        <li style={listItemStyle}>
          <strong>Underskriften skyddar i dag inte mot den som driver systemet.</strong> Den stoppar
          den som försöker skicka in ett kuvert i någon annans namn. Men den prövas inte mot BankID,
          så den som kan skriva direkt i databasen kan lägga in röster som ser ut att vara
          underskrivna av riktiga väljare, och kontrollen före stängningen godkänner dem.{' '}
          <Link href={limitationHref(chain)}>Mer om underskriften</Link>
        </li>
        <li style={listItemStyle}>
          <strong>Låset görs i ordning av den som driver systemet.</strong> Under ett ögonblick finns
          då hela nyckeln på ett ställe, innan den delas i tre delar och förstörs. Den som behöll en
          kopia av den kan öppna vilket kuvert som helst, ensam.{' '}
          <Link href={limitationHref(dealer)}>Mer om hur låset görs i ordning</Link>
        </li>
        <li style={listItemStyle}>
          <strong>Två förtroendepersoner som samarbetar.</strong> Låset skyddar mot var och en av dem
          ensam. Två som går ihop kan öppna vilket kuvert som helst, inte bara summan.
        </li>
        <li style={listItemStyle}>
          <strong>Någon som kan läsa databasen och kommer åt din enhet.</strong> Medan röstningen
          pågår sparar din enhet ett slags fingeravtryck av ditt inre kuvert. Den som kan läsa urnan
          utan namn och dessutom kommer åt fingeravtrycket innan det raderats kan se om din röst var
          den som räknades, men inte vad du röstade på.{' '}
          <Link href="/architecture/technical#inte-ger">Mer om fingeravtrycket</Link>
        </li>
        <li style={listItemStyle}>
          <strong>Någon som ser dig rösta i sista stund.</strong> Den som står bredvid när du röstar
          strax före stängningen vet vilken röst som gäller, eftersom du inte hinner ändra dig
          efteråt.
        </li>
      </ul>
      {/*
        Adressen står utskriven, inte sammansatt. tests/security/known-limitations.test.ts
        kräver att huvudsidan länkar till listan, och letar efter just den här adressen.
      */}
      <p style={{ marginBottom: 0 }}>
        <Link href="/architecture/technical#begransningar">Alla kända begränsningar</Link>, och
        varför systemet inte räcker för ett riktigt val, står på Tekniska detaljer.
      </p>
    </section>
  )
}
