import type { KeyObject, X509Certificate } from 'node:crypto'
import { safeEqual } from '@/lib/crypto'
import { votersDb } from '@/modules/eligibility/db'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import {
  signedOnDay,
  verifyCertificateChain,
  type ChainFailure,
} from '@/modules/eligibility/bankid/certificate-chain'
import {
  envelopePayload,
  verifySignedPayload,
} from '@/modules/eligibility/bankid/envelope-signature'
import { trustedBankIdRoots } from '@/modules/eligibility/bankid/trusted-roots'
import { hashPersonalNumber } from '@/modules/eligibility/identity'
import { openCertificateChain } from '@/modules/eligibility/sealed-chain'
import { verifyEncryptedBallotOnServer } from '@/lib/crypto/server'
import type { EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { getEncryptedBallotShape } from '@/modules/ballot-box'

/**
 * DET ENDA ÖGONBLICK DÅ VARJE RÖST GÅR ATT KNYTA TILL EN VÄLJARE.
 *
 * Före ombyggnaden fanns ingen koppling alls: en felräkning gav ett tal och
 * ingenting mer. Efter skalningen finns ingen väljare kvar att fråga.
 * Däremellan — här, medan `PendingVote` fortfarande pekar på `voterStatusId`
 * — går varje avvikelse att peka ut och utreda.
 *
 * KONTROLLERNAS KARAKTÄR SKILJER SIG ÅT, och det är värt att förstå varför:
 *
 *   Relationella   säger att raden hänger ihop med resten av databasen. En
 *                  angripare med skrivrättighet ordnar det lätt — det räcker
 *                  att peka på en verklig, röstberättigad väljare och en
 *                  valsedel som finns.
 *   Kryptografiska prövar det som skrivrätt ensam inte räcker till, men inte
 *                  alla lika mycket. Signaturen och kedjan kan med riktig
 *                  BankID bara väljaren ha ställt, eftersom nyckeln som
 *                  utfärdar certifikaten finns hos BankID. I demon utfärdar
 *                  attrappen dem själv, med en incheckad nyckel, och den som
 *                  driver en demo kan förfalska också dem. Bevisen för
 *                  valsedeln binder inte väljaren alls: vem som helst kan ta
 *                  fram dem för ett chiffer hen själv krypterat. De visar att
 *                  chiffret är en giltig valsedel, inte vems den är.
 *
 * VAD SIGNATURKONTROLLEN (STALE_SEQUENCE/BAD_SIGNATURE NEDAN) STÄNGER, OCH
 * VAD DEN INTE STÄNGER (uppgift 14f).
 *
 * Fram till uppgift 14f prövades signaturen mot den nyckel raden själv bar. En
 * angripare med skrivrätt i databasen genererade ett eget nyckelpar, skrev
 * under ett välformat kuvert och lade nyckel, signatur och ett verkligt
 * `voterStatusId` i en rad som varje kontroll här godkände. Att pröva kedjan
 * när rösten läggs hade inte räckt, eftersom den som skriver direkt i
 * databasen aldrig passerar läggningen.
 *
 * Nu bär raden BankID-kedjan, krypterad, och valideringen prövar den HÄR, för
 * varje rad:
 *
 *   1. kedjan går att öppna för just den här raden, se `sealed-chain.ts`
 *   2. kedjan går till en betrodd rot, med de kontroller som
 *      `verifyCertificateChain` gör, och gällde den dag kuvertet lades
 *   3. signaturen håller mot lövets nyckel, för nuvarande eller en äldre räknare
 *   4. personnumret i lövet är väljarens: hashat med samma peppar som
 *      röstlängden ska det ge radens identitetshash
 *
 * Med riktig BankID, där nyckeln som utfärdar certifikaten finns hos BankID,
 * kan den som bara kan skriva i röstlängden därmed inte längre lägga in en röst
 * för någon som inte skrivit under. Det gäller röstlängden och inte
 * röstdatabasen, där den som kan skriva än så länge kan byta ut ett chiffer
 * (spec 4.6, förbehåll 4). Det håller bara för att stängningen flyttar
 * exakt de rader som prövats här. Sedan fixrunda 1 av uppgift 14f läser den
 * kuverten en gång, med `readEnvelopes`, och skickar just den läsningen hit.
 * Före det läste stängningen två gånger, och en förfalskad rad som togs bort
 * mellan läsningarna flyttades utan att ha prövats.
 *
 * En granskare med åtkomst under valideringen kan pröva varje underskrift mot
 * BankID:s rot, men bara med pepparn. Kedjorna är krypterade med en nyckel ur
 * IDENTITY_PEPPER, alltså samma hemlighet som öppnar namnen och personnumren i
 * dem, så den som granskar underskrifterna får också veta vem som röstat. I
 * Azure ligger pepparn i Key Vault (infra/azure/app.bicep), och granskaren
 * behöver alltså få den därifrån.
 *
 * DET SOM INTE STÄNGS står i src/lib/known-limitations.ts. Den som driver
 * systemet kan ta bort ett kuvert eller lägga tillbaka en väljares tidigare
 * äkta kuvert med dess räknare, eftersom räknaren för den senaste
 * underskriften lagras i samma databas. Inget certifikat prövas mot en
 * spärrlista. Och i demoläget utfärdar attrappen certifikaten själv, med en
 * incheckad nyckel, så den som driver en demo kan fortfarande förfalska.
 *
 * VAD DEN HÄR FILEN INTE GÖR
 *
 * Den kopplar inte in sig i stängningen. Det är uppgift 11:s ansvar
 * (`close-election.usecase.ts`), som äger beslutet att avbryta skalningen när
 * `report.summary.passed` är falskt (spec 7.1: valideringen är en spärr, inte
 * en rapport — men just den inkopplingen sker i den andra filen). Den här
 * filen levererar bara användningsfallet.
 */

/**
 * Vilken del av signaturkontrollen en rad föll på. Kedjans egna skäl kommer ur
 * `verifyCertificateChain`, och därtill:
 *
 *   unreadable   kedjan går inte att öppna för raden: trasig, ändrad, flyttad
 *                från en annan rad, eller aldrig förseglad
 *   signature    signaturen håller inte mot lövets nyckel för någon räknare
 *   other_voter  kedjan och signaturen håller, men lövet tillhör någon annan
 */
export type SignatureFault = ChainFailure | 'unreadable' | 'signature' | 'other_voter'

export type Anomaly = {
  /**
   * DUPLICATE_CIPHERTEXT: två kuvert har samma chifferhash (fixrunda 2 av
   * uppgift 11d, ruling 129). Bara ett av dem kan flyttas, eftersom
   * chifferhashen är unik i urnan. Läggningen tar inte emot ett sådant kuvert,
   * och ett unikt index i pending_vote stoppar det, så en sådan rad är skriven
   * förbi båda. Båda raderna pekas ut, eftersom ingenting säger vilken som är
   * den äkta.
   */
  kind: 'BAD_SIGNATURE' | 'STALE_SEQUENCE' | 'WRONG_BALLOT' | 'BAD_PROOF' | 'DUPLICATE_CIPHERTEXT'
  pendingVoteId: string
  /** Bara för administratörens utredning. Publiceras aldrig. */
  voterStatusId: string
  /**
   * Bara för BAD_SIGNATURE, och bara för administratörens utredning. Skälet
   * skiljer en rad vars kedja inte går till roten från en rad som bär en annan
   * väljares äkta underskrift, och det är två helt olika utredningar.
   */
  reason?: SignatureFault
}

export type ValidationReport = {
  /** Publiceras: antal, kategorier, utfall — aldrig vem. */
  summary: { votes: number; voters: number; byKind: Record<string, number>; passed: boolean }
  /** Publiceras inte. Finns för administratören att utreda, och inte längre än så. */
  anomalies: Anomaly[]
}

/**
 * Hur långt bakåt en äkta, tidigare giltig signatur letas efter innan raden
 * hellre klassas som obevisad (BAD_SIGNATURE) än obevisat gammal
 * (STALE_SEQUENCE).
 *
 * `PendingVote` lagrar bara den SENASTE räknaren — ingen historik över tidigare
 * kuvert finns kvar att slå upp. Det enda sättet att avgöra om en rads
 * signatur i själva verket hör till ett LÄGRE, redan överspelat värde är att
 * pröva kryptografiskt: bygg om det signerade innehållet för varje lägre
 * räknarvärde och se om just den signaturen håller för något av dem. Ett
 * äkta gammalt kuvert visar sig då som "denna signatur höll, fast för
 * räknarvärde k, inte för det som står i kolumnen" — omöjligt att förfalska,
 * eftersom det kräver väljarens privata nyckel.
 *
 * Gränsen finns för att en absurt hög (tampererad) räknarkolumn på EN rad
 * inte ska få valideringen att leta i det oändliga för just den raden. Ingen
 * verklig väljare ändrar sig hundratals gånger på en och samma valsedel.
 *
 * Den ensam räcker inte mot en angripare som skriver MÅNGA rader, var och en
 * med en absurt hög räknarkolumn — se `MAX_TOTAL_STALE_PROBES` nedan för
 * taket som skyddar mot det.
 */
const MAX_STALE_LOOKBACK = 500

/**
 * Sammanlagt tak för hela körningen på hur många extra signaturverifieringar
 * STALE_SEQUENCE-sökningen får göra, över samtliga rader.
 *
 * `MAX_STALE_LOOKBACK` begränsar kostnaden för EN avvikande rad. Det räcker
 * inte mot en angripare med skrivrättighet som skapar MÅNGA rader, var och en
 * med en manipulerad, hög räknarkolumn: utan ett gemensamt tak skulle
 * kostnaden växa linjärt med antalet sådana rader, upp till
 * `MAX_STALE_LOOKBACK` extra verifieringar VAR — långsamt nog att fördröja
 * stängningen, vilket är precis det valideringen (spec 7.1) inte får göra sig
 * skyldig till själv.
 *
 * Budgeten delas mellan ALLA rader i körningen, inte per rad. Tar den slut
 * mitt i sökningen för en rad avgörs den raden som BAD_SIGNATURE i stället
 * för STALE_SEQUENCE — en försiktig, inte en felaktig, klassificering: raden
 * är fortfarande en avvikelse och gör fortfarande `passed` falskt, bara
 * kategorin kan bli fel under den extrema omständigheten att budgeten tagit
 * slut. Ett normalt val, utan manipulerade rader, förbrukar aldrig budgeten —
 * varje ärlig rad kostar exakt en verifiering (det rena, snabba fallet).
 */
const MAX_TOTAL_STALE_PROBES = 5000

type SignatureVerdict = 'ok' | 'stale' | 'bad'

/**
 * Avgör om den lagrade signaturen bevisar nuvarande innehåll, ett äldre
 * innehåll (återuppspelning), eller ingetdera.
 *
 * Nyckeln är lövets, ur en kedja som just prövats mot en betrodd rot, och
 * aldrig något som raden själv påstår. Se `judgeSignature`.
 *
 * Bygger om det signerade innehållet ur radens EGNA lagrade fält —
 * `ciphertextHash` och `castSequence` — i stället för att förvänta sig
 * `signedData` bevarat ordagrant. Det finns ingen sådan kolumn: kolumnerna som
 * SKREVS av `castEncryptedBallot` kommer själva ur `signedData` vid
 * läggningstillfället, och `envelopePayload` är en entydig, längdprefixerad
 * kodning — samma fält ger alltid samma sträng. Återuppbyggnaden är alltså
 * inte en gissning utan en exakt återskapning av det som en gång verkligen
 * signerades, förutsatt att fälten inte ändrats var för sig sedan dess.
 */
function classifySignature(
  electionId: string,
  vote: {
    ballotId: string
    ciphertextHash: string
    castSequence: number
    bankIdSignature: string
  },
  signingKey: KeyObject,
  /** Delad mellan alla rader i körningen — se `MAX_TOTAL_STALE_PROBES`. */
  staleProbeBudget: { remaining: number },
): SignatureVerdict {
  const current = envelopePayload({
    electionId,
    ballotId: vote.ballotId,
    ciphertextHash: vote.ciphertextHash,
    castSequence: vote.castSequence,
  })

  if (verifySignedPayload(vote.bankIdSignature, signingKey, current)) return 'ok'

  const lowerBound = Math.max(1, vote.castSequence - MAX_STALE_LOOKBACK)

  for (
    let candidate = vote.castSequence - 1;
    candidate >= lowerBound && staleProbeBudget.remaining > 0;
    candidate -= 1
  ) {
    staleProbeBudget.remaining -= 1

    const older = envelopePayload({
      electionId,
      ballotId: vote.ballotId,
      ciphertextHash: vote.ciphertextHash,
      castSequence: candidate,
    })

    if (verifySignedPayload(vote.bankIdSignature, signingKey, older)) return 'stale'
  }

  return 'bad'
}

type SignatureJudgement =
  | { verdict: 'ok' }
  | { verdict: 'stale' }
  | { verdict: 'bad'; reason: SignatureFault }

/**
 * Hela signaturkontrollen för en rad: kedjan, signaturen och vem lövet tillhör.
 *
 * I DEN ORDNINGEN, OCH AV ETT SKÄL. Utan en kedja till roten finns ingen
 * nyckel som BankID står för, och då säger en signatur ingenting. Utan en
 * signatur som håller finns inget att knyta till väljaren. Och
 * identitetshashen är dyr, 37 ms, så den räknas bara för en rad där allt annat
 * redan håller.
 *
 * Varje fel blir en avvikelse med sitt skäl, aldrig ett undantag: raden kommer
 * ur databasen, förbi varje schema, och en spärr som kraschar på en trasig rad
 * har hjälpt den som skrev den, som `proofHoldsSafely` nedan säger. Undantaget
 * är ett fel i driftsättningen, en rotfil eller peppar som saknas, och det ska
 * stoppa hela körningen i stället för att bli en avvikelse per rad.
 *
 * EN ÄLDRE ÄKTA RÄKNARE PRÖVAS OCKSÅ MOT VÄLJAREN. Ett återuppspelat kuvert är
 * STALE_SEQUENCE bara om det är väljarens eget. Bär det en annan väljares äkta
 * underskrift är det en annans röst i hennes namn, och det väger tyngre än att
 * räknaren är gammal.
 */
async function judgeSignature(
  electionId: string,
  vote: {
    voterStatusId: string
    ballotId: string
    ciphertextHash: string
    castSequence: number
    bankIdSignature: string
    bankIdCertificateChain: string
    updatedAt: Date
    voterStatus: { externalIdentityHash: string }
  },
  roots: X509Certificate[],
  identityHashOf: (personalNumber: string) => Promise<string>,
  staleProbeBudget: { remaining: number },
): Promise<SignatureJudgement> {
  const chain = openCertificateChain(vote.bankIdCertificateChain, {
    voterStatusId: vote.voterStatusId,
    ballotId: vote.ballotId,
  })
  if (!chain) return { verdict: 'bad', reason: 'unreadable' }

  /**
   * Giltighetstiden prövas mot dagen då kuvertet lades. Det är den enda
   * tidpunkten för underskriften som finns kvar, och den finns med avsikt bara
   * på dygnet när. Att pröva mot dagen för valideringen hade underkänt en röst
   * vars certifikat gick ut efter att den lades, och det som gällde när
   * väljaren skrev under är det som avgör, som i spec 7.4.
   *
   * Dagen kommer ur `updatedAt`, och den kolumnen kan den som skriver i
   * databasen ändra. Ett utgånget certifikat godkänns därför om raden
   * bakdateras till en dag då det gällde (granskningen av uppgift 14f, M4). Det
   * kräver ett äkta certifikat och dess privata nyckel, och står i posten
   * `no-revocation-check` i src/lib/known-limitations.ts, eftersom tidpunkten i
   * BankID:s OCSP-svar hade stängt det.
   */
  const certificate = verifyCertificateChain(chain, {
    roots,
    signedDuring: signedOnDay(vote.updatedAt),
  })
  if (!certificate.ok) return { verdict: 'bad', reason: certificate.reason }

  const verdict = classifySignature(electionId, vote, certificate.signingKey, staleProbeBudget)
  if (verdict === 'bad') return { verdict: 'bad', reason: 'signature' }

  const identityHash = await identityHashOf(certificate.personalNumber)
  if (!safeEqual(identityHash, vote.voterStatus.externalIdentityHash)) {
    return { verdict: 'bad', reason: 'other_voter' }
  }

  return { verdict }
}

/**
 * Gäller valsedeln väljarens kommun och region?
 *
 * Samma villkor som `ballotsForVoter` filtrerar med — men här som en spärr
 * mot en rad som redan skrivits, inte som ett filter mot vad väljaren erbjuds.
 * `castEncryptedBallot` kontrollerar aldrig detta (den känner inte ens till
 * väljarens folkbokföring), så en felaktig rad här kan komma från en bugg
 * lika gärna som ett angrepp — se spec avsnitt 7.
 */
function mismatchesVoterArea(
  ballot: { kind: string; areaCode: string | null },
  voter: { municipalityCode: string | null; regionCode: string | null },
): boolean {
  if (ballot.kind === 'KOMMUN') return ballot.areaCode !== voter.municipalityCode
  if (ballot.kind === 'LANDSTING') return ballot.areaCode !== voter.regionCode
  return false
}

/**
 * `ciphertext`/`proofs` lagras som Prisma `Json` och har därför ingen statisk
 * form i klienten. Bara ett typläge — ingen runtime-kontroll sker här. Formen
 * och varje tal prövas strikt av verifieringen själv (se `parseBallot` i
 * src/lib/crypto/verify-ballot.ts), som anropas via `proofHoldsSafely` nedan.
 */
function toEncryptedBallot(vote: {
  ciphertext: unknown
  proofs: unknown
  ciphertextHash: string
}): EncryptedBallot {
  return {
    ciphertext: vote.ciphertext as EncryptedBallot['ciphertext'],
    proofs: vote.proofs as EncryptedBallot['proofs'],
    ciphertextHash: vote.ciphertextHash,
  }
}

/**
 * BAD_PROOF-kontrollen, skyddad mot kast (fixrunda 2, uppgift 10:s
 * granskning).
 *
 * HÄR FINNS INGET SCHEMA FRAMFÖR. Raden kommer direkt ur databasen, förbi
 * varje Zod-schema, och den här filens dokumentationshuvud handlar
 * genomgående om att en angripare med skrivrättighet kan ha skrivit precis
 * den raden. Ett missformat chiffer (icke-numeriska strängar, `null` i
 * stället för en array, fel längd) är då inte ett programmeringsfel — det ÄR
 * avvikelsen valideringen finns för att hitta, och ska rapporteras som
 * BAD_PROOF precis som ett välformat men matematiskt ogiltigt bevis.
 *
 * DET RÄCKTE INTE ATT FÅNGA KAST (granskningen av uppgift 14b, KRITISKT 1).
 * Verifieringen gjorde då bara `BigInt(...)` på fälten, och ett tal som gick
 * att tolka gick rakt in i beviset. En negativ utmaning räknades som 1, och
 * en förfalskad valsedel med +1000 för ett parti och −999 för blankt
 * godkändes här, med en äkta underskrift, fast trådschemat hade stoppat den.
 * Nu tolkar verifieringen själv varje tal strikt och svarar nej på en rad som
 * inte håller, se `parseBallot` i src/lib/crypto/verify-ballot.ts.
 *
 * Fånget står kvar, eftersom verifieringen fortfarande kan kasta: på en
 * trasig publik nyckel, som är serverns egen, eller på ett internt fel.
 *
 * VALIDERINGEN ÄR EN SPÄRR (spec 7.1), OCH EN SPÄRR SOM KRASCHAR HAR HJÄLPT
 * ANGRIPAREN I STÄLLET FÖR ATT STOPPA HONOM. Ett okatchat undantag här skulle
 * få hela `validateBeforeClose` att kasta för HELA omröstningen — administratören
 * får en stacktrace i stället för en avvikelserapport, och valet går inte att
 * stänga alls. En enda missformad rad, skriven av vem som helst med
 * skrivrättighet, vore då en spärr mot att någonsin stänga valet — strax
 * effektivare för en angripare än den avvikelse raden annars hade orsakat.
 *
 * Att linda in HELA anropet är avsiktligt: skyddet täcker varje sätt
 * verifieringen kan kasta, utan att räkna upp dem en och en.
 *
 * `await` STÅR INNANFÖR `try`, OCH DET ÄR INTE EN DETALJ. Verifieringen körs i
 * steg sedan uppgift 14b, så ett kast kommer som ett avvisat löfte.
 * Returnerades löftet utan `await` skulle det passera förbi `catch`, och en
 * enda trasig rad kunna fälla hela valideringen igen.
 */
async function proofHoldsSafely(
  shape: { publicKey: string; optionCount: number },
  electionId: string,
  ballotId: string,
  vote: { ciphertext: unknown; proofs: unknown; ciphertextHash: string },
): Promise<boolean> {
  try {
    return await verifyEncryptedBallotOnServer(
      shape.publicKey,
      electionId,
      ballotId,
      shape.optionCount,
      toEncryptedBallot(vote),
    )
  } catch {
    return false
  }
}

/**
 * Omröstningens valsedlar och liggande kuvert, lästa en gång.
 *
 * DET SOM VALIDERAS ÄR DET SOM FLYTTAS (granskningen av uppgift 14f, K1).
 *
 * Fram till fixrunda 1 av uppgift 14f läste stängningen pending_vote två
 * gånger: en gång för det den skulle flytta och en gång här inne, i
 * valideringen. Granskaren skrev en förfalskad rad, utan underskrift, som fanns
 * vid den första läsningen och togs bort före den andra. Valideringen såg den
 * aldrig, stängningen flyttade den och svarade `closed`, och den förfalskade
 * rösten låg i urnan. Fönstret var en fråga brett, men den som kan skriva i
 * databasen kan träffa det varje gång.
 *
 * Nu läser stängningen kuverten en gång, med den här funktionen, och ger just
 * den läsningen till `validateEnvelopes`, som aldrig läser pending_vote själv.
 * Sedan flyttar stängningen exakt de rader som validerats, och raderar dem
 * efter id och chifferhash. Allt som ändrats efter läsningen märks där, se
 * `clearPendingVotes`.
 *
 * Varje fält som någon kontroll prövar läses här, också väljarens kommun och
 * identitetshash. Ingenting i valideringen ska behöva gå tillbaka till
 * databasen och kunna få ett annat svar.
 *
 * I OMGÅNGAR, MEN SOM EN LÄSNING (uppgift 11d). Prisma kastar för ett svar över
 * 536 870 888 tecken, och med utfyllnaden av kedjan från 14f gick ett val med
 * fler än några tusen kuvert inte att stänga. Kuverten läses därför i
 * omgångar om `ENVELOPE_READ_BATCH_SIZE`, i id-ordning, och läggs ihop till en
 * läsning som valideras som helhet. Det försvagar inte det ovan: allt som
 * ändras medan omgångarna läses fångas av raderingen efter id och chifferhash,
 * som för en enda fråga. Ett kuvert som läses och sedan tas bort eller byts ut
 * gör att färre raderas än flyttas, och ett kuvert som läggs till bakom
 * läsningen blir kvar och stoppar transaktionen. Sedan 11d kan dessutom ingen
 * väljare lägga ett kuvert medan läsningen pågår, eftersom stängningen
 * skriver CLOSED först.
 *
 * TAKET ÄR NU PROCESSENS MINNE (fixrunda 1 av 11d, M6). Hela läsningen hålls
 * i minnet medan stängningen pågår, med kedjan, utfylld till 32 829 tecken, i
 * varje kuvert. Granskningen uppskattade ett kuvert till 45–52 kB vid två eller
 * tre alternativ och till omkring 200 kB vid 26. Med 1 GiB heap, som
 * granskningen räknade med för containerns 2 GiB i Azure, blir taket omkring
 * 20 000 kuvert vid tre alternativ och 5 000 vid 26, och det följer heapen i
 * proportion. Tar minnet slut kraschar processen i stället för att svara.
 * Kopplingen är då orörd, eftersom inget raderats, och låset släpps med
 * anslutningen, men administratören får inget besked. Kedjan släpps inte
 * efter varje validerad omgång. Läsningen blir färdig innan valideringen
 * börjar, så att släppa kedjan under valideringen sänker inte toppen, och att
 * validera omgång för omgång kräver att läsningen och valideringen vävs ihop,
 * vilket inte är en enkel ändring. Låsets tidsgräns sätter ett högre tak, se
 * `CLOSING_LOCK_TIMEOUT_MS` i close-election.usecase.ts.
 */
export async function readEnvelopes(electionId: string) {
  const ballots = await votersDb.electionBallot.findMany({
    where: { electionId },
    select: { id: true, kind: true, areaCode: true },
  })
  const ballotIds = ballots.map((ballot) => ballot.id)

  const envelopes: EnvelopeRow[] = []
  let after: string | null = null

  for (;;) {
    const batch = await readEnvelopeBatch(ballotIds, after)
    envelopes.push(...batch)
    if (batch.length < ENVELOPE_READ_BATCH_SIZE) break
    after = batch[batch.length - 1]!.id
  }

  return { electionId, ballots, envelopes }
}

/**
 * Hur många kuvert som läses per fråga.
 *
 * Ett kuvert är chiffret och bevisen, uppmätt omkring 6 300 tecken per
 * alternativ, och kedjan, som är utfylld till 32 829 tecken. Vid 200
 * alternativ, det mesta läggningen tar emot, är det omkring 1,3 miljoner tecken
 * per kuvert, och hundra kuvert blir omkring 130 miljoner, en fjärdedel av
 * Prismas tak. En rad som skrivits förbi läggningen kan vara större än så, och
 * då stoppas stängningen med kopplingen orörd i stället.
 */
export const ENVELOPE_READ_BATCH_SIZE = 100

/** En omgång kuvert efter `after` i id-ordning, med allt valideringen prövar. */
function readEnvelopeBatch(ballotIds: string[], after: string | null) {
  return votersDb.pendingVote.findMany({
    where: { ballotId: { in: ballotIds }, ...(after === null ? {} : { id: { gt: after } }) },
    orderBy: { id: 'asc' },
    take: ENVELOPE_READ_BATCH_SIZE,
    select: {
      id: true,
      voterStatusId: true,
      ballotId: true,
      ciphertext: true,
      proofs: true,
      ciphertextHash: true,
      castSequence: true,
      bankIdSignature: true,
      bankIdCertificateChain: true,
      updatedAt: true,
      voterStatus: {
        select: { municipalityCode: true, regionCode: true, externalIdentityHash: true },
      },
    },
  })
}

type EnvelopeRow = Awaited<ReturnType<typeof readEnvelopeBatch>>[number]

/** En läsning ur `readEnvelopes`: det valideringen prövar och det stängningen flyttar. */
export type EnvelopeSnapshot = Awaited<ReturnType<typeof readEnvelopes>>

/**
 * Läser kuverten och validerar dem, för den som bara vill ha rapporten.
 *
 * Stängningen använder INTE den här, eftersom den måste flytta samma läsning
 * som valideras. Den anropar `readEnvelopes` och `validateEnvelopes` för sig.
 */
export async function validateBeforeClose(electionId: string): Promise<ValidationReport> {
  return validateEnvelopes(await readEnvelopes(electionId))
}

/**
 * Kör hela valideringen över en läsning av kuverten, medan `PendingVote`
 * fortfarande pekar på `voterStatusId`.
 *
 * KONTROLLERNA KÖRS I ORDNING, BILLIGAST FÖRST — MEN ALLA KÖRS, FÖR VARJE
 * RAD, OAVSETT OM EN TIDIGARE REDAN TRÄFFAT.
 *
 *   1. WRONG_BALLOT    — en ren uppslagning mot spegeltabellen.
 *   2. STALE_SEQUENCE  — kryptografisk: kedjan mot roten och en `verify` av
 *   3. BAD_SIGNATURE      signaturen i det vanliga fallet (bara en avvikande
 *                        rad kostar flera), och en identitetshash per väljare.
 *   4. BAD_PROOF       — dyrast: en handfull modulär exponentiering per
 *                        alternativ på valsedeln.
 *   5. DUPLICATE_CIPHERTEXT — två kuvert med samma chifferhash, prövat över
 *                        hela läsningen när raderna är genomgångna.
 *
 * "Billigast först" avgör bara ORDNINGEN de körs i, inte OM de körs. En rad
 * kan ha flera samtidiga fel — fel valsedel OCH ett förfalskat bevis är inte
 * mer osannolikt än bara det ena — och just den kombinationen betyder mest
 * för en administratörs triage (spec 7.2 finns för att avvikelser ska gå att
 * UTREDA). WRONG_BALLOT-kommentaren ovan säger uttryckligen att en sådan rad
 * "kan komma från en bugg lika gärna som ett angrepp": att i det läget dölja
 * en SAMTIDIG signatur- eller bevisavvikelse, bara för att den redan
 * kategoriserats som fel valsedel, vore att gömma exakt den information som
 * skiljer en bugg från ett angrepp. En rad utan avvikelser kostar fortfarande
 * bara det billiga, vanliga fallet av varje kontroll.
 *
 * VALIDERINGEN KONTROLLERAR INTE NUVARANDE RÖSTBERÄTTIGANDE, och det är ett
 * beslut, inte en glömska (spec 7.4). Att rösten var legitim när den lades
 * framgår av signaturen, inte av röstlängdens tillstånd i efterhand. En
 * väljare som strukits efter att ha röstat — dödsfall är det realistiska
 * fallet — ska få sin röst räknad, precis som en svensk förtidsröst. Ingen
 * kontroll här läser `VoterStatus.isEligible`.
 *
 * INGENTING HÄR LÄSER PENDING_VOTE. Raderna kommer ur `snapshot`, och det är
 * samma rader som stängningen sedan flyttar, se `readEnvelopes`.
 */
export async function validateEnvelopes(snapshot: EnvelopeSnapshot): Promise<ValidationReport> {
  const { electionId, ballots, envelopes: pendingVotes } = snapshot
  const ballotById = new Map(ballots.map((ballot) => [ballot.id, ballot]))

  /**
   * Rötterna läses en gång per körning. Går de inte att fastställa kastar
   * `trustedBankIdRoots`, och stängningen avbryts med kopplingen orörd. Det är
   * ett fel i driftsättningen, och att då underkänna varje rad hade sett ut som
   * ett angrepp på varje väljare.
   */
  const roots = trustedBankIdRoots()

  /**
   * EN HASHNING PER VÄLJARE OCH KÖRNING, INTE PER KUVERT.
   *
   * Identitetshashen är scrypt och tar 37 ms (se `identity.ts`). En väljare har
   * ett kuvert per valsedel, alltså tre i ett riksdagsval, och samma personnummer
   * i varje löv. Hashades varje kuvert för sig hade valideringen vuxit med 37 ms
   * per kuvert i stället för per väljare. Löftet sparas, inte svaret, så att två
   * kuvert för samma väljare aldrig räknar samma hash två gånger.
   */
  const identityHashes = new Map<string, Promise<string>>()
  const identityHashOf = (personalNumber: string): Promise<string> => {
    let hash = identityHashes.get(personalNumber)
    if (!hash) {
      hash = hashPersonalNumber(personalNumber)
      identityHashes.set(personalNumber, hash)
    }
    return hash
  }

  const anomalies: Anomaly[] = []
  const shapeCache = new Map<string, Awaited<ReturnType<typeof getEncryptedBallotShape>>>()
  // Delad över hela körningen — se `MAX_TOTAL_STALE_PROBES`.
  const staleProbeBudget = { remaining: MAX_TOTAL_STALE_PROBES }

  for (const vote of pendingVotes) {
    const anomaly = (kind: Anomaly['kind'], reason?: SignatureFault): Anomaly => ({
      kind,
      pendingVoteId: vote.id,
      voterStatusId: vote.voterStatusId,
      ...(reason === undefined ? {} : { reason }),
    })

    // 1. WRONG_BALLOT — billigast: en uppslagning, ingen kryptografi.
    const ballot = ballotById.get(vote.ballotId)
    if (!ballot || mismatchesVoterArea(ballot, vote.voterStatus)) {
      anomalies.push(anomaly('WRONG_BALLOT'))
    }

    // 2–3. STALE_SEQUENCE / BAD_SIGNATURE — kedjan, signaturen och vem lövet
    // tillhör, se `judgeSignature`. En verifiering av signaturen och två av
    // kedjan i det vanliga fallet, och en hashning per väljare. Körs OAVSETT om
    // WRONG_BALLOT redan träffade.
    const signature = await judgeSignature(electionId, vote, roots, identityHashOf, staleProbeBudget)
    if (signature.verdict === 'stale') {
      anomalies.push(anomaly('STALE_SEQUENCE'))
    }
    if (signature.verdict === 'bad') {
      anomalies.push(anomaly('BAD_SIGNATURE', signature.reason))
    }

    // 4. BAD_PROOF — dyrast, men körs ändå: en rad kan ha ett ogiltigt bevis
    // OBEROENDE av om valsedeln eller signaturen redan avvek.
    let shape = shapeCache.get(vote.ballotId)
    if (shape === undefined) {
      shape = await getEncryptedBallotShape(vote.ballotId)
      shapeCache.set(vote.ballotId, shape)
    }

    const proofHolds =
      shape !== null && (await proofHoldsSafely(shape, electionId, vote.ballotId, vote))

    if (!proofHolds) {
      anomalies.push(anomaly('BAD_PROOF'))
    }
  }

  /**
   * 5. DUPLICATE_CIPHERTEXT — två kuvert med samma chifferhash (fixrunda 2 av
   * uppgift 11d, ruling 129). Återläsningen i stängningen avbröt förut varje
   * körning när det hände, och ruling 126 kallade dessutom stängningens egen
   * rad förfalskad. Nu stoppar valideringen stängningen och pekar ut raderna.
   */
  const envelopesByHash = new Map<string, Array<(typeof pendingVotes)[number]>>()
  for (const vote of pendingVotes) {
    const same = envelopesByHash.get(vote.ciphertextHash)
    if (same) same.push(vote)
    else envelopesByHash.set(vote.ciphertextHash, [vote])
  }
  for (const same of envelopesByHash.values()) {
    if (same.length < 2) continue
    for (const vote of same) {
      anomalies.push({ kind: 'DUPLICATE_CIPHERTEXT', pendingVoteId: vote.id, voterStatusId: vote.voterStatusId })
    }
  }

  const byKind: Record<string, number> = {}
  for (const found of anomalies) {
    byKind[found.kind] = (byKind[found.kind] ?? 0) + 1
  }

  const summary = {
    votes: pendingVotes.length,
    voters: new Set(pendingVotes.map((vote) => vote.voterStatusId)).size,
    byKind,
    passed: anomalies.length === 0,
  }

  /**
   * ATT LÄSA KOPPLINGEN SKA SYNAS (spec 7.2).
   *
   * En tyst läsning är oskiljbar från en obehörig. Loggas utan identiteter
   * eller antal, precis som varje annan revisionshändelse i den här tabellen
   * — se `audit.service.ts` för varför.
   */
  await recordAuditEvent(AUDIT_EVENTS.PRE_CLOSE_VALIDATION)

  return { summary, anomalies }
}
