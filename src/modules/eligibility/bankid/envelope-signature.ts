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
 *     `verifyEnvelopeSignature` nedan gör bara `crypto.verify(certificate,
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
 * Skilt från verifyEnvelopeSignature med flit. Anroparen ska hasha värdet och
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

function certificateBelongsTo(certificate: string, expectedPersonalNumber: string): boolean {
  return personalNumberFromCertificate(certificate) === expectedPersonalNumber
}

/**
 * Verifierar att RÄTT PERSON signerat RÄTT INNEHÅLL.
 *
 * Båda halvorna behövs. En giltig signatur över rätt innehåll från fel person
 * är en röst lagd i någon annans namn. En giltig signatur från rätt person
 * över fel innehåll är en återuppspelad eller flyttad röst.
 */
export function verifyEnvelopeSignature(
  signature: string,
  certificate: string,
  expectedPayload: EnvelopePayload,
  expectedPersonalNumber: string,
): boolean {
  if (!certificateBelongsTo(certificate, expectedPersonalNumber)) return false

  const verifier = createVerify('sha256')
  verifier.update(envelopePayload(expectedPayload))
  verifier.end()

  try {
    return verifier.verify(certificate, signature, 'base64')
  } catch {
    // En trasig nyckel eller signatur är inte ett undantag att bubbla upp —
    // det är ett underkänt kuvert.
    return false
  }
}
