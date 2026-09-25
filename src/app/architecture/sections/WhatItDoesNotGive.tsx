import { LimitationReference, listItemStyle, type PageLimitations } from './shared'

/**
 * Vad konstruktionen inte ger, inte ens när allt är byggt (spec 3.1, 4.6 och
 * 10). Där en punkt finns i listan över kända begränsningar hänvisar den dit
 * med listans egen rubrik.
 */
export function WhatItDoesNotGive({ limitations }: { limitations: PageLimitations }) {
  const { link, bankIdOrder, removal, swapCiphertext, dealer } = limitations

  return (
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
          <strong>Kopplingen lämnar systemet via BankID.</strong> Det väljaren signerar
          innehåller chifferhashen, och samma order bär hennes identitet. Med skarp BankID finns
          kopplingen kvar hos BankID efter raderingen här. <LimitationReference entry={bankIdOrder} />
        </li>
        <li style={listItemStyle}>
          <strong>Signaturen hindrar inte att äkta kuvert tas bort eller läggs tillbaka.</strong>{' '}
          Med riktig BankID prövas varje signatur mot BankID:s rotcertifikat och varje certifikat
          mot väljarens identitetshash, och stängningen flyttar exakt de kuvert som prövats, så den
          som kan skriva i röstlängden, voters_db, kan inte lägga in en röst för någon som inte
          skrivit under. Det gäller inte röstdatabasen, votes_db, där den som kan skriva än så länge
          kan byta ut ett chiffer efter stängningen (spec 4.6, förbehåll 4); det ska uppgift 12b
          stänga. Ett byte före infogningen räknas inte. En rad som redan ligger på ett äkta kuverts
          plats ersätts med det validerade kuvertet, och stängningen larmar. En rad som skrivs medan
          stängningen pågår stoppar den, och omkörningen ersätter raden.{' '}
          <LimitationReference entry={swapCiphertext} /> En
          granskare med åtkomst under valideringen kan pröva varje underskrift mot roten, men bara
          med pepparn, som i Azure ligger i valvet:
          kedjorna är krypterade med en nyckel ur den, och samma hemlighet öppnar namnen och
          personnumren i dem. Däremot kan ett kuvert raderas, och ett äldre äkta kuvert kan läggas
          tillbaka med sin räknare, eftersom räknaren lagras i samma databas. Väljaren ser det på sin
          enhet före stängningen. <LimitationReference entry={removal} />
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
          <strong>Tvång vid själva slutet är fortfarande möjligt.</strong> Den som ser dig lägga
          rösten strax före stängningen vet att den gäller. Skärmen hjälper honom inte, men att
          se läggningen räcker. Estland låter en pappersröst upphäva den digitala. Det ingår inte
          här.
        </li>
        <li style={listItemStyle}>
          <strong>En insider med en enhets sparade chifferhash.</strong> Den som har läsrätt i
          votes_db och dessutom kommer åt väljarens enhet innan den raderat sina uppgifter kan se
          om den enhetens röst var den som räknades, men inte vad den innehöll.
        </li>
        <li style={listItemStyle}>
          <strong>Allmänheten kan inte räkna om summan röst för röst.</strong> Att summan består
          av exakt de giltiga rösterna vilar på valideringen och slutkontrollen, inte på något en
          utomstående kan räkna om.
        </li>
      </ul>
    </section>
  )
}
