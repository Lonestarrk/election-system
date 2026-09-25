import { describe, expect, it } from 'vitest'
import type { BallotOption } from '@/lib/crypto/ballot-encoding'
import { decryptWithSecret, encrypt, generateKeyPair, multiply } from '@/lib/crypto/elgamal'
import {
  G,
  MAX_DECIMAL_DIGITS,
  P,
  Q,
  bigintModPow,
  modPow,
  parseElement,
  parseScalar,
  randomScalar,
  registerGroupExponentiation,
} from '@/lib/crypto/group'
import { nativeModPow } from '@/lib/crypto/native-exponentiation'
import { verifyZeroOrOne } from '@/lib/crypto/proofs'
import { verifyEncryptedBallotOnServer } from '@/lib/crypto/server'
import { hashCiphertext, verifyEncryptedBallot, type EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { encryptBallot } from '@/lib/encrypt-client'
import { encryptedBallotSchema } from '@/lib/validation'
import { forgeBallot, forgeZeroOrOneProof } from './forged-ballot'

/**
 * VARJE TAL I EN VALSEDEL TOLKAS STRIKT, OCH EN NEGATIV EXPONENT KASTAR.
 *
 * Granskaren av uppgift 14b byggde en valsedel med +1000 för ett parti och −999
 * för blankt, och den godkändes. Två fel samverkade. Tolkningen gjorde bara
 * `BigInt()`, så en negativ utmaning gick rakt in i beviset. Och
 * exponentieringen räknade en negativ exponent som 1, i BigInt och i OpenSSL
 * lika. Trådschemat stoppade minustecknet, men valideringen före stängningen
 * och omverifieringen i skalningen läser raden ur databasen, förbi schemat.
 *
 * Rättelsen sitter där alla vägar möts: i tolkningen i verify-ballot.ts, som
 * varje väg går igenom, och i modPow. Det här testet prövar kryptot. Samma
 * förfalskning prövas mot databasvägen i
 * tests/integration/validate-before-close.test.ts och
 * tests/integration/close-election.test.ts.
 *
 * Filen importerar serverns ingång, så OpenSSL är registrerat. Där BigInt-vägen
 * prövas kopplas registreringen ur och sedan in igen.
 */

const keys = generateKeyPair()
const publicKey = keys.publicKey.toString()
const ELECTION = 'val-strikt'
const BALLOT = 'valsedel-strikt'

const options: BallotOption[] = [
  { kind: 'BLANK' },
  { kind: 'PARTY', ballotPartyId: 'parti-a' },
  { kind: 'PARTY', ballotPartyId: 'parti-b' },
]

function inBigInt<T>(run: () => T): T {
  registerGroupExponentiation(null)
  try {
    return run()
  } finally {
    registerGroupExponentiation(nativeModPow)
  }
}

function verifiedInBigInt(ballot: EncryptedBallot): boolean {
  return inBigInt(() => verifyEncryptedBallot(publicKey, ELECTION, BALLOT, options.length, ballot))
}

function verifiedOnServer(ballot: EncryptedBallot): Promise<boolean> {
  return verifyEncryptedBallotOnServer(publicKey, ELECTION, BALLOT, options.length, ballot)
}

/** Som raden läses ur databasen: Prismas Json ger tillbaka exakt det som skrevs, utan schema. */
function asDatabaseRow(ballot: unknown): EncryptedBallot {
  return JSON.parse(JSON.stringify(ballot)) as EncryptedBallot
}

describe('en förfalskad valsedel med +1000 för ett parti och −999 för blankt', () => {
  const { ballot: forged, ciphertexts } = forgeBallot(keys.publicKey, ELECTION, BALLOT, [
    -999n,
    1000n,
    0n,
  ])

  it('lägger verkligen tusen röster på partiet, och summerar ändå till 1', () => {
    // Utan det här säger testerna nedan ingenting: det är just den här
    // valsedeln som godkändes före rättelsen.
    expect(decryptWithSecret(keys.privateKey, ciphertexts[1]!)).toBe(1000)
    expect(decryptWithSecret(keys.privateKey, ciphertexts.reduce((a, b) => multiply(a, b)))).toBe(1)
    expect(BigInt(forged.proofs.components[1]!.challenge0) < 0n).toBe(true)
  })

  it('underkänns i BigInt', () => {
    expect(verifiedInBigInt(forged)).toBe(false)
  })

  it('underkänns på servern, i OpenSSL och i steg', async () => {
    expect(await verifiedOnServer(forged)).toBe(false)
  })

  it('underkänns som databasrad, alltså förbi trådschemat', async () => {
    // Valideringen före stängningen och omverifieringen i skalningen läser
    // raden så här. Det var den vägen förfalskningen gick igenom.
    const row = asDatabaseRow(forged)
    expect(await verifiedOnServer(row)).toBe(false)
    expect(inBigInt(() => verifyEncryptedBallot(publicKey, ELECTION, BALLOT, 3, row))).toBe(false)
  })

  it('stoppas också av trådschemat', () => {
    expect(encryptedBallotSchema.safeParse(forged).success).toBe(false)
  })

  it('kontrasten: en ärlig valsedel godkänns på alla vägar', async () => {
    const honest = encryptBallot(publicKey, ELECTION, BALLOT, options, options[1]!)

    expect(encryptedBallotSchema.safeParse(honest).success).toBe(true)
    expect(verifiedInBigInt(honest)).toBe(true)
    expect(await verifiedOnServer(honest)).toBe(true)
    expect(await verifiedOnServer(asDatabaseRow(honest))).toBe(true)
  })
})

describe('en negativ exponent kastar, i båda implementationerna', () => {
  it('bigintModPow, nativeModPow och modPow, också med tabellerna och modulo q', () => {
    expect(() => bigintModPow(G, -1n, P)).toThrow(RangeError)
    expect(() => nativeModPow(G, -1n)).toThrow(RangeError)
    expect(() => modPow(G, -1n, P)).toThrow(RangeError)
    expect(() => modPow(7n, -2n, Q)).toThrow(RangeError)
    // I BigInt-läge går g genom sin tabell, som svarar null för en negativ
    // exponent. Då ska inte heller reserven räkna den som 1.
    expect(() => inBigInt(() => modPow(G, -(Q - 1n), P))).toThrow(RangeError)
  })

  it('kontrasten: exponenten 0 ger fortfarande 1', () => {
    expect(bigintModPow(G, 0n, P)).toBe(1n)
    expect(nativeModPow(G, 0n)).toBe(1n)
    expect(modPow(G, 0n, P)).toBe(1n)
  })

  it('ett 0-eller-1-bevis med negativ utmaning kastar i stället för att godkännas', () => {
    // Direkt mot beviset, förbi tolkningen. Så når uppgift 12:s och 12b:s kod
    // bevisen om de någon gång bygger dem utan verify-ballot.ts.
    const ciphertext = encrypt(keys.publicKey, 1000n, randomScalar())
    const binding = {
      electionId: ELECTION,
      ballotId: BALLOT,
      ciphertextHash: hashCiphertext([{ c1: ciphertext.c1.toString(), c2: ciphertext.c2.toString() }]),
    }
    const proof = forgeZeroOrOneProof(keys.publicKey, ciphertext, binding, 0)

    expect(proof.challenge0 < 0n).toBe(true)
    expect(() => verifyZeroOrOne(keys.publicKey, ciphertext, proof, binding, 0)).toThrow(RangeError)
    expect(() => inBigInt(() => verifyZeroOrOne(keys.publicKey, ciphertext, proof, binding, 0))).toThrow(
      RangeError,
    )
  })
})

describe('tolkningen av ett tal', () => {
  it('är kanonisk: bara siffror, ingen inledande nolla utom i "0", högst 617 siffror', () => {
    expect(MAX_DECIMAL_DIGITS).toBe(617)
    expect(MAX_DECIMAL_DIGITS).toBe(P.toString().length)

    const notCanonical = ['007', '00', '-0', '-5', '+5', ' 5', '5 ', '5\n', '0x5', '1e3', '5.0', '']
    // Siffror ur andra skriftsystem: ٣ är arabisk-indisk trea, ５ en trea i full bredd.
    notCanonical.push('\u0663', '\uff15')

    for (const text of notCanonical) {
      expect(parseScalar(text), JSON.stringify(text)).toBeNull()
      expect(parseElement(text), JSON.stringify(text)).toBeNull()
    }
    for (const value of [5, 5n, null, undefined, {}, ['5']]) {
      expect(parseScalar(value), String(value)).toBeNull()
    }
    expect(parseScalar('0')).toBe(0n)
    expect(parseScalar('5')).toBe(5n)
  })

  it('en exponent ligger i [0, q), ett gruppelement i [1, p)', () => {
    expect(parseScalar((Q - 1n).toString())).toBe(Q - 1n)
    expect(parseScalar(Q.toString())).toBeNull()
    expect(parseScalar((P - 1n).toString())).toBeNull()

    expect(parseElement('0')).toBeNull()
    expect(parseElement('1')).toBe(1n)
    expect(parseElement((P - 1n).toString())).toBe(P - 1n)
    expect(parseElement(P.toString())).toBeNull()
    expect(parseElement('1' + '0'.repeat(MAX_DECIMAL_DIGITS))).toBeNull()
  })
})

describe('trådschemat och verifieringen säger samma sak om varje tal', () => {
  const honest = encryptBallot(publicKey, ELECTION, BALLOT, options, options[2]!)

  type Fields = Record<string, unknown>
  type Mutable = {
    ciphertext: Fields[]
    proofs: { components: Fields[]; sum: Fields }
    ciphertextHash: string
  }

  const plus = (value: unknown, delta: bigint) => (BigInt(value as string) + delta).toString()

  /** Ändrar ett fält i ett bevis. */
  const inProof = (index: number, change: (proof: Fields) => void) => (ballot: Mutable) =>
    change(ballot.proofs.components[index]!)

  /** Ändrar ett chiffer och räknar om hashen, så att det är tolkningen som ska säga nej. */
  const inCiphertext = (change: (pair: Fields) => void) => (ballot: Mutable) => {
    change(ballot.ciphertext[0]!)
    ballot.ciphertextHash = hashCiphertext(ballot.ciphertext as Array<{ c1: string; c2: string }>)
  }

  const variants: Array<[string, (ballot: Mutable) => void]> = [
    // Likvärdiga mod q, och därför godkända före rättelsen. Samma valsedel
    // fick då flera kodningar, och ett tal kunde göras hur långt som helst.
    ['ett svar plus q', inProof(0, (p) => (p.response0 = plus(p.response0, Q)))],
    ['en utmaning plus q', inProof(1, (p) => (p.challenge1 = plus(p.challenge1, Q)))],
    ['summasvaret plus q', (b) => (b.proofs.sum.response = plus(b.proofs.sum.response, Q))],
    ['en inledande nolla i ett svar', inProof(0, (p) => (p.response1 = '0' + String(p.response1)))],
    ['en inledande nolla i ett åtagande', inProof(2, (p) => (p.a0 = '0' + String(p.a0)))],
    ['en inledande nolla i c1', inCiphertext((pair) => (pair.c1 = '0' + String(pair.c1)))],
    ['ett svar med 622 siffror', inProof(0, (p) => (p.response0 = plus(p.response0, Q * 10n ** 5n)))],
  ]

  variants.push(
    // Utanför intervallen.
    ['summautmaningen plus q', (b) => (b.proofs.sum.challenge = plus(b.proofs.sum.challenge, Q))],
    ['ett åtagande plus p', inProof(0, (p) => (p.b1 = plus(p.b1, P)))],
    ['c1 plus p', inCiphertext((pair) => (pair.c1 = plus(pair.c1, P)))],
    ['c2 = 0', inCiphertext((pair) => (pair.c2 = '0'))],
    ['ett negativt svar', inProof(0, (p) => (p.response0 = '-' + String(p.response0)))],
    // Former som BigInt() godtar men som inte är kanoniska.
    ['ett plustecken', inProof(0, (p) => (p.response0 = '+' + String(p.response0)))],
    ['ett blanksteg', inProof(0, (p) => (p.challenge0 = ' ' + String(p.challenge0)))],
    ['hex', (b) => (b.proofs.sum.response = '0x' + BigInt(b.proofs.sum.response as string).toString(16))],
    // Former som bara en databasrad kan ha. Förut kastade de inne i verifieringen.
    ['ett tal i stället för en sträng', inProof(0, (p) => (p.response0 = 5))],
    ['null i stället för ett tal', inProof(0, (p) => (p.b0 = null))],
    ['ett fält som saknas', inProof(0, (p) => delete p.a1)],
    ['en sträng i stället för bevisen', (b) => ((b as { proofs: unknown }).proofs = 'bevis')],
    ['null i stället för chiffret', (b) => ((b as { ciphertext: unknown }).ciphertext = null)],
  )

  it('kontrasten: den ärliga valsedeln godkänns av båda', async () => {
    expect(encryptedBallotSchema.safeParse(honest).success).toBe(true)
    expect(await verifiedOnServer(asDatabaseRow(honest))).toBe(true)
  })

  it.each(variants)('%s: underkänns av båda, utan att verifieringen kastar', async (_name, change) => {
    const ballot = structuredClone(honest) as unknown as Mutable
    change(ballot)
    const row = ballot as unknown as EncryptedBallot

    expect(encryptedBallotSchema.safeParse(row).success).toBe(false)
    expect(await verifiedOnServer(asDatabaseRow(row))).toBe(false)
    expect(
      inBigInt(() => verifyEncryptedBallot(publicKey, ELECTION, BALLOT, options.length, row)),
    ).toBe(false)
  })
})

describe('ett långt tal räknas aldrig', () => {
  it('en giltig valsedel med ett svar förlängt med k·q underkänns innan någon exponentiering', async () => {
    /**
     * Granskarens prob F1: fyra tal förlängda med k·q i en komponent gav en
     * giltig valsedel på 1,4 MB, som låste händelseslingan i 5,45 s i ett
     * enda steg. Talet är likvärdigt mod q, så beviset höll. Nu sätter
     * tolkningen en gräns på 617 siffror, och den prövas innan något tal
     * räknas med: exponentieringen anropas inte en enda gång.
     */
    const ballot = structuredClone(encryptBallot(publicKey, ELECTION, BALLOT, options, options[0]!))
    const proof = ballot.proofs.components[0]!
    proof.response0 = (BigInt(proof.response0) + (Q << 100_000n)).toString()
    expect(proof.response0.length).toBeGreaterThan(30_000)

    let exponentiations = 0
    registerGroupExponentiation((base, exponent) => {
      exponentiations += 1
      return nativeModPow(base, exponent)
    })
    try {
      expect(await verifiedOnServer(ballot)).toBe(false)
      expect(exponentiations).toBe(0)
    } finally {
      registerGroupExponentiation(nativeModPow)
    }
  })
})
