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

1. **Gruppelement utanfor primtalsundergruppen.** En klient som skickar `c1` av ordning 2 kan lacka en bit av nyckeln vid partiell dekryptering. Varje inkommande `c1`/`c2` måste avvisas om `y^q` inte ar 1. *(Uppgift 1, test i uppgift 9)*
2. **Rost som anlander efter `closesAt`.** Maste avvisas med tydligt besked, inte tyst sparas — en rost som accepteras efter skalningen hamnar aldrig i rakningen och väljaren tror att hon rostat. *(Uppgift 9)*
3. **Skalningen kors två gånger.** Ett avbrott mellan infogning och radering far inte ge dubbletter eller forlorade roster vid omkorning. *(Uppgift 11)*
4. **Partiellt dekrypteringsbevis fran ett annat chiffer.** En förtroendeman som ateranvander ett tidigare bevis måste avvisas, annars kan k-1 arliga kombineras med ett falskt bidrag. *(Uppgift 3, test i uppgift 12)*
5. **Enhetsvektor som summerar till 2.** Varje komponent kan vara giltigt 0-eller-1 och anda ge två roster. Summabeviset ar enda skyddet. *(Uppgift 2)*
6. **Noll roster pa en valsedel.** Dekrypteringen ger `g^0 = 1` och diskreta logaritmen måste svara `0`, inte loopa. *(Uppgift 1 och 12)*
7. **Rost lagd i någon annans namn.** En rad som skrivs direkt i databasen pekar pa en verklig, röstberättigad väljare och passerar varje relationell kontroll. Bara signaturen avslöjar att väljaren aldrig godkant innehallet. *(Uppgift 8, test i uppgift 10)*
8. **Ateruppspelat aldre kuvert.** Den som fangat väljarens forsta signerade kuvert skickar in det igen efter att hon ändrat sig, och rosten atergar till den kopta — ett röstköp som overlever hela andringsmojligheten. Raknaren måste ligga inuti det signerade. *(Uppgift 8, test i uppgift 10)*

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

  /**
   * DE TVA GRENARNAS MAL, UTSKRIVNA VAR FOR SIG.
   *
   * Gren 0 påstår att chiffret kodar 0, alltså att c2 = h^r. Malet ar c2.
   * Gren 1 påstår 1, alltså att c2 = h^r * g. Malet ar c2 / g.
   *
   * Den SIMULERADE grenen ar den vi inte kan bevisa arligt, alltså motsatsen
   * till `message`. Tas fel mål här blir simuleringen ogiltig, och verifieraren
   * underkanner ett arligt bevis — ett fel som bara syns som att giltiga roster
   * avvisas.
   */
  const target0 = ciphertext.c2
  const target1 = (ciphertext.c2 * modPow(G, Q - 1n, P)) % P
  const simulatedTarget = message === 0 ? target1 : target0

  const simulated = {
    a: (modPow(G, fakeResponse, P) * modPow(ciphertext.c1, Q - fakeChallenge, P)) % P,
    b:
      (modPow(publicKey, fakeResponse, P) * modPow(simulatedTarget, Q - fakeChallenge, P)) % P,
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

  it('hittar valet oavsett i vilken ordning fältet skrevs', () => {
    // Serialiseringsjamforelse hade fallit har, och felmeddelandet hade pekat
    // pa datan nar felet lag i formen.
    const options = canonicalOptions(SHAPE)
    const choice = { candidateId: 'k-anna', ballotPartyId: 'bp-s', kind: 'CANDIDATE' } as const

    expect(indexOfChoice(options, choice)).toBe(3)
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

/**
 * Jamfor falt for falt, inte via JSON.stringify.
 *
 * Serialisering beror pa nyckelordningen i objektet. En anropare som bygger
 * sitt val med falten i annan ordning hade fatt "Valet finns inte pa den har
 * valsedeln" — ett meddelande som pekar pa data nar felet ligger i formen.
 */
function sameOption(a: BallotOption, b: BallotOption): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'BLANK') return true
  if (b.kind === 'BLANK') return false
  if (a.ballotPartyId !== b.ballotPartyId) return false
  if (a.kind === 'CANDIDATE' && b.kind === 'CANDIDATE') return a.candidateId === b.candidateId
  return a.kind === b.kind
}

export function indexOfChoice(options: BallotOption[], choice: BallotOption): number {
  const index = options.findIndex((option) => sameOption(option, choice))

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

  /// RESTRICT, INTE CASCADE.
  ///
  /// En struken väljares rost ska räknas (spec 7.4), sa en radering far inte
  /// tyst ta rosten med sig. Restrict betyder att en väljare inte kan
  /// hardraderas medan hon har en liggande rost. Efter skalningen ar raden
  /// borta och raderingen fri igen.
  voterStatus   VoterStatus @relation(fields: [voterStatusId], references: [id], onDelete: Restrict)

  /// Speglat id. Ingen FK — valsedeln bor i den andra databasen.
  ballotId String @map("ballot_id")

  /// M par (c1, c2) som decimalsträngar.
  ciphertext Json

  /// M stycken 0/1-bevis plus ett summabevis.
  proofs Json

  /// SHA-256 över den kanoniska serialiseringen. Väljarens inklusionshandtag.
  ciphertextHash String @map("ciphertext_hash")

  /// Okar vid varje laggning och ligger INUTI det signerade.
  ///
  /// Utan den kan den som fangat väljarens forsta signerade kuvert skicka in
  /// det igen efter att hon ändrat sig, och rosten atergar till den kopta.
  castSequence Int @map("cast_sequence")

  /// Valjarens egen signatur over kuvertet, fran BankID /sign.
  bankIdSignature String @map("bankid_signature")

  /// Certifikatet ur signaturen. Bar personnummer och namn — far därför
  /// ALDRIG folja med till votes_db vid skalningen.
  bankIdCertificate String @map("bankid_certificate")

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

  /// OPEN | CLOSED | VALIDATED | STRIPPED | TALLIED | CERTIFIED.
  ///
  /// Enkelriktad. Ordningen måste vara omöjlig att kasta om, inte bara
  /// osannolik — se spec 6.1. Att fasen ar ett falt och inte en jamforelse mot
  /// klockan spelar roll: en klocka som gar fel andrar beteendet tyst, medan en
  /// fasovergang ar en handelse någon utfort.
  phase String @default("OPEN")

  /// Merklerot over (ciphertextHash, bankIdSignature) fore skalningen.
  ///
  /// Det enda som overlever raderingen av signaturerna, och det som later en
  /// väljare med sparat kuvert bevisa att det räknades. Se spec 7.3.
  envelopeRoot String? @map("envelope_root")
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

- [ ] **Steg 5: Gor den kanoniska ordningen bevisbart total**

Granskningen av uppgift 4 hittade detta, och det hor hemma har.

`canonicalOptions` sorterar pa `displayOrder`. Men varken `BallotParty` eller
`Candidate` har ett unikhetsvillkor pa fältet, sa två partier pa samma valsedel
kan dela ordningsnummer. `Array.prototype.sort` ar stabil, vilket betyder att
ordningen da faller tillbaka pa **insattningsordningen** — som kan skilja mellan
klienten och servern, eftersom de laser raderna ur olika fragor.

Foljden vore att en rost räknas pa fel alternativ, och ingenting i bevisen
fångar det: de bevisar att vektorn ar valformad, inte att den betyder samma sak
for bada parter. Sorteringen ar alltså bara total om databasen garanterar det.

Lagg till i `prisma/votes/schema.prisma`:

```prisma
// pa BallotParty
  @@unique([ballotId, displayOrder])

// pa Candidate
  @@unique([ballotPartyId, displayOrder])
```

Och ett test i `tests/security/schema-separation.test.ts`:

```ts
it('ordningsnumren ar unika, sa den kanoniska ordningen ar total', () => {
  /**
   * Utan detta faller sorteringen tillbaka pa insättningsordning nar två
   * alternativ delar displayOrder — och klient och server kan da numrera
   * valsedeln olika. Rosten hamnar pa fel alternativ, och inget bevis ser det.
   */
  const ballotParty = votesFields.match(/model BallotParty \{[\s\S]*?
\}/)?.[0] ?? ''
  const candidate = votesFields.match(/model Candidate \{[\s\S]*?
\}/)?.[0] ?? ''

  expect(ballotParty).toContain('@@unique([ballotId, displayOrder])')
  expect(candidate).toContain('@@unique([ballotPartyId, displayOrder])')
})
```

Finns redan rader som bryter mot villkoret i utvecklingsdatabasen faller
migreringen. Kor `npm run reset:votes && npm run seed` forst om sa sker —
seed-datan har unika ordningsnummer.

- [ ] **Steg 6: Generera migreringarna**

```bash
npx prisma migrate dev --schema=prisma/voters/schema.prisma --name pending_vote --create-only
npx prisma migrate dev --schema=prisma/votes/schema.prisma --name encrypted_vote --create-only
npm run migrate
npm run generate
```

**Stoppa dev-servern forst.** Pa Windows haller en korande Next-process Prisma-
motorens DLL last, och `prisma generate` faller da med
`EPERM: operation not permitted, rename ... query_engine-windows.dll.node.tmp`.
Felet ser ut som ett rattighetsproblem men ar en fillasning. Kontrollera med
`netstat -ano | grep :3000` och stoppa processen innan du genererar.

Databasen kors i Docker och delas med resten av arbetet. Kor `npm run migrate`
mot den, inte mot en ny instans.

- [ ] **Steg 7: Kör testerna**

Kör: `npx vitest run tests/security/schema-separation.test.ts`
Förväntat: PASS

- [ ] **Steg 8: Committa**

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

  it('andelen lagras skyddad, inte i klartext', async () => {
    const id = await newElection()
    const share = await votesDb.trusteeShare.findFirstOrThrow({ where: { electionId: id } })

    // AES-GCM-formatet ar iv:tag:payload — tre hexdelar.
    expect(share.encryptedShare.split(':')).toHaveLength(3)
    expect(() => BigInt(share.encryptedShare)).toThrow()
  })

  it('andelen gar inte att lasa upp med fel fras', async () => {
    // Hela skyddet. Gar den upp med vad som helst ar lösenfrasen dekoration.
    const id = await newElection()
    const share = await votesDb.trusteeShare.findFirstOrThrow({ where: { electionId: id } })

    expect(() => decryptShare(share.encryptedShare, 'fel-fras', share.trusteeIndex)).toThrow()
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

// createElection tar nu ocksa `trusteePassphrases: [string, string, string]`.
// Fraserna lagras ALDRIG — bara de krypterade andelarna. I demolage seedas tre
// kanda fraser som skrivs ut av npm run seed.

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
    encryptedShare: encryptShare(share.value, input.trusteePassphrases[share.index - 1]!, share.index),
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
/**
 * Nyckeln harleds ur FORTROENDEMANNENS LOSENFRAS, aldrig ur appens miljo.
 *
 * Alternativet skyddar ingenting: en andel krypterad med en nyckel harledd ur
 * IDENTITY_PEPPER ar läsbar for var och en som har databasen och miljön — och
 * appen behöver bada for att fungera, sa en komprometterad appserver ger
 * batteri. Tre andelar i samma lada ar inte tre innehavare.
 *
 * Saltet ar andelens index, sa att två förtroendeman med samma fras anda far
 * olika nycklar.
 */
function keyFor(passphrase: string, trusteeIndex: number): Buffer {
  return scryptSync(passphrase, `trustee-share-${trusteeIndex}`, 32)
}

export function encryptShare(value: bigint, passphrase: string, trusteeIndex: number): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(passphrase, trusteeIndex), iv)
  const encrypted = Buffer.concat([cipher.update(value.toString(), 'utf8'), cipher.final()])

  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(
    ':',
  )
}

export function decryptShare(stored: string, passphrase: string, trusteeIndex: number): bigint {
  const [iv, tag, payload] = stored.split(':')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyFor(passphrase, trusteeIndex),
    Buffer.from(iv!, 'hex'),
  )
  decipher.setAuthTag(Buffer.from(tag!, 'hex'))

  return BigInt(
    Buffer.concat([decipher.update(Buffer.from(payload!, 'hex')), decipher.final()]).toString(
      'utf8',
    ),
  )
}
```

- [ ] **Steg 5: Kör testerna**

Kör: `npx vitest run tests/integration/threshold-key.test.ts`
Förväntat: PASS, 3 tester

- [ ] **Steg 6: Committa**

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

  it('en pahittad hash avvisas', async () => {
    /**
     * Klienten far inte kunna pasta vad som helst om sitt eget chiffer.
     * Godtas hashen pa ord letar väljarens inklusionskontroll senare efter ett
     * värde som inte finns i den publicerade mangden — och felet syns forst
     * efter att kopplingen raderats.
     */
    const keys = generateKeyPair()
    const options = canonicalOptions(SHAPE)
    const ballot = encryptBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options, {
      kind: 'BLANK',
    })

    const tampered = { ...ballot, ciphertextHash: 'f'.repeat(64) }

    expect(
      verifyEncryptedBallot(keys.publicKey.toString(), 'val-1', 'vs-1', options.length, tampered),
    ).toBe(false)
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
import { createHash } from 'node:crypto'
import { isInSubgroup } from './group'
import { multiply, type Ciphertext } from './elgamal'
import { verifySumIsOne, verifyZeroOrOne, type EqualityProof, type ZeroOrOneProof } from './proofs'

export type EncryptedBallot = {
  ciphertext: Array<{ c1: string; c2: string }>
  proofs: { components: ZeroOrOneProof[]; sum: EqualityProof }
  ciphertextHash: string
}

/**
 * Kanonisk hash over chifferlistan.
 *
 * Bor har och inte i klientmodulen, eftersom BADE bevisaren och verifieraren
 * måste rakna fram exakt samma värde. Tva implementationer som glider isar ger
 * ett fel som ser ut som en manipulerad rost.
 */
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
import { randomScalar } from './crypto/group'
import { encrypt, multiply } from './crypto/elgamal'
import { proveSumIsOne, proveZeroOrOne } from './crypto/proofs'
import { indexOfChoice, unitVector, type BallotOption } from './crypto/ballot-encoding'
import { hashCiphertext, proofContext, type EncryptedBallot } from './crypto/verify-ballot'

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

export { hashCiphertext }
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

## Task 8: BankID-signering av det yttre kuvertet

**Files:**
- Modify: `src/modules/eligibility/bankid/IBankIdService.ts`, `src/modules/eligibility/bankid/MockBankIdService.ts`
- Create: `src/modules/eligibility/bankid/envelope-signature.ts`
- Test: `tests/unit/envelope-signature.test.ts`

**Interfaces:**
- Consumes: `hashCiphertext` från uppgift 7
- Produces:
  ```ts
  export type SignRequest = {
    endUserIp: string
    userVisibleData: string
    userNonVisibleData: string
  }
  export type EnvelopePayload = {
    electionId: string
    ballotId: string
    ciphertextHash: string
    castSequence: number
  }
  export function envelopePayload(payload: EnvelopePayload): string
  export function verifyEnvelopeSignature(
    signature: string, certificate: string,
    expectedPayload: EnvelopePayload, expectedPersonalNumber: string,
  ): boolean
  // IBankIdService utökas med: sign(request: SignRequest): Promise<BankIdAuthOrder>
  ```

- [ ] **Steg 1: Skriv de fallerande testerna**

```ts
// tests/unit/envelope-signature.test.ts
import { describe, expect, it } from 'vitest'
import { MockBankIdService } from '@/modules/eligibility/bankid/MockBankIdService'
import {
  envelopePayload,
  verifyEnvelopeSignature,
} from '@/modules/eligibility/bankid/envelope-signature'

const PAYLOAD = {
  electionId: 'val-1',
  ballotId: 'vs-1',
  ciphertextHash: 'a'.repeat(64),
  castSequence: 1,
}

async function signAs(personalNumber: string, payload = PAYLOAD) {
  const service = new MockBankIdService()
  const order = await service.sign({
    endUserIp: '127.0.0.1',
    userVisibleData: 'Rösta i Valet 2026',
    userNonVisibleData: envelopePayload(payload),
  })
  service.selectDemoIdentity(order.orderRef, personalNumber)

  let result = await service.collect(order.orderRef)
  while (result.status === 'pending') result = await service.collect(order.orderRef)
  if (result.status !== 'complete') throw new Error('signeringen blev inte klar')

  return result.completionData
}

describe('signaturen binder rösten till väljaren', () => {
  it('en ärlig signatur går igenom', async () => {
    const data = await signAs('199001011234')

    expect(verifyEnvelopeSignature(data.signature, data.certificate, PAYLOAD, '199001011234')).toBe(
      true,
    )
  })

  it('en signatur från en annan person avvisas', async () => {
    /**
     * HÅLET SOM STÄNGS.
     *
     * Utan den här kontrollen är det SERVERN som påstår att Anna lade rösten.
     * Vem som helst med skrivrättighet till röstlängden kan påstå det om vilken
     * väljare som helst som ännu inte röstat, och den relationella kontrollen i
     * uppgift 10 fångar det inte — väljaren är ju verklig.
     */
    const data = await signAs('198505152345')

    expect(verifyEnvelopeSignature(data.signature, data.certificate, PAYLOAD, '199001011234')).toBe(
      false,
    )
  })

  it('en signatur för en annan valsedel avvisas', async () => {
    const data = await signAs('199001011234')

    expect(
      verifyEnvelopeSignature(
        data.signature,
        data.certificate,
        { ...PAYLOAD, ballotId: 'vs-9' },
        '199001011234',
      ),
    ).toBe(false)
  })

  it('en signatur för ett annat chiffer avvisas', async () => {
    const data = await signAs('199001011234')

    expect(
      verifyEnvelopeSignature(
        data.signature,
        data.certificate,
        { ...PAYLOAD, ciphertextHash: 'b'.repeat(64) },
        '199001011234',
      ),
    ).toBe(false)
  })

  it('en återuppspelad signatur med lägre räknare avvisas', async () => {
    /**
     * ÅTERUPPSPELNINGEN.
     *
     * Den som fångat väljarens FÖRSTA signerade kuvert kan annars skicka in det
     * igen efter att hon ändrat sig, och rösten återgår till den köpta. Det vore
     * ett röstköp som överlever hela ändringsmöjligheten — alltså precis det
     * modellen finns för att förhindra.
     *
     * Räknaren måste ligga INUTI det signerade, annars byts den bara ut.
     */
    const data = await signAs('199001011234', { ...PAYLOAD, castSequence: 1 })

    expect(
      verifyEnvelopeSignature(
        data.signature,
        data.certificate,
        { ...PAYLOAD, castSequence: 2 },
        '199001011234',
      ),
    ).toBe(false)
  })

  it('nyttolasten är entydig och går inte att förväxla', () => {
    // Med enbart avgränsare kan "vs-12" + "abc" och "vs-1" + "2abc" ge samma
    // sträng, och då flyttas en signatur mellan valsedlar utan att något ser
    // fel ut. Längdprefix stänger det.
    const a = envelopePayload({ ...PAYLOAD, ballotId: 'vs-12', ciphertextHash: 'c'.repeat(64) })
    const b = envelopePayload({ ...PAYLOAD, ballotId: 'vs-1', ciphertextHash: '2' + 'c'.repeat(63) })

    expect(a).not.toBe(b)
  })
})
```

- [ ] **Steg 2: Kör testerna och se att de fallerar**

Kör: `npx vitest run tests/unit/envelope-signature.test.ts`
Förväntat: FAIL, `sign` finns inte på `MockBankIdService`

- [ ] **Steg 3: Utöka `IBankIdService`**

```ts
export type SignRequest = {
  endUserIp: string
  /** Visas i appen. Det väljaren faktiskt godkänner. */
  userVisibleData: string
  /**
   * Signeras men visas inte. Här ligger chifferhashen, valsedelns id och
   * räknaren — sådant som måste vara bundet men som ingen människa kan granska
   * på en telefonskärm.
   */
  userNonVisibleData: string
}

export interface IBankIdService {
  auth(request: BankIdAuthRequest): Promise<BankIdAuthOrder>

  /**
   * BankID /sign. Används vid röstläggning, aldrig vid inloggning.
   *
   * Skillnaden mot auth är inte kosmetisk: en auth bevisar att någon var
   * närvarande, en sign bevisar att just den personen godkände just det här
   * innehållet. Det senare är vad som gör en röst oförfalskbar — även för den
   * som driver systemet.
   */
  sign(request: SignRequest): Promise<BankIdAuthOrder>

  qrData(orderRef: string): Promise<BankIdQrData | null>
  collect(orderRef: string): Promise<BankIdCollectResult>
  cancel(orderRef: string): Promise<void>
}
```

Utöka `BankIdCollectComplete.completionData` med `signature: string` och
`certificate: string`.

- [ ] **Steg 4: Låt attrappen signera på riktigt**

```ts
import { createSign, generateKeyPairSync } from 'node:crypto'

/**
 * Ett nyckelpar per demoidentitet, hållet i minnet.
 *
 * Attrappen får inte returnera en påhittad sträng. Skulle den göra det prövas
 * verifieringen aldrig, och hela signaturkedjan vore otestad ända tills någon
 * kopplar in skarp BankID — alltså precis när ett fel kostar som mest.
 */
private readonly keys = new Map<string, { privateKey: string; publicKey: string }>()

private keysFor(personalNumber: string) {
  const existing = this.keys.get(personalNumber)
  if (existing) return existing

  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  this.keys.set(personalNumber, pair)
  return pair
}
```

När en signeringsorder blir klar i `collect`: signera `userNonVisibleData` med
identitetens privata nyckel och returnera signaturen tillsammans med den publika nyckeln
som `certificate`.

- [ ] **Steg 5: Skriv `envelope-signature.ts`**

```ts
import { createVerify } from 'node:crypto'

export type EnvelopePayload = {
  electionId: string
  ballotId: string
  ciphertextHash: string
  castSequence: number
}

/**
 * Den kanoniska sträng som signeras.
 *
 * Längdprefix på varje fält, inte bara avgränsare. Med enbart ett skiljetecken
 * kan två olika uppsättningar fält ge samma sträng, och då går en signatur att
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
 * Verifierar att RÄTT PERSON signerat RÄTT INNEHÅLL.
 *
 * Båda halvorna behövs. En giltig signatur över rätt innehåll från fel person
 * är en röst lagd i någon annans namn. En giltig signatur från rätt person över
 * fel innehåll är en återuppspelad eller flyttad röst.
 */
export function verifyEnvelopeSignature(
  signature: string,
  certificate: string,
  expectedPayload: EnvelopePayload,
  expectedPersonalNumber: string,
): boolean {
  if (!certificateBelongsTo(certificate, expectedPersonalNumber)) return false

  const verifier = createVerify('sha256')
  verifier.update(envelopePayload(expectedPayload))
  verifier.end()

  try {
    return verifier.verify(certificate, signature, 'base64')
  } catch {
    // En trasig nyckel eller signatur är inte ett undantag att bubbla upp —
    // det är ett underkänt kuvert.
    return false
  }
}
```

- [ ] **Steg 6: Kör testerna**

Kör: `npx vitest run tests/unit/envelope-signature.test.ts`
Förväntat: PASS, 6 tester

- [ ] **Steg 7: Committa**

```bash
git add src/modules/eligibility/bankid/ tests/unit/envelope-signature.test.ts
git commit -m "Väljaren signerar sitt kuvert — en röst går inte att lägga i någon annans namn"
```

---

## Task 9: Lägg och ändra röst

**Files:**
- Create: `src/modules/eligibility/pending-vote.service.ts`, `src/app/api/vote/encrypted/route.ts`
- Test: `tests/integration/pending-vote.test.ts`

**Interfaces:**
- Consumes: `verifyEncryptedBallot`, `EncryptedBallot`, `canonicalOptions` fran uppgift 7;
  `verifyEnvelopeSignature`, `EnvelopePayload` fran uppgift 8
- Produces:
  ```ts
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
  export function castEncryptedBallot(
    voterStatusId: string, electionId: string, ballotId: string,
    ballot: EncryptedBallot, envelope: SignedEnvelope,
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

it('en rost signerad av någon annan avvisas', async () => {
  // REVIEW FOCUS 7. Raden pekar pa en verklig, röstberättigad väljare och
  // passerar varje relationell kontroll — bara signaturen avslöjar den.
  const ballot = await buildBallot('bp-s')
  const envelope = await signAs(kim, ballot, 1)

  expect((await castRaw(voter, ballot, envelope)).status).toBe('invalid_signature')
})

it('ett ateruppspelat aldre kuvert avvisas', async () => {
  // REVIEW FOCUS 8. Utan detta overlever ett röstköp hela andringsmojligheten.
  const first = await buildBallot('bp-s')
  await cast(voter, first, await signAs(voter, first, 1))
  const second = await buildBallot('bp-m')
  await cast(voter, second, await signAs(voter, second, 2))

  expect((await castRaw(voter, first, await signAs(voter, first, 1))).status).toBe('stale_sequence')
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
    select: { id: true, castSequence: true },
  })

  /**
   * RAKNAREN MASTE OKA, OCH KONTROLLEN MASTE LIGGA HAR.
   *
   * Den som fangat väljarens forsta signerade kuvert kan annars skicka in det
   * igen efter att hon ändrat sig, och rosten atergar till den kopta — ett
   * röstköp som overlever hela andringsmojligheten.
   */
  if (existing && envelope.castSequence <= existing.castSequence) {
    return { status: 'stale_sequence' }
  }

  /**
   * SIGNATUREN AR DEN ENDA KONTROLL SOM STANGER "ROST LAGD I NAGON ANNANS NAMN".
   *
   * En rad som skrivs direkt i databasen pekar pa en verklig väljare och
   * passerar varje relationell kontroll. Bara signaturen avslöjar att väljaren
   * aldrig godkant innehallet. Se spec 4.6.
   */
  const voter = await votersDb.voterStatus.findUnique({
    where: { id: voterStatusId },
    select: { externalIdentityHash: true },
  })

  if (
    !voter ||
    !verifyEnvelopeSignature(
      envelope.signature,
      envelope.certificate,
      { electionId, ballotId, ciphertextHash: ballot.ciphertextHash, castSequence: envelope.castSequence },
      voter.externalIdentityHash,
    )
  ) {
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
      bankIdCertificate: envelope.certificate,
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
      bankIdCertificate: envelope.certificate,
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

## Task 10: Validering som spärr före skalning

**Files:**
- Create: `src/orchestration/validate-before-close.usecase.ts`
- Test: `tests/integration/validate-before-close.test.ts`

**Interfaces:**
- Consumes: `verifyEnvelopeSignature`, `envelopePayload` från uppgift 8; `verifyEncryptedBallot` från uppgift 7
- Produces:
  ```ts
  export type Anomaly = {
    kind: 'BAD_SIGNATURE' | 'STALE_SEQUENCE' | 'WRONG_BALLOT' | 'BAD_PROOF'
    pendingVoteId: string
    /** Bara för administratörens utredning. Publiceras aldrig. */
    voterStatusId: string
  }
  export type ValidationReport = {
    /** Publiceras. */
    summary: { votes: number; voters: number; byKind: Record<string, number>; passed: boolean }
    /** Publiceras inte. */
    anomalies: Anomaly[]
  }
  export function validateBeforeClose(electionId: string): Promise<ValidationReport>
  ```

- [ ] **Steg 1: Skriv de fallerande testerna**

```ts
// tests/integration/validate-before-close.test.ts
describe('validering medan kopplingen finns kvar', () => {
  it('en ren omröstning ger noll avvikelser', async () => {
    await castFor(anna, 'bp-s')
    await castFor(kim, 'bp-m')

    const report = await validateBeforeClose(electionId)

    expect(report.summary).toMatchObject({ votes: 2, voters: 2, passed: true })
    expect(report.anomalies).toHaveLength(0)
  })

  it('upptäcker en röst lagd i någon annans namn', async () => {
    /**
     * DET HÅL SOM BARA SIGNATUREN STÄNGER.
     *
     * Raden skrivs direkt i databasen och pekar på en verklig, röstberättigad
     * väljare. Varje relationell kontroll passerar — det är först signaturen
     * som avslöjar att väljaren aldrig godkänt innehållet.
     */
    await stuffVoteFor(kim, 'bp-m') // skriver rad utan giltig signatur

    const report = await validateBeforeClose(electionId)

    expect(report.summary.passed).toBe(false)
    expect(report.anomalies).toContainEqual(
      expect.objectContaining({ kind: 'BAD_SIGNATURE', voterStatusId: kim }),
    )
  })

  it('upptäcker en återuppspelad äldre röst', async () => {
    const first = await castFor(anna, 'bp-s')
    await castFor(anna, 'bp-m')
    await replayEnvelope(anna, first) // skriver tillbaka det gamla kuvertet

    const report = await validateBeforeClose(electionId)

    expect(report.anomalies).toContainEqual(
      expect.objectContaining({ kind: 'STALE_SEQUENCE', voterStatusId: anna }),
    )
  })

  it('upptäcker en valsedel väljaren inte har rätt till', async () => {
    // Gunvor är folkbokförd i Falun och ska inte kunna ha Stockholms
    // kommunvalsedel liggande, oavsett om det beror på bugg eller angrepp.
    await forceBallotFor(gunvor, stockholmMunicipalBallotId)

    const report = await validateBeforeClose(electionId)

    expect(report.anomalies).toContainEqual(
      expect.objectContaining({ kind: 'WRONG_BALLOT', voterStatusId: gunvor }),
    )
  })

  it('rapportens sammanfattning namnger ingen väljare', async () => {
    /**
     * Valideringen kräver att kopplingen läses, alltså precis den förmåga som
     * gör modellen svagare på valhemlighet. Det som publiceras måste därför
     * vara antal och kategorier — aldrig vem.
     */
    await stuffVoteFor(kim, 'bp-m')

    const report = await validateBeforeClose(electionId)

    expect(JSON.stringify(report.summary)).not.toContain(kim)
    expect(report.summary.byKind).toMatchObject({ BAD_SIGNATURE: 1 })
  })

  it('en struken väljares rost underkanns INTE', async () => {
    /**
     * Beslutet i spec 7.4, vaktat.
     *
     * Det ar latt att lagga till en rostberattigandekontroll "for sakerhets
     * skull" — den kanns som en självklarhet. Den skulle förkasta giltiga
     * roster fran väljare som strukits efter att ha rostat.
     */
    await castFor(anna, 'bp-s')
    await votersDb.voterStatus.update({ where: { id: anna }, data: { isEligible: false } })

    const report = await validateBeforeClose(electionId)

    expect(report.summary.passed).toBe(true)
    expect(report.anomalies).toHaveLength(0)
  })

  it('att valideringen körts hamnar i revisionsloggen', async () => {
    // Att läsa kopplingen ska synas. En tyst läsning är oskiljbar från en
    // obehörig.
    await validateBeforeClose(electionId)

    const events = await votersDb.auditEvent.findMany({ orderBy: { id: 'desc' }, take: 1 })
    expect(events[0]!.type).toBe('PRE_CLOSE_VALIDATION')
  })
})
```

- [ ] **Steg 2: Kör och se att de fallerar**

Kör: `npx vitest run tests/integration/validate-before-close.test.ts`
Förväntat: FAIL, modulen saknas

- [ ] **Steg 3: Implementera `validate-before-close.usecase.ts`**

```ts
/**
 * DET ENDA ÖGONBLICK DÅ VARJE RÖST GÅR ATT KNYTA TILL EN VÄLJARE.
 *
 * Före ombyggnaden fanns ingen koppling alls; en felräkning gav ett tal och
 * ingenting mer. Efter skalningen finns ingen väljare kvar att fråga. Däremellan
 * — här — går varje avvikelse att peka ut och utreda.
 *
 * KONTROLLERNAS KARAKTÄR SKILJER SIG ÅT, och det är värt att förstå:
 *
 *   Relationella   säger att raden hänger ihop med resten av databasen. En
 *                  angripare med skrivrättighet ordnar det lätt.
 *   Kryptografiska säger att raden bär ett bevis bara väljaren kunde framställa.
 *                  Ingen med databasåtkomst kan förfalska dem — inte heller vi.
 *
 * Signaturkontrollen är den enda som stänger "en röst lagd i någon annans namn",
 * eftersom en sådan rad passerar varje relationell kontroll: väljaren är verklig,
 * röstberättigad och har rätt till valsedeln.
 */
```

Kontrollerna körs i ordning, billigast först:

1. `WRONG_BALLOT` — valsedeln gäller väljarens kommun och region
2. `STALE_SEQUENCE` — räknaren i signaturen är den högsta väljaren ställt ut
3. `BAD_SIGNATURE` — signaturen verifierar mot chifferhash och personnummer
4. `BAD_PROOF` — valsedelns bevis verifierar

**VALIDERINGEN KONTROLLERAR INTE NUVARANDE ROSTBERATTIGANDE, och det ar ett
beslut och inte en glomska.** Att rosten var legitim nar den lades framgar av
signaturen, inte av rostlangdens tillstand i efterhand. En väljare som strukits
efter att ha rostat — dodsfall ar det realistiska fallet — ska fa sin rost
raknad, precis som en svensk fortidsrost. En kontroll mot nulaget skulle
förkasta giltiga roster. Se spec 7.4.

`passed` är sant enbart när `anomalies` är tom. Skriv `PRE_CLOSE_VALIDATION` till
revisionsloggen med antal, aldrig med identiteter.

Inkopplingen i stangningen gors av UPPGIFT 11, som ager
`close-election.usecase.ts`. Den har uppgiften levererar bara
anvandningsfallet och sina tester.

- [ ] **Steg 4: Kör testerna**

Kör: `npx vitest run tests/integration/validate-before-close.test.ts`
Förväntat: PASS

- [ ] **Steg 5: Committa**

```bash
git add src/orchestration/validate-before-close.usecase.ts tests/integration/validate-before-close.test.ts
git commit -m "Valideringen är en spärr: skalningen körs inte över en avvikelse"
```

---

## Task 11: Stängning och skalning

**Files:**
- Create: `src/orchestration/close-election.usecase.ts`, `src/app/api/admin/elections/close/route.ts`
- Modify: `src/orchestration/final-check.usecase.ts`
- Test: `tests/integration/close-election.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CloseOutcome =
    | { status: 'closed'; moved: number; cleared: number; envelopeRoot: string }
    | { status: 'too_early'; closesAt: Date }
    | { status: 'already_closed' }
    | { status: 'validation_failed'; summary: ValidationReport['summary'] }
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

it('publicerar en kuvertrot INNAN signaturerna raderas', async () => {
  /**
   * Spec 7.3. Roten ar det enda som overlever, sa den måste beraknas medan
   * signaturerna finns. Ett test som bara kontrollerar att roten finns EFTERAT
   * skulle passera aven om den beraknats over en tom mangd.
   */
  await castFor(anna, 'bp-s')
  await castFor(kim, 'bp-m')

  const outcome = await closeElection(electionId)

  expect(outcome).toMatchObject({ status: 'closed' })
  const election = await votersDb.election.findUniqueOrThrow({ where: { id: electionId } })

  expect(election.envelopeRoot).toMatch(/^[0-9a-f]{64}$/)
  // Roten ska vara den over de två faktiska kuverten, inte over ingenting.
  expect(election.envelopeRoot).not.toBe(envelopeRootOf([]))
})

it('vagrar skala nar valideringen hittar en avvikelse', async () => {
  // Sparren, inte rapporten. Skalningen far inte kora over ett fynd.
  await stuffVoteFor(kim, 'bp-m')

  const outcome = await closeElection(electionId)

  expect(outcome.status).toBe('validation_failed')
  expect(await votersDb.pendingVote.count()).toBeGreaterThan(0)
  expect(await votesDb.encryptedVote.count()).toBe(0)
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
 *   1. validera enligt uppgift 10 — avbryt vid avvikelse
 *   2. berakna och spara Merkleroten over kuverten
 *   3. verifiera varje valsedel EN GÅNG TILL
 *   4. infoga i votes_db, sorterat på chifferhash
 *   5. kontrollera att antalet stämmer
 *   6. först då radera kopplingen
 *
 * Steg 1 ar en SPARR, inte en rapport. Att skala anda vore att kasta bort
 * bevismaterialet for det problem man just hittat: efter steg 6 finns ingen
 * väljare att fraga och ingen signatur att kontrollera.
 *
 * Steg 2 MASTE ligga fore steg 6. Merkleroten over (ciphertextHash,
 * bankIdSignature), sorterade pa chifferhash, ar det enda som overlever
 * raderingen av signaturerna — och det som later en väljare med sparat kuvert
 * bevisa i efterhand att det räknades. Beraknas den efter raderingen finns
 * ingenting att berakna den over. Roten avslöjar ingenting själv; den ar en
 * hash.
 *
 * Steg 3 känns överflödigt — bevisen kontrollerades ju när rösten lades. Det är
 * ändå rätt: det är den sista punkt där ett fel kan pekas ut.
 *
 * Steg 4 före 6 är inte en smaksak. Raderade vi först och kraschade skulle
 * rösterna vara borta utan att finnas i räkningen — ingen kan återskapa dem.
 * Flyttar vi först och kraschar är chiffren redan trygga, och omkörningen ser
 * dem som befintliga tack vare det unika indexet på ciphertextHash.
 *
 * SORTERINGEN PÅ INNEHÅLL är inte kosmetik. Skulle raderna infogas i den
 * ordning väljarna röstade kunde den som vet när någon legitimerade sig peka
 * ut hens rad, och skalningen vore verkningslös.
 */
```

Implementera enligt kommentaren. Uppdatera `Election.linkClearedAt` och
`Election.phase` sist.

**Kuvertrotens format måste vara utskrivet, inte uppfunnet.** Den oberoende
verifieraren i uppgift 13 ska kunna rakna om den utan att lasa var kallkod, och
en väljare ska kunna bevisa inklusion mot den. Aterbruka `src/lib/merkle.ts`,
som redan finns och bar domanseparerade prefix samt bladantalet i roten:

```ts
import { hashLeaf, merkleRoot } from '@/lib/merkle'

/**
 * Ett blad per kuvert, sorterat pa chifferhash.
 *
 * Sorteringen gor roten oberoende av i vilken ordning väljarna rostade — samma
 * skal som infogningen i votes_db sorteras. Bladet binder BADE hashen och
 * signaturen: bara hashen hade latit en signatur bytas ut obemarkt, bara
 * signaturen hade inte pekat ut vilken rost den horde till.
 */
export function envelopeLeaf(envelope: { ciphertextHash: string; bankIdSignature: string }): string {
  return hashLeaf(`${envelope.ciphertextHash}|${envelope.bankIdSignature}`)
}

export function envelopeRootOf(
  envelopes: Array<{ ciphertextHash: string; bankIdSignature: string }>,
): string {
  const sorted = [...envelopes].sort((a, b) => a.ciphertextHash.localeCompare(b.ciphertextHash))
  return merkleRoot(sorted.map(envelopeLeaf))
}
```

Bada funktionerna exporteras ur `close-election.usecase.ts`, sa att bade testet
och den oberoende verifieraren kan anropa dem.

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

## Task 12: Summering och tröskeldekryptering

**Files:**
- Create: `src/orchestration/tally.usecase.ts`, `src/app/api/admin/elections/decrypt/route.ts`
- Test: `tests/integration/tally.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function aggregate(ballotId: string): Promise<Ciphertext[]>
  export function submitPartialDecryption(
    ballotId: string, trusteeIndex: number, passphrase: string,
  ): Promise<{ status: 'accepted' | 'rejected' | 'duplicate' | 'wrong_passphrase' }>
  export function completeTally(ballotId: string): Promise<{ status: 'tallied'; counts: number[] } | { status: 'needs_more_trustees'; have: number; need: number }>
  ```

- [ ] **Steg 1: Skriv de fallerande testerna**

```ts
it('räknar rätt utan att öppna någon enskild röst', async () => {
  await castFor(anna, 'bp-s')
  await castFor(kim, 'bp-s')
  await castFor(robin, 'bp-m')
  await closeElection(electionId)

  await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0]!)
  await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1]!)
  const result = await completeTally(ballotId)

  expect(result).toMatchObject({ status: 'tallied' })
  expect((result as { counts: number[] }).counts).toEqual([0, 2, 1]) // blank, S, M
})

it('fel lösenfras later ingen andel oppnas', async () => {
  // Utan detta ar frasen dekoration och andelen lika oskyddad som forut.
  await closeElection(electionId)

  expect(await submitPartialDecryption(ballotId, 1, 'fel')).toMatchObject({
    status: 'wrong_passphrase',
  })
})

it('en ensam förtroendeman räcker inte', async () => {
  await closeElection(electionId)
  await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0]!)

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
  await submitPartialDecryption(emptyBallotId, 1, TRUSTEE_PASSPHRASES[0]!)
  await submitPartialDecryption(emptyBallotId, 2, TRUSTEE_PASSPHRASES[1]!)

  expect(await completeTally(emptyBallotId)).toMatchObject({ status: 'tallied', counts: [0, 0, 0] })
})

it('ingen enskild röst finns dekrypterad någonstans efteråt', async () => {
  // Det som gör valhemligheten strukturell och inte en rutin.
  await castFor(anna, 'bp-s')
  await closeElection(electionId)
  await submitPartialDecryption(ballotId, 1, TRUSTEE_PASSPHRASES[0]!)
  await submitPartialDecryption(ballotId, 2, TRUSTEE_PASSPHRASES[1]!)
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

**TVA FYND FRAN TIDIGARE UPPGIFTER SOM DEN HAR UPPGIFTEN AGER.**

Granskningen av uppgift 1 och 3 noterade att kryptoprimitiven medvetet inte
självförsvarar sig — de litar pa att anroparen validerar. Den har uppgiften ar
anroparen, och far därför inte arva den tilliten:

1. **`combine` ska vagra dubbla `trusteeIndex`.** Utan vakten utesluter den inre
   loopens `j === i`-filter aven dubblettens eget index ur produkten, och
   Lagrange-koefficienten blir fel — TYST. Ett felaktigt röstetal som inte kastar
   ar den värsta felklassen i ett räkneverk. Det unika indexet
   `@@unique([ballotId, optionIndex, trusteeIndex])` hindrar det i praktiken, men
   vakten ar två rader och gor felet loud:

   ```ts
   const indices = new Set(partials.map((partial) => partial.trusteeIndex))
   if (indices.size !== partials.length) {
     throw new Error('Samma förtroendeman bidrog två gånger.')
   }
   ```

   Lagg den i `combine` i `src/lib/crypto/threshold.ts` som en del av den har
   uppgiften, och tacka den med ett test.

2. **Validera gruppelement fran databasen innan de anvands.** Chiffren
   kontrollerades med `isInSubgroup` nar rosten lades, men aggregeringen laser dem
   fran `votes_db` och ska inte forutsatta att ingen rort dem däremellan. Anropa
   `isInSubgroup` pa varje `c1` och `c2` innan de multipliceras ihop, och avbryt
   rakningen med ett tydligt fel om något faller — en tyst felaktig summa ar sam re
   an ett avbrott.

- [ ] **Steg 4: Kör testerna**

Kör: `npx vitest run tests/integration/tally.test.ts`
Förväntat: PASS, 5 tester

- [ ] **Steg 5: Committa**

```bash
git add src/orchestration/tally.usecase.ts src/app/api/admin/elections/decrypt/route.ts tests/integration/tally.test.ts
git commit -m "Homomorf räkning: bara summan öppnas, av två förtroendemän"
```

---

## Task 13: Publicering och oberoende verifiering

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

## Task 14: Slakta blindsigneringen

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

## Task 15: Dokumentation och begränsningar

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

## Task 16: Demoläge och skarpt läge

**Files:**
- Create: `src/lib/runtime-mode.ts`, `src/app/api/mode/route.ts`
- Modify: `src/modules/eligibility/bankid/index.ts`, `prisma/votes/schema.prisma`, `prisma/voters/schema.prisma`
- Test: `tests/unit/runtime-mode.test.ts`, `tests/security/demo-mode-cannot-reach-production.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RuntimeMode = 'DEMO' | 'SHARP'
  export type Requirement = { id: string; met: boolean; detail: string }
  export function runtimeMode(): RuntimeMode
  export function sharpModeRequirements(): Requirement[]
  export function assertBootable(): void
  ```

- [ ] **Steg 1: Skriv de fallerande testerna**

```ts
// tests/unit/runtime-mode.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'

async function load(env: Record<string, string>) {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return import('@/lib/runtime-mode')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('vilket läge appen kör i', () => {
  it('skarpt är förvalt — demoläge kräver ett aktivt val', async () => {
    // Förvalet måste vara det säkra. En glömd variabel ska inte kunna
    // innebära att vem som helst kan logga in som vem som helst.
    const { runtimeMode } = await load({ NODE_ENV: 'development' })

    expect(runtimeMode()).toBe('SHARP')
  })

  it('demoläge kräver både flaggan och att det inte är produktion', async () => {
    const demo = await load({ NODE_ENV: 'development', DEMO_MODE: 'true' })
    expect(demo.runtimeMode()).toBe('DEMO')

    const prod = await load({ NODE_ENV: 'production', DEMO_MODE: 'true' })
    expect(prod.runtimeMode()).toBe('SHARP')
  })
})

describe('produktion med demoflaggan satt', () => {
  it('kraschar vid start i stället för att välja ett läge', async () => {
    /**
     * DET FARLIGASTE UTFALLET I HELA APPEN.
     *
     * I demoläge kringgår demoidentiteterna BankID helt — vem som helst kan
     * rösta som vem som helst. En produktionsdeploy som tyst hamnar i demoläge
     * vore därför inte en felkonfiguration utan ett totalhaveri för valet.
     *
     * Att tyst falla tillbaka till skarpt läge vore heller inte rätt: då döljer
     * vi att någon försökt sätta flaggan. Ett valsystem som inte startar är
     * bättre än ett som startar i fel läge.
     */
    const { assertBootable } = await load({ NODE_ENV: 'production', DEMO_MODE: 'true' })

    expect(() => assertBootable()).toThrow(/DEMO_MODE/)
  })
})

describe('skarpt läge är en checklista, inte en boolean', () => {
  it('räknar upp exakt vad som saknas', async () => {
    const { sharpModeRequirements } = await load({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'false',
      APP_ORIGIN: 'http://val.example',
      IDENTITY_PEPPER: 'byt-ut-mig-detta-ar-bara-for-lokal-utveckling-0000',
    })

    const unmet = sharpModeRequirements().filter((requirement) => !requirement.met)

    expect(unmet.map((requirement) => requirement.id).sort()).toEqual([
      'bankid-real',
      'cookie-secure',
      'https-origin',
      'pepper-changed',
      'trustee-passphrases-changed',
    ])
  })

  it('vägrar starta så länge något krav är ouppfyllt', async () => {
    const { assertBootable } = await load({ NODE_ENV: 'production', COOKIE_SECURE: 'false' })

    // Meddelandet ska räkna upp vad som saknas. Ett "konfigurationsfel" utan
    // lista tvingar den som driftsätter att gissa.
    expect(() => assertBootable()).toThrow(/cookie-secure/)
  })

  it('demoläge behöver inte uppfylla listan', async () => {
    const { assertBootable } = await load({ NODE_ENV: 'development', DEMO_MODE: 'true' })

    expect(() => assertBootable()).not.toThrow()
  })
})
```

```ts
// tests/security/demo-mode-cannot-reach-production.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('demoläget kan inte nå produktion', () => {
  it('varje demorutt är villkorad på lägesfunktionen', () => {
    // Statisk kontroll, av samma skäl som api-surface-testet: en ny demorutt
    // ska inte kunna glömmas bort.
    for (const route of ['bankid-scan', 'reset-rate-limits', 'database-state']) {
      const content = readFileSync(`src/app/api/demo/${route}/route.ts`, 'utf8')

      expect(content, `${route} saknar lägeskontroll`).toMatch(
        /runtimeMode\(\) !== 'DEMO'|!isDemoMode/,
      )
    }
  })

  it('lägesfunktionen läser inte bara en enda variabel', () => {
    // Ett `DEMO_MODE === 'true'` utan NODE_ENV-villkor vore en enda felsatt
    // miljövariabel från katastrof.
    const content = readFileSync('src/lib/runtime-mode.ts', 'utf8')

    expect(content).toContain('NODE_ENV')
    expect(content).toContain('DEMO_MODE')
  })
})
```

- [ ] **Steg 2: Kör och se att de fallerar**

Kör: `npx vitest run tests/unit/runtime-mode.test.ts`
Förväntat: FAIL, modulen saknas

- [ ] **Steg 3: Implementera `runtime-mode.ts`**

```ts
/**
 * DEMOLÄGE OCH SKARPT LÄGE.
 *
 * I demoläge kringgår demoidentiteterna BankID helt — vem som helst kan rösta
 * som vem som helst. Det är hela poängen med en demo, och det är också därför
 * den här filen är en av de farligaste i projektet.
 *
 * TRE REGLER, OCH DE ÄR ALLA DEFENSIVA
 *
 *   1. Skarpt läge är förvalt. En glömd variabel ger det säkra utfallet.
 *   2. Demoläge kräver BÅDE flaggan och att det inte är produktion. En enda
 *      felsatt variabel räcker alltså inte.
 *   3. Produktion med flaggan satt KRASCHAR. Att tyst falla tillbaka till
 *      skarpt läge vore att dölja att någon försökt.
 *
 * Ett valsystem som inte startar är bättre än ett som startar i fel läge.
 *
 * SKARPT LÄGE ÄR EN CHECKLISTA
 *
 * Ett läge som bara betyder "inte demo" ger falsk trygghet: appen kan köra med
 * exempelpeppar över http med demofraser för förtroendemännen och ändå kalla
 * sig skarp. Kraven räknas därför upp, och appen vägrar starta tills alla är
 * uppfyllda — med en lista på vad som saknas, så att den som driftsätter
 * slipper gissa.
 */

export type RuntimeMode = 'DEMO' | 'SHARP'
export type Requirement = { id: string; met: boolean; detail: string }

const EXAMPLE_PEPPER = 'byt-ut-mig-detta-ar-bara-for-lokal-utveckling-0000'

export function runtimeMode(): RuntimeMode {
  if (process.env.NODE_ENV === 'production') return 'SHARP'
  return process.env.DEMO_MODE === 'true' ? 'DEMO' : 'SHARP'
}

export function sharpModeRequirements(): Requirement[] {
  return [
    {
      id: 'bankid-real',
      met: process.env.BANKID_CERT_PATH !== undefined,
      detail: 'BANKID_CERT_PATH saknas — ingen riktig legitimering är konfigurerad.',
    },
    {
      id: 'cookie-secure',
      met: process.env.COOKIE_SECURE === 'true',
      detail: 'COOKIE_SECURE måste vara true, annars går sessionscookien i klartext.',
    },
    {
      id: 'https-origin',
      met: (process.env.APP_ORIGIN ?? '').split(',').every((o) => o.trim().startsWith('https://')),
      detail: 'Varje origin i APP_ORIGIN måste vara https.',
    },
    {
      id: 'pepper-changed',
      met: process.env.IDENTITY_PEPPER !== EXAMPLE_PEPPER,
      detail: 'IDENTITY_PEPPER är kvar på exempelvärdet — hela röstlängden vore läsbar.',
    },
    {
      id: 'trustee-passphrases-changed',
      met: process.env.SEEDED_TRUSTEE_PASSPHRASES !== 'true',
      detail: 'Förtroendemännens fraser är de seedade, som står i repot.',
    },
  ]
}

export function assertBootable(): void {
  if (process.env.NODE_ENV === 'production' && process.env.DEMO_MODE === 'true') {
    throw new Error(
      'DEMO_MODE är satt i produktion. I demoläge kan vem som helst rösta som vem som ' +
        'helst. Appen startar inte.',
    )
  }

  if (runtimeMode() === 'DEMO') return

  const unmet = sharpModeRequirements().filter((requirement) => !requirement.met)
  if (unmet.length === 0) return

  throw new Error(
    'Skarpt läge kan inte startas. Följande krav är ouppfyllda:\n' +
      unmet.map((requirement) => `  ${requirement.id}: ${requirement.detail}`).join('\n'),
  )
}
```

- [ ] **Steg 4: Låt omröstningen bära sitt läge**

Lägg till på `Election` i båda schemana:

```prisma
  /// Vilket läge omröstningen skapades i.
  ///
  /// En server i skarpt läge vägrar röra en DEMO-omröstning, och tvärtom.
  /// Utan det kan demoröster hamna i ett skarpt val — och en demoomröstning
  /// skulle kunna fastställas som riktig.
  mode String @default("DEMO")
```

`castEncryptedBallot`, `closeElection` och `certifyElection` avvisar en omröstning vars
`mode` skiljer sig från `runtimeMode()`.

- [ ] **Steg 5: Kör testerna**

Kör: `npx vitest run tests/unit/runtime-mode.test.ts tests/security/demo-mode-cannot-reach-production.test.ts`
Förväntat: PASS, 8 tester

- [ ] **Steg 6: Committa**

```bash
git add src/lib/runtime-mode.ts src/app/api/mode/route.ts prisma/ tests/unit/runtime-mode.test.ts tests/security/demo-mode-cannot-reach-production.test.ts
git commit -m "Demoläge och skarpt läge, med produktion som felläge"
```

---

## Sjalvgranskning

**Spec-tackning.** Avsnitt 4.1–4.5 till uppgift 1–3. Avsnitt 4.3 till uppgift 4. Avsnitt
4.6 till uppgift 8. Avsnitt 5 till uppgift 5. Avsnitt 6 steg 1 till uppgift 6, steg 2–6
till uppgift 7–9, steg 7 till uppgift 10–11, steg 8–9 till uppgift 12, steg 10 till
uppgift 11 steg 4. Avsnitt 7 till uppgift 10. Avsnitt 8 till uppgift 14. Avsnitt 9–10
till uppgift 15. Ingen lucka.

**Typkonsistens.** `Ciphertext` definieras i uppgift 1 och anvands ooforandrad i 2, 3, 7
och 12. `EqualityProof` definieras i uppgift 2 och anvands i 3. `EncryptedBallot`
definieras i uppgift 7 och konsumeras i 9. `BallotOption` definieras i uppgift 4 och
anvands i 7. `EnvelopePayload` definieras i uppgift 8 och konsumeras i 9 och 10.
`proofContext` och `envelopePayload` delas mellan bevisare och verifierare — de två
funktioner som måste vara bitidentiska pa bada sidor.

**Review Focus-tackning.** 1 till uppgift 1 och 9. 2 till uppgift 9. 3 till uppgift 11.
4 till uppgift 3 och 12. 5 till uppgift 2. 6 till uppgift 1 och 12. 7 och 8 till uppgift
8 och 10.

**Beslut som tagits och som uppgifterna måste folja:**

- **Andelarna krypteras med en lösenfras per förtroendeman**, aldrig lagrad. Uppgift 6
  måste alltså ta emot tre fraser vid valets skapande, och uppgift 12 begara dem vid
  dekrypteringen. Demofraser seedas och skrivs ut. Spec 4.5.
- **Signaturerna forstors vid skalningen, men en Merklerot over (ciphertextHash,
  signatur) publiceras forst.** Uppgift 11 måste berakna och publicera roten fore
  raderingen, inte efter. Spec 7.3.
- **En struken väljares rost räknas anda.** Uppgift 5 far därför INTE satta kaskad fran
  VoterStatus till PendingVote, och uppgift 10 far INTE kontrollera nuvarande
  röstberättigande. Spec 7.4.
- **Ingen preliminar rakning under pagaende röstning.** Spec 6.2. Ett avsiktligt bortval,
  inte en glomd funktion — och satsvis overforing loser tidskopplingen men inte
  ändringsdriften eller det juridiska.
- **Skarpt lage ar forvalt och ar en checklista.** Uppgift 16. Demolage kraver bade
  flaggan och att det inte ar produktion; produktion med flaggan satt kraschar vid start.
