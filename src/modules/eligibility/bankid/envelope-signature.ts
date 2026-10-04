import { createHash, createVerify, randomBytes, type KeyObject } from 'node:crypto'

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

  /**
   * Åtagandet över chifferhashen, se `ciphertextCommitment`. INTE
   * chifferhashen själv (uppgift 11e).
   *
   * BankID sparar det väljaren skriver under, med hennes identitet, bland annat
   * för tvister. Bar det signerade chifferhashen fanns kopplingen mellan
   * väljaren och chiffret kvar hos BankID efter att den raderats här, eftersom
   * hashen står i urnan och pekar ut chiffret. Åtagandet går bara att räkna med
   * saltet, som finns i `PendingVote` och raderas med raden vid skalningen.
   */
  ciphertextCommitment: string

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

/** Formatets namn, först i det signerade. v1 bar chifferhashen, v2 bär åtagandet. */
const ENVELOPE_FORMAT = 'valsystem/kuvert/v2'
const LEGACY_ENVELOPE_FORMAT = 'valsystem/kuvert/v1'

/** Domänen för åtagandet, så att samma indata aldrig kan vara en hash i ett annat sammanhang. */
const COMMITMENT_DOMAIN = 'valsystem/bankid-atagande/v1'

/** 32 byte som 64 gemena hextecken, så som chifferhashen och saltet lagras. */
const HEX_32_BYTES = /^[0-9a-f]{64}$/

/**
 * ÅTAGANDET ÖVER CHIFFERHASHEN (uppgift 11e).
 *
 *   SHA-256( UTF-8("valsystem/bankid-atagande/v1") ‖ 0x00 ‖ H ‖ S )
 *
 * där H är chifferhashens 32 byte och S saltets 32 byte, båda avkodade ur 64
 * gemena hextecken. Svaret är 64 gemena hextecken.
 *
 * KODNINGEN ÄR ENTYDIG. Domänen är fast och följs av 0x00, och H och S har fast
 * längd, så två olika par kan inte ge samma indata. Längdprefix behövs därför
 * inte, till skillnad från i nyttolasten, där fälten har olika längd.
 *
 * SALTET GÖR ÅTAGANDET OMÖJLIGT ATT MATCHA UTAN RADEN. Chifferhashen står i
 * urnan efter stängningen. Utan salt hade den som har BankID:s kopia kunnat
 * räkna åtagandet för varje hash i urnan och hitta väljarens. Med 32 slumpbyte
 * går det inte att pröva sig fram, och saltet raderas med raden.
 *
 * Returnerar null för en hash eller ett salt som inte är 64 gemena hextecken,
 * och kastar aldrig: valideringen läser båda ur databasen, förbi varje schema,
 * och en trasig rad ska bli en avvikelse och inte en krasch.
 */
export function ciphertextCommitment(ciphertextHash: string, salt: string): string | null {
  if (!HEX_32_BYTES.test(ciphertextHash) || !HEX_32_BYTES.test(salt)) return null

  return createHash('sha256')
    .update(Buffer.from(COMMITMENT_DOMAIN, 'utf8'))
    .update(Buffer.from([0]))
    .update(Buffer.from(ciphertextHash, 'hex'))
    .update(Buffer.from(salt, 'hex'))
    .digest('hex')
}

/**
 * Ett nytt salt: 32 byte ur `crypto.randomBytes`, som 64 gemena hextecken.
 *
 * Skapas i /api/vote/sign-start, hålls med ordern i orderlagret och sparas i
 * `PendingVote` när rösten läggs. Det går aldrig till klienten eller till
 * BankID, loggas aldrig och följer aldrig med till votes_db.
 */
export function newCommitmentSalt(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Texten väljaren ser i BankID-appen innan hon skriver sin kod.
 *
 * Den säger vad som skrivs under, och ingenting som pekar ut rösten: varken
 * chifferhashen eller åtagandet, eftersom BankID sparar också den här texten.
 * En partivalsedel namnges efter sitt slag och inte efter sin etikett, som för en
 * kommun- eller regionvalsedel namnger området. Undantaget är en fråga (FRAGA),
 * som namnges efter sin etikett, eftersom etiketten är frågan och inte ett område. Det tar inte bort något BankID
 * kan veta: valsedelns id står i det signerade, och vilken valsedel det är går
 * att slå upp i det publicerade resultatet. Texten ska bara inte säga mer än
 * väljaren behöver läsa.
 */
export function signingText(electionName: string, ballotKind: string, ballotLabel?: string): string {
  // En fråga namnges efter sin text. Frågan är offentlig och säger inget om svaret, och utan den
  // går det inte att se vilken av en omröstnings frågor man skriver under.
  if (ballotKind === 'FRAGA') {
    return (
      `Jag svarar på frågan "${ballotLabel ?? ''}" i ${electionName}. ` +
      'Svaret är krypterat. Det jag skriver under är ett åtagande om det, och det visar inte vad ' +
      'jag har svarat. Jag kan ändra svaret fram till att röstningen stänger.'
    )
  }

  const ballot = BALLOT_KIND_TEXT[ballotKind] ?? 'omröstningen'
  return (
    `Jag lägger min röst i ${electionName}, ${ballot}. ` +
    'Rösten är krypterad. Det jag skriver under är ett åtagande om den, och det visar inte vad ' +
    'jag har röstat på. Jag kan ändra rösten fram till att röstningen stänger.'
  )
}

const BALLOT_KIND_TEXT: Record<string, string> = {
  RIKSDAG: 'valet till riksdagen',
  LANDSTING: 'valet till regionfullmäktige',
  KOMMUN: 'valet till kommunfullmäktige',
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
  return encodeFields([
    ENVELOPE_FORMAT,
    payload.electionId,
    payload.ballotId,
    payload.ciphertextCommitment,
    String(payload.castSequence),
  ])
}

/**
 * DET GAMLA FORMATET, MED CHIFFERHASHEN I DET SIGNERADE.
 *
 * Kuvert som lades före uppgift 11e är underskrivna över den här strängen.
 * Läggningen tar aldrig emot den, eftersom `parseEnvelopePayload` bara läser
 * det nya formatet. Funktionen finns för valideringen före stängningen, som
 * känner igen ett äkta kuvert i det gamla formatet och skiljer det från en
 * förfalskning, se `OLD_SIGNATURE_FORMAT` i validate-before-close.usecase.ts.
 */
export function legacyEnvelopePayload(payload: {
  electionId: string
  ballotId: string
  ciphertextHash: string
  castSequence: number
}): string {
  return encodeFields([
    LEGACY_ENVELOPE_FORMAT,
    payload.electionId,
    payload.ballotId,
    payload.ciphertextHash,
    String(payload.castSequence),
  ])
}

function encodeFields(parts: string[]): string {
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
 * faktiskt finns kvar av strängen, data som blir över efter sista fältet,
 * eller det gamla formatet med chifferhashen. Anroparen ska då avvisa
 * kuvertet — aldrig anta något om innehållet i en trasig nyttolast.
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

  const [magic, electionId, ballotId, ciphertextCommitment, castSequenceText] = fields as [
    string,
    string,
    string,
    string,
    string,
  ]

  if (magic !== ENVELOPE_FORMAT) return null
  if (!/^\d+$/.test(castSequenceText)) return null

  return { electionId, ballotId, ciphertextCommitment, castSequence: Number(castSequenceText) }
}

/**
 * DET GAMLA FORMATETS KONTROLL, FRÅN FÖRE UPPGIFT 17b.
 *
 * Attrappens underskrift var då en RSA-signatur direkt över det signerade. Sedan
 * uppgift 17b är underskriften BankID:s XML-dokument, och den prövas av
 * `verifyBankIdSignature` i ./xmldsig.ts. Funktionen här används bara av
 * valideringen före stängningen, för att skilja ett äkta gammalt kuvert från en
 * förfalskning, se `OLD_BANKID_FORMAT` i validate-before-close.usecase.ts.
 *
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
 * `signedData` är det som en gång signerades. Det gamla formatet bar det inte,
 * så valideringen bygger om det ur radens kolumner, som är entydiga kodningar.
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
