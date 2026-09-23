import { truncateToDay } from '@/lib/time'
import { verifyEncryptedBallot, type EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { hashPersonalNumber } from './identity'
import {
  personalNumberFromCertificate,
  publicKeyFromCertificate,
  verifyEnvelopeSignature,
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
  castSequence: number
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
    select: { closesAt: true, linkClearedAt: true },
  })

  // Stängd, eller redan skalad. Båda betyder att rösten aldrig skulle räknas.
  if (!election || election.linkClearedAt !== null || election.closesAt <= new Date()) {
    return { status: 'closed' }
  }

  if (!shape) return { status: 'not_eligible' }

  if (
    !verifyEncryptedBallot(shape.publicKey, electionId, ballotId, shape.optionCount, ballot)
  ) {
    return { status: 'invalid_proof' }
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
   * röstköp som överlever hela ändringsmöjligheten.
   */
  if (existing && envelope.castSequence <= existing.castSequence) {
    return { status: 'stale_sequence' }
  }

  const voter = await votersDb.voterStatus.findUnique({
    where: { id: voterStatusId },
    select: { externalIdentityHash: true },
  })

  if (!voter) return { status: 'not_eligible' }

  /**
   * TVÅ SKILDA KONTROLLER, OCH DE FÅR INTE SLÅS IHOP.
   *
   * 1. Är signaturen giltig för den nyttolast servern byggde? Rent
   *    kryptografiskt, ingen identitet inblandad.
   * 2. Tillhör certifikatet SAMMA person som sessionen? Det avgörs genom att
   *    HASHA personnumret certifikatet påstår och jämföra mot röstlängdens
   *    identitetshash.
   *
   * Granskningen av uppgift 8 fångade att ett tidigare utkast skickade
   * `voter.externalIdentityHash` direkt som `expectedPersonalNumber` till
   * `verifyEnvelopeSignature`. Den funktionen jämför mot certifikatets
   * KLARTEXTSIFFROR, så en hash hade aldrig matchat — och varje giltig röst
   * hade avvisats med `invalid_signature`. Ett totalt, tyst haveri i precis
   * den funktion uppgiften bygger.
   *
   * `verifyEnvelopeSignature` tar (av uppgift 8:s granskning) alltid emot ett
   * `expectedPersonalNumber` att jämföra certifikatets påstående mot — annars
   * skulle en förfalskad väljare kunna signera med sitt EGET certifikat och
   * komma förbi den kontrollen helt. Här jämförs certifikatet mot SIG SJÄLVT
   * (`assertedPersonalNumber`), vilket gör anropet till en ren kryptografisk
   * kontroll: håller signaturen ihop med det certifikat den påstår komma
   * från? IDENTITETEN — att just DET certifikatet får föras till väljarens
   * rad — avgörs helt separat, av hashjämförelsen nedan. De två kontrollerna
   * slås alltså aldrig ihop till en, trots att de delar samma anrop.
   *
   * Hashningen är dessutom asynkron (scrypt genom antagningskön), vilket är
   * skälet att den hör hemma här och inte i signaturmodulen.
   */
  const assertedPersonalNumber = personalNumberFromCertificate(envelope.certificate)

  const signatureIsValid =
    assertedPersonalNumber !== null &&
    verifyEnvelopeSignature(
      envelope.signature,
      envelope.certificate,
      {
        electionId,
        ballotId,
        ciphertextHash: ballot.ciphertextHash,
        castSequence: envelope.castSequence,
      },
      assertedPersonalNumber,
    )

  const signerIsTheVoter =
    assertedPersonalNumber !== null &&
    (await hashPersonalNumber(assertedPersonalNumber)) === voter.externalIdentityHash

  if (!signatureIsValid || !signerIsTheVoter) {
    return { status: 'invalid_signature' }
  }

  await votersDb.pendingVote.upsert({
    where: { voterStatusId_ballotId: { voterStatusId, ballotId } },
    update: {
      ciphertext: ballot.ciphertext,
      proofs: ballot.proofs,
      ciphertextHash: ballot.ciphertextHash,
      castSequence: envelope.castSequence,
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
      castSequence: envelope.castSequence,
      bankIdSignature: envelope.signature,
      bankIdPublicKey: publicKeyFromCertificate(envelope.certificate),
      updatedAt: truncateToDay(new Date()),
    },
  })

  return { status: 'recorded', ciphertextHash: ballot.ciphertextHash, replaced: existing !== null }
}

/**
 * Nästa giltiga räknarvärde för väljarens kuvert på den här valsedeln.
 *
 * Delas mellan de två rutterna i det tvådelade signeringsflödet
 * (`/api/vote/sign-start` och `/api/vote/encrypted`): den nyttolast BankID
 * signerar måste bära exakt samma värde som `castEncryptedBallot` bygger sin
 * förväntade nyttolast med, annars verifierar aldrig en ärlig signatur. Båda
 * anropen räknar därför fram samma tal genom samma funktion, i stället för
 * att den ena sidan behöver komma ihåg och skicka det till den andra — det
 * finns inget mellanlagrat tillstånd att en angripare skulle kunna påverka.
 *
 * Ändras ingenting i röstlängden mellan de två anropen (det normala fallet)
 * ger de exakt samma tal. Skulle ett tredje anrop hinna emellan — en
 * verkligt samtidig ändring — upptäcks det inte här, men det är ofarligt:
 * `castEncryptedBallot` bygger sin egen förväntade nyttolast av samma
 * räknare vid det tillfället, och en signatur över ett annat tal verifierar
 * då inte. Felet blir `invalid_signature`, aldrig en accepterad förfalskning.
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
 */
export async function clearPendingVotes(electionId: string): Promise<number> {
  const ballots = await votersDb.electionBallot.findMany({
    where: { electionId },
    select: { id: true },
  })

  const result = await votersDb.pendingVote.deleteMany({
    where: { ballotId: { in: ballots.map((ballot) => ballot.id) } },
  })

  return result.count
}
