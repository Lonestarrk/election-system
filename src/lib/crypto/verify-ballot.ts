import { isInSubgroup, parseElement, parseScalar } from './group'
import { multiply, type Ciphertext } from './elgamal'
import { verifySumIsOne, verifyZeroOrOne, type EqualityProof, type ZeroOrOneProof } from './proofs'
import { sha256Hex } from './sha256'

/**
 * Bevisen på trådformat.
 *
 * ZeroOrOneProof/EqualityProof i proofs.ts bär bigint — praktiskt att räkna
 * med, men JSON.stringify kastar på ett bigint-fält. Precis som chiffret
 * serialiseras därför varje bevisfält till en sträng innan valsedeln lämnar
 * klienten.
 */
export type SerialisedZeroOrOneProof = {
  a0: string
  b0: string
  a1: string
  b1: string
  challenge0: string
  challenge1: string
  response0: string
  response1: string
}

export type SerialisedEqualityProof = { a: string; b: string; challenge: string; response: string }

export type EncryptedBallot = {
  ciphertext: Array<{ c1: string; c2: string }>
  proofs: { components: SerialisedZeroOrOneProof[]; sum: SerialisedEqualityProof }
  ciphertextHash: string
}

export function serialiseZeroOrOneProof(proof: ZeroOrOneProof): SerialisedZeroOrOneProof {
  return {
    a0: proof.a0.toString(),
    b0: proof.b0.toString(),
    a1: proof.a1.toString(),
    b1: proof.b1.toString(),
    challenge0: proof.challenge0.toString(),
    challenge1: proof.challenge1.toString(),
    response0: proof.response0.toString(),
    response1: proof.response1.toString(),
  }
}

/**
 * Ett objekt med fält. En rad ur databasen har inte passerat något schema och
 * kan vara vad som helst.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Alla fält, eller null om ett enda av dem inte gick att tolka. */
function everyField<T extends Record<string, bigint | null>>(
  fields: T,
): { [K in keyof T]: bigint } | null {
  for (const value of Object.values(fields)) {
    if (value === null) return null
  }
  return fields as { [K in keyof T]: bigint }
}

/**
 * STRIKT TOLKNING AV ETT BEVIS. VARJE VÄG TILL VERIFIERINGEN GÅR HÄR IGENOM.
 *
 * Åtagandena är tal i [1, p), utmaningarna och svaren exponenter i [0, q), och
 * varje tal är kanoniskt skrivet, med högst 617 siffror (se parseScalar i
 * group.ts). Förut gjordes bara `BigInt()`. En negativ utmaning gick då rakt
 * in i beviset, och en förfalskad valsedel med +1000 för ett parti och −999
 * för blankt godkändes när den lästes ur databasen (granskningen av uppgift
 * 14b, KRITISKT 1). Trådschemat stoppade minustecknet, men valideringen före
 * stängningen och omverifieringen i skalningen går förbi schemat. Här går de
 * inte förbi, och inte heller kod som skrivs senare, som räkningen i uppgift
 * 12 och slutkontrollen i uppgift 12b, så länge den verifierar härigenom.
 *
 * Null betyder att beviset inte går att tolka, och valsedeln underkänns.
 */
function parseZeroOrOneProof(proof: unknown): ZeroOrOneProof | null {
  if (!isRecord(proof)) return null
  return everyField({
    a0: parseElement(proof.a0),
    b0: parseElement(proof.b0),
    a1: parseElement(proof.a1),
    b1: parseElement(proof.b1),
    challenge0: parseScalar(proof.challenge0),
    challenge1: parseScalar(proof.challenge1),
    response0: parseScalar(proof.response0),
    response1: parseScalar(proof.response1),
  })
}

export function serialiseEqualityProof(proof: EqualityProof): SerialisedEqualityProof {
  return {
    a: proof.a.toString(),
    b: proof.b.toString(),
    challenge: proof.challenge.toString(),
    response: proof.response.toString(),
  }
}

/** Samma strikta tolkning för summabeviset. */
function parseEqualityProof(proof: unknown): EqualityProof | null {
  if (!isRecord(proof)) return null
  return everyField({
    a: parseElement(proof.a),
    b: parseElement(proof.b),
    challenge: parseScalar(proof.challenge),
    response: parseScalar(proof.response),
  })
}

type ParsedBallot = { ciphertexts: Ciphertext[]; components: ZeroOrOneProof[]; sum: EqualityProof }

/**
 * Hela valsedeln, tolkad innan något räknas med den.
 *
 * Formen prövas också. En rad ur databasen kan ha `null` där chiffret ska stå
 * och en sträng där bevisen ska stå. Förut kastade det inne i verifieringen,
 * och anroparna fick fånga det. Nu underkänns valsedeln, precis som en
 * valsedel vars bevis inte håller.
 */
function parseBallot(ballot: unknown, expectedLength: number): ParsedBallot | null {
  if (!isRecord(ballot) || !isRecord(ballot.proofs)) return null

  const { ciphertext } = ballot
  const { components, sum } = ballot.proofs
  if (!Array.isArray(ciphertext) || !Array.isArray(components)) return null
  if (ciphertext.length !== expectedLength || components.length !== expectedLength) return null

  const ciphertexts: Ciphertext[] = []
  for (const pair of ciphertext) {
    const parsed = isRecord(pair)
      ? everyField({ c1: parseElement(pair.c1), c2: parseElement(pair.c2) })
      : null
    if (!parsed) return null
    ciphertexts.push(parsed)
  }

  const proofs: ZeroOrOneProof[] = []
  for (const component of components) {
    const parsed = parseZeroOrOneProof(component)
    if (!parsed) return null
    proofs.push(parsed)
  }

  const parsedSum = parseEqualityProof(sum)
  if (!parsedSum) return null

  return { ciphertexts, components: proofs, sum: parsedSum }
}

/**
 * Kanonisk hash over chifferlistan.
 *
 * Bor har och inte i klientmodulen, eftersom BADE bevisaren och verifieraren
 * måste rakna fram exakt samma värde. Tva implementationer som glider isar ger
 * ett fel som ser ut som en manipulerad rost.
 *
 * Av samma skäl är hashen `sha256Hex`, som också finns i webbläsaren, och inte
 * Nodes `createHash`. Indatan är oförändrad, och därmed hashen. Se ./sha256.ts.
 */
export function hashCiphertext(ciphertext: Array<{ c1: string; c2: string }>): string {
  const parts = ['valsystem/chiffer/v1']
  for (const pair of ciphertext) {
    parts.push('\u0000', pair.c1, '\u0000', pair.c2)
  }
  return sha256Hex(parts.join(''))
}

/** Kontexten som binder ett bevis till sin plats. Måste vara identisk hos bevisaren. */
export function proofContext(electionId: string, ballotId: string, index: number): string {
  return `${electionId}|${ballotId}|${index}`
}

/**
 * Verifierar en inkommen valsedel fullständigt, ett steg i taget.
 *
 * Ordningen är vald: billiga kontroller först, så att skräp avvisas innan vi
 * betalar för hundra modexp.
 *
 * EN IMPLEMENTATION, TVÅ SÄTT ATT KÖRA DEN, som krypteringen i
 * src/lib/encrypt-client.ts. Generatorn lämnar ifrån sig efter varje
 * alternativs undergruppskontroll och efter varje alternativs bevis. Mellan
 * stegen kan den som kör den släppa fram annat arbete, och det är hela
 * skillnaden: kontrollerna, deras ordning och svaret är desamma.
 * `verifyEncryptedBallot` kör alla steg i ett svep. Servern kör dem genom
 * `verifyEncryptedBallotInSteps`, via src/lib/crypto/server.ts, så att
 * händelseslingan inte står still medan en valsedel prövas.
 */
function* ballotVerification(
  publicKey: string,
  electionId: string,
  ballotId: string,
  expectedLength: number,
  ballot: EncryptedBallot,
): Generator<void, boolean, void> {
  /**
   * VALETS NYCKEL ÄR SERVERNS EGEN, OCH EN TRASIG NYCKEL KASTAR.
   *
   * Nyckeln kommer ur valets rad och inte från väljaren. Går den inte att
   * tolka kan ingen valsedel prövas, och felet ligger hos servern, inte hos
   * valsedeln. Allt nedan kommer utifrån, och det underkänns i stället.
   */
  const key = parseElement(publicKey)
  if (key === null) throw new Error('Valets publika nyckel är inte ett tal i [1, p).')

  /**
   * HELA VALSEDELN TOLKAS FÖRST, INNAN NÅGOT RÄKNAS MED DEN.
   *
   * Billigast först, och det är också vad som gör tidsgränsen för ett steg
   * sann. Ett tal utanför sitt intervall, eller längre än 617 siffror,
   * underkänns här utan en enda exponentiering. Förut kunde ett svar förlängt
   * med k·q låsa händelseslingan i sekunder i ett enda steg.
   */
  const parsed = parseBallot(ballot, expectedLength)
  if (!parsed) return false

  /**
   * HASHEN MASTE RAKNAS OM, INTE TAS PA ORD.
   *
   * Klienten skickar bade chiffret och dess hash. Godtar vi hashen som den ar
   * kan en klient skicka en hash som inte hor till chiffret — och eftersom
   * signaturen i uppgift 8 binder just den påstådda hashen skulle aven den
   * verifiera.
   *
   * Foljden vore tyst och sen: väljarens inklusionskontroll letar efter en hash
   * som inte finns i den publicerade mangden, och Merkleroten over kuverten
   * beraknas over värden utan motsvarande chiffer. Felet syns forst efter att
   * kopplingen raderats, alltså nar ingen langre kan fraga väljaren.
   */
  if (ballot.ciphertextHash !== hashCiphertext(ballot.ciphertext)) return false

  for (const { c1, c2 } of parsed.ciphertexts) {
    // REVIEW FOCUS 1. Ett element utanför undergruppen läcker en bit av
    // tröskelnyckeln vid varje partiell dekryptering. Varje element prövas
    // innan något bevis räknas med det, också när stegen körs ett i taget.
    if (!isInSubgroup(c1) || !isInSubgroup(c2)) return false
    yield
  }

  for (const [index, ciphertext] of parsed.ciphertexts.entries()) {
    const proof = parsed.components[index]!
    if (!verifyZeroOrOne(key, ciphertext, proof, proofContext(electionId, ballotId, index))) {
      return false
    }
    yield
  }

  const product = parsed.ciphertexts.reduce((a, b) => multiply(a, b))

  return verifySumIsOne(key, product, parsed.sum, proofContext(electionId, ballotId, -1))
}

/** Alla steg i ett svep, för testerna och för den som inte har någon händelseslinga att hålla fri. */
export function verifyEncryptedBallot(
  publicKey: string,
  electionId: string,
  ballotId: string,
  expectedLength: number,
  ballot: EncryptedBallot,
): boolean {
  const steps = ballotVerification(publicKey, electionId, ballotId, expectedLength, ballot)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
  }
}

/**
 * Samma verifiering, med `pause` mellan stegen.
 *
 * Ett steg är ett alternativs undergruppskontroll, två exponentieringar, eller
 * ett alternativs bevis, åtta. Pausen avgör vad som får köra däremellan. På
 * servern är det `setImmediate`, som släpper fram väntande I/O, alltså andra
 * besökares begäranden. Ett tal som inte går att tolka underkänner
 * valsedeln, som ett bevis som inte håller. Kastar ett steg ändå, till exempel
 * på en trasig nyckel eller när `pause` avbryter, blir det ett avvisat löfte,
 * precis som den synkrona varianten kastar.
 */
export async function verifyEncryptedBallotInSteps(
  publicKey: string,
  electionId: string,
  ballotId: string,
  expectedLength: number,
  ballot: EncryptedBallot,
  pause: () => Promise<void>,
): Promise<boolean> {
  const steps = ballotVerification(publicKey, electionId, ballotId, expectedLength, ballot)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
    await pause()
  }
}
