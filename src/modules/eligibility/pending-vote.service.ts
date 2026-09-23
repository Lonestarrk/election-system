import { truncateToDay } from '@/lib/time'
import { verifyEncryptedBallot, type EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { hashPersonalNumber } from './identity'
import {
  parseEnvelopePayload,
  personalNumberFromCertificate,
  publicKeyFromCertificate,
  verifySignedPayload,
} from './bankid/envelope-signature'
import { votersDb } from './db'

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
  certificate: string

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
 * Valsedelns kryptonyckel och antal alternativ — det `verifyEncryptedBallot`
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
 */
export async function castEncryptedBallot(
  voterStatusId: string,
  electionId: string,
  ballotId: string,
  ballot: EncryptedBallot,
  envelope: SignedEnvelope,
  shape: EncryptedBallotShape | null,
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

  if (
    !verifyEncryptedBallot(shape.publicKey, electionId, ballotId, shape.optionCount, ballot)
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
   * SIGNATUREN VERIFIERAS MOT DET FAKTISKT SIGNERADE INNEHÅLLET.
   *
   * Inte mot en nyttolast som byggs om här — se `SignedEnvelope.signedData`
   * och `verifySignedPayload` för hela resonemanget.
   */
  if (!verifySignedPayload(envelope.signature, envelope.certificate, envelope.signedData)) {
    return { status: 'invalid_signature' }
  }

  /**
   * TVÅ SKILDA KONTROLLER, OCH DE FÅR INTE SLÅS IHOP (fixrunda 1 av uppgift
   * 9:s granskning, fynd 2).
   *
   * 1. Ovan: är signaturen giltig för exakt det signerade innehållet? Rent
   *    kryptografiskt, ingen identitet inblandad — `verifySignedPayload` tar
   *    inte ens emot ett förväntat personnummer.
   * 2. Nedan: tillhör certifikatet SAMMA person som väljarraden? Det avgörs
   *    genom att HASHA personnumret certifikatet påstår och jämföra mot
   *    röstlängdens identitetshash — aldrig genom att jämföra certifikatet
   *    mot sig självt (`certificateBelongsTo(certificate,
   *    personalNumberFromCertificate(certificate))` vore alltid sant, ett
   *    no-op maskerat som en kontroll — se `certificateBelongsTo`s JSDoc).
   *
   * Granskningen av uppgift 8 fångade dessutom att ett tidigare utkast
   * skickade `voter.externalIdentityHash` direkt som förväntat personnummer
   * till signaturverifieringen, som jämför mot KLARTEXTSIFFROR — en hash
   * hade aldrig matchat, och varje giltig röst hade avvisats.
   */
  const assertedPersonalNumber = personalNumberFromCertificate(envelope.certificate)
  if (assertedPersonalNumber === null) return { status: 'invalid_signature' }

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
  const signerIsTheVoter =
    (await hashPersonalNumber(assertedPersonalNumber)) === voter.externalIdentityHash

  if (!signerIsTheVoter) {
    return { status: 'invalid_signature' }
  }

  await votersDb.pendingVote.upsert({
    where: { voterStatusId_ballotId: { voterStatusId, ballotId } },
    update: {
      ciphertext: ballot.ciphertext,
      proofs: ballot.proofs,
      ciphertextHash: ballot.ciphertextHash,
      castSequence: signedPayload.castSequence,
      bankIdSignature: envelope.signature,
      /**
       * DEN PUBLIKA NYCKELN, INTE CERTIFIKATET.
       *
       * Certifikatet bär personnumret i klartext — både i attrappens format
       * och i riktiga svenska BankID-certifikat, där det ligger i subject.
       * Att lagra det i råform skulle sätta ett klartextpersonnummer bredvid
       * identitetshashen i röstlängden, alltså upphäva hela skälet att
       * hasha.
       *
       * Det som behövs senare är (a) nyckeln, för att kunna verifiera
       * signaturen vid en framtida validering, och (b) att underskrivaren var rätt
       * person — och det andra är redan avgjort av kontrollen ovan och bärs
       * av radens koppling till voterStatusId.
       */
      bankIdPublicKey: publicKeyFromCertificate(envelope.certificate),
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
      bankIdPublicKey: publicKeyFromCertificate(envelope.certificate),
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

/** Väljarens liggande kuvert för en valsedel, om något. Används för att visa en verifikationskod. */
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
 * Raderar samtliga liggande kuvert för en omröstning.
 *
 * `PendingVote.ballotId` har medvetet ingen foreign key mot `ElectionBallot`
 * (valsedelns innehåll hör till den andra databasen), så kopplingen till en
 * omröstning görs här via en uppslagning i två steg i stället för en direkt
 * relationsfråga.
 *
 * Anropas av skalningen (uppgift 11) efter att kuverten flyttats till den
 * anonyma sidan. Rösten som redan flyttats påverkas inte — det som raderas
 * här är bara kopplingen mellan väljare och kuvert, aldrig innehållet.
 *
 * @param client Klienten raderingen körs med. Skalningen skickar in sin
 *   transaktion, så att raderingen och fasövergången blir odelbara — en krasch
 *   däremellan hade lämnat en omröstning i OPEN utan kuvert kvar, vilket en
 *   omkörning inte kan skilja från en omröstning där ingen röstat.
 *
 *   PARAMETERN ÄR VALFRI, OCH DET ÄR EN FÄLLA VÄRD ATT KÄNNA TILL. Ett
 *   framtida anrop inuti ett `$transaction` som glömmer att skicka `tx` kör
 *   raderingen UTANFÖR transaktionen, och varken TypeScript eller testerna
 *   säger ifrån — raderingen skulle då ligga kvar även när resten rullas
 *   tillbaka. Den är valfri bara för att de befintliga anroparna (testerna för
 *   uppgift 9) ska slippa ändras. Skriver du ett anrop inuti en transaktion,
 *   skicka alltid med `tx`.
 */
export async function clearPendingVotes(
  electionId: string,
  client: PendingVoteClient = votersDb,
): Promise<number> {
  const ballots = await client.electionBallot.findMany({
    where: { electionId },
    select: { id: true },
  })

  const result = await client.pendingVote.deleteMany({
    where: { ballotId: { in: ballots.map((ballot) => ballot.id) } },
  })

  return result.count
}

/** Se `clearPendingVotes`. Den delade klienten eller en transaktion. */
export type PendingVoteClient = Pick<typeof votersDb, 'electionBallot' | 'pendingVote'>
