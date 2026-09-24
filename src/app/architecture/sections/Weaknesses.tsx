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
 * Spec 4.6 kräver att det sägs rakt ut vad underskriften inte skyddar mot.
 * Sedan uppgift 14f prövas den mot BankID:s rot, och sedan dess fixrunda 1
 * flyttar stängningen bara de kuvert som prövats. Med riktigt BankID kan den
 * som bara kan skriva i röstlängden därför inte längre förfalska en röst. Det
 * gäller röstlängden och inte urnan utan namn: den som kan skriva i
 * röstdatabasen kan än så länge byta ut ett kuvert, och ingenting räknas eller
 * kontrolleras i urnan efter stängningen (spec 4.6, förbehåll 4). Kvar är
 * också att den som driver systemet kan ta bort ett äkta kuvert eller lägga
 * tillbaka ett tidigare, att den som granskar underskrifterna behöver pepparn,
 * som också öppnar namnen, och att attrappen i demon utfärdar certifikaten
 * själv. Spec 10 räknar dessutom upp insidern som både kan läsa databasen och
 * kommer åt en enhet. Allt det står här, inte bara på Tekniska detaljer.
 *
 * VALVET (uppgift 11g). Tre punkter säger vad valvet i Azure inte skyddar mot,
 * och varje mening är avgränsad till var den gäller. Den som får läsa valvet
 * får pepparn, och med den namnen i de liggande kuverten, och i en kopia från
 * före stängningen. Systemet har alla hemligheter i minnet medan det kör, och
 * båda urnornas nycklar: att urnorna har var sin nyckel skyddar mot att en av
 * dem läcker, inte mot den som tagit sig in i systemet eller driver det. Och
 * utanför Azure finns inget valv alls. Vad valvet innehåller och inte står på
 * Tekniska detaljer, under Hemligheterna i Azure, med markörer mot
 * Bicep-filerna.
 *
 * Där en punkt motsvarar en post i listan över kända begränsningar tar sidan
 * emot posten och länkar dit. Tas posten bort kastar uppslaget i page.tsx, och
 * testet går rött, så att punkten här inte står kvar när problemet är löst.
 * Rubrikerna ur listan visas inte här, eftersom de är skrivna med fackord.
 */
export function Weaknesses({
  copies,
  bankIdOrder,
  removal,
  pepperHolder,
  demoIssuer,
  dealer,
}: {
  /** link-exists-during-voting */
  copies: KnownLimitation
  /** bankid-order-carries-link */
  bankIdOrder: KnownLimitation
  /** operator-can-remove-or-restore-envelope */
  removal: KnownLimitation
  /** pepper-holder-reads-voter-names */
  pepperHolder: KnownLimitation
  /** mock-issues-certificates-in-demo */
  demoIssuer: KnownLimitation
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
          <strong>Den som driver systemet kan ta bort din röst eller lägga tillbaka en tidigare.</strong>{' '}
          Med riktigt BankID prövas varje underskrift mot BankID:s rotcertifikat, och vid
          stängningen flyttas bara de röster som prövats. Den som bara kan skriva direkt i
          röstlängden kan därför inte längre lägga in röster för någon som inte skrivit under. Den
          som kan skriva i urnan utan namn kan däremot än så länge byta ut ett kuvert, och ingenting
          kontrollerar urnan efter stängningen. Den som granskar kontrollen före stängningen kan pröva
          varje underskrift själv, men behöver då hemligheten ur valvet, som också visar namnen på dem
          som röstat. Däremot kan en äkta röst tas bort, och en tidigare röst som du verkligen skrev
          under kan läggas tillbaka i stället för din senaste. Enheten du röstade från märker det före
          stängningen: den säger då att rösten har ändrats, eller att ingen röst finns.{' '}
          <Link href={limitationHref(removal)}>Mer om underskriften</Link>
        </li>
        <li style={listItemStyle}>
          <strong>Den som kan läsa valvet.</strong> Hemligheten i valvet gör fingeravtryck av
          personnummer, och med dem och röstlängden går det att se om en viss person står i
          röstlängden och i vilken kommun hen är folkbokförd. Den låser också upp intygen i de yttre
          kuverten, alltså namn och personnummer för alla som har röstat, både i urnan medan
          röstningen pågår och i en kopia av urnan från före stängningen. Den som får läsa valvet
          behöver då bara komma åt urnan med namn, eller en kopia av den, för att få namnen.
          Uppsättningen i Azure slår i dag inte på någon logg över vem som läser valvet.{' '}
          <Link href={limitationHref(pepperHolder)}>Mer om hemligheten</Link>
        </li>
        <li style={listItemStyle}>
          <strong>Systemet har valvets alla hemligheter medan det körs.</strong> Systemet hämtar dem ur
          valvet när det startar och har dem sedan i minnet, också nycklarna till båda urnorna. Den
          som har tagit sig in i systemet kommer alltså åt det som valvet förvarar, och det gör också
          den som driver systemet i Azure. Att urnorna har var sin nyckel skyddar bara mot att en av
          nycklarna läcker. Starkare vore ett valv som gjorde fingeravtrycken själv, utan att lämna ut
          hemligheten. Det är inte byggt.{' '}
          <Link href="/architecture/technical#hemligheterna">Mer om valvet</Link>
        </li>
        <li style={listItemStyle}>
          <strong>Utanför molnet finns inget valv.</strong> När systemet körs på en vanlig dator, som
          under utvecklingen, står hemligheterna i en textfil bredvid programmet. Valvet finns bara
          när systemet körs i Azure.
        </li>
        <li style={listItemStyle}>
          <strong>I demon skriver systemet själv ut BankID-intygen.</strong> Här finns inget riktigt
          BankID, så demon utfärdar själv de intyg som underskrifterna prövas mot, och den som driver
          demon kan därför fortfarande förfalska en underskrift. Skyddet ovan gäller med riktigt
          BankID. Demon körs också i Azure, med hemligheterna i valvet. Men förtroendepersonernas
          lösenord för demovalet är kända, så där kan den som kommer åt databaserna öppna vilket
          kuvert som helst. <Link href={limitationHref(demoIssuer)}>Mer om demon</Link>
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
