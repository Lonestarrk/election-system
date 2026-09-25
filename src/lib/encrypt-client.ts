import { randomScalar, useFixedBase } from './crypto/group'
import { encrypt, multiply, type Ciphertext } from './crypto/elgamal'
import {
  proveSumIsOne,
  startZeroOrOne,
  type BallotBinding,
  type PendingZeroOrOneProof,
} from './crypto/proofs'
import { indexOfChoice, unitVector, type BallotOption } from './crypto/ballot-encoding'
import {
  hashCiphertext,
  serialiseEqualityProof,
  serialiseZeroOrOneProof,
  type EncryptedBallot,
} from './crypto/verify-ballot'

/**
 * KRYPTERAR VÄLJARENS VAL — OCH KASTAR SLUMPTALEN.
 *
 * Slumptalen returneras inte, loggas inte och sparas inte. Det är den enda
 * anledningen till att kvittot inte är ett bevis: utan dem kan väljaren visa
 * ATT hennes chiffer ingår i räkningen, men inte VAD det innehåller.
 *
 * Skulle någon senare "hjälpsamt" returnera dem för felsökning är röstköp
 * möjligt igen, och ingenting i databasen avslöjar att det hänt.
 *
 * EN IMPLEMENTATION, TVÅ SÄTT ATT KÖRA DEN.
 *
 * Krypteringen görs komponent för komponent i `ballotEncryption`, som lämnar
 * ifrån sig ett steg i taget. `encryptBallot` kör alla steg i ett svep, för
 * servern och testerna. `encryptBallotInSteps` släpper fram webbläsaren mellan
 * stegen, så att röstsidan kan visa hur långt den kommit: en valsedel med
 * personröst tar en tredjedels sekund på en snabb dator och mer på en långsam
 * telefon, och en sida som står still så länge ser trasig ut. Båda kör samma
 * kod och ger samma sorts resultat.
 *
 * Det enda som lämnar ett steg är hur många komponenter som är krypterade.
 * Slumptalen ligger kvar i generatorns egna variabler och i de påbörjade
 * bevisen, och försvinner med dem.
 */
function* ballotEncryption(
  publicKey: string,
  electionId: string,
  ballotId: string,
  options: BallotOption[],
  choice: BallotOption,
): Generator<number, EncryptedBallot, void> {
  const key = BigInt(publicKey)
  const vector = unitVector(options.length, indexOfChoice(options, choice))

  /**
   * VALETS NYCKEL ÄR EN FAST BAS, SOM g.
   *
   * Varje kryptering och varje bevis under valet exponentierar h, så en tabell
   * för h gör de exponentieringarna till multiplikationer utan kvadreringar
   * (src/lib/crypto/fixed-base.ts). Tabellen byggs första gången den behövs och
   * finns kvar för sidans livstid, så att väljarens nästa valsedel i samma val
   * inte bygger om den. Bevisen blir desamma, tal för tal: det är bara vägen
   * till varje potens som ändras.
   */
  useFixedBase(key)

  const nonces: bigint[] = []
  const ciphertexts: Ciphertext[] = []
  const pending: PendingZeroOrOneProof[] = []

  for (const [index, message] of vector.entries()) {
    const nonce = randomScalar()
    const ciphertext = encrypt(key, message, nonce)

    // Beviset påbörjas här, med varje exponentiering det kräver. Det görs
    // färdigt nedan, när utmaningen kan räknas.
    pending.push(startZeroOrOne(key, ciphertext, message === 1n ? 1 : 0, nonce))
    ciphertexts.push(ciphertext)
    nonces.push(nonce)

    yield index + 1
  }

  /**
   * BEVISEN GÖRS FÄRDIGA NÄR HELA LISTAN FINNS (uppgift 14d).
   *
   * Varje utmaning binder hela chifferlistan genom dess hash (se
   * `BallotBinding` i src/lib/crypto/proofs.ts), så ingen av dem kan räknas
   * förrän det sista chiffret finns. Exponentieringarna är redan gjorda, ett
   * alternativ i taget ovan, och det som återstår är ett transkript, en hash
   * och några multiplikationer per alternativ, och summabeviset. Stegen är
   * därför lika många som före uppgift 14d och ungefär lika långa. Det sista
   * är några millisekunder längre, eftersom utmaningarna räknas där och inte
   * i stegen före.
   */
  const serialised = ciphertexts.map((c) => ({ c1: c.c1.toString(), c2: c.c2.toString() }))
  const binding: BallotBinding = { electionId, ballotId, ciphertextHash: hashCiphertext(serialised) }

  const components = pending.map((complete, index) => serialiseZeroOrOneProof(complete(binding, index)))

  const sum = serialiseEqualityProof(
    proveSumIsOne(
      key,
      ciphertexts.reduce((a, b) => multiply(a, b)),
      nonces.reduce((a, b) => a + b, 0n),
      binding,
    ),
  )

  return { ciphertext: serialised, proofs: { components, sum }, ciphertextHash: binding.ciphertextHash }
}

export function encryptBallot(
  publicKey: string,
  electionId: string,
  ballotId: string,
  options: BallotOption[],
  choice: BallotOption,
): EncryptedBallot {
  const steps = ballotEncryption(publicKey, electionId, ballotId, options, choice)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
  }
}

/** Hur långt krypteringen kommit: färdiga komponenter av alla. */
export type EncryptionProgress = (done: number, total: number) => void

/**
 * Samma kryptering, med en paus efter varje komponent.
 *
 * Pausen är en ny uppgift i händelseslingan, inte en tidsfördröjning: den ger
 * webbläsaren tillfälle att rita om sidan och hantera ett tryck på en knapp.
 * Det gör inte krypteringen snabbare, bara möjlig att följa.
 */
export async function encryptBallotInSteps(
  publicKey: string,
  electionId: string,
  ballotId: string,
  options: BallotOption[],
  choice: BallotOption,
  onProgress: EncryptionProgress = () => {},
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<EncryptedBallot> {
  const steps = ballotEncryption(publicKey, electionId, ballotId, options, choice)
  // Bevisen görs färdiga och summabeviset räknas i ett steg till efter komponenterna.
  const total = options.length + 1

  onProgress(0, total)
  await pause()

  for (;;) {
    const step = steps.next()
    if (step.done) {
      onProgress(total, total)
      return step.value
    }
    onProgress(step.value, total)
    await pause()
  }
}

export { hashCiphertext }
