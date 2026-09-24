import { createVerify, type KeyObject } from 'node:crypto'

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
 * Verifierar ENBART att signaturen kryptografiskt håller ihop med nyckeln,
 * för exakt det innehåll som påstås signerat.
 *
 * KONTROLLERAR INTE VEM, OCH INTE ATT NYCKELN ÄR BANKID:S. Det är två andra
 * frågor, och de ställs var för sig. Nyckeln ska vara lövets, ur en kedja som
 * `verifyCertificateChain` i `certificate-chain.ts` just har prövat mot en
 * betrodd rot, och att lövet tillhör väljaren avgörs genom att hasha dess
 * personnummer och jämföra med röstlängdens identitetshash. En signatur som
 * den här funktionen godkänner bevisar bara att NÅGON med den privata nyckeln
 * godkände exakt `signedData`.
 *
 * Fram till uppgift 14f var det precis den luckan som fanns: nyckeln kom ur
 * raden själv, och den som kunde skriva i databasen lade in ett eget nyckelpar
 * som den här funktionen sedan godkände. Därför tar den emot en `KeyObject`,
 * som bara kedjeprövningen lämnar ut, och ingen text ur en rad.
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
  signingKey: KeyObject,
  signedData: string,
): boolean {
  const verifier = createVerify('sha256')
  verifier.update(signedData)
  verifier.end()

  try {
    return verifier.verify(signingKey, signature, 'base64')
  } catch {
    // En trasig nyckel eller signatur är inte ett undantag att bubbla upp —
    // det är ett underkänt kuvert.
    return false
  }
}
