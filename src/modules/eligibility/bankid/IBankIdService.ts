/**
 * Abstraktion över BankID-legitimering, enligt BankID API v6.
 *
 * Poängen med gränssnittet är att `MockBankIdService` ska kunna bytas mot en
 * riktig implementation utan att någon annan del av systemet ändras.
 * Signaturerna följer därför det skarpa API:ets form.
 *
 * DET FINNS INGET PERSONNUMMER I AUTH-ANROPET, OCH DET ÄR AVSIKTLIGT.
 *
 * BankID v6 (Secure Start) tillåter inte längre flöden där användaren skriver
 * in sitt personnummer. Legitimeringen startas i stället på ett av två sätt:
 *
 *   – ANNAN ENHET: en animerad QR-kod som väljaren skannar med sin BankID-app.
 *   – SAMMA ENHET: en autostart-token som öppnar BankID-appen lokalt.
 *
 * Skälet BankID anger är att en illasinnad app annars kan förmå någon att
 * signera något genom att mata in ett personnummer den fått tag på. Att koden
 * eller autostarten binder ordern till just den enhet som har appen stänger
 * det.
 *
 * FÖR DET HÄR SYSTEMET ÄR DET EN FÖRBÄTTRING, INTE BARA ETT KRAV.
 *
 * Den tidigare inmatningsrutan var ett uppslagsverk mot röstlängden i
 * förklädnad. Den svarade medvetet likadant oavsett om personnumret fanns i
 * röstlängden eller inte — men den tog ändå emot godtyckliga personnummer från
 * vem som helst. Nu kommer personnumret först i BankID:s eget svar, efter att
 * personen legitimerat sig på sin egen enhet med sin egen app. Systemet kan
 * inte längre tillfrågas om ett personnummer det inte redan fått.
 *
 * Observera också vad gränssnittet INTE exponerar: ingen metod tar emot eller
 * returnerar något som har med röstning att göra. Legitimering och röst möts
 * först vid utfärdandet av röstintyget.
 */

export type BankIdAuthOrder = {
  orderRef: string

  /**
   * Token som öppnar BankID-appen på samma enhet.
   *
   * Används i en URL enligt BankID:s specifikation:
   *   bankid:///?autostarttoken=<token>&redirect=null
   *
   * På iOS krävs universal link-varianten i stället:
   *   https://app.bankid.com/?autostarttoken=<token>&redirect=null
   *
   * `redirect=null` betyder att appen avslutas utan att öppna någon URL, så
   * att den anropande sidan hamnar i fokus igen. Ett värde där skulle skicka
   * väljaren vidare — och en URL som går att styra utifrån är en
   * omdirigeringssårbarhet i ett flöde som just legitimerat någon.
   */
  autoStartToken: string
}

export type BankIdCollectPending = {
  status: 'pending'
  /**
   * Meddelandenyckel enligt BankID:s meddelandekatalog.
   * outstandingTransaction | noClient | started | userSign | userMrtd
   */
  hintCode: string
}

export type BankIdCollectComplete = {
  status: 'complete'
  completionData: {
    /**
     * Personnummer, hämtat ur BankID:s svar.
     *
     * Detta är den ENDA vägen ett personnummer kommer in i systemet. Det
     * skrivs aldrig in av någon och kan inte gissas fram — det kommer från
     * BankID efter att personen bevisat vem hen är.
     *
     * Får aldrig lämna eligibility-modulen.
     */
    personalNumber: string
    name: string
    givenName: string
    surname: string

    /**
     * Signaturen över `userNonVisibleData`, satt endast av `sign`-ordrar.
     *
     * Det som gör en röst oförfalskbar: en verifierare kan bevisa att just den
     * här personen godkände just det signerade innehållet, utan att behöva
     * lita på vad servern påstår.
     */
    signature: string

    /**
     * Certifikatkedjan signaturen verifieras mot, i PEM: lövet först och sedan
     * de mellannivåer som utfärdat det, uppåt mot roten. Attrappen har en,
     * prövningen tar en till tre. Tom för `auth`-ordrar.
     *
     * ROTEN INGÅR INTE, OCH FÅR INTE GÖRA DET. Kedjan prövas mot rötter som är
     * konfigurerade (se `trusted-roots.ts`). En rot som följde med svaret vore
     * en rot som den som skrev svaret själv valt, och då vore prövningen
     * ingenting värd.
     *
     * I attrappen utfärdar attrappens mellannivå ett nytt löv vid varje
     * underskrift. I skarpt BankID ligger kedjan i XML-signaturens `KeyInfo`,
     * och att läsa ut den därifrån är inte byggt (se begränsningen
     * `bankid-xmldsig-adapter-missing` i src/lib/known-limitations.ts).
     *
     * BÄR SAMMA SKYDDSVÄRDA UPPGIFT SOM `personalNumber`, I KLARTEXT, OCH
     * DESSUTOM NAMNET.
     *
     * Lövets subject har personnumret som `serialNumber` och namnet som
     * `commonName`, `givenName` och `surname`, i attrappen som i ett riktigt
     * BankID-certifikat. Kedjan är med andra ord inte en ofarlig nyckel med ett
     * bevis bifogat; den ÄR personnumret och namnet, plus ett bevis.
     *
     * Får därför, precis som `personalNumber`, aldrig lämna eligibility-modulen
     * eller lagras i klartext. Rösten lagrar kedjan krypterad, se
     * `sealed-chain.ts`.
     */
    certificateChain: string[]

    /**
     * Det signerade innehållet, ordagrant — samma sträng som skickades in i
     * `userNonVisibleData` vid `sign`. Tomt för `auth`-ordrar, som inte
     * signerar något.
     *
     * SANNINGSKÄLLAN FÖR VAD SOM FAKTISKT SIGNERADES.
     *
     * Fixrunda 1 av uppgift 9:s granskning fångade att `/api/vote/encrypted`
     * byggde OM nyttolasten vid varje anrop (en färsk `nextCastSequence()`)
     * i stället för att verifiera mot det som faktiskt signerades. Effekten:
     * `castSequence` i den återuppbyggda nyttolasten kunde skilja sig från
     * den som väljarens BankID-app faktiskt skrev under — det vanliga fallet
     * är två flikar, där väljaren röstar klart i den ena medan den andra
     * fortfarande väntar på en signering som påbörjades tidigare. Symptomet
     * var ett missvisande `invalid_signature` i stället för `stale_sequence`,
     * och ingen test övade den riktiga vägen eftersom testhjälparna skickade
     * `castSequence` vid sidan av signaturen i stället för att läsa det ur
     * den.
     *
     * Det signerade innehållet finns redan hos BankID — det behöver aldrig
     * gissas eller räknas om. Attrappen har det i `order.userNonVisibleData`.
     *
     * BYTET TILL SKARPT BANKID: det signerade innehållet ligger inte som ett
     * eget fält i BankID:s svar, utan inuti XML-signaturen
     * (`ocspResponse`/`signature`, base64-kodad XML enligt BankID:s
     * signaturformat). Den som byter implementation måste packa upp XML:en
     * och läsa ut `userNonVisibleData` därifrån — det får INTE återskapas
     * genom att anta att det är samma sträng som servern skulle ha byggt,
     * det är precis den gissningen som orsakade fixrunda 1:s fynd.
     */
    signedData: string
  }
}

export type BankIdCollectFailed = {
  status: 'failed'
  /**
   * expiredTransaction | certificateErr | userCancel | cancelled | startFailed
   */
  hintCode: string
}

export type BankIdCollectResult =
  | BankIdCollectPending
  | BankIdCollectComplete
  | BankIdCollectFailed

export type BankIdAuthRequest = {
  /**
   * Väljarens IP-adress, som BankID:s `endUserIp`.
   *
   * BankID kräver den för sin egen riskbedömning. Systemet lagrar den inte och
   * loggar den inte — den passerar till BankID och kastas.
   */
  endUserIp: string

  /** Text som visas i BankID-appen. Ska säga vad personen legitimerar sig för. */
  userVisibleData?: string
}

/**
 * Den animerade QR-kodens aktuella data.
 *
 * Beräknas på servern varje gång den efterfrågas, eftersom den bygger på
 * `qrStartSecret` — som enligt BankID:s specifikation aldrig får lämna
 * servern. Klienten får bara den färdiga strängen, som är värdelös en sekund
 * senare.
 */
export type BankIdQrData = {
  /** bankid.<qrStartToken>.<sekunder>.<qrAuthCode> */
  qrData: string
  /** Sekunder sedan ordern startades. Hjälper klienten veta om den är aktuell. */
  elapsedSeconds: number
}

export type SignRequest = {
  /**
   * Väljarens IP-adress, som BankID:s `endUserIp`.
   *
   * BankID kräver den för sin egen riskbedömning. Systemet lagrar den inte och
   * loggar den inte — den passerar till BankID och kastas.
   */
  endUserIp: string

  /** Visas i appen. Det väljaren faktiskt godkänner. */
  userVisibleData: string

  /**
   * Signeras men visas inte. Här ligger chifferhashen, valsedelns id och
   * räknaren — sådant som måste vara bundet men som ingen människa kan granska
   * på en telefonskärm.
   */
  userNonVisibleData: string
}

export interface IBankIdService {
  /** Startar en legitimeringsorder. */
  auth(request: BankIdAuthRequest): Promise<BankIdAuthOrder>

  /**
   * BankID /sign. Används vid röstläggning, aldrig vid inloggning.
   *
   * Skillnaden mot auth är inte kosmetisk: en auth bevisar att någon var
   * närvarande, en sign bevisar att just den personen godkände just det här
   * innehållet. Det senare är vad som gör en röst oförfalskbar — även för den
   * som driver systemet.
   */
  sign(request: SignRequest): Promise<BankIdAuthOrder>

  /**
   * Den animerade QR-kodens data just nu.
   *
   * Returnerar null om ordern inte finns eller har gått ut. BankID:s
   * specifikation anger att koden ska uppdateras varje sekund.
   */
  qrData(orderRef: string): Promise<BankIdQrData | null>

  /** Frågar efter status för en pågående order. */
  collect(orderRef: string): Promise<BankIdCollectResult>

  /** Avbryter en pågående order. */
  cancel(orderRef: string): Promise<void>
}
