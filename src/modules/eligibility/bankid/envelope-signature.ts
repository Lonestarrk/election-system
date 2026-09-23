import { createVerify } from 'node:crypto'

/**
 * Det som binder en signatur till en bestämd röst.
 *
 * Ligger i `userNonVisibleData` vid signeringen — se `SignRequest` i
 * `IBankIdService.ts` för varför just de här fälten och ingen mänsklig
 * granskning av dem.
 */
export type EnvelopePayload = {
  electionId: string
  ballotId: string
  ciphertextHash: string

  /**
   * Räknaren för väljarens senaste giltiga kuvert.
   *
   * Ligger INUTI det signerade, inte bredvid. Ett kuvert som fångas upp och
   * skickas in igen efter att väljaren ändrat sig bär den gamla, lägre
   * räknaren — och en signatur över den gamla räknaren kan inte göras om till
   * en signatur över den nya. Låg räknaren i stället bredvid signaturen kunde
   * den bytas ut fritt, och hela ändringsmöjligheten vore ett röstköp som
   * överlever den.
   */
  castSequence: number
}

/**
 * Den kanoniska sträng som signeras.
 *
 * Längdprefix på varje fält, inte bara avgränsare. Med enbart ett
 * skiljetecken kan två olika uppsättningar fält ge samma sträng — till
 * exempel "vs-12" + "abc" och "vs-1" + "2abc" — och då går en signatur att
 * flytta mellan valsedlar utan att något ser fel ut.
 */
export function envelopePayload(payload: EnvelopePayload): string {
  const parts = [
    'valsystem/kuvert/v1',
    payload.electionId,
    payload.ballotId,
    payload.ciphertextHash,
    String(payload.castSequence),
  ]

  return parts.map((part) => `${part.length}:${part}`).join('')
}

/**
 * Den omvända operationen till `envelopePayload` — läser tillbaka fälten ur
 * en signerad sträng.
 *
 * VARFÖR DEN HÄR FUNKTIONEN BEHÖVS (fixrunda 1 av uppgift 9:s granskning).
 *
 * `castSequence` fick tidigare räknas fram på nytt vid varje verifiering, i
 * stället för att läsas ur det som faktiskt signerades — och en färsk
 * uträkning kan skilja sig från den väljarens BankID-app en gång skrev
 * under (det vanliga fallet: väljaren har en signering stående i en flik
 * medan hon röstar klart i en annan). Talet som ska prövas mot
 * dubbelröstningsspärren är det signerade, och det finns redan i
 * `signedData` — det ska läsas ut, aldrig gissas eller räknas om.
 *
 * LÄNGDPREFIXEN GÖR AVKODNINGEN ENTYDIG.
 *
 * Varje fälts längd står skriven direkt före fältet, så det finns aldrig
 * något att gissa om var ett fält slutar och nästa börjar — till skillnad
 * från ett format med bara avgränsare, där ett fält som råkar innehålla
 * avgränsaren skulle klippa fel.
 *
 * Returnerar null för allt som inte är välformat: fel antal fält, en
 * längdangivelse som inte är siffror, en längd som inte stämmer med vad som
 * faktiskt finns kvar av strängen, eller data som blir över efter sista
 * fältet. Anroparen ska då avvisa kuvertet — aldrig anta något om
 * innehållet i en trasig nyttolast.
 */
export function parseEnvelopePayload(payload: string): EnvelopePayload | null {
  const fields: string[] = []
  let rest = payload

  for (let i = 0; i < 5; i += 1) {
    const separator = rest.indexOf(':')
    if (separator === -1) return null

    const lengthText = rest.slice(0, separator)
    if (!/^\d+$/.test(lengthText)) return null

    const length = Number(lengthText)
    const content = rest.slice(separator + 1, separator + 1 + length)
    if (content.length !== length) return null

    fields.push(content)
    rest = rest.slice(separator + 1 + length)
  }

  if (rest.length !== 0) return null

  const [magic, electionId, ballotId, ciphertextHash, castSequenceText] = fields as [
    string,
    string,
    string,
    string,
    string,
  ]

  if (magic !== 'valsystem/kuvert/v1') return null
  if (!/^\d+$/.test(castSequenceText)) return null

  return { electionId, ballotId, ciphertextHash, castSequence: Number(castSequenceText) }
}

/**
 * Kontrollerar att certifikatet påstås tillhöra rätt person.
 *
 * Ett riktigt BankID-certifikat är utfärdat av BankIDs CA och bär
 * personnumret i sitt subject-fält — ett påstående från utfärdaren, inte
 * något väljaren själv skriver under med sin signatur. Utan den här
 * kontrollen bevisar en giltig signatur bara att NÅGON godkänt innehållet,
 * inte VEM — och en väljare som fångat en annan väljares certifikat (eller
 * bara läst av det, det är en publik nyckel) skulle kunna lägga dennes röst i
 * eget namn så länge chifferhashen råkar stämma.
 *
 * `MockBankIdService` simulerar CA-påståendet genom att skriva personnumret
 * som en rad ovanför den publika PEM-nyckeln — se dess dokumentation.
 *
 * BYTET TILL SKARPT BANKID ÄR TVÅ STEG, INTE ETT.
 *
 * (a) Läs personnumret ur certifikatets subject-fält i stället för
 *     radprefixet — det är den lätta delen, en annan avläsning av samma
 *     sorts påstående.
 *
 * (b) VALIDERA CERTIFIKATETS KEDJA MOT BANKIDS CA. Det är inte valfritt.
 *     `verifySignedPayload` nedan gör bara `crypto.verify(certificate,
 *     …)` — och Node/OpenSSLs PEM-parser kontrollerar ingen utfärdarkedja,
 *     den extraherar bara nyckelmaterial ur vilken PEM-text som helst mellan
 *     `-----BEGIN` och `-----END`. Utan kedjevalidering kan vem som helst
 *     skapa ett eget nyckelpar, skriva in vilket personnummer som helst i
 *     subject-fältet och signera med sin egen privata nyckel — och den här
 *     kontrollen skulle säga ja, eftersom den bara läser vad certifikatet
 *     PÅSTÅR, inte om påståendet är styrkt av en betrodd utfärdare. Det är
 *     precis den bindning en CA-signatur ger och ett självutfärdat
 *     certifikat inte kan ge.
 *
 * Attrappen behöver inte (b) eftersom dess "certifikat" aldrig påstår sig
 * vara utfärdat av någon — det är bara en nyckel med ett radprefix som
 * testerna känner igen. Men den dagen `certificate` kommer från ett riktigt
 * BankID-svar måste kedjevalideringen in HÄR, före signaturkontrollen,
 * annars är hela funktionen en attackyta i stället för ett skydd.
 */
const MOCK_CERTIFICATE_PREFIX = /^personnummer:(\d+)\n/

/**
 * Personnumret som certifikatet påstår, i siffror.
 *
 * Skilt från signaturkontrollen med flit. Anroparen ska hasha värdet och
 * jämföra mot röstlängdens identitetshash — hashningen är asynkron och hör
 * hemma i behörighetsmodulen, inte här.
 *
 * Returnerar null när certifikatet inte bär något personnummer i det format vi
 * känner igen. Anroparen ska då avvisa, aldrig anta.
 */
export function personalNumberFromCertificate(certificate: string): string | null {
  const match = MOCK_CERTIFICATE_PREFIX.exec(certificate)
  return match ? match[1] : null
}

/**
 * Nyckelmaterialet ur certifikatet, utan det som identifierar personen.
 *
 * Certifikatet bär personnumret i klartext. Det som ska lagras och senare
 * verifieras mot är nyckeln, inte påståendet om vem den tillhör — den
 * kopplingen avgörs när rösten läggs och bärs därefter av radens koppling
 * till väljaren, inte av en klartextuppgift i en kolumn.
 *
 * Attrappens format har personnumret på en rad före PEM-blocket. Ett riktigt
 * X.509-certifikat har det i subject-fältet och saknar prefixet helt, så där
 * returneras certifikatet oförändrat — nyckeln extraheras då av crypto vid
 * verifieringen.
 *
 * Ligger bredvid personalNumberFromCertificate med flit: två funktioner som
 * tolkar samma format på var sitt håll skulle kunna glida isär, och symptomet
 * vore signaturer som verifierar mot fel nyckel.
 */
export function publicKeyFromCertificate(certificate: string): string {
  return certificate.replace(MOCK_CERTIFICATE_PREFIX, '')
}

/**
 * Påstår certifikatet att det tillhör exakt det här personnumret?
 *
 * RENT ETT PÅSTÅENDE — INGEN KRYPTOGRAFI HÄR. Funktionen kontrollerar bara
 * vad certifikatet SÄGER, inte om påståendet är styrkt (det görs, i skarpt
 * BankID, av kedjevalideringen mot BankIDs CA — se
 * `personalNumberFromCertificate`) och inte om NÅGON SIGNERAT NÅGOT
 * ÖVERHUVUDTAGET med det (det gör `verifySignedPayload`).
 *
 * EXPORTERAD MED FLIT, SEPARAT FRÅN SIGNATURKONTROLLEN (fixrunda 1 av
 * uppgift 9:s granskning, fynd 2).
 *
 * Ett tidigare anropsställe jämförde ett certifikat mot SIG SJÄLVT —
 * `certificateBelongsTo(certificate, personalNumberFromCertificate(certificate))`
 * i praktiken — vilket alltid är sant och gjorde identitetskontrollen till
 * ett no-op maskerat som en riktig kontroll. Genom att den här funktionen
 * tar emot ett `expectedPersonalNumber` utifrån (typiskt röstlängdens
 * identitetshash, avhashat till ett jämförbart klartextvärde av anroparen —
 * se `pending-vote.service.ts`) i stället för att härledas ur samma
 * certifikat, blir det tautologiska anropet en typfelsfri omöjlighet att
 * återupprepa av misstag.
 */
export function certificateBelongsTo(certificate: string, expectedPersonalNumber: string): boolean {
  return personalNumberFromCertificate(certificate) === expectedPersonalNumber
}

/**
 * Verifierar ENBART att signaturen kryptografiskt håller ihop med
 * certifikatet, för exakt det innehåll som påstås signerat.
 *
 * KONTROLLERAR INTE VEM. Det är en annan fråga och ett separat ansvar — se
 * `certificateBelongsTo`. En signatur som denna funktion godkänner bevisar
 * att NÅGON med den privata nyckeln till just det certifikatet godkände
 * exakt `signedData`; den bevisar ingenting om vem den personen är. Att slå
 * ihop de två frågorna i en enda funktion var precis vad som gjorde
 * `verifyEnvelopeSignature` (den tidigare, nu borttagna funktionen) sårbar
 * för att anropas tautologiskt — se `certificateBelongsTo` för hela
 * resonemanget.
 *
 * `signedData` ska vara det FAKTISKT signerade innehållet, hämtat ordagrant
 * ur BankID:s eget svar (`completionData.signedData`) — aldrig återskapat
 * genom att bygga en ny `envelopePayload`. Anroparen läser ut de enskilda
 * fälten (bland dem `castSequence`) ur `signedData` med
 * `parseEnvelopePayload`. Ordningen mellan avkodningen och det här anropet
 * spelar ingen roll för säkerheten — `signedData` kommer aldrig från
 * begärans kropp, bara från BankID:s eget svar — men
 * `pending-vote.service.ts` avkodar och stämmer av innehållet FÖRST, som en
 * billig kontroll innan den dyrare kryptografiska verifieringen görs.
 */
export function verifySignedPayload(
  signature: string,
  certificate: string,
  signedData: string,
): boolean {
  const verifier = createVerify('sha256')
  verifier.update(signedData)
  verifier.end()

  try {
    return verifier.verify(certificate, signature, 'base64')
  } catch {
    // En trasig nyckel eller signatur är inte ett undantag att bubbla upp —
    // det är ett underkänt kuvert.
    return false
  }
}
