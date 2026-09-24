import { safeEqual } from '@/lib/crypto'
import { truncateToDay } from '@/lib/time'
import { VerificationAborted, verifyEncryptedBallotOnServer } from '@/lib/crypto/server'
import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { hashPersonalNumber } from './identity'
import {
  parseCertificateChain,
  signedAt,
  verifyCertificateChain,
} from './bankid/certificate-chain'
import { parseEnvelopePayload, verifySignedPayload } from './bankid/envelope-signature'
import { trustedBankIdRoots } from './bankid/trusted-roots'
import { votersDb } from './db'
import { sealCertificateChain } from './sealed-chain'

/**
 * DET YTTRE KUVERTET.
 *
 * Raden bär identitet och ett chiffer servern inte kan läsa. Att den kan
 * bytas ut är hela skyddet mot röstköp: köparen måste bevaka väljaren ända
 * till stängningen för att veta vad som faktiskt räknas.
 *
 * DUBBELRÖSTNINGSSPÄRREN ÄR ETT UNIKT INDEX, inte en kontroll i koden. Två
 * samtidiga anrop kan därför inte båda skapa en rad — den andra blir en
 * uppdatering, oavsett hur de ligger i tid.
 */

export type SignedEnvelope = {
  signature: string

  /**
   * Certifikatkedjan ur BankID:s svar, lövet först, i PEM. Se
   * `completionData.certificateChain` i `IBankIdService.ts`.
   */
  certificateChain: readonly string[]

  /**
   * Det faktiskt signerade innehållet, ordagrant — BankID:s eget
   * `completionData.signedData`.
   *
   * INTE ETT SEPARAT `castSequence`-FÄLT, OCH DET ÄR AVSIKTLIGT (fixrunda 1
   * av uppgift 9:s granskning, fynd 1).
   *
   * Ett tidigare utkast lät anroparen skicka med `castSequence` vid sidan av
   * signaturen, och `castEncryptedBallot` räknade fram sin egen färska
   * `nextCastSequence()` för att verifiera mot i stället för att lita på det
   * medskickade talet. Två uträkningar av samma sak, gjorda vid olika
   * tillfällen, kan ge olika svar — det vanliga fallet är en väljare som har
   * en signering stående i en flik medan hon röstar klart i en annan.
   * Följden var ett missvisande `invalid_signature` i stället för
   * `stale_sequence`, och `stale_sequence`-grenen var i praktiken otestad i
   * sin verkliga form.
   *
   * `castSequence` läses i stället ut ur `signedData` (via
   * `parseEnvelopePayload`), EFTER att signaturen verifierats mot exakt den
   * strängen. Talet som prövas mot dubbelröstningsspärren är därmed
   * garanterat samma tal som väljarens BankID-app en gång skrev under —
   * aldrig ett nytt, oberoende räknat.
   */
  signedData: string
}

export type CastOutcome =
  | { status: 'recorded'; ciphertextHash: string; replaced: boolean }
  | { status: 'closed' }
  | { status: 'invalid_proof' }
  | { status: 'invalid_signature' }
  | { status: 'stale_sequence' }
  | { status: 'not_eligible' }

/**
 * Valsedelns kryptonyckel och antal alternativ — det `verifyEncryptedBallotOnServer`
 * behöver för att kunna pröva bevisen.
 *
 * MÅSTE KOMMA FRÅN ANROPAREN, INTE HÄMTAS HÄR.
 *
 * Uppgifterna — omröstningens krypteringsnyckel, partier, kandidater — finns
 * bara i den anonyma röstdatabasen, och den här modulen får aldrig importera
 * därifrån (tests/security/module-boundaries.test.ts, "väljarmodulen
 * importerar ingenting från den anonyma röstmodulen" — ett absolut krav utan
 * undantagslista). Rutten hämtar därför formen genom röstmodulens publika API
 * (`getEncryptedBallotShape`) och skickar med den hit. Typen definieras här
 * på nytt i stället för att importeras från `@/modules/ballot-box` — samma
 * form, men avsiktligt två separata deklarationer, så att modulgränsen
 * fortsätter vara en TypeScript-importgräns och inte bara ett löfte.
 */
export type EncryptedBallotShape = { publicKey: string; optionCount: number }

/**
 * Registrerar väljarens röst — eller ersätter en tidigare liggande.
 *
 * @param shape Valsedelns kryptonyckel och antal alternativ, hämtad av
 *   anroparen via den anonyma modulens publika API. Null betyder att
 *   valsedeln inte finns, inte stöds av det krypterade flödet (en
 *   FRAGA-valsedel), eller att omröstningen saknar krypteringsnyckel.
 * @param signal Begärans signal, när rösten läggs åt en besökare. Då
 *   gäller verifieringsköns tak, och kastar funktionen `VerificationQueueFull`
 *   när kön är full. Ger besökaren upp kastar den `VerificationAborted`, och
 *   ingenting läggs. Se src/lib/crypto/server.ts.
 */
export async function castEncryptedBallot(
  voterStatusId: string,
  electionId: string,
  ballotId: string,
  ballot: EncryptedBallot,
  envelope: SignedEnvelope,
  shape: EncryptedBallotShape | null,
  signal?: AbortSignal,
): Promise<CastOutcome> {
  const election = await votersDb.election.findUnique({
    where: { id: electionId },
    select: { closesAt: true, linkClearedAt: true, phase: true },
  })

  /**
   * Stängd, eller redan skalad. Alla tre villkoren betyder att rösten aldrig
   * skulle räknas.
   *
   * FASEN ÄR AUKTORITATIV DÄR DEN FINNS (uppgift 9:s granskning).
   *
   * `Election.phase`s egen dokumentation säger varför: en klocka som går fel
   * ändrar beteendet tyst, medan en fasövergång är en händelse någon utfört.
   * Fram till uppgift 11 fanns ingen fas att läsa, och kontrollen kunde bara
   * fråga klockan.
   *
   * KLOCKKONTROLLEN ÄR KVAR, OCH DET ÄR INTE EN DUBBLERING. Den fångar det
   * omvända fallet: att tiden gått ut men stängningen ännu inte körts, alltså
   * att fasen fortfarande står i OPEN. Utan den skulle röster kunna tillkomma
   * i glappet mellan `closesAt` och den administratör som trycker på knappen.
   */
  if (
    !election ||
    election.phase !== 'OPEN' ||
    election.linkClearedAt !== null ||
    election.closesAt <= new Date()
  ) {
    return { status: 'closed' }
  }

  if (!shape) return { status: 'not_eligible' }

  /**
   * BEVISEN PRÖVAS I OPENSSL, I STEG OCH I TUR OCH ORDNING.
   *
   * En riksdagsvalsedel med 26 alternativ kräver omkring 290 exponentieringar.
   * I ren BigInt var det elva sekunder, synkront, med servern stillastående för
   * alla andra. Se src/lib/crypto/server.ts.
   */
  if (
    !(await verifyEncryptedBallotOnServer(
      shape.publicKey,
      electionId,
      ballotId,
      shape.optionCount,
      ballot,
      signal ? { signal } : undefined,
    ))
  ) {
    return { status: 'invalid_proof' }
  }

  /**
   * DET SIGNERADE INNEHÅLLET AVKODAS FÖRST — RÄKNAREN KOMMER DÄRIFRÅN, INTE
   * FRÅN EN NY UTRÄKNING (fixrunda 1 av uppgift 9:s granskning, fynd 1).
   *
   * `envelope.signedData` är BankID:s eget `completionData.signedData` —
   * ordagrant det väljarens app skrev under. `parseEnvelopePayload` läser ut
   * `electionId`, `ballotId`, `ciphertextHash` och `castSequence` ur den
   * strängen. Alla fyra måste stämma mot den här begäran; annars är kuvertet
   * antingen trasigt eller en signatur som egentligen gäller en ANNAN röst
   * — och en sådan signatur ska aldrig kunna återanvändas här bara för att
   * den råkar verifiera kryptografiskt mot sitt eget, avvikande innehåll.
   */
  const signedPayload = parseEnvelopePayload(envelope.signedData)

  if (
    !signedPayload ||
    signedPayload.electionId !== electionId ||
    signedPayload.ballotId !== ballotId ||
    signedPayload.ciphertextHash !== ballot.ciphertextHash
  ) {
    return { status: 'invalid_signature' }
  }

  const existing = await votersDb.pendingVote.findUnique({
    where: { voterStatusId_ballotId: { voterStatusId, ballotId } },
    select: { id: true, castSequence: true },
  })

  /**
   * RÄKNAREN MÅSTE ÖKA, OCH KONTROLLEN MÅSTE LIGGA HÄR.
   *
   * Den som fångat väljarens första signerade kuvert kan annars skicka in det
   * igen efter att hon ändrat sig, och rösten återgår till den köpta — ett
   * röstköp som överlever hela ändringsmöjligheten. Talet som jämförs är nu
   * garanterat det som faktiskt signerades (se `signedPayload` ovan), inte en
   * uträkning gjord vid det här anropet — annars kan den avgörande jämförelsen
   * göras mot fel tal utan att någon signatur någonsin behöver förfalskas,
   * exakt det granskningen fångade.
   */
  if (existing && signedPayload.castSequence <= existing.castSequence) {
    return { status: 'stale_sequence' }
  }

  /**
   * KEDJAN PRÖVAS MOT BANKID:S ROT INNAN NÅGOT ANNAT I SIGNATUREN (uppgift 14f).
   *
   * Signaturen är bara värd vad nyckeln bakom den är värd, och nyckeln är
   * bara värd något om BankID står för den. Kedjan ska därför gå från lövet
   * genom en till tre mellannivåer med CA-rätt till en betrodd rot, lövet ska
   * få användas till underskrifter, och alla ska ha gällt nu, när BankID just
   * svarade. Först då lämnas lövets nyckel ut, och den är den enda signaturen
   * prövas mot. Se `verifyCertificateChain` för varje kontroll.
   *
   * Rötterna läses ur konfigurationen. Går de inte att fastställa kastar
   * `trustedBankIdRoots`, och rösten läggs inte, i stället för att prövas mot
   * något annat än det som konfigurerats.
   */
  const chain = parseCertificateChain(envelope.certificateChain)
  const certificate = chain
    ? verifyCertificateChain(chain, { roots: trustedBankIdRoots(), signedDuring: signedAt(new Date()) })
    : null

  if (!chain || !certificate?.ok) return { status: 'invalid_signature' }

  /**
   * SIGNATUREN VERIFIERAS MOT DET FAKTISKT SIGNERADE INNEHÅLLET.
   *
   * Inte mot en nyttolast som byggs om här — se `SignedEnvelope.signedData`
   * och `verifySignedPayload` för hela resonemanget.
   */
  if (!verifySignedPayload(envelope.signature, certificate.signingKey, envelope.signedData)) {
    return { status: 'invalid_signature' }
  }

  /**
   * TVÅ SKILDA KONTROLLER, OCH DE FÅR INTE SLÅS IHOP (fixrunda 1 av uppgift
   * 9:s granskning, fynd 2).
   *
   * 1. Ovan: är signaturen giltig för exakt det signerade innehållet, med en
   *    nyckel som BankID står för? Kryptografiskt, ingen väljare inblandad.
   * 2. Nedan: tillhör lövet SAMMA person som väljarraden? Det avgörs genom att
   *    HASHA personnumret i lövet och jämföra med röstlängdens identitetshash.
   *    Personnumret är nu ett påstående som kedjan styrker, inte något som
   *    certifikatet säger om sig självt.
   *
   * Granskningen av uppgift 8 fångade dessutom att ett tidigare utkast
   * skickade `voter.externalIdentityHash` direkt som förväntat personnummer
   * till signaturverifieringen, som jämför mot KLARTEXTSIFFROR — en hash
   * hade aldrig matchat, och varje giltig röst hade avvisats.
   */
  const voter = await votersDb.voterStatus.findUnique({
    where: { id: voterStatusId },
    select: { externalIdentityHash: true },
  })

  if (!voter) return { status: 'not_eligible' }

  /**
   * HASHNINGEN KOMMER SIST, EFTER ATT SIGNATUREN REDAN ÄR BEKRÄFTAT GILTIG.
   *
   * scrypt (via `hashPersonalNumber`) är avsiktligt kostsamt — se
   * `identity.ts`. Att köra den för varje inkommen begäran, även de vars
   * signatur redan underkänts ovan, vore att betala den kostnaden i onödan
   * och ett billigt sätt att belasta antagningskön utan en enda giltig
   * signatur.
   */
  const signerIsTheVoter = safeEqual(
    await hashPersonalNumber(certificate.personalNumber),
    voter.externalIdentityHash,
  )

  if (!signerIsTheVoter) {
    return { status: 'invalid_signature' }
  }

  /**
   * BESÖKAREN KAN HA GETT UPP UNDER TIDEN (granskningen av uppgift 14b,
   * MINDRE 3).
   *
   * Verifieringen stannar vid nästa steg när signalen avbryts, men dess sista
   * steg, läsningarna och hashningen ovan kan hinna bli klara ändå. En röst ska
   * inte läggas åt en besökare som aldrig får veta det: väljaren har inte sett
   * "lagd", och då ska rösten inte heller vara det.
   */
  if (signal?.aborted) throw new VerificationAborted()

  /**
   * KEDJAN LAGRAS, KRYPTERAD OCH BUNDEN TILL RADEN.
   *
   * Valideringen före stängningen prövar kedjan en gång till, och det är den
   * prövningen som, med riktig BankID, stoppar den som skriver direkt i
   * röstlängden, eftersom den aldrig passerar läggningen. Nyckeln för sig
   * räckte inte: den kunde bytas mot en egen. Kedjan bär personnummer och namn
   * i klartext och krypteras därför, se `sealed-chain.ts`.
   */
  const bankIdCertificateChain = sealCertificateChain(chain, { voterStatusId, ballotId })

  await votersDb.pendingVote.upsert({
    where: { voterStatusId_ballotId: { voterStatusId, ballotId } },
    update: {
      ciphertext: ballot.ciphertext,
      proofs: ballot.proofs,
      ciphertextHash: ballot.ciphertextHash,
      castSequence: signedPayload.castSequence,
      bankIdSignature: envelope.signature,
      bankIdCertificateChain,
      updatedAt: truncateToDay(new Date()),
    },
    create: {
      voterStatusId,
      ballotId,
      ciphertext: ballot.ciphertext,
      proofs: ballot.proofs,
      ciphertextHash: ballot.ciphertextHash,
      castSequence: signedPayload.castSequence,
      bankIdSignature: envelope.signature,
      bankIdCertificateChain,
      updatedAt: truncateToDay(new Date()),
    },
  })

  return { status: 'recorded', ciphertextHash: ballot.ciphertextHash, replaced: existing !== null }
}

/**
 * Nästa räknarvärde för väljarens kuvert på den här valsedeln — det tal som
 * ska LÄGGAS IN i nyttolasten `/api/vote/sign-start` ber BankID signera.
 *
 * ANVÄNDS BARA VID SIGNERINGENS START, INTE VID VERIFIERING.
 *
 * Fram till fixrunda 1 av uppgift 9:s granskning anropades den här funktionen
 * på nytt av `/api/vote/encrypted` också, för att jämföra mot i stället för
 * att lita på det tal som faktiskt signerats. Två uträkningar av samma sak
 * vid olika tillfällen kan ge olika svar — se `SignedEnvelope.signedData` för
 * hela felet det orsakade. `castEncryptedBallot` läser numera räknaren ur
 * `envelope.signedData` (via `parseEnvelopePayload`) i stället, och anropar
 * aldrig den här funktionen.
 *
 * Kvar att komma ihåg: startas TVÅ signeringar för samma väljare och valsedel
 * innan någon av dem hunnit slutföras (två flikar, ingen ännu klar) kan båda
 * få samma tal härifrån, eftersom ingen rad finns att räkna från förrän en av
 * dem faktiskt skrivs. Det är ofarligt — `castEncryptedBallot`s
 * `stale_sequence`-kontroll (`<=`, inte `<`) fångar ändå den som kommer in
 * sist, se dess kommentar.
 */
export async function nextCastSequence(voterStatusId: string, ballotId: string): Promise<number> {
  const existing = await votersDb.pendingVote.findUnique({
    where: { voterStatusId_ballotId: { voterStatusId, ballotId } },
    select: { castSequence: true },
  })

  return (existing?.castSequence ?? 0) + 1
}

/**
 * Väljarens liggande kuvert för en valsedel, med chifferhash, om något.
 *
 * INGEN RUTT FÅR LÄMNA UT DET HÄR. Funktionen finns för testerna. Röstsidan
 * jämför i stället med `compareWithPendingVotes`, som svarar lika, olika eller
 * ingen röst och aldrig hashen själv; se den funktionen för varför. Ingen kod
 * visas heller för väljaren (spec 3.1 punkt 3).
 */
export async function pendingVoteFor(
  voterStatusId: string,
  ballotId: string,
): Promise<{ ciphertextHash: string } | null> {
  return votersDb.pendingVote.findUnique({
    where: { voterStatusId_ballotId: { voterStatusId, ballotId } },
    select: { ciphertextHash: true },
  })
}

/**
 * Det röstsidan behöver veta om väljarens kuvert: valets fas, om en röst tas
 * emot just nu, och vilka valsedlar som har ett liggande kuvert.
 *
 * BARA VALSEDLARNAS ID, ALDRIG NÅGON CHIFFERHASH. Att ett kuvert finns är vad
 * sidan behöver för beskedet "Du har en röst registrerad". Hashen behövs inte
 * för det, och en enhet som fick den skulle veta mer än den själv lagt; se
 * `compareWithPendingVotes`.
 *
 * Uppgiften kommer ur pending_vote, kuvertmodellens egen tabell, och inte ur
 * det gamla flödets markering. Ett kuvert kan bytas ut fram till stängningen,
 * en markering i det gamla flödet kan det inte.
 *
 * `acceptsVotes` har samma villkor som `castEncryptedBallot` avvisar på, i
 * omvänd form: fasen är OPEN, kopplingen är inte raderad och `closesAt` har
 * inte passerats. Sidan ska inte erbjuda en röstning som servern sedan
 * vägrar ta emot. Ändras villkoret där ska det ändras här.
 */
export type EnvelopeOverview = {
  phase: string
  closesAt: Date
  acceptsVotes: boolean
  ballotIdsWithEnvelope: string[]
}

export async function envelopeOverview(
  voterStatusId: string,
  electionId: string,
): Promise<EnvelopeOverview | null> {
  const election = await votersDb.election.findUnique({
    where: { id: electionId },
    select: {
      phase: true,
      closesAt: true,
      linkClearedAt: true,
      ballots: { select: { id: true } },
    },
  })

  if (!election) return null

  const envelopes = await votersDb.pendingVote.findMany({
    where: { voterStatusId, ballotId: { in: election.ballots.map((ballot) => ballot.id) } },
    select: { ballotId: true },
  })

  return {
    phase: election.phase,
    closesAt: election.closesAt,
    acceptsVotes:
      election.phase === 'OPEN' &&
      election.linkClearedAt === null &&
      election.closesAt > new Date(),
    ballotIdsWithEnvelope: envelopes.map((envelope) => envelope.ballotId),
  }
}

/** Utfallet av en jämförelse: samma kuvert, ett annat kuvert, eller inget kuvert alls. */
export type DeviceComparison = 'same' | 'different' | 'none'

/**
 * Jämför enhetens sparade chifferhashar med väljarens liggande kuvert.
 *
 * SERVERN JÄMFÖR, DEN LÄMNAR INTE UT.
 *
 * Det enkla hade varit att ge sidan hashen för det liggande kuvertet och låta
 * den jämföra själv. Då får en enhet veta hashen för en röst som lagts från en
 * ANNAN enhet, alltså för den röst som faktiskt räknas. Tillsammans med
 * läsrätt i votes_db pekar den ut rätt rad efter stängningen. Det är spec
 * 10:s svaghet om insidern med en enhets sparade chifferhash, fast för den
 * slutliga rösten i stället för en som kanske redan bytts ut.
 *
 * Här skickar enheten den hash den själv sparade när den lade rösten, och får
 * tillbaka bara lika, olika eller ingen röst. Enheten vet därmed aldrig mer än
 * sin egen hash, och den visste den redan.
 *
 * Jämförelsen görs i konstant tid, så att svarstiden inte berättar hur många
 * tecken i början som stämde. Utan det hade hashen gått att gissa fram tecken
 * för tecken över tillräckligt många anrop, och då vore den utlämnad ändå.
 */
export async function compareWithPendingVotes(
  voterStatusId: string,
  deviceHashes: Array<{ ballotId: string; ciphertextHash: string }>,
): Promise<Array<{ ballotId: string; result: DeviceComparison }>> {
  const envelopes = await votersDb.pendingVote.findMany({
    where: { voterStatusId, ballotId: { in: deviceHashes.map((entry) => entry.ballotId) } },
    select: { ballotId: true, ciphertextHash: true },
  })

  const held = new Map(envelopes.map((envelope) => [envelope.ballotId, envelope.ciphertextHash]))

  return deviceHashes.map((entry): { ballotId: string; result: DeviceComparison } => {
    const current = held.get(entry.ballotId)
    if (current === undefined) return { ballotId: entry.ballotId, result: 'none' }
    return {
      ballotId: entry.ballotId,
      result: safeEqual(current, entry.ciphertextHash) ? 'same' : 'different',
    }
  })
}

/**
 * Hur många kuvert som raderas per sats. PostgreSQL tar ett begränsat antal
 * parametrar per sats, och varje kuvert kostar två, id och chifferhash.
 */
const CLEAR_BATCH_SIZE = 1_000

/**
 * Raderar kopplingen för exakt de kuvert skalningen flyttat, och räknar det
 * som ligger kvar på omröstningens valsedlar.
 *
 * EFTER ID OCH CHIFFERHASH, INTE EFTER VALSEDEL (granskningen av uppgift 14f,
 * K1). Fram till fixrundan raderades allt som låg på valsedlarna när
 * transaktionen kördes, och det var inte alltid det som flyttats. Ett kuvert
 * som tagits bort efter läsningen märktes inte, och ett som lagts till eller
 * bytts ut efter läsningen raderades utan att ha flyttats. En väljare som
 * ändrade sig i sista stund förlorade då sin nya röst medan den gamla
 * räknades. Chifferhashen står med i villkoret, så ett kuvert som bytts ut i
 * samma rad räknas inte längre som samma kuvert.
 *
 * FUNKTIONEN AVGÖR INGENTING SJÄLV. Skalningen jämför `removed` med antalet
 * flyttade och kräver att `left` är noll, inne i transaktionen och före COMMIT,
 * så att en avvikelse rullar tillbaka raderingen med allt annat. Se
 * `EnvelopesChangedError` i src/orchestration/close-election.usecase.ts.
 *
 * `PendingVote.ballotId` har medvetet ingen foreign key mot `ElectionBallot`
 * (valsedelns innehåll hör till den andra databasen), så det som ligger kvar
 * för omröstningen räknas via en uppslagning i två steg i stället för en
 * direkt relationsfråga.
 *
 * Rösten som redan flyttats påverkas inte. Det som raderas här är bara
 * kopplingen mellan väljare och kuvert, aldrig innehållet.
 *
 * @param client Skalningens transaktion, så att raderingen och fasövergången
 *   blir odelbara. En krasch däremellan hade lämnat en omröstning i OPEN utan
 *   kuvert kvar, vilket en omkörning inte kan skilja från en omröstning där
 *   ingen röstat. Parametern är obligatorisk, så att ett anrop inuti en
 *   transaktion inte kan glömma den och tyst radera utanför transaktionen.
 */
export async function clearPendingVotes(
  electionId: string,
  envelopes: ReadonlyArray<{ id: string; ciphertextHash: string }>,
  client: PendingVoteClient,
): Promise<{ removed: number; left: number }> {
  let removed = 0

  for (let start = 0; start < envelopes.length; start += CLEAR_BATCH_SIZE) {
    const batch = envelopes.slice(start, start + CLEAR_BATCH_SIZE)
    const result = await client.pendingVote.deleteMany({
      where: { OR: batch.map(({ id, ciphertextHash }) => ({ id, ciphertextHash })) },
    })
    removed += result.count
  }

  const ballots = await client.electionBallot.findMany({
    where: { electionId },
    select: { id: true },
  })
  const left = await client.pendingVote.count({
    where: { ballotId: { in: ballots.map((ballot) => ballot.id) } },
  })

  return { removed, left }
}

/** Se `clearPendingVotes`. Den delade klienten eller en transaktion. */
export type PendingVoteClient = Pick<typeof votersDb, 'electionBallot' | 'pendingVote'>
