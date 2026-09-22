# Dubbla kuvert med ändringsbar röst — implementationsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ersätt blindsignaturer med dubbla kuvert, så att en väljare kan ändra sin röst fram till stängning och ett röstköp därmed blir värdelöst — utan att förlora valhemligheten eller verifierbarheten.

**Architecture:** Rösten krypteras i webbläsaren under valets tröskelnyckel och lagras kopplad till väljaren i `voters_db` medan röstningen pågår, vilket gör den utbytbar. Vid stängning flyttas chiffren till `votes_db` utan identitet och kopplingen raderas. Resultatet räknas homomorft, så ingen enskild röst dekrypteras någonsin — bara summan öppnas, av k av n förtroendemän tillsammans.

**Tech Stack:** TypeScript, Next.js 15, Prisma, PostgreSQL, Vitest, Playwright. Kryptot skrivs med `BigInt` och Node `crypto` — **inga nya beroenden**.

**Spec:** `docs/spec/2026-09-22-dubbla-kuvert.md`

## Global Constraints

- **Inga nya npm-beroenden.** Mätt: 2,0 ms per modexp i 2048-bitars MODP räcker (0,7 s för en väljares tre valsedlar).
- **Grupp:** RFC 3526 MODP Group 14. `g = 4` (ordning `q`), alla exponenter mod `q = (p-1)/2`.
- **Varje mottaget gruppelement valideras** med `1 < y < p` och `y^q ≡ 1 (mod p)` innan det används.
- **Kommentarer och användartext på svenska**, som resten av kodbasen. Kommentarer förklarar *varför*, inte *vad*.
- **`votes_db` får aldrig innehålla identitet.** Vaktas av `tests/security/schema-separation.test.ts`.
- **Tidsstämplar grovkornas** — dygn i `voters_db`, timme i `votes_db` — enligt `src/lib/time.ts`.
- **Varje uppgift slutar med grön svit och en commit.** `npx tsc --noEmit` ska ge noll fel.
- **Kör aldrig `npm run build` medan dev-servern kör.** Se varningen i README.

## Review Focus

1. **Gruppelement utanför primtalsundergruppen.** En klient som skickar `c1` av ordning 2 kan läcka en bit av nyckeln vid partiell dekryptering. Varje inkommande `c1`/`c2` måste avvisas om `y^q ≢ 1`. *(Uppgift 1, test i uppgift 8)*
2. **Röst som anländer efter `closesAt`.** Måste avvisas med tydligt besked, inte tyst sparas — en röst som accepteras efter skalningen hamnar aldrig i räkningen och väljaren tror att hon röstat. *(Uppgift 8)*
3. **Skalningen körs två gånger.** Ett avbrott mellan infogning och radering får inte ge dubbletter eller förlorade röster vid omkörning. *(Uppgift 9)*
4. **Partiellt dekrypteringsbevis från ett annat chiffer.** En förtroendeman som återanvänder ett tidigare bevis måste avvisas, annars kan k-1 ärliga kombineras med ett falskt bidrag. *(Uppgift 3, test i uppgift 10)*
5. **Enhetsvektor som summerar till 2.** Varje komponent kan vara giltigt 0-eller-1 och ändå ge två röster. Summabeviset är enda skyddet. *(Uppgift 2)*
6. **Noll röster på en valsedel.** Dekrypteringen ger `g^0 = 1` och diskreta logaritmen måste svara `0`, inte loopa. *(Uppgift 1)*

---

## File Structure

**Nya filer**

| Fil | Ansvar |
|---|---|
| `src/lib/crypto/group.ts` | Gruppens parametrar, modexp, slumptal, undergruppsvalidering |
| `src/lib/crypto/elgamal.ts` | Kryptering, homomorf produkt, diskret logaritm |
| `src/lib/crypto/proofs.ts` | Chaum–Pedersen: 0-eller-1, summa, likhet. Fiat–Shamir |
| `src/lib/crypto/threshold.ts` | Shamir-delning, partiell dekryptering, kombination |
| `src/lib/crypto/ballot-encoding.ts` | Kanonisk alternativlista och enhetsvektor |
| `src/lib/encrypt-client.ts` | Klientens kryptering av en valsedel, kastar slumptalet |
| `src/modules/eligibility/pending-vote.service.ts` | Det yttre kuvertet: upsert, radering |
| `src/orchestration/close-election.usecase.ts` | Skalningen: flytta chiffer, radera koppling |
| `src/orchestration/tally.usecase.ts` | Homomorf summering och tröskeldekryptering |
| `src/app/api/vote/encrypted/route.ts` | Lägg eller ändra röst |
| `src/app/api/admin/elections/close/route.ts` | Stäng och skala |
| `src/app/api/admin/elections/decrypt/route.ts` | Förtroendemannens bidrag |

**Ändrade filer**

| Fil | Ändring |
|---|---|
| `prisma/voters/schema.prisma` | `PendingVote`, `Election.linkClearedAt` |
| `prisma/votes/schema.prisma` | `EncryptedVote`, `TrusteeShare`, `PartialDecryption`, `BallotTally` |
| `src/orchestration/create-election.usecase.ts` | Generera tröskelnyckel |
| `src/orchestration/final-check.usecase.ts` | Ny CRITICAL-kontroll: kopplingen är borta |
| `src/app/rosta/page.tsx` | Visa lagd röst, tillåt ändring, visa chifferhash |
| `src/app/api/observer/votes/route.ts` | Publicera chiffer och bevis |
| `tools/verify-election.mjs` | Räkna om summan oberoende |

**Raderade filer:** `src/lib/blind-signature.ts`, `src/lib/blind-client.ts`, `src/modules/eligibility/credential.service.ts`, `src/app/api/vote/credential/route.ts`, `src/modules/ballot-box/token.service.ts`

---

## Task 1: Gruppen och ElGamal

**Files:**
- Create: `src/lib/crypto/group.ts`, `src/lib/crypto/elgamal.ts`
- Test: `tests/unit/crypto/elgamal.test.ts`

**Interfaces:**
- Consumes: ingenting
- Produces:
  ```ts
  // group.ts
  export const P: bigint
  export const Q: bigint
  export const G: bigint
  export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint
  export function randomScalar(): bigint
  export function isInSubgroup(value: bigint): boolean
  // elgamal.ts
  export type Ciphertext = { c1: bigint; c2: bigint }
  export type KeyPair = { privateKey: bigint; publicKey: bigint }
  export function generateKeyPair(): KeyPair
  export function encrypt(publicKey: bigint, message: bigint, nonce: bigint): Ciphertext
  export function multiply(a: Ciphertext, b: Ciphertext): Ciphertext
  export function decryptWithSecret(privateKey: bigint, ciphertext: Ciphertext): number
  export function discreteLog(target: bigint, maximum: number): number
  ```

- [ ] **Steg 1: Skriv de fallerande testerna**

```ts
// tests/unit/crypto/elgamal.test.ts
import { describe, expect, it } from 'vitest'
import { G, P, Q, isInSubgroup, modPow, randomScalar } from '@/lib/crypto/group'
import {
  decryptWithSecret,
  discreteLog,
  encrypt,
  generateKeyPair,
  multiply,
} from '@/lib/crypto/elgamal'

describe('gruppen', () => {
  it('g har ordning q, inte 2q', () => {
    // RFC 3526 anger g = 2, som genererar hela gruppen av ordning 2q. Vi
    // använder g = 4 = 2², vars ordning är primtalet q. Utan det finns en
    // undergrupp av ordning 2, och ett element därifrån läcker en bit av
    // nyckeln vid varje partiell dekryptering.
    expect(modPow(G, Q, P)).toBe(1n)
    expect(G).not.toBe(2n)
  })

  it('avvisar element utanför undergruppen', () => {
    expect(isInSubgroup(modPow(G, 12345n, P))).toBe(true)
    expect(isInSubgroup(1n)).toBe(false)
    expect(isInSubgroup(P - 1n)).toBe(false) // ordning 2
    expect(isInSubgroup(0n)).toBe(false)
    expect(isInSubgroup(P)).toBe(false)
  })

  it('slumptal ligger i [1, q-1]', () => {
    for (let i = 0; i < 50; i += 1) {
      const r = randomScalar()
      expect(r > 0n && r < Q).toBe(true)
    }
  })
})

describe('kryptering', () => {
  it('det som krypteras går att dekryptera', () => {
    const keys = generateKeyPair()
    const ciphertext = encrypt(keys.publicKey, 1n, randomScalar())

    expect(decryptWithSecret(keys.privateKey, ciphertext)).toBe(1)
  })

  it('samma klartext ger olika chiffer varje gång', () => {
    // Annars kan vem som helst se vilka väljare som valt samma alternativ
    // genom att jämföra chiffren, och valhemligheten faller utan att någon
    // nyckel läckt.
    const keys = generateKeyPair()
    const first = encrypt(keys.publicKey, 1n, randomScalar())
    const second = encrypt(keys.publicKey, 1n, randomScalar())

    expect(first.c1).not.toBe(second.c1)
    expect(first.c2).not.toBe(second.c2)
  })

  it('chiffer ligger i undergruppen', () => {
    const keys = generateKeyPair()
    const ciphertext = encrypt(keys.publicKey, 1n, randomScalar())

    expect(isInSubgroup(ciphertext.c1)).toBe(true)
    expect(isInSubgroup(ciphertext.c2)).toBe(true)
  })
})

describe('homomorf summering', () => {
  it('produkten av chiffer krypterar summan av klartexterna', () => {
    // Detta är hela grunden: rösterna räknas utan att någon enskild öppnas.
    const keys = generateKeyPair()
    const ones = Array.from({ length: 7 }, () => encrypt(keys.publicKey, 1n, randomScalar()))
    const zeros = Array.from({ length: 3 }, () => encrypt(keys.publicKey, 0n, randomScalar()))

    const sum = [...ones, ...zeros].reduce((a, b) => multiply(a, b))

    expect(decryptWithSecret(keys.privateKey, sum)).toBe(7)
  })

  it('en tom summa ger noll, inte en oändlig loop', () => {
    // REVIEW FOCUS 6. En valsedel utan röster ger g^0 = 1, och en naiv
    // baby-step giant-step som börjar på 1 kan missa fallet.
    const keys = generateKeyPair()
    const zero = encrypt(keys.publicKey, 0n, randomScalar())

    expect(decryptWithSecret(keys.privateKey, zero)).toBe(0)
  })
})

describe('diskret logaritm', () => {
  it('hittar små exponenter', () => {
    for (const m of [0, 1, 2, 17, 500, 4999]) {
      expect(discreteLog(modPow(G, BigInt(m), P), 5000)).toBe(m)
    }
  })

  it('kastar när värdet ligger utanför intervallet', () => {
    // Hellre ett fel än ett tyst felaktigt röstetal.
    expect(() => discreteLog(modPow(G, 9999n, P), 100)).toThrow()
  })
})
```

- [ ] **Steg 2: Kör testerna och se att de fallerar**

Kör: `npx vitest run tests/unit/crypto/elgamal.test.ts`
Förväntat: FAIL, "Failed to resolve import '@/lib/crypto/group'"

- [ ] **Steg 3: Skriv `group.ts`**

```ts
import { randomBytes } from 'node:crypto'

/**
 * RFC 3526 MODP Group 14, 2048 bitar.
 *
 * VARFÖR g = 4 OCH INTE RFC:ns g = 2
 *
 * Med g = 2 genereras hela multiplikativa gruppen, vars ordning är 2q. Den
 * innehåller då en undergrupp av ordning 2, och ett element därifrån läcker en
 * bit av den privata nyckeln vid varje partiell dekryptering. Efter tillräckligt
 * många röster är nyckeln utläsbar.
 *
 * g = 2² har ordning q, som är primtal, och då finns ingen liten undergrupp att
 * hamna i. Priset är att varje mottaget element måste kontrolleras — se
 * isInSubgroup.
 */
export const P = BigInt(
  '0x' +
    'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E08' +
    '8A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B' +
    '302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9' +
    'A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE6' +
    '49286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8' +
    'FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
    '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C' +
    '180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718' +
    '3995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFF' +
    'FFFFFFFF',
)

/** Undergruppens ordning. Alla exponenter räknas mod detta. */
export const Q = (P - 1n) / 2n

/** Generator av ordning q. */
export const G = 4n

export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let b = base % modulus
  let e = exponent

  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus
    b = (b * b) % modulus
    e >>= 1n
  }

  return result
}

/**
 * Enhetligt slumptal i [1, q-1].
 *
 * Avvisning i stället för modulo: `randomBytes % q` ger en snedfördelning mot
 * små tal, och ett förutsägbart slumptal i ElGamal avslöjar klartexten.
 */
export function randomScalar(): bigint {
  const byteLength = (Q.toString(16).length + 1) >> 1

  for (;;) {
    const candidate = BigInt('0x' + randomBytes(byteLength).toString('hex'))
    if (candidate > 0n && candidate < Q) return candidate
  }
}

/**
 * Ligger värdet i undergruppen av ordning q?
 *
 * REVIEW FOCUS 1. Ett chiffer utanför undergruppen är inte ett räknefel utan ett
 * angrepp: det låter en klient läcka en bit av tröskelnyckeln per röst.
 */
export function isInSubgroup(value: bigint): boolean {
  if (value <= 1n || value >= P) return false
  return modPow(value, Q, P) === 1n
}
```

- [ ] **Steg 4: Skriv `elgamal.ts`**

```ts
import { G, P, Q, isInSubgroup, modPow, randomScalar } from './group'

export type Ciphertext = { c1: bigint; c2: bigint }
export type KeyPair = { privateKey: bigint; publicKey: bigint }

export function generateKeyPair(): KeyPair {
  const privateKey = randomScalar()
  return { privateKey, publicKey: modPow(G, privateKey, P) }
}

/**
 * Exponentiell ElGamal: klartexten läggs i exponenten.
 *
 * Det gör summering möjlig utan dekryptering — priset är att dekrypteringen ger
 * g^m och att m måste sökas fram. Eftersom m är ett röstetal är sökrymden liten.
 */
export function encrypt(publicKey: bigint, message: bigint, nonce: bigint): Ciphertext {
  return {
    c1: modPow(G, nonce, P),
    c2: (modPow(publicKey, nonce, P) * modPow(G, message, P)) % P,
  }
}

/** Komponentvis produkt. Krypterar summan av klartexterna. */
export function multiply(a: Ciphertext, b: Ciphertext): Ciphertext {
  return { c1: (a.c1 * b.c1) % P, c2: (a.c2 * b.c2) % P }
}

/** Endast för tester och för den betrodda utdelaren. Drift använder tröskeln. */
export function decryptWithSecret(privateKey: bigint, ciphertext: Ciphertext): number {
  const shared = modPow(ciphertext.c1, privateKey, P)
  const inverse = modPow(shared, Q - 1n, P)
  return discreteLog((ciphertext.c2 * inverse) % P, 1_000_000)
}

/**
 * Baby-step giant-step över [0, maximum].
 *
 * Kastar hellre än gissar: ett röstetal utanför intervallet betyder att något
 * annat är fel, och ett tyst felaktigt tal vore värre än ett avbrott.
 */
export function discreteLog(target: bigint, maximum: number): number {
  const step = Math.ceil(Math.sqrt(maximum + 1))
  const table = new Map<string, number>()

  let value = 1n
  for (let j = 0; j <= step; j += 1) {
    table.set(value.toString(), j)
    value = (value * G) % P
  }

  const factor = modPow(modPow(G, BigInt(step), P), Q - 1n, P)
  let gamma = target

  for (let i = 0; i <= step; i += 1) {
    const found = table.get(gamma.toString())
    if (found !== undefined) {
      const result = i * step + found
      if (result <= maximum) return result
    }
    gamma = (gamma * factor) % P
  }

  throw new Error(`Diskret logaritm saknas i [0, ${maximum}].`)
}

export { isInSubgroup }
```

- [ ] **Steg 5: Kör testerna**

Kör: `npx vitest run tests/unit/crypto/elgamal.test.ts`
Förväntat: PASS, 10 tester

- [ ] **Steg 6: Committa**

```bash
git add src/lib/crypto/group.ts src/lib/crypto/elgamal.ts tests/unit/crypto/elgamal.test.ts
git commit -m "Exponentiell ElGamal i primtalsundergrupp"
```

---

## Task 2: Bevis att valsedeln är välformad

**Files:**
- Create: `src/lib/crypto/proofs.ts`
- Test: `tests/unit/crypto/proofs.test.ts`

**Interfaces:**
- Consumes: `Ciphertext`, `modPow`, `randomScalar`, `G`, `P`, `Q` från uppgift 1
- Produces:
  ```ts
  export type ZeroOrOneProof = {
    a0: bigint; b0: bigint; a1: bigint; b1: bigint
    challenge0: bigint; challenge1: bigint
    response0: bigint; response1: bigint
  }
  export type EqualityProof = { a: bigint; b: bigint; challenge: bigint; response: bigint }
  export function challengeHash(context: string, values: bigint[]): bigint
  export function proveZeroOrOne(
    publicKey: bigint, ciphertext: Ciphertext, message: 0 | 1, nonce: bigint, context: string,
  ): ZeroOrOneProof
  export function verifyZeroOrOne(
    publicKey: bigint, ciphertext: Ciphertext, proof: ZeroOrOneProof, context: string,
  ): boolean
  export function proveSumIsOne(
    publicKey: bigint, product: Ciphertext, nonceSum: bigint, context: string,
  ): EqualityProof
  export function verifySumIsOne(
    publicKey: bigint, product: Ciphertext, proof: EqualityProof, context: string,
  ): boolean
  ```

- [ ] **Steg 1: Skriv de fallerande testerna**

```ts
// tests/unit/crypto/proofs.test.ts
import { describe, expect, it } from 'vitest'
import { P, randomScalar } from '@/lib/crypto/group'
import { encrypt, generateKeyPair, multiply, type Ciphertext } from '@/lib/crypto/elgamal'
import {
  challengeHash,
  proveSumIsOne,
  proveZeroOrOne,
  verifySumIsOne,
  verifyZeroOrOne,
} from '@/lib/crypto/proofs'

const CONTEXT = 'val-1|valsedel-2|index-0'

describe('0-eller-1-bevis', () => {
  it('ett ärligt bevis för 0 går igenom', () => {
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const ciphertext = encrypt(keys.publicKey, 0n, nonce)
    const proof = proveZeroOrOne(keys.publicKey, ciphertext, 0, nonce, CONTEXT)

    expect(verifyZeroOrOne(keys.publicKey, ciphertext, proof, CONTEXT)).toBe(true)
  })

  it('ett ärligt bevis för 1 går igenom', () => {
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const ciphertext = encrypt(keys.publicKey, 1n, nonce)
    const proof = proveZeroOrOne(keys.publicKey, ciphertext, 1, nonce, CONTEXT)

    expect(verifyZeroOrOne(keys.publicKey, ciphertext, proof, CONTEXT)).toBe(true)
  })

  it('avslöjar inte vilket av de två det var', () => {
    // Beviset är disjunktivt: verifieraren lär sig "0 eller 1", ingenting mer.
    // Skulle strukturen skilja sig åt vore varje röst läsbar ur sitt bevis.
    const keys = generateKeyPair()
    const zero = proveZeroOrOne(keys.publicKey, encrypt(keys.publicKey, 0n, 7n), 0, 7n, CONTEXT)
    const one = proveZeroOrOne(keys.publicKey, encrypt(keys.publicKey, 1n, 7n), 1, 7n, CONTEXT)

    expect(Object.keys(zero).sort()).toEqual(Object.keys(one).sort())
  })

  it('ett bevis för 2 går inte att framställa', () => {
    // Utan detta kan en väljare lägga hur många röster som helst på sin kandidat.
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const ciphertext = encrypt(keys.publicKey, 2n, nonce)

    // Den ärliga bevisaren kan bara påstå 0 eller 1, och båda blir falska.
    for (const claim of [0, 1] as const) {
      const proof = proveZeroOrOne(keys.publicKey, ciphertext, claim, nonce, CONTEXT)
      expect(verifyZeroOrOne(keys.publicKey, ciphertext, proof, CONTEXT)).toBe(false)
    }
  })

  it('ett bevis går inte att flytta till ett annat chiffer', () => {
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const mine = encrypt(keys.publicKey, 1n, nonce)
    const other = encrypt(keys.publicKey, 1n, randomScalar())
    const proof = proveZeroOrOne(keys.publicKey, mine, 1, nonce, CONTEXT)

    expect(verifyZeroOrOne(keys.publicKey, other, proof, CONTEXT)).toBe(false)
  })

  it('ett bevis går inte att flytta till en annan valsedel', () => {
    // Fiat–Shamir-utmaningen binder kontexten. Utan bindningen kunde ett giltigt
    // bevis klippas ut ur en valsedel och klistras in i en annan.
    const keys = generateKeyPair()
    const nonce = randomScalar()
    const ciphertext = encrypt(keys.publicKey, 1n, nonce)
    const proof = proveZeroOrOne(keys.publicKey, ciphertext, 1, nonce, CONTEXT)

    expect(verifyZeroOrOne(keys.publicKey, ciphertext, proof, 'val-1|valsedel-9|index-0')).toBe(
      false,
    )
  })
})

describe('summabevis', () => {
  const buildBallot = (publicKey: bigint, choiceIndex: number, length: number) => {
    const nonces = Array.from({ length }, () => randomScalar())
    const ciphertexts = nonces.map((nonce, index) =>
      encrypt(publicKey, index === choiceIndex ? 1n : 0n, nonce),
    )
    const nonceSum = nonces.reduce((a, b) => a + b, 0n)
    return { ciphertexts, nonceSum }
  }

  it('en giltig enhetsvektor går igenom', () => {
    const keys = generateKeyPair()
    const { ciphertexts, nonceSum } = buildBallot(keys.publicKey, 3, 8)
    const product = ciphertexts.reduce((a, b) => multiply(a, b))
    const proof = proveSumIsOne(keys.publicKey, product, nonceSum, CONTEXT)

    expect(verifySumIsOne(keys.publicKey, product, proof, CONTEXT)).toBe(true)
  })

  it('två ettor fångas trots att varje komponent är giltig', () => {
    /**
     * REVIEW FOCUS 5.
     *
     * Det farligaste felet i hela konstruktionen. Varje komponent kan bära ett
     * korrekt 0-eller-1-bevis och vektorn ändå innehålla två ettor — väljaren
     * har då lagt två röster. Bara summabeviset ser det.
     */
    const keys = generateKeyPair()
    const nonces = Array.from({ length: 8 }, () => randomScalar())
    const ciphertexts = nonces.map((nonce, index) =>
      encrypt(keys.publicKey, index === 2 || index === 5 ? 1n : 0n, nonce),
    )
    const product = ciphertexts.reduce((a, b) => multiply(a, b))
    const proof = proveSumIsOne(
      keys.publicKey,
      product,
      nonces.reduce((a, b) => a + b, 0n),
      CONTEXT,
    )

    expect(verifySumIsOne(keys.publicKey, product, proof, CONTEXT)).toBe(false)
  })

  it('en tom vektor fångas', () => {
    const keys = generateKeyPair()
    const nonces = Array.from({ length: 8 }, () => randomScalar())
    const ciphertexts = nonces.map((nonce) => encrypt(keys.publicKey, 0n, nonce))
    const product = ciphertexts.reduce((a, b) => multiply(a, b))
    const proof = proveSumIsOne(
      keys.publicKey,
      product,
      nonces.reduce((a, b) => a + b, 0n),
      CONTEXT,
    )

    expect(verifySumIsOne(keys.publicKey, product, proof, CONTEXT)).toBe(false)
  })
})

describe('utmaningen', () => {
  it('är deterministisk och beror på allt som matas in', () => {
    expect(challengeHash('a', [1n, 2n])).toBe(challengeHash('a', [1n, 2n]))
    expect(challengeHash('a', [1n, 2n])).not.toBe(challengeHash('b', [1n, 2n]))
    expect(challengeHash('a', [1n, 2n])).not.toBe(challengeHash('a', [1n, 3n]))
    expect(challengeHash('a', [1n, 2n])).not.toBe(challengeHash('a', [2n, 1n]))
  })
})
```

- [ ] **Steg 2: Kör testerna och se att de fallerar**

Kör: `npx vitest run tests/unit/crypto/proofs.test.ts`
Förväntat: FAIL, "Failed to resolve import '@/lib/crypto/proofs'"

- [ ] **Steg 3: Implementera `proofs.ts`**

```ts
import { createHash } from 'node:crypto'
import { G, P, Q, modPow, randomScalar } from './group'
import type { Ciphertext } from './elgamal'

/**
 * BEVISEN ÄR INTE VALFRIA.
 *
 * En krypterad valsedel utan bevis är ogranskbar: en klient kan lägga 1000
 * röster på en kandidat, och ingenting syns förrän slutsumman är orimlig — då
 * är kopplingen till väljaren redan raderad och felet omöjligt att spåra.
 *
 * Två bevis behövs, och båda krävs:
 *   – varje komponent krypterar 0 eller 1
 *   – hela vektorn summerar till exakt 1
 *
 * Det andra är inte överflödigt. Varje komponent kan vara giltig och vektorn
 * ändå innehålla två ettor.
 */

export type ZeroOrOneProof = {
  a0: bigint
  b0: bigint
  a1: bigint
  b1: bigint
  challenge0: bigint
  challenge1: bigint
  response0: bigint
  response1: bigint
}

export type EqualityProof = { a: bigint; b: bigint; challenge: bigint; response: bigint }

/**
 * Fiat–Shamir: utmaningen härleds ur allt som ska bindas.
 *
 * `context` bär valets och valsedelns id samt komponentens index. Utan det kan
 * ett giltigt bevis klippas ut ur en valsedel och återanvändas i en annan.
 */
export function challengeHash(context: string, values: bigint[]): bigint {
  const hash = createHash('sha256')
  hash.update('valsystem/bevis/v1\u0000')
  hash.update(context)
  for (const value of values) {
    hash.update('\u0000')
    hash.update(value.toString(16))
  }
  return BigInt('0x' + hash.digest('hex')) % Q
}

export function proveZeroOrOne(
  publicKey: bigint,
  ciphertext: Ciphertext,
  message: 0 | 1,
  nonce: bigint,
  context: string,
): ZeroOrOneProof {
  // Den gren som är sann bevisas ärligt; den falska simuleras baklänges med en
  // på förhand vald utmaning. Verifieraren kan inte skilja dem åt.
  const fakeChallenge = randomScalar()
  const fakeResponse = randomScalar()
  const honestCommitment = randomScalar()

  const shifted = message === 1 ? (ciphertext.c2 * modPow(G, Q - 1n, P)) % P : ciphertext.c2

  const simulated = {
    a: (modPow(G, fakeResponse, P) * modPow(ciphertext.c1, Q - fakeChallenge, P)) % P,
    b:
      (modPow(publicKey, fakeResponse, P) *
        modPow(message === 1 ? ciphertext.c2 : shifted, Q - fakeChallenge, P)) %
      P,
  }

  const honest = { a: modPow(G, honestCommitment, P), b: modPow(publicKey, honestCommitment, P) }

  const [first, second] = message === 0 ? [honest, simulated] : [simulated, honest]

  const challenge = challengeHash(context, [
    ciphertext.c1,
    ciphertext.c2,
    first.a,
    first.b,
    second.a,
    second.b,
  ])

  const honestChallenge = (Q + challenge - fakeChallenge) % Q
  const honestResponse = (honestCommitment + honestChallenge * nonce) % Q

  return message === 0
    ? {
        a0: honest.a,
        b0: honest.b,
        a1: simulated.a,
        b1: simulated.b,
        challenge0: honestChallenge,
        challenge1: fakeChallenge,
        response0: honestResponse,
        response1: fakeResponse,
      }
    : {
        a0: simulated.a,
        b0: simulated.b,
        a1: honest.a,
        b1: honest.b,
        challenge0: fakeChallenge,
        challenge1: honestChallenge,
        response0: fakeResponse,
        response1: honestResponse,
      }
}

export function verifyZeroOrOne(
  publicKey: bigint,
  ciphertext: Ciphertext,
  proof: ZeroOrOneProof,
  context: string,
): boolean {
  const challenge = challengeHash(context, [
    ciphertext.c1,
    ciphertext.c2,
    proof.a0,
    proof.b0,
    proof.a1,
    proof.b1,
  ])

  if ((proof.challenge0 + proof.challenge1) % Q !== challenge) return false

  const zeroBranch =
    modPow(G, proof.response0, P) === (proof.a0 * modPow(ciphertext.c1, proof.challenge0, P)) % P &&
    modPow(publicKey, proof.response0, P) ===
      (proof.b0 * modPow(ciphertext.c2, proof.challenge0, P)) % P

  const shifted = (ciphertext.c2 * modPow(G, Q - 1n, P)) % P

  const oneBranch =
    modPow(G, proof.response1, P) === (proof.a1 * modPow(ciphertext.c1, proof.challenge1, P)) % P &&
    modPow(publicKey, proof.response1, P) === (proof.b1 * modPow(shifted, proof.challenge1, P)) % P

  return zeroBranch && oneBranch
}

export function proveSumIsOne(
  publicKey: bigint,
  product: Ciphertext,
  nonceSum: bigint,
  context: string,
): EqualityProof {
  const commitment = randomScalar()
  const a = modPow(G, commitment, P)
  const b = modPow(publicKey, commitment, P)
  const challenge = challengeHash(context + '|summa', [product.c1, product.c2, a, b])

  return { a, b, challenge, response: (commitment + challenge * (nonceSum % Q)) % Q }
}

export function verifySumIsOne(
  publicKey: bigint,
  product: Ciphertext,
  proof: EqualityProof,
  context: string,
): boolean {
  if (proof.challenge !== challengeHash(context + '|summa', [product.c1, product.c2, proof.a, proof.b]))
    return false

  // Produkten ska kryptera exakt g^1, alltså c2 delat med g.
  const shifted = (product.c2 * modPow(G, Q - 1n, P)) % P

  return (
    modPow(G, proof.response, P) === (proof.a * modPow(product.c1, proof.challenge, P)) % P &&
    modPow(publicKey, proof.response, P) === (proof.b * modPow(shifted, proof.challenge, P)) % P
  )
}
```

- [ ] **Steg 4: Kör testerna**

Kör: `npx vitest run tests/unit/crypto/proofs.test.ts`
Förväntat: PASS, 10 tester

- [ ] **Steg 5: Committa**

```bash
git add src/lib/crypto/proofs.ts tests/unit/crypto/proofs.test.ts
git commit -m "Chaum-Pedersen: valsedeln bevisas välformad utan att avslöjas"
```

---

## Task 3: Tröskelnyckel

**Files:**
- Create: `src/lib/crypto/threshold.ts`
- Test: `tests/unit/crypto/threshold.test.ts`

**Interfaces:**
- Consumes: `Ciphertext`, `EqualityProof`, `challengeHash`, `modPow`, `G`, `P`, `Q`, `randomScalar`
- Produces:
  ```ts
  export type Share = { index: number; value: bigint }
  export type PartialDecryption = { trusteeIndex: number; value: bigint; proof: EqualityProof }
  export function splitSecret(secret: bigint, trustees: number, threshold: number): Share[]
  export function publicShare(share: Share): bigint
  export function partiallyDecrypt(share: Share, ciphertext: Ciphertext): PartialDecryption
  export function verifyPartialDecryption(
    expectedPublicShare: bigint, ciphertext: Ciphertext, partial: PartialDecryption,
  ): boolean
  export function combine(ciphertext: Ciphertext, partials: PartialDecryption[]): bigint
  ```

- [ ] **Steg 1: Skriv de fallerande testerna**

```ts
// tests/unit/crypto/threshold.test.ts
import { describe, expect, it } from 'vitest'
import { G, P, modPow, randomScalar } from '@/lib/crypto/group'
import { discreteLog, encrypt, generateKeyPair, multiply } from '@/lib/crypto/elgamal'
import {
  combine,
  partiallyDecrypt,
  publicShare,
  splitSecret,
  verifyPartialDecryption,
} from '@/lib/crypto/threshold'

describe('delning av nyckeln', () => {
  it('två av tre räcker för att öppna summan', () => {
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const sum = [1n, 1n, 0n, 1n]
      .map((m) => encrypt(keys.publicKey, m, randomScalar()))
      .reduce((a, b) => multiply(a, b))

    const partials = [shares[0]!, shares[2]!].map((share) => partiallyDecrypt(share, sum))

    expect(discreteLog(combine(sum, partials), 100)).toBe(3)
  })

  it('vilka två som helst ger samma svar', () => {
    // Lagrange-koefficienterna beror på vilka index som deltar. Räknas de fel
    // blir resultatet fel bara för vissa kombinationer — alltså ett fel som
    // uppträder på valnatten och inte i utvecklingen.
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const sum = encrypt(keys.publicKey, 5n, randomScalar())

    for (const pair of [[0, 1], [0, 2], [1, 2]]) {
      const partials = pair.map((i) => partiallyDecrypt(shares[i]!, sum))
      expect(discreteLog(combine(sum, partials), 100)).toBe(5)
    }
  })

  it('en ensam förtroendeman kan inte öppna någonting', () => {
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const sum = encrypt(keys.publicKey, 5n, randomScalar())

    expect(() => discreteLog(combine(sum, [partiallyDecrypt(shares[0]!, sum)]), 100)).toThrow()
  })
})

describe('bevis för partiell dekryptering', () => {
  it('ett ärligt bidrag går igenom', () => {
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const ciphertext = encrypt(keys.publicKey, 1n, randomScalar())
    const partial = partiallyDecrypt(shares[0]!, ciphertext)

    expect(verifyPartialDecryption(publicShare(shares[0]!), ciphertext, partial)).toBe(true)
  })

  it('ett påhittat värde avvisas', () => {
    // Utan beviset kan en förtroendeman skeva resultatet obemärkt: summan blir
    // fel och ingen kan peka ut vem som orsakade det.
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const ciphertext = encrypt(keys.publicKey, 1n, randomScalar())
    const partial = partiallyDecrypt(shares[0]!, ciphertext)

    const tampered = { ...partial, value: (partial.value * G) % P }

    expect(verifyPartialDecryption(publicShare(shares[0]!), ciphertext, tampered)).toBe(false)
  })

  it('ett bevis från ett annat chiffer avvisas', () => {
    /**
     * REVIEW FOCUS 4.
     *
     * En förtroendeman som återanvänder ett tidigare bevis kan annars bidra med
     * ett värde som inte hör till det chiffer som räknas, och k-1 ärliga
     * bidrag räcker då inte för att upptäcka det.
     */
    const keys = generateKeyPair()
    const shares = splitSecret(keys.privateKey, 3, 2)
    const first = encrypt(keys.publicKey, 1n, randomScalar())
    const second = encrypt(keys.publicKey, 1n, randomScalar())
    const partial = partiallyDecrypt(shares[0]!, first)

    expect(verifyPartialDecryption(publicShare(shares[0]!), second, partial)).toBe(false)
  })
})
```

- [ ] **Steg 2: Kör testerna och se att de fallerar**

Kör: `npx vitest run tests/unit/crypto/threshold.test.ts`
Förväntat: FAIL, "Failed to resolve import '@/lib/crypto/threshold'"

- [ ] **Steg 3: Implementera `threshold.ts`**

```ts
import { G, P, Q, modPow, randomScalar } from './group'
import type { Ciphertext } from './elgamal'
import { challengeHash, type EqualityProof } from './proofs'

/**
 * SHAMIR-DELNING ÖVER Z_q.
 *
 * Nyckeln som öppnar valresultatet får inte finnas hos en enda person. Den delas
 * i n andelar där k krävs för att öppna, så att en ensam administratör varken
 * kan läsa resultatet i förtid eller vägra släppa det.
 *
 * BETRODD UTDELARE — och det är en känd begränsning. Under ett kort ögonblick
 * vid valets skapande existerar hela den privata nyckeln på ett ställe. Riktig
 * distribuerad nyckelgenerering låter förtroendemännen bygga nyckeln utan att
 * den någonsin sätts ihop; det ligger utanför den här etappen.
 */

export type Share = { index: number; value: bigint }
export type PartialDecryption = { trusteeIndex: number; value: bigint; proof: EqualityProof }

export function splitSecret(secret: bigint, trustees: number, threshold: number): Share[] {
  // Polynom av grad k-1 med hemligheten som konstantterm.
  const coefficients = [secret, ...Array.from({ length: threshold - 1 }, () => randomScalar())]

  return Array.from({ length: trustees }, (_, position) => {
    const x = BigInt(position + 1)
    let value = 0n
    let power = 1n

    for (const coefficient of coefficients) {
      value = (value + coefficient * power) % Q
      power = (power * x) % Q
    }

    return { index: position + 1, value }
  })
}

export function publicShare(share: Share): bigint {
  return modPow(G, share.value, P)
}

export function partiallyDecrypt(share: Share, ciphertext: Ciphertext): PartialDecryption {
  const value = modPow(ciphertext.c1, share.value, P)

  // Beviset binder BÅDE c1 och generatorn till samma exponent, så bidraget kan
  // inte flyttas till ett annat chiffer.
  const commitment = randomScalar()
  const a = modPow(G, commitment, P)
  const b = modPow(ciphertext.c1, commitment, P)
  const challenge = challengeHash('partiell-dekryptering', [
    publicShare(share),
    ciphertext.c1,
    value,
    a,
    b,
  ])

  return {
    trusteeIndex: share.index,
    value,
    proof: { a, b, challenge, response: (commitment + challenge * share.value) % Q },
  }
}

export function verifyPartialDecryption(
  expectedPublicShare: bigint,
  ciphertext: Ciphertext,
  partial: PartialDecryption,
): boolean {
  const { proof } = partial

  if (
    proof.challenge !==
    challengeHash('partiell-dekryptering', [
      expectedPublicShare,
      ciphertext.c1,
      partial.value,
      proof.a,
      proof.b,
    ])
  ) {
    return false
  }

  return (
    modPow(G, proof.response, P) === (proof.a * modPow(expectedPublicShare, proof.challenge, P)) % P &&
    modPow(ciphertext.c1, proof.response, P) ===
      (proof.b * modPow(partial.value, proof.challenge, P)) % P
  )
}

/** Returnerar g^m. Anroparen tar den diskreta logaritmen. */
export function combine(ciphertext: Ciphertext, partials: PartialDecryption[]): bigint {
  const indices = partials.map((partial) => BigInt(partial.trusteeIndex))

  let shared = 1n
  for (const partial of partials) {
    const i = BigInt(partial.trusteeIndex)

    // Lagrange-koefficient vid x = 0, räknad mod q.
    let numerator = 1n
    let denominator = 1n
    for (const j of indices) {
      if (j === i) continue
      numerator = (numerator * j) % Q
      denominator = (denominator * ((Q + j - i) % Q)) % Q
    }

    const lambda = (numerator * modPow(denominator, Q - 2n, Q)) % Q
    shared = (shared * modPow(partial.value, lambda, P)) % P
  }

  return (ciphertext.c2 * modPow(shared, Q - 1n, P)) % P
}
```

- [ ] **Steg 4: Kör testerna**

Kör: `npx vitest run tests/unit/crypto/threshold.test.ts`
Förväntat: PASS, 6 tester

- [ ] **Steg 5: Committa**

```bash
git add src/lib/crypto/threshold.ts tests/unit/crypto/threshold.test.ts
git commit -m "Tröskelnyckel: två av tre förtroendemän öppnar resultatet"
```

---

## Task 4: Valsedeln som enhetsvektor

**Files:**
- Create: `src/lib/crypto/ballot-encoding.ts`
- Test: `tests/unit/crypto/ballot-encoding.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type BallotOption =
    | { kind: 'BLANK' }
    | { kind: 'PARTY'; ballotPartyId: string }
    | { kind: 'CANDIDATE'; ballotPartyId: string; candidateId: string }
  export type BallotShape = {
    allowsCandidateVote: boolean
    parties: Array<{ id: string; displayOrder: number; candidates: Array<{ id: string; displayOrder: number }> }>
  }
  export function canonicalOptions(shape: BallotShape): BallotOption[]
  export function indexOfChoice(options: BallotOption[], choice: BallotOption): number
  export function unitVector(length: number, index: number): bigint[]
  ```

- [ ] **Steg 1: Skriv de fallerande testerna**

```ts
// tests/unit/crypto/ballot-encoding.test.ts
import { describe, expect, it } from 'vitest'
import {
  canonicalOptions,
  indexOfChoice,
  unitVector,
  type BallotShape,
} from '@/lib/crypto/ballot-encoding'

const SHAPE: BallotShape = {
  allowsCandidateVote: true,
  parties: [
    { id: 'bp-s', displayOrder: 1, candidates: [{ id: 'k-anna', displayOrder: 1 }] },
    { id: 'bp-m', displayOrder: 2, candidates: [] },
  ],
}

describe('kanonisk ordning', () => {
  it('blank röst ligger alltid först', () => {
    // Utan ett blankalternativ kan den som inte vill rösta på något inte
    // producera en vektor som summerar till 1, och summabeviset faller.
    expect(canonicalOptions(SHAPE)[0]).toEqual({ kind: 'BLANK' })
  })

  it('partier före kandidater, båda i displayOrder', () => {
    expect(canonicalOptions(SHAPE)).toEqual([
      { kind: 'BLANK' },
      { kind: 'PARTY', ballotPartyId: 'bp-s' },
      { kind: 'PARTY', ballotPartyId: 'bp-m' },
      { kind: 'CANDIDATE', ballotPartyId: 'bp-s', candidateId: 'k-anna' },
    ])
  })

  it('utelämnar kandidater när valsedeln inte tillåter personröst', () => {
    const options = canonicalOptions({ ...SHAPE, allowsCandidateVote: false })

    expect(options).toHaveLength(3)
    expect(options.some((option) => option.kind === 'CANDIDATE')).toBe(false)
  })

  it('ordningen är stabil oavsett hur indata råkar komma', () => {
    // Klient, server och den oberoende verifieraren måste räkna fram exakt
    // samma lista. Skiljer de sig på en enda plats räknas röster på fel
    // alternativ, och ingenting i bevisen fångar det.
    const shuffled: BallotShape = { ...SHAPE, parties: [...SHAPE.parties].reverse() }

    expect(canonicalOptions(shuffled)).toEqual(canonicalOptions(SHAPE))
  })
})

describe('enhetsvektor', () => {
  it('sätter exakt en etta', () => {
    expect(unitVector(4, 2)).toEqual([0n, 0n, 1n, 0n])
  })

  it('kastar på index utanför vektorn', () => {
    expect(() => unitVector(4, 4)).toThrow()
    expect(() => unitVector(4, -1)).toThrow()
  })

  it('indexOfChoice hittar rätt plats', () => {
    const options = canonicalOptions(SHAPE)

    expect(indexOfChoice(options, { kind: 'PARTY', ballotPartyId: 'bp-m' })).toBe(2)
    expect(
      indexOfChoice(options, { kind: 'CANDIDATE', ballotPartyId: 'bp-s', candidateId: 'k-anna' }),
    ).toBe(3)
  })

  it('kastar på ett val som inte finns på valsedeln', () => {
    expect(() =>
      indexOfChoice(canonicalOptions(SHAPE), { kind: 'PARTY', ballotPartyId: 'bp-okänt' }),
    ).toThrow()
  })
})
```

- [ ] **Steg 2: Kör testerna och se att de fallerar**

Kör: `npx vitest run tests/unit/crypto/ballot-encoding.test.ts`
Förväntat: FAIL, "Failed to resolve import"

- [ ] **Steg 3: Implementera `ballot-encoding.ts`**

```ts
/**
 * VALSEDELN SOM ENHETSVEKTOR.
 *
 * Varje alternativ får en plats i en vektor. Väljarens val är en etta på sin
 * plats och nollor på alla andra. Varje komponent krypteras för sig, och
 * summan av alla väljares vektorer ger röstetalen — utan att någon enskild
 * vektor öppnas.
 *
 * ORDNINGEN MÅSTE VARA IDENTISK ÖVERALLT. Klienten bygger vektorn, servern
 * verifierar bevisen, och den oberoende verifieraren räknar om summan. Skiljer
 * sig listan på en enda plats räknas röster på fel alternativ, och ingenting i
 * bevisen fångar det — de bevisar bara att vektorn är välformad, inte att den
 * betyder samma sak för alla.
 */

export type BallotOption =
  | { kind: 'BLANK' }
  | { kind: 'PARTY'; ballotPartyId: string }
  | { kind: 'CANDIDATE'; ballotPartyId: string; candidateId: string }

export type BallotShape = {
  allowsCandidateVote: boolean
  parties: Array<{
    id: string
    displayOrder: number
    candidates: Array<{ id: string; displayOrder: number }>
  }>
}

export function canonicalOptions(shape: BallotShape): BallotOption[] {
  const parties = [...shape.parties].sort((a, b) => a.displayOrder - b.displayOrder)

  const options: BallotOption[] = [{ kind: 'BLANK' }]

  for (const party of parties) {
    options.push({ kind: 'PARTY', ballotPartyId: party.id })
  }

  if (shape.allowsCandidateVote) {
    for (const party of parties) {
      const candidates = [...party.candidates].sort((a, b) => a.displayOrder - b.displayOrder)
      for (const candidate of candidates) {
        options.push({ kind: 'CANDIDATE', ballotPartyId: party.id, candidateId: candidate.id })
      }
    }
  }

  return options
}

export function indexOfChoice(options: BallotOption[], choice: BallotOption): number {
  const index = options.findIndex(
    (option) => JSON.stringify(option) === JSON.stringify(choice),
  )

  if (index === -1) throw new Error('Valet finns inte på den här valsedeln.')
  return index
}

export function unitVector(length: number, index: number): bigint[] {
  if (index < 0 || index >= length) throw new Error(`Index ${index} ligger utanför vektorn.`)
  return Array.from({ length }, (_, position) => (position === index ? 1n : 0n))
}
```

- [ ] **Steg 4: Kör testerna**

Kör: `npx vitest run tests/unit/crypto/ballot-encoding.test.ts`
Förväntat: PASS, 9 tester

- [ ] **Steg 5: Committa**

```bash
git add src/lib/crypto/ballot-encoding.ts tests/unit/crypto/ballot-encoding.test.ts
git commit -m "Valsedeln kodas som enhetsvektor med blankalternativ först"
```

---

## Task 5: Schema och migrering

**Files:**
- Modify: `prisma/voters/schema.prisma`, `prisma/votes/schema.prisma`
- Create: `prisma/voters/migrations/<tid>_pending_vote/migration.sql`, `prisma/votes/migrations/<tid>_encrypted_vote/migration.sql`
- Modify: `tests/security/schema-separation.test.ts`

- [ ] **Steg 1: Skriv det fallerande testet**

```ts
// Läggs till i tests/security/schema-separation.test.ts
it('PendingVote bär identitet och hör därför hemma i röstlängden', () => {
  expect(votersFields).toMatch(/model PendingVote \{/)
  expect(votesFields).not.toMatch(/model PendingVote \{/)
})

it('EncryptedVote innehåller ingen identitet', () => {
  const model = votesFields.match(/model EncryptedVote \{[\s\S]*?\n\}/)?.[0] ?? ''

  expect(model).not.toBe('')
  for (const forbidden of ['voterStatusId', 'personalNumber', 'identityHash', 'sessionId']) {
    expect(model, `EncryptedVote innehåller ${forbidden}`).not.toContain(forbidden)
  }
})

it('kopplingen har en unik nyckel per väljare och valsedel', () => {
  // Utan den kan en väljare få två liggande röster på samma valsedel, och
  // skalningen skulle flytta båda.
  const model = votersFields.match(/model PendingVote \{[\s\S]*?\n\}/)?.[0] ?? ''

  expect(model).toContain('@@unique([voterStatusId, ballotId])')
})
```

- [ ] **Steg 2: Kör och se att det fallerar**

Kör: `npx vitest run tests/security/schema-separation.test.ts`
Förväntat: FAIL, "expected '' not to be ''"

- [ ] **Steg 3: Lägg till modellerna i `prisma/voters/schema.prisma`**

```prisma
/// Det yttre kuvertet: vem som röstat, plus ett chiffer systemet inte kan läsa.
///
/// RADEN ERSÄTTS NÄR VÄLJAREN ÄNDRAR SIG, och RADERAS när röstningen stänger.
/// Det är hela mekanismen mot röstköp: en köpare måste bevaka väljaren fram
/// till stängningen för att vara säker på vad som räknas.
///
/// Att kopplingen existerar under röstningen är ett medvetet byte mot den
/// tidigare konstruktionen, där den var fysiskt omöjlig. Se
/// docs/spec/2026-09-22-dubbla-kuvert.md avsnitt 9.
model PendingVote {
  id String @id @default(uuid())

  voterStatusId String      @map("voter_status_id")
  voterStatus   VoterStatus @relation(fields: [voterStatusId], references: [id], onDelete: Cascade)

  /// Speglat id. Ingen FK — valsedeln bor i den andra databasen.
  ballotId String @map("ballot_id")

  /// M par (c1, c2) som decimalsträngar.
  ciphertext Json

  /// M stycken 0/1-bevis plus ett summabevis.
  proofs Json

  /// SHA-256 över den kanoniska serialiseringen. Väljarens inklusionshandtag.
  ciphertextHash String @map("ciphertext_hash")

  /// Dygnsupplöst, som all annan tidsdata i röstlängden.
  updatedAt DateTime @map("updated_at")

  @@unique([voterStatusId, ballotId])
  @@index([ballotId])
  @@map("pending_vote")
}
```

Lägg till på `Election` i samma fil:

```prisma
  /// När kopplingen väljare↔röst raderades. Null medan röstningen pågår.
  linkClearedAt DateTime? @map("link_cleared_at")
```

Och på `VoterStatus`:

```prisma
  pendingVotes PendingVote[]
```

- [ ] **Steg 4: Lägg till modellerna i `prisma/votes/schema.prisma`**

```prisma
/// Det inre kuvertet, efter att identitetslagret skalats bort.
model EncryptedVote {
  id String @id @default(uuid())

  ballotId String         @map("ballot_id")
  ballot   ElectionBallot @relation(fields: [ballotId], references: [id], onDelete: Cascade)

  ciphertext Json
  proofs     Json

  /// Unik: gör skalningen idempotent. En avbruten körning kan köras om utan
  /// att skapa dubbletter.
  ciphertextHash String @unique @map("ciphertext_hash")

  @@index([ballotId])
  @@map("encrypted_vote")
}

/// En förtroendemans andel av dekrypteringsnyckeln.
model TrusteeShare {
  id String @id @default(uuid())

  electionId String   @map("election_id")
  election   Election @relation(fields: [electionId], references: [id], onDelete: Cascade)

  trusteeIndex Int @map("trustee_index")

  /// g^{x_i}. Publik, och det som bevisen kontrolleras mot.
  publicShare String @map("public_share")

  /// x_i, skyddad. En andel i klartext här vore lika illa som ingen delning.
  encryptedShare String @map("encrypted_share")

  @@unique([electionId, trusteeIndex])
  @@map("trustee_share")
}

model PartialDecryption {
  id String @id @default(uuid())

  ballotId String         @map("ballot_id")
  ballot   ElectionBallot @relation(fields: [ballotId], references: [id], onDelete: Cascade)

  optionIndex  Int    @map("option_index")
  trusteeIndex Int    @map("trustee_index")
  value        String
  proof        Json

  @@unique([ballotId, optionIndex, trusteeIndex])
  @@map("partial_decryption")
}

model BallotTally {
  id String @id @default(uuid())

  ballotId String         @map("ballot_id")
  ballot   ElectionBallot @relation(fields: [ballotId], references: [id], onDelete: Cascade)

  optionIndex Int @map("option_index")
  count       Int

  @@unique([ballotId, optionIndex])
  @@map("ballot_tally")
}
```

Lägg till på `Election`:

```prisma
  /// Valets publika krypteringsnyckel, h = g^x.
  encryptionPublicKey String? @map("encryption_public_key")

  tallyCompletedAt DateTime? @map("tally_completed_at")

  trusteeShares TrusteeShare[]
```

Och på `ElectionBallot`:

```prisma
  encryptedVotes     EncryptedVote[]
  partialDecryptions PartialDecryption[]
  tallies            BallotTally[]
```

- [ ] **Steg 5: Generera migreringarna**

```bash
npx prisma migrate dev --schema=prisma/voters/schema.prisma --name pending_vote --create-only
npx prisma migrate dev --schema=prisma/votes/schema.prisma --name encrypted_vote --create-only
npm run migrate
npm run generate
```

Stoppa dev-servern först — den håller Prisma-motorens DLL låst på Windows.

- [ ] **Steg 6: Kör testerna**

Kör: `npx vitest run tests/security/schema-separation.test.ts`
Förväntat: PASS

- [ ] **Steg 7: Committa**

```bash
git add prisma/ tests/security/schema-separation.test.ts
git commit -m "Schema för dubbla kuvert: PendingVote och EncryptedVote"
```

---

## Task 6: Tröskelnyckel vid valets skapande

**Files:**
- Modify: `src/orchestration/create-election.usecase.ts`
- Test: `tests/integration/threshold-key.test.ts`

**Interfaces:**
- Consumes: `generateKeyPair`, `splitSecret`, `publicShare` från uppgift 1 och 3
- Produces: `createElection` sparar `encryptionPublicKey` och tre `TrusteeShare`

- [ ] **Steg 1: Skriv det fallerande testet**

```ts
// tests/integration/threshold-key.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { votesDb } from '@/modules/ballot-box/db'
import { createElection } from '@/orchestration/create-election.usecase'
import { disconnect, firstPartyId, isDatabaseAvailable, resetElectionData } from './helpers'
import { isInSubgroup } from '@/lib/crypto/group'

const databaseAvailable = await isDatabaseAvailable()

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

describe.skipIf(!databaseAvailable)('tröskelnyckel vid skapande', () => {
  beforeEach(async () => {
    await resetElectionData()
  })

  async function newElection() {
    const partyId = await firstPartyId()
    const outcome = await createElection({
      name: 'Nyckeltest',
      kind: 'RIKSDAGSVAL',
      opensAt: new Date(Date.now() - 60_000),
      closesAt: new Date(Date.now() + 3_600_000),
      ballots: [
        { kind: 'RIKSDAG', label: 'Riksdagen', allowsCandidateVote: false, parties: [{ partyId }] },
      ],
    })
    if (outcome.status !== 'created') throw new Error('kunde inte skapa')
    return outcome.election.id
  }

  it('sparar en publik nyckel i undergruppen', async () => {
    const id = await newElection()
    const election = await votesDb.election.findUniqueOrThrow({ where: { id } })

    expect(election.encryptionPublicKey).toBeTruthy()
    expect(isInSubgroup(BigInt(election.encryptionPublicKey!))).toBe(true)
  })

  it('skapar tre andelar', async () => {
    const id = await newElection()

    expect(await votesDb.trusteeShare.count({ where: { electionId: id } })).toBe(3)
  })

  it('lagrar ingen andel i klartext bredvid sin publika motsvarighet', () => {
    // Skulle encryptedShare vara samma värde som ligger bakom publicShare vore
    // hela delningen teater.
    expect(true).toBe(true) // ersätts i steg 3 med ett riktigt värdetest
  })
})
```

- [ ] **Steg 2: Kör och se att det fallerar**

Kör: `npx vitest run tests/integration/threshold-key.test.ts`
Förväntat: FAIL, `encryptionPublicKey` finns inte

- [ ] **Steg 3: Utöka `createElection`**

I `src/orchestration/create-election.usecase.ts`, efter att omröstningen skapats i `votes_db`:

```ts
import { generateKeyPair } from '@/lib/crypto/elgamal'
import { publicShare, splitSecret } from '@/lib/crypto/threshold'
import { encryptShare } from '@/lib/crypto/share-storage'

/**
 * TRE ANDELAR, TVÅ KRÄVS.
 *
 * Nyckeln som öppnar resultatet får inte ligga hos en ensam administratör —
 * varken för att kunna läsa i förtid eller för att kunna vägra släppa siffrorna.
 *
 * Den ursprungliga privata nyckeln raderas här och lämnar aldrig funktionen.
 * Att den existerar alls under ett ögonblick är den betrodda utdelarens svaghet,
 * och den står som känd begränsning.
 */
const keys = generateKeyPair()
const shares = splitSecret(keys.privateKey, 3, 2)

await votesDb.election.update({
  where: { id: election.id },
  data: { encryptionPublicKey: keys.publicKey.toString() },
})

await votesDb.trusteeShare.createMany({
  data: shares.map((share) => ({
    electionId: election.id,
    trusteeIndex: share.index,
    publicShare: publicShare(share).toString(),
    encryptedShare: encryptShare(share.value),
  })),
})
```

- [ ] **Steg 4: Skriv `src/lib/crypto/share-storage.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { env } from '@/lib/env'

/**
 * Andelarna skyddas med AES-256-GCM under en nyckel härledd ur miljön.
 *
 * DET ÄR INTE TILLRÄCKLIGT FÖR ETT RIKTIGT VAL, och det ska stå så. En riktig
 * konstruktion låter varje förtroendeman hålla sin andel på egen hårdvara, så
 * att en databasdump plus applikationens miljö inte räcker för att öppna
 * resultatet. Här är målet att visa mekaniken, inte att skydda den.
 */
const KEY = scryptSync(env.identityPepper, 'trustee-share', 32)

export function encryptShare(value: bigint): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const encrypted = Buffer.concat([cipher.update(value.toString(), 'utf8'), cipher.final()])

  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(
    ':',
  )
}

export function decryptShare(stored: string): bigint {
  const [iv, tag, payload] = stored.split(':')
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv!, 'hex'))
  decipher.setAuthTag(Buffer.from(tag!, 'hex'))

  return BigInt(
    Buffer.concat([decipher.update(Buffer.from(payload!, 'hex')), decipher.final()]).toString(
      'utf8',
    ),
  )
}
```

- [ ] **Steg 5: Byt ut platshållartestet i steg 1**

```ts
  it('andelen lagras skyddad, inte i klartext', async () => {
    const id = await newElection()
    const share = await votesDb.trusteeShare.findFirstOrThrow({ where: { electionId: id } })

    // AES-GCM-formatet är iv:tag:payload — tre hexdelar.
    expect(share.encryptedShare.split(':')).toHaveLength(3)
    expect(() => BigInt(share.encryptedShare)).toThrow()
  })
```

- [ ] **Steg 6: Kör testerna**

Kör: `npx vitest run tests/integration/threshold-key.test.ts`
Förväntat: PASS, 3 tester

- [ ] **Steg 7: Committa**

```bash
git add src/orchestration/create-election.usecase.ts src/lib/crypto/share-storage.ts tests/integration/threshold-key.test.ts
git commit -m "Varje omröstning får en tröskelnyckel delad på tre"
```

---

## Task 7: Klientens kryptering

**Files:**
- Create: `src/lib/encrypt-client.ts`
- Test: `tests/unit/encrypt-client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type EncryptedBallot = {
    ciphertext: Array<{ c1: string; c2: string }>
    proofs: { components: ZeroOrOneProof[]; sum: EqualityProof }
    ciphertextHash: string
  }
  export function encryptBallot(
    publicKey: string, electionId: string, ballotId: string,
    options: BallotOption[], choice: BallotOption,
  ): EncryptedBallot
  export function hashCiphertext(ciphertext: Array<{ c1: string; c2: string }>): string
  ```

- [ ] **Steg 1: Skriv de fallerande testerna**

```ts
// tests/unit/encrypt-client.test.ts
import { describe, expect, it } from 'vitest'
import { generateKeyPair } from '@/lib/crypto/elgamal'
import { canonicalOptions } from '@/lib/crypto/ballot-encoding'
import { encryptBallot, hashCiphertext } from '@/lib/encrypt-client'
import { verifyEncryptedBallot } from '@/lib/crypto/verify-ballot'

const SHAPE = {
  allowsCandidateVote: false,
  parties: [
    { id: 'bp-s', displayOrder: 1, candidates: [] },
    { id: 'bp-m', displayOrder: 2, candidates: [] },
  ],
}

describe('krypterad valsedel', () => {
  it('servern accepterar en ärligt krypterad valsedel', () => {
    const keys = generateKeyPair()
    const options = canonicalOptions(SHAPE)
    const ballot = encryptBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options, {
      kind: 'PARTY',
      ballotPartyId: 'bp-m',
    })

    expect(
      verifyEncryptedBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options.length, ballot),
    ).toBe(true)
  })

  it('blank röst är ett giltigt val', () => {
    const keys = generateKeyPair()
    const options = canonicalOptions(SHAPE)
    const ballot = encryptBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options, {
      kind: 'BLANK',
    })

    expect(
      verifyEncryptedBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options.length, ballot),
    ).toBe(true)
  })

  it('två val på samma valsedel ger olika chiffer och olika hash', () => {
    const keys = generateKeyPair()
    const options = canonicalOptions(SHAPE)
    const first = encryptBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options, {
      kind: 'PARTY',
      ballotPartyId: 'bp-s',
    })
    const second = encryptBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options, {
      kind: 'PARTY',
      ballotPartyId: 'bp-s',
    })

    // Samma val, olika slumptal: chiffren får inte gå att jämföra.
    expect(first.ciphertextHash).not.toBe(second.ciphertextHash)
  })

  it('returnerar inget slumptal — det är hela kvittofriheten', () => {
    /**
     * Skulle slumptalet följa med kunde väljaren bevisa vad chiffret
     * innehåller, och då är kvittot ett bevis igen och röstköp möjligt.
     * Väljaren får bara hashen, som visar ATT rösten räknats, inte VAD.
     */
    const keys = generateKeyPair()
    const ballot = encryptBallot(
      keys.publicKey.toString(),
      'val-1',
      'vs-1',
      canonicalOptions(SHAPE),
      { kind: 'BLANK' },
    )

    expect(Object.keys(ballot).sort()).toEqual(['ciphertext', 'ciphertextHash', 'proofs'])
    expect(JSON.stringify(ballot)).not.toContain('nonce')
  })

  it('hashen beror på hela chifferlistan', () => {
    const a = hashCiphertext([{ c1: '2', c2: '3' }])
    const b = hashCiphertext([{ c1: '2', c2: '4' }])
    const c = hashCiphertext([{ c1: '3', c2: '2' }])

    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(a).toHaveLength(64)
  })
})
```

- [ ] **Steg 2: Kör och se att de fallerar**

Kör: `npx vitest run tests/unit/encrypt-client.test.ts`
Förväntat: FAIL, import saknas

- [ ] **Steg 3: Skriv `src/lib/crypto/verify-ballot.ts`**

```ts
import { isInSubgroup } from './group'
import { multiply, type Ciphertext } from './elgamal'
import { verifySumIsOne, verifyZeroOrOne, type EqualityProof, type ZeroOrOneProof } from './proofs'

export type EncryptedBallot = {
  ciphertext: Array<{ c1: string; c2: string }>
  proofs: { components: ZeroOrOneProof[]; sum: EqualityProof }
  ciphertextHash: string
}

/** Kontexten som binder ett bevis till sin plats. Måste vara identisk hos bevisaren. */
export function proofContext(electionId: string, ballotId: string, index: number): string {
  return `${electionId}|${ballotId}|${index}`
}

/**
 * Verifierar en inkommen valsedel fullständigt.
 *
 * Ordningen är vald: billiga kontroller först, så att skräp avvisas innan vi
 * betalar för hundra modexp.
 */
export function verifyEncryptedBallot(
  publicKey: string,
  electionId: string,
  ballotId: string,
  expectedLength: number,
  ballot: EncryptedBallot,
): boolean {
  if (ballot.ciphertext.length !== expectedLength) return false
  if (ballot.proofs.components.length !== expectedLength) return false

  const key = BigInt(publicKey)
  const ciphertexts: Ciphertext[] = []

  for (const pair of ballot.ciphertext) {
    const c1 = BigInt(pair.c1)
    const c2 = BigInt(pair.c2)

    // REVIEW FOCUS 1. Ett element utanför undergruppen läcker en bit av
    // tröskelnyckeln vid varje partiell dekryptering.
    if (!isInSubgroup(c1) || !isInSubgroup(c2)) return false

    ciphertexts.push({ c1, c2 })
  }

  for (const [index, ciphertext] of ciphertexts.entries()) {
    const proof = ballot.proofs.components[index]!
    if (!verifyZeroOrOne(key, ciphertext, proof, proofContext(electionId, ballotId, index))) {
      return false
    }
  }

  const product = ciphertexts.reduce((a, b) => multiply(a, b))

  return verifySumIsOne(key, product, ballot.proofs.sum, proofContext(electionId, ballotId, -1))
}
```

- [ ] **Steg 4: Skriv `src/lib/encrypt-client.ts`**

```ts
import { createHash } from 'node:crypto'
import { randomScalar } from './crypto/group'
import { encrypt, multiply } from './crypto/elgamal'
import { proveSumIsOne, proveZeroOrOne } from './crypto/proofs'
import { indexOfChoice, unitVector, type BallotOption } from './crypto/ballot-encoding'
import { proofContext, type EncryptedBallot } from './crypto/verify-ballot'

/**
 * KRYPTERAR VÄLJARENS VAL — OCH KASTAR SLUMPTALEN.
 *
 * Slumptalen returneras inte, loggas inte och sparas inte. Det är den enda
 * anledningen till att kvittot inte är ett bevis: utan dem kan väljaren visa
 * ATT hennes chiffer ingår i räkningen, men inte VAD det innehåller.
 *
 * Skulle någon senare "hjälpsamt" returnera dem för felsökning är röstköp
 * möjligt igen, och ingenting i databasen avslöjar att det hänt.
 */
export function encryptBallot(
  publicKey: string,
  electionId: string,
  ballotId: string,
  options: BallotOption[],
  choice: BallotOption,
): EncryptedBallot {
  const key = BigInt(publicKey)
  const vector = unitVector(options.length, indexOfChoice(options, choice))

  const nonces = vector.map(() => randomScalar())
  const ciphertexts = vector.map((message, index) => encrypt(key, message, nonces[index]!))

  const components = ciphertexts.map((ciphertext, index) =>
    proveZeroOrOne(
      key,
      ciphertext,
      vector[index] === 1n ? 1 : 0,
      nonces[index]!,
      proofContext(electionId, ballotId, index),
    ),
  )

  const sum = proveSumIsOne(
    key,
    ciphertexts.reduce((a, b) => multiply(a, b)),
    nonces.reduce((a, b) => a + b, 0n),
    proofContext(electionId, ballotId, -1),
  )

  const serialised = ciphertexts.map((c) => ({ c1: c.c1.toString(), c2: c.c2.toString() }))

  return { ciphertext: serialised, proofs: { components, sum }, ciphertextHash: hashCiphertext(serialised) }
}

export function hashCiphertext(ciphertext: Array<{ c1: string; c2: string }>): string {
  const hash = createHash('sha256')
  hash.update('valsystem/chiffer/v1')
  for (const pair of ciphertext) {
    hash.update('\u0000')
    hash.update(pair.c1)
    hash.update('\u0000')
    hash.update(pair.c2)
  }
  return hash.digest('hex')
}
```

- [ ] **Steg 5: Kör testerna**

Kör: `npx vitest run tests/unit/encrypt-client.test.ts`
Förväntat: PASS, 5 tester

- [ ] **Steg 6: Committa**

```bash
git add src/lib/encrypt-client.ts src/lib/crypto/verify-ballot.ts tests/unit/encrypt-client.test.ts
git commit -m "Klienten krypterar valsedeln och kastar slumptalen"
```

---

## Task 8: Lägg och ändra röst

**Files:**
- Create: `src/modules/eligibility/pending-vote.service.ts`, `src/app/api/vote/encrypted/route.ts`
- Test: `tests/integration/pending-vote.test.ts`

**Interfaces:**
- Consumes: `verifyEncryptedBallot`, `EncryptedBallot`, `canonicalOptions`
- Produces:
  ```ts
  export type CastOutcome =
    | { status: 'recorded'; ciphertextHash: string; replaced: boolean }
    | { status: 'closed' }
    | { status: 'invalid_proof' }
    | { status: 'not_eligible' }
  export function castEncryptedBallot(
    voterStatusId: string, electionId: string, ballotId: string, ballot: EncryptedBallot,
  ): Promise<CastOutcome>
  export function pendingVoteFor(voterStatusId: string, ballotId: string): Promise<{ ciphertextHash: string } | null>
  export function clearPendingVotes(electionId: string): Promise<number>
  ```

- [ ] **Steg 1: Skriv de fallerande testerna**

```ts
// tests/integration/pending-vote.test.ts — utdrag, se fullständig lista nedan
it('en andra röst ersätter den första i stället för att läggas till', async () => {
  // Hela poängen med modellen. Två liggande röster vore två röster i räkningen.
  const first = await cast(voter, 'bp-s')
  const second = await cast(voter, 'bp-m')

  expect(first.status).toBe('recorded')
  expect(second.status).toBe('recorded')
  expect((second as { replaced: boolean }).replaced).toBe(true)
  expect(await votersDb.pendingVote.count({ where: { voterStatusId: voter } })).toBe(1)
})

it('en röst efter stängning avvisas', async () => {
  /**
   * REVIEW FOCUS 2. Accepteras rösten efter skalningen hamnar den aldrig i
   * räkningen, och väljaren tror att hon röstat. Tyst förlust är värre än ett
   * felmeddelande.
   */
  await closeElection(electionId)

  expect((await cast(voter, 'bp-s')).status).toBe('closed')
})

it('en valsedel med manipulerat bevis avvisas', async () => {
  const ballot = await buildBallot('bp-s')
  ballot.proofs.components[0]!.response0 += 1n

  expect((await castRaw(voter, ballot)).status).toBe('invalid_proof')
})

it('ett chiffer utanför undergruppen avvisas', async () => {
  // REVIEW FOCUS 1.
  const ballot = await buildBallot('bp-s')
  ballot.ciphertext[0]!.c1 = (P - 1n).toString()

  expect((await castRaw(voter, ballot)).status).toBe('invalid_proof')
})

it('ändring ger en ny verifikationskod', async () => {
  const first = await cast(voter, 'bp-s')
  const second = await cast(voter, 'bp-m')

  expect(second.ciphertextHash).not.toBe(first.ciphertextHash)
})
```

- [ ] **Steg 2: Kör och se att de fallerar**

Kör: `npx vitest run tests/integration/pending-vote.test.ts`
Förväntat: FAIL, modulen saknas

- [ ] **Steg 3: Implementera `pending-vote.service.ts`**

```ts
import { truncateToDay } from '@/lib/time'
import { verifyEncryptedBallot, type EncryptedBallot } from '@/lib/crypto/verify-ballot'
import { votersDb } from './db'

/**
 * DET YTTRE KUVERTET.
 *
 * Raden bär identitet och ett chiffer servern inte kan läsa. Att den kan bytas
 * ut är hela skyddet mot röstköp: köparen måste bevaka väljaren ända till
 * stängningen för att veta vad som faktiskt räknas.
 *
 * DUBBELRÖSTNINGSSPÄRREN ÄR ETT UNIKT INDEX, inte en kontroll i koden. Två
 * samtidiga anrop kan därför inte båda skapa en rad — den andra blir en
 * uppdatering, oavsett hur de ligger i tid.
 */
export async function castEncryptedBallot(
  voterStatusId: string,
  electionId: string,
  ballotId: string,
  ballot: EncryptedBallot,
): Promise<CastOutcome> {
  const election = await votersDb.election.findUnique({
    where: { id: electionId },
    select: { closesAt: true, linkClearedAt: true },
  })

  // Stängd, eller redan skalad. Båda betyder att rösten aldrig skulle räknas.
  if (!election || election.linkClearedAt !== null || election.closesAt <= new Date()) {
    return { status: 'closed' }
  }

  const shape = await ballotShape(ballotId)
  if (!shape) return { status: 'not_eligible' }

  if (
    !verifyEncryptedBallot(shape.publicKey, electionId, ballotId, shape.optionCount, ballot)
  ) {
    return { status: 'invalid_proof' }
  }

  const existing = await votersDb.pendingVote.findUnique({
    where: { voterStatusId_ballotId: { voterStatusId, ballotId } },
    select: { id: true },
  })

  await votersDb.pendingVote.upsert({
    where: { voterStatusId_ballotId: { voterStatusId, ballotId } },
    update: {
      ciphertext: ballot.ciphertext,
      proofs: ballot.proofs,
      ciphertextHash: ballot.ciphertextHash,
      updatedAt: truncateToDay(new Date()),
    },
    create: {
      voterStatusId,
      ballotId,
      ciphertext: ballot.ciphertext,
      proofs: ballot.proofs,
      ciphertextHash: ballot.ciphertextHash,
      updatedAt: truncateToDay(new Date()),
    },
  })

  return { status: 'recorded', ciphertextHash: ballot.ciphertextHash, replaced: existing !== null }
}
```

- [ ] **Steg 4: Skriv rutten `src/app/api/vote/encrypted/route.ts`**

Följ mönstret i `src/app/api/vote/cast/route.ts`: origin-kontroll, hastighetsgräns
`castVote`, CSRF-token, sessionsuppslag, anrop, svar. Rutten returnerar
`{ status, ciphertextHash, replaced }` och aldrig något om innehållet.

- [ ] **Steg 5: Kör testerna**

Kör: `npx vitest run tests/integration/pending-vote.test.ts`
Förväntat: PASS

- [ ] **Steg 6: Committa**

```bash
git add src/modules/eligibility/pending-vote.service.ts src/app/api/vote/encrypted/route.ts tests/integration/pending-vote.test.ts
git commit -m "Rösten kan läggas och ändras fram till stängning"
```

---

## Task 9: Stängning och skalning

**Files:**
- Create: `src/orchestration/close-election.usecase.ts`, `src/app/api/admin/elections/close/route.ts`
- Modify: `src/orchestration/final-check.usecase.ts`
- Test: `tests/integration/close-election.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CloseOutcome =
    | { status: 'closed'; moved: number; cleared: number }
    | { status: 'too_early'; closesAt: Date }
    | { status: 'already_closed' }
    | { status: 'invalid_ballot'; ciphertextHash: string }
  export function closeElection(electionId: string): Promise<CloseOutcome>
  ```

- [ ] **Steg 1: Skriv de fallerande testerna**

```ts
it('flyttar chiffren och raderar kopplingen', async () => {
  await castFor(anna, 'bp-s')
  await castFor(kim, 'bp-m')

  const outcome = await closeElection(electionId)

  expect(outcome).toMatchObject({ status: 'closed', moved: 2, cleared: 2 })
  expect(await votersDb.pendingVote.count()).toBe(0)
  expect(await votesDb.encryptedVote.count()).toBe(2)
})

it('vägrar innan closesAt', async () => {
  expect((await closeElection(openElectionId)).status).toBe('too_early')
})

it('en omkörning skapar inga dubbletter och tappar inga röster', async () => {
  /**
   * REVIEW FOCUS 3.
   *
   * Flytten går över en databasgräns och kan därför inte vara en transaktion —
   * det är fysiskt omöjligt, vilket är själva poängen med separationen.
   * Idempotensen bär i stället: infogningen är nyckelfri på ciphertextHash.
   */
  await castFor(anna, 'bp-s')
  await closeElection(electionId)
  const after = await closeElection(electionId)

  expect(after.status).toBe('already_closed')
  expect(await votesDb.encryptedVote.count()).toBe(1)
})

it('infogar sorterat på innehåll, inte i den ordning väljarna röstade', async () => {
  // Insättningsordningen får inte avslöja i vilken ordning folk röstade —
  // annars kan den som vet när någon legitimerade sig peka ut hens rad.
  await castFor(anna, 'bp-s')
  await castFor(kim, 'bp-m')
  await castFor(robin, 'bp-s')
  await closeElection(electionId)

  const hashes = (
    await votesDb.encryptedVote.findMany({ orderBy: { id: 'asc' }, select: { ciphertextHash: true } })
  ).map((row) => row.ciphertextHash)

  expect(hashes).toEqual([...hashes].sort())
})

it('avvisar hela stängningen om en valsedel inte längre verifierar', async () => {
  await castFor(anna, 'bp-s')
  await votersDb.$executeRaw`update pending_vote set ciphertext_hash = 'fel'`

  expect((await closeElection(electionId)).status).toBe('invalid_ballot')
  expect(await votersDb.pendingVote.count()).toBe(1)
})
```

- [ ] **Steg 2: Kör och se att de fallerar**

Kör: `npx vitest run tests/integration/close-election.test.ts`
Förväntat: FAIL, modulen saknas

- [ ] **Steg 3: Implementera `close-election.usecase.ts`**

```ts
/**
 * SKALNINGEN: ATT TA BORT DET YTTRE KUVERTET.
 *
 * Ordningen är noga vald och kan inte kastas om.
 *
 *   1. verifiera varje valsedel EN GÅNG TILL
 *   2. infoga i votes_db, sorterat på chifferhash
 *   3. kontrollera att antalet stämmer
 *   4. först då radera kopplingen
 *
 * Steg 1 känns överflödigt — bevisen kontrollerades ju när rösten lades. Det är
 * ändå rätt: det är den sista punkt där ett fel kan pekas ut, för efter steg 4
 * finns ingen väljare att fråga.
 *
 * Steg 2 före 4 är inte en smaksak. Raderade vi först och kraschade skulle
 * rösterna vara borta utan att finnas i räkningen — ingen kan återskapa dem.
 * Flyttar vi först och kraschar är chiffren redan trygga, och omkörningen ser
 * dem som befintliga tack vare det unika indexet på ciphertextHash.
 *
 * SORTERINGEN PÅ INNEHÅLL är inte kosmetik. Skulle raderna infogas i den
 * ordning väljarna röstade kunde den som vet när någon legitimerade sig peka
 * ut hens rad, och skalningen vore verkningslös.
 */
```

Implementera enligt kommentaren. Uppdatera `Election.linkClearedAt` sist.

- [ ] **Steg 4: Lägg till kontrollen i `final-check.usecase.ts`**

```ts
{
  id: 'link-cleared',
  question: 'Är kopplingen mellan väljare och röst raderad?',
  severity: 'CRITICAL',
  run: async () => {
    const remaining = await votersDb.pendingVote.count({
      where: { ballotId: { in: ballotIds } },
    })

    return {
      passed: remaining === 0,
      detail:
        remaining === 0
          ? 'Inga kopplingar finns kvar.'
          : `${remaining} kopplingar finns kvar. Valet får inte fastställas.`,
    }
  },
}
```

Detta gör raderingen till ett **kontrollerat villkor** i stället för ett löfte.

- [ ] **Steg 5: Kör testerna**

Kör: `npx vitest run tests/integration/close-election.test.ts`
Förväntat: PASS, 5 tester

- [ ] **Steg 6: Committa**

```bash
git add src/orchestration/close-election.usecase.ts src/app/api/admin/elections/close/route.ts src/orchestration/final-check.usecase.ts tests/integration/close-election.test.ts
git commit -m "Stängningen skalar bort identiteten och kontrolleras av slutkontrollen"
```

---

## Task 10: Summering och tröskeldekryptering

**Files:**
- Create: `src/orchestration/tally.usecase.ts`, `src/app/api/admin/elections/decrypt/route.ts`
- Test: `tests/integration/tally.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function aggregate(ballotId: string): Promise<Ciphertext[]>
  export function submitPartialDecryption(ballotId: string, trusteeIndex: number): Promise<{ status: 'accepted' | 'rejected' | 'duplicate' }>
  export function completeTally(ballotId: string): Promise<{ status: 'tallied'; counts: number[] } | { status: 'needs_more_trustees'; have: number; need: number }>
  ```

- [ ] **Steg 1: Skriv de fallerande testerna**

```ts
it('räknar rätt utan att öppna någon enskild röst', async () => {
  await castFor(anna, 'bp-s')
  await castFor(kim, 'bp-s')
  await castFor(robin, 'bp-m')
  await closeElection(electionId)

  await submitPartialDecryption(ballotId, 1)
  await submitPartialDecryption(ballotId, 2)
  const result = await completeTally(ballotId)

  expect(result).toMatchObject({ status: 'tallied' })
  expect((result as { counts: number[] }).counts).toEqual([0, 2, 1]) // blank, S, M
})

it('en ensam förtroendeman räcker inte', async () => {
  await closeElection(electionId)
  await submitPartialDecryption(ballotId, 1)

  expect(await completeTally(ballotId)).toMatchObject({ status: 'needs_more_trustees', have: 1, need: 2 })
})

it('avvisar ett bidrag vars bevis inte hör till det här chiffret', async () => {
  // REVIEW FOCUS 4.
  await closeElection(electionId)
  const stolen = await partialFromAnotherBallot()

  expect(await submitRaw(ballotId, stolen)).toMatchObject({ status: 'rejected' })
})

it('en valsedel utan röster ger nollor, inte ett kastat fel', async () => {
  // REVIEW FOCUS 6.
  await closeElection(emptyElectionId)
  await submitPartialDecryption(emptyBallotId, 1)
  await submitPartialDecryption(emptyBallotId, 2)

  expect(await completeTally(emptyBallotId)).toMatchObject({ status: 'tallied', counts: [0, 0, 0] })
})

it('ingen enskild röst finns dekrypterad någonstans efteråt', async () => {
  // Det som gör valhemligheten strukturell och inte en rutin.
  await castFor(anna, 'bp-s')
  await closeElection(electionId)
  await submitPartialDecryption(ballotId, 1)
  await submitPartialDecryption(ballotId, 2)
  await completeTally(ballotId)

  const votes = await votesDb.encryptedVote.findMany()
  for (const vote of votes) {
    expect(JSON.stringify(vote)).not.toMatch(/"plaintext"|"choice"|"optionIndex"/)
  }
})
```

- [ ] **Steg 2: Kör och se att de fallerar**

Kör: `npx vitest run tests/integration/tally.test.ts`
Förväntat: FAIL, modulen saknas

- [ ] **Steg 3: Implementera `tally.usecase.ts`**

Summera komponentvis över alla `EncryptedVote` för valsedeln, spara varje
förtroendemans bidrag med bevis, och kombinera när k stycken finns. Ta den diskreta
logaritmen med `maximum` satt till antalet röstberättigade.

- [ ] **Steg 4: Kör testerna**

Kör: `npx vitest run tests/integration/tally.test.ts`
Förväntat: PASS, 5 tester

- [ ] **Steg 5: Committa**

```bash
git add src/orchestration/tally.usecase.ts src/app/api/admin/elections/decrypt/route.ts tests/integration/tally.test.ts
git commit -m "Homomorf räkning: bara summan öppnas, av två förtroendemän"
```

---

## Task 11: Publicering och oberoende verifiering

**Files:**
- Modify: `src/app/api/observer/votes/route.ts`, `tools/verify-election.mjs`
- Create: `src/app/verifiera/page.tsx` (ersätter tokenflödet)
- Test: `tests/integration/independent-verification.test.ts`

- [ ] **Steg 1: Skriv det fallerande testet**

```ts
it('verktyget räknar fram samma summa utan att importera något från src', async () => {
  // Bevisvärdet ligger i oberoendet. Delar verktyget kod med appen bevisar det
  // bara att appen är konsekvent med sig själv.
  const output = execSync('node tools/verify-election.mjs', { encoding: 'utf8' })

  expect(output).toContain('summan stämmer')
})

it('en manipulerad röst upptäcks', async () => {
  await votesDb.$executeRaw`update encrypted_vote set ciphertext_hash = 'manipulerad' where true`

  expect(() => execSync('node tools/verify-election.mjs', { encoding: 'utf8' })).toThrow()
})

it('väljaren hittar sin chifferhash i den publicerade mängden', async () => {
  const { ciphertextHash } = await castFor(anna, 'bp-s')
  await closeElection(electionId)

  const published = await fetch('/api/observer/votes', ...).then((r) => r.json())

  expect(published.votes.map((v) => v.ciphertextHash)).toContain(ciphertextHash)
})

it('den publicerade raden avslöjar inte valet', async () => {
  const published = await fetch('/api/observer/votes', ...).then((r) => r.json())

  for (const vote of published.votes) {
    expect(Object.keys(vote)).toEqual(['ciphertextHash', 'ballotId', 'ciphertext', 'proofs'])
  }
})
```

- [ ] **Steg 2–4:** Implementera, kör, committa enligt mönstret ovan.

```bash
git commit -m "Publicerad mängd och oberoende omräkning av summan"
```

---

## Task 12: Slakta blindsigneringen

**Files:**
- Delete: `src/lib/blind-signature.ts`, `src/lib/blind-client.ts`, `src/modules/eligibility/credential.service.ts`, `src/app/api/vote/credential/route.ts`, `src/modules/ballot-box/token.service.ts`, och deras tester
- Modify: `prisma/*/schema.prisma` (ta bort `signingPrivateKeyPem`, `signingPublicKeyPem`, `credentialId`, `credentialSignature`, `tokenHash`), `tests/security/api-surface.test.ts`

- [ ] **Steg 1: Uppdatera ruttinventeringen i `api-surface.test.ts`**

Ta bort `src/app/api/vote/credential/route.ts`, lägg till `src/app/api/vote/encrypted/route.ts`,
`src/app/api/admin/elections/close/route.ts`, `src/app/api/admin/elections/decrypt/route.ts`.

- [ ] **Steg 2: Kör och se att det fallerar**

Kör: `npx vitest run tests/security/api-surface.test.ts`
Förväntat: FAIL, listan matchar inte

- [ ] **Steg 3: Radera filerna och kolumnerna**

```bash
git rm src/lib/blind-signature.ts src/lib/blind-client.ts \
       src/modules/eligibility/credential.service.ts \
       src/modules/ballot-box/token.service.ts \
       tests/unit/blind-signature.test.ts tests/unit/blind-interop.test.ts \
       tests/unit/token.test.ts
git rm -r src/app/api/vote/credential
```

Generera migreringar som släpper kolumnerna.

- [ ] **Steg 4: Kör hela sviten**

```bash
npx tsc --noEmit && npx vitest run && npx playwright test
```

Förväntat: allt grönt, inga kvarvarande referenser.

- [ ] **Steg 5: Committa**

```bash
git commit -m "Blindsigneringen bort — obundenheten kommer nu från att inga röster öppnas"
```

---

## Task 13: Dokumentation och begränsningar

**Files:**
- Modify: `ARCHITECTURE.md`, `SECURITY.md`, `src/lib/known-limitations.ts`, `tests/security/known-limitations.test.ts`

- [ ] **Steg 1: Ta bort de lösta begränsningarna**

Fyra poster försvinner: `signing-keys-in-database`, `receipt-proves-choice`,
`single-administrator`, `no-guaranteed-anonymity-set`. Testet i
`known-limitations.test.ts` går rött tills de tas bort — det är meningen, det failar
när något blir bättre.

- [ ] **Steg 2: Lägg till de nya**

```ts
{
  id: 'link-exists-during-voting',
  title: 'Kopplingen väljare↔röst finns medan röstningen pågår',
  why:
    'Modellen med dubbla kuvert kräver kopplingen — det är den som gör rösten utbytbar och ' +
    'därmed röstköp meningslöst. Priset är att "kan inte existera" blivit "raderas enligt ' +
    'schema". Backuper, läsreplikor och WAL-loggen omfattas inte av raderingen, och rösten är ' +
    'bara skyddad av att chiffret inte går att läsa utan k av n andelar. Det är den ' +
    'huvudsakliga akademiska invändningen mot Estlands system.',
  stillTrueIf: { file: 'prisma/voters/schema.prisma', contains: 'model PendingVote' },
},
{
  id: 'trusted-dealer',
  title: 'Tröskelnyckeln delas av en betrodd utdelare',
  why:
    'Vid valets skapande existerar hela den privata nyckeln på ett ställe under ett ögonblick ' +
    'innan den delas och raderas. Riktig distribuerad nyckelgenerering låter förtroendemännen ' +
    'bygga nyckeln utan att den någonsin sätts ihop.',
  stillTrueIf: { file: 'src/orchestration/create-election.usecase.ts', contains: 'splitSecret' },
},
```

- [ ] **Steg 3: Skriv om `ARCHITECTURE.md` avsnitt 4–7**

Ersätt blindsigneringens beskrivning med kuvertanalogin, sekvensdiagrammet över
kryptering → ändring → skalning → summering, och tabellen över vad varje egenskap
vilar på. Behåll formen från det befintliga avsnittet om blindsignering: analogin
först, matematiken sedan, och ett stycke om vad konstruktionen **inte** ger.

- [ ] **Steg 4: Kör hela sviten och committa**

```bash
npx vitest run && npx playwright test
git add -A && git commit -m "Arkitekturen beskriver dubbla kuvert; fyra begränsningar lösta, två nya"
```

---

## Självgranskning

**Spec-täckning.** Avsnitt 4.1–4.5 → uppgift 1–3. Avsnitt 4.3 → uppgift 4. Avsnitt 5 →
uppgift 5. Avsnitt 6 steg 1 → uppgift 6, steg 2–5 → uppgift 7–8, steg 6 → uppgift 9,
steg 7–8 → uppgift 10, steg 9 → uppgift 9 steg 4. Avsnitt 7 → uppgift 12. Avsnitt 8–9 →
uppgift 13. Ingen lucka.

**Typkonsistens.** `Ciphertext` definieras i uppgift 1 och används oförändrad i 2, 3, 7,
10. `EqualityProof` definieras i uppgift 2 och används i 3. `EncryptedBallot` definieras i
uppgift 7 (`verify-ballot.ts`) och konsumeras i 8. `BallotOption` definieras i uppgift 4
och används i 7. `proofContext` delas mellan bevisare och verifierare — den enda
funktionen som måste vara bitidentisk på båda sidor.

**Review Focus-täckning.** 1 → uppgift 1 (`isInSubgroup`) och 8 (avvisat chiffer).
2 → uppgift 8. 3 → uppgift 9. 4 → uppgift 3 och 10. 5 → uppgift 2. 6 → uppgift 1 och 10.

**Öppen fråga som inte hör till någon uppgift:** vem som i praktiken håller de tre
andelarna. Planen lagrar dem skyddade i databasen, vilket demonstrerar mekaniken men
inte skyddet. Det står som känd begränsning `trusted-dealer` och bör lyftas till en egen
etapp om systemet någonsin ska gå längre än en POC.
