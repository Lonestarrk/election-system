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
 * som en rad ovanför den publika PEM-nyckeln — se dess dokumentation. Byts
 * mocken mot skarpt BankID ersätts radläsningen här av en riktig avläsning av
 * certifikatets subject.
 */
const MOCK_CERTIFICATE_PREFIX = /^personnummer:(\d+)\n/

function certificateBelongsTo(certificate: string, expectedPersonalNumber: string): boolean {
  const match = MOCK_CERTIFICATE_PREFIX.exec(certificate)
  return match !== null && match[1] === expectedPersonalNumber
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
