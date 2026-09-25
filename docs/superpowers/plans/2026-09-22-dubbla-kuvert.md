# Dubbla kuvert med ändringsbar röst — implementationsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ersätt blindsignaturer med dubbla kuvert, så att en väljare kan ändra sin röst fram till stängning och ett röstköp därmed blir värdelöst — utan att förlora valhemligheten eller verifierbarheten.

**Architecture:** Rösten krypteras i webbläsaren under valets tröskelnyckel och lagras kopplad till väljaren i `voters_db` medan röstningen pågår, vilket gör den utbytbar. Vid stängning flyttas chiffren till `votes_db` utan identitet och kopplingen raderas. Resultatet räknas homomorft, så ingen enskild röst dekrypteras någonsin — bara summan öppnas, av k av n förtroendemän tillsammans.

**Tech Stack:** TypeScript, Next.js 15, Prisma, PostgreSQL, Vitest, Playwright. Kryptot skrivs med `BigInt` och Node `crypto` — **inga nya beroenden**.

**Spec:** `docs/spec/2026-09-22-dubbla-kuvert.md`

## Global Constraints

- **Inga nya npm-beroenden**, med ett dokumenterat undantag i uppgift 18 (OpenAPI).
  Regeln skrevs för kryptot: varje kryptoberoende är en angreppsyta i just den kod
  som bär valhemligheten, och mätningen visade att inget behövs. Undantaget rör
  varken krypto, röstdata eller identiteter. Den ursprungliga mätningen, 2,0 ms per
  modexp, gällde OpenSSL och inte ren BigInt. Rättade siffror står i spec 4.1: 39,7 ms i
  Node och 4,4 ms i Chromium. Regeln står kvar, eftersom uppgift 14b når OpenSSL via
  `node:crypto` utan nya beroenden.
- **Grupp:** RFC 3526 MODP Group 14. `g = 4` (ordning `q`), alla exponenter mod `q = (p-1)/2`.
- **Varje mottaget gruppelement valideras** med `1 < y < p` och `y^q ≡ 1 (mod p)` innan det används.
- **Kommentarer och användartext på svenska**, som resten av kodbasen. Kommentarer förklarar *varför*, inte *vad*.
- **`votes_db` får aldrig innehålla identitet.** Vaktas av `tests/security/schema-separation.test.ts`.
- **Tidsstämplar grovkornas** — dygn i `voters_db`, timme i `votes_db` — enligt `src/lib/time.ts`.
- **Varje uppgift slutar med grön svit och en commit.** `npx tsc --noEmit` ska ge noll fel.
- **Bygget och dev-servern kan köra samtidigt**, eftersom de har var sin katalog:
  `.next-dev` för dev-servern och `.next` för bygget. Bygget skriver om `next-env.d.ts`,
  som återställs med `git checkout -- next-env.d.ts`. Byggskriptet kör inte
  `prisma generate`. Regeln att aldrig bygga medan dev-servern kör är föråldrad.

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
| `src/app/vote/page.tsx` | Visa lagd röst, tillåt ändring, visa chifferhash |
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
  /// Den publika nyckeln ur certifikatet — INTE certifikatet självt.
  ///
  /// Certifikatet bär personnumret i klartext, både i attrappens format och i
  /// riktiga svenska BankID-certifikat där det ligger i subject. Att lagra det
  /// i råform skulle sätta ett klartextpersonnummer bredvid identitetshashen i
  /// röstlängden, alltså upphäva hela skälet att hasha.
  ///
  /// Nyckeln räcker för att verifiera signaturen om vid valideringen. Att
  /// underskrivaren var rätt person avgörs när rösten läggs, och bärs därefter
  /// av radens koppling till voterStatusId.
  bankIdPublicKey String @map("bankid_public_key")

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

    expect(() =>
      decryptShare(share.encryptedShare, 'fel-fras', id, share.trusteeIndex),
    ).toThrow()
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
    encryptedShare: encryptShare(
      share.value,
      input.trusteePassphrases[share.index - 1]!,
      election.id,
      share.index,
    ),
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
function keyFor(passphrase: string, electionId: string, trusteeIndex: number): Buffer {
  return scryptSync(passphrase, `trustee-share-${electionId}-${trusteeIndex}`, 32)
}

export function encryptShare(
  value: bigint,
  passphrase: string,
  electionId: string,
  trusteeIndex: number,
): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(passphrase, trusteeIndex), iv)
  const encrypted = Buffer.concat([cipher.update(value.toString(), 'utf8'), cipher.final()])

  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(
    ':',
  )
}

export function decryptShare(
  stored: string,
  passphrase: string,
  electionId: string,
  trusteeIndex: number,
): bigint {
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

/**
 * BEVISEN MASTE SERIALISERAS, PRECIS SOM CHIFFRET.
 *
 * ZeroOrOneProof och EqualityProof bar bigint-falt, och JSON.stringify kastar
 * pa bigint. Kuvertet ska bade over HTTP och ner i en jsonb-kolumn, sa typerna
 * fran proofs.ts kan inte anvandas direkt har.
 *
 * Samma monster som chiffret redan foljer: {c1, c2} lagras som strangar och
 * parsas till bigint forst nar de ska raknas med. Rundgangen maste vara trogen
 * — en parse som tyst ger ett annat varde an serialiseringen skrev skulle
 * underkanna arliga bevis, och skulle kunna passera testerna eftersom samma kod
 * bade skriver och laser.
 */
export type SerialisedZeroOrOneProof = Record<keyof ZeroOrOneProof, string>
export type SerialisedEqualityProof = Record<keyof EqualityProof, string>

export type EncryptedBallot = {
  ciphertext: Array<{ c1: string; c2: string }>
  proofs: { components: SerialisedZeroOrOneProof[]; sum: SerialisedEqualityProof }
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
  /**
   * TVA SKILDA KONTROLLER, OCH DE FAR INTE SLAS IHOP.
   *
   * 1. Ar signaturen giltig for den nyttolast servern byggde? Rent
   *    kryptografiskt, ingen identitet inblandad.
   * 2. Tillhor certifikatet SAMMA person som sessionen? Det avgors genom att
   *    hasha personnumret certifikatet pastar och jamfora mot rostlangdens
   *    identitetshash.
   *
   * Granskningen av uppgift 8 fangade att ett tidigare utkast skickade
   * `voter.externalIdentityHash` direkt som `expectedPersonalNumber` till
   * verifyEnvelopeSignature. Den funktionen jamfor mot certifikatets
   * KLARTEXTSIFFROR, sa en hash hade aldrig matchat — och varje giltig rost
   * hade avvisats med `invalid_signature`. Ett totalt, tyst haveri i precis den
   * funktion uppgiften bygger.
   *
   * Hashningen ar dessutom asynkron (scrypt genom antagningskon), vilket ar
   * skalet att den hor hemma har och inte i signaturmodulen.
   */
  const voter = await votersDb.voterStatus.findUnique({
    where: { id: voterStatusId },
    select: { externalIdentityHash: true },
  })

  if (!voter) return { status: 'not_eligible' }

  const signatureIsValid = verifyEnvelopeSignature(envelope.signature, envelope.certificate, {
    electionId,
    ballotId,
    ciphertextHash: ballot.ciphertextHash,
    castSequence: envelope.castSequence,
  })

  const assertedPersonalNumber = personalNumberFromCertificate(envelope.certificate)

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
       * Certifikatet bar personnumret i klartext — bade i attrappens format och
       * i riktiga svenska BankID-certifikat, dar det ligger i subject. Att lagra
       * det raform skulle satta ett klartextpersonnummer bredvid
       * identitetshashen i rostlangden, alltsa upphava hela skalet att hasha.
       *
       * Det som behovs senare ar (a) nyckeln, for att kunna verifiera signaturen
       * om vid valideringen, och (b) att underskrivaren var ratt person — och
       * det andra ar redan avgjort av kontrollen ovan och bars av radens
       * koppling till voterStatusId.
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
```

- [ ] **Steg 3a: Lägg till `publicKeyFromCertificate`**

`envelope-signature.ts` exporterar redan `personalNumberFromCertificate`. Lägg
en systerfunktion bredvid den, så att det fortsätter finnas **ett enda ställe**
som förstår certifikatformatet:

```ts
/**
 * Nyckelmaterialet ur certifikatet, utan det som identifierar personen.
 *
 * Certifikatet bär personnumret i klartext. Det som ska lagras och senare
 * verifieras mot är nyckeln, inte påståendet om vem den tillhör — den
 * kopplingen avgörs när rösten läggs och bärs därefter av radens koppling till
 * väljaren.
 *
 * Attrappens format har personnumret på en rad före PEM-blocket. Ett riktigt
 * X.509-certifikat har det i subject-fältet och saknar prefixet helt, så där
 * returneras certifikatet oförändrat — nyckeln extraheras då av crypto vid
 * verifieringen.
 *
 * Ligger bredvid personalNumberFromCertificate med flit: två funktioner som
 * tolkar samma format på var sitt håll skulle kunna glida isär, och symptomet
 * vore signaturer som verifierar mot fel nyckel.
 */
export function publicKeyFromCertificate(certificate: string): string {
  return certificate.replace(/^personnummer:\d+
/, '')
}
```

Ett test som vaktar att båda funktionerna läser samma certifikat konsekvent:

```ts
it('nyckel och personnummer läses ur samma certifikat utan att störa varandra', async () => {
  const data = await signAs('199001011234')

  expect(personalNumberFromCertificate(data.certificate)).toBe('199001011234')
  expect(publicKeyFromCertificate(data.certificate)).toMatch(/^-----BEGIN PUBLIC KEY-----/)
  expect(publicKeyFromCertificate(data.certificate)).not.toContain('personnummer:')
})
```

- [ ] **Steg 3b: Byt ut certifikatkolumnen**

Uppgift 5 byggdes innan granskningen av uppgift 8 hittade det här, så kolumnen
heter `bankid_certificate` i databasen. Den ska bära den publika nyckeln, inte
certifikatet — se kommentaren i schemat.

```bash
# Efter att schemat ändrats:
npx prisma migrate dev --schema=prisma/voters/schema.prisma --name bankid_public_key --create-only
npm run migrate && npm run generate
```

Stoppa dev-servern före `generate` — en körande Next-process håller Prisma-
motorns DLL låst på Windows, och felet ser ut som ett rättighetsproblem.

Tabellen är tom i alla miljöer (ingen röst har lagts än), så en `DROP COLUMN`
följd av `ADD COLUMN` är riskfri här. Skriv ändå migreringen som ett namnbyte
om kolumnen kan innehålla data när du kör den.

- [ ] **Steg 4: Skriv rutten `src/app/api/vote/encrypted/route.ts`**

Följ mönstret i `src/app/api/vote/cast/route.ts`: origin-kontroll, hastighetsgräns
`castVote`, CSRF-token, sessionsuppslag, anrop, svar. Rutten returnerar
`{ status, ciphertextHash, replaced }` och aldrig något om innehållet.

### SIGNATUREN OCH CERTIFIKATET FÅR ALDRIG KOMMA FRÅN BEGÄRANS KROPP

Det här är uppgiftens farligaste detalj, och den avgör om signaturen betyder
något alls.

Tar rutten emot `signature` och `certificate` från klienten kan vem som helst
skapa ett eget nyckelpar, formatera ett certifikat med valfritt personnummer,
signera vad som helst med det, och skicka in. `verifyEnvelopeSignature` skulle
säga ja: signaturen stämmer mot certifikatet, och certifikatet påstår rätt
person. Hela mekanismen vore dekoration — och det är just det hål uppgift 8
finns för att stänga.

**Servern måste hämta båda från sin egen BankID-hämtning**, och den måste
själv bygga den nyttolast den verifierar mot. Klienten skickar aldrig något
som ingår i signaturen.

Flödet blir därför tvådelat:

```
1. POST /api/vote/sign-start  { ballotId, ciphertextHash }
   Servern räknar fram castSequence (befintlig + 1, eller 1), bygger
   envelopePayload SJÄLV, och startar en BankID-signering med den i
   userNonVisibleData. Returnerar orderRef, QR och autostart.

2. POST /api/vote/encrypted   { ballotId, orderRef, ballot }
   Servern hämtar completionData från BankID, tar signature och certificate
   DÄRIFRÅN, och verifierar mot den nyttolast den byggde i steg 1 — inte mot
   något klienten påstår.
```

`castSequence` kommer alltså också från servern. Fick klienten sätta den kunde
den ange ett godtyckligt högt tal och sedan spela upp ett äldre kuvert med ett
ännu högre — återuppspelningsskyddet skulle vara verkningslöst.

Lägg till ett test som vaktar egenskapen:

```ts
it('en signatur som klienten skickar med i kroppen ignoreras', async () => {
  /**
   * Utan detta kan vem som helst skapa ett eget nyckelpar, formatera ett
   * certifikat med valfritt personnummer, och signera vad som helst. Servern
   * hämtar därför signaturen från BankID och aldrig från begäran.
   */
  const forged = await selfSignedEnvelopeFor('199001011234', ballot)

  const response = await post('/api/vote/encrypted', {
    ballotId,
    orderRef: unsignedOrderRef,
    ballot,
    signature: forged.signature,
    certificate: forged.certificate,
    castSequence: 99,
  })

  expect(response.status).not.toBe('recorded')
})
```

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

**Och gör `phase` auktoritativ där den är tillgänglig.** Granskningen av uppgift
9 påpekade att `castEncryptedBallot` avgör "stängd" enbart via klockan och
`linkClearedAt`, aldrig via fasen — trots att fältets egen kommentar säger att
en klocka som går fel ändrar beteendet tyst medan en fasövergång är en händelse
någon utfört. Det var planmandaterat, eftersom fasen inte fanns förrän nu.

Utöka därför kontrollen i `pending-vote.service.ts` så att en röst avvisas när
`election.phase !== 'OPEN'`, utöver de befintliga villkoren. Behåll
klockkontrollen — den fångar fallet att stängningen ännu inte körts fast tiden
gått ut. Lägg ett test som sätter fasen till `CLOSED` med klockan kvar i
framtiden och kräver att rösten avvisas.

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

## Task 11b: Engelska sökvägar i hela appen

**Beslut av användaren 2026-09-23:** *"Kör engelska urls på hela appen."*
Gränssnittet förblir på svenska; bara sökvägarna byts.

| Från | Till |
|---|---|
| `/legitimera` | `/identify` |
| `/rosta` | `/vote` |
| `/verifiera` | `/verify` |
| `/demo` | `/architecture` |

`/admin` och alla API-rutter är redan engelska. `/api/demo/*` behåller sitt namn:
de rutterna hör till demoläget (attrapp-BankID) och inte till arkitektursidan.
Att sidan hette `/demo` blandade ihop de två, vilket blir ett verkligt problem när
uppgift 17 gör demoläget till en egen växel.

**Files:** flytta katalogerna under `src/app` med `git mv`, så att historiken
följer med. Uppdatera sedan varje referens: menyn i `layout.tsx`, länkar i sidor
och komponenter, returadressen i BankID:s flöde på samma enhet, länkar i
pushnotiser, matchare i `middleware.ts`, e2e-testernas `page.goto`, och
säkerhetstester som läser sidfiler efter sökväg (till exempel
`known-limitations.test.ts`, som läser `src/app/demo/page.tsx`).

**Omdirigeringarna, och varför de INTE är permanenta**

`next.config.ts` har i dag `{ source: '/verify', destination: '/verifiera',
permanent: true }`. Vänds den bara om blir det en loop. Det finns också en
fälla som inte syns i koden: webbläsare cachar permanenta omdirigeringar. En
enhet som en gång besökt `/verify` minns att den ska till `/verifiera`, och
möter sedan serverns nya omdirigering tillbaka. Loopen sitter då i
webbläsaren och överlever en rättning på servern.

Ta därför bort den gamla omdirigeringen och lägg de fyra svenska sökvägarna som
**tillfälliga** omdirigeringar (`permanent: false`). Ett proof of concept har
inget sökmotorbehov som motiverar permanenta, och permanenta omdirigeringar
gör varje framtida namnbyte till en loop på användarnas enheter. Skriv skälet i
kommentaren. Den nuvarande kommentaren säger att *"gränssnittet är på svenska,
så verifieringssidan ligger på /verifiera"*, och den ska ersättas.

- [ ] Flytta, uppdatera referenser och omdirigera
- [ ] Verifiera med `curl`: varje ny sökväg svarar 200, varje gammal svarar 307
      till den nya, och `curl -L --max-redirs 5` når fram utan loop, även för
      `/verify`
- [ ] `grep` i `src/` och `tests/`: inga svenska sidsökvägar kvar utom i
      omdirigeringstabellen
- [ ] `npx tsc --noEmit`, `npx vitest run` och `npx playwright test`
- [ ] Committa

---

## Task 11c: Arkitektursidan beskriver kuvertmodellen

**Prioriterad av användaren 2026-09-23.** Alla fyra innehållsdelarna är valda.

**Files:**
- Modify: `src/app/architecture/page.tsx` (flyttad i uppgift 11b), `src/app/api/demo/database-state/route.ts`
- Test: e2e för sidan, och säkerhetstester som läser sidan

**Varför den måste skrivas om, inte lappas**

Sidan beskriver i sin helhet den gamla modellen: röstintyg, blinda signaturer,
tokens och `anonymous_vote`. Dess bärande demonstration, *"Finns det någon
koppling?"* med de främmande nycklarna ur `information_schema`, har också blivit
fel. I kuvertmodellen finns kopplingen med flit medan röstningen pågår. Det som
skyddar valhemligheten då är att chiffret inte går att läsa utan k av n andelar,
och vid stängningen raderas kopplingen. Det är en starkare demonstration än den
gamla, eftersom den visar skyddet ändra form.

**Innehåll**

1. **Kuvertmodellen förklarad.** Analogin först, sedan faserna
   `OPEN → CLOSED → VALIDATED → STRIPPED → TALLIED → CERTIFIED` med vad varje fas
   tillåter (spec 6.1:s tabell), sedan vad konstruktionen **inte** ger.
2. **Livevy av databaserna.** Som i dag, men med `pending_vote`,
   `encrypted_vote`, `partial_decryption`, `ballot_tally`, valets `phase` och
   `envelopeRoot`. **Visas bara i demoläge**, med samma predikat som
   `database-state`-rutten redan använder (`bankIdIsMocked`). Uppgift 17 byter
   predikatet mot lägesväxeln. I skarpt läge får sidan aldrig visa
   röstlängdens innehåll.
3. **Följ en röst.** Före stängningen: väljarens rad i `pending_vote`, där
   kopplingen syns men chiffret inte går att läsa. Efter stängningen: raden är
   borta, och chiffret ligger i `encrypted_vote` utan koppling.
   **Sidan får inte själv återskapa kopplingen.** Ett "följ en röst" som minns
   vilken chifferhash som hörde till vilken väljare, i databasen, i
   webbläsarens lagring eller i en cache, och visar det efter stängningen, vore
   exakt den koppling modellen raderar. Efter stängningen kan en röst bara
   hittas av den som har verifikationskoden, alltså väljaren själv. Det är så
   sidan ska visa det: låt besökaren klistra in sin egen kod.
4. **Risker och begränsningar.** Metadatarisker och *"varför detta inte räcker
   för ett riktigt val"*, uppdaterade. Minst: kopplingen finns under röstningen;
   backuper, läsreplikor och WAL-loggen omfattas inte av raderingen; betrodd
   utdelare av tröskelnyckeln; ingen validering av BankID-certifikatkedjan
   (spec 4.6).

   **Sidan läser begränsningarna, den skriver dem inte.**
   `tests/security/known-limitations.test.ts` kräver att sidan importerar
   `@/lib/known-limitations` och att ingen rubrik står hårdkodad i JSX. Sidans
   riskavsnitt blir alltså aldrig mer rätt än listan. Listan beskriver i dag bara
   den gamla modellen, så **lägg till de tre begränsningar som redan är sanna i
   koden**:

   ```ts
   {
     id: 'link-exists-during-voting',
     title: 'Kopplingen väljare↔röst finns medan röstningen pågår',
     why:
       'Modellen med dubbla kuvert kräver kopplingen — det är den som gör rösten utbytbar, så ' +
       'att en köpt röst kan ersättas ända fram till stängningen. Priset är att "kan inte existera" blivit "raderas enligt ' +
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

   Den tredje skriver du själv, med samma ton: **BankID-certifikatkedjan valideras
   inte.** Signaturen på det yttre kuvertet kontrolleras mot den publika nyckel som
   står i certifikatet, men certifikatet prövas inte mot BankID:s CA. Den som har
   skrivrättighet i databasen kan därför bygga ett eget nyckelpar och en egen
   självkonsekvent rad som valideringen godkänner (spec 4.6, och testet med den
   äkta förfalskningen i `validate-before-close.test.ts`). Välj en `stillTrueIf`-markör
   som finns i koden SÅ LÄNGE kedjan inte valideras, och motivera valet i en
   kommentar på samma sätt som de befintliga posterna gör.

   **Ta inte bort några befintliga poster.** De beskriver det gamla röstflödet,
   som finns kvar tills uppgift 15. Testet tvingar bort var och en i den uppgift
   som löser den, eftersom dess markör då försvinner.

Beskriv bara det som finns. Tröskeldekrypteringen och publiceringen byggs i
uppgift 12 och 13. Sidan får förklara dem som design, men livevyn ska visa vad
databasen faktiskt innehåller och inte påstå att ett steg körts.

- [ ] Skriv om sidan och utöka `database-state`
- [ ] Öppna sidan i en riktig webbläsare via dev-servern, även på mobilbredd.
      Ett blockerat skript syns inte i bygget, och projektet har redan förlorat
      tid på det två gånger.
- [ ] Tester, hela sviten, committa

---

## Task 11f: Arkitektursidan för alla, med en klickbar tidslinje

**Beslut av användaren 2026-09-23:** *"Gör arkitektursidan mindre teknisk men
behåll en förklaring hur dubbla kuvert funkar, fast med språk för otekniska
personer. Behåll Databaserna just nu. Flytta resten till tekniska detaljer och
till utvecklingsstatus, som undersidor. Lägg till en interaktiv sektion där man
kan klicka sig igenom de olika momenten och se en animation som visar hur din röst
förblir hemlig och hur den kan läsas och avkodas. Allt ska visas tydligt med
animation som triggas av klick på en knapp för varje delmoment, i en slags
tidslinje för hela omröstningen."*

Uppgiften körs efter att fixrundorna i 11c är klara, så att innehållet är rätt
innan det flyttas.

**Sidorna**

| Sökväg | Rubrik | Innehåll |
|---|---|---|
| `/architecture` | Arkitektur | Kuvertmodellen på vardagsspråk, den klickbara tidslinjen, *Databaserna just nu* (bara i demoläge, med "Följ en röst") och länkar till undersidorna |
| `/architecture/technical` | Tekniska detaljer | Allt tekniskt som står på sidan i dag: faserna, kryptografin, vad signaturen skyddar mot och inte, databasgränsen och SQL-demonstrationen, vad som publiceras, metadatarisker, begränsningslistan och varför detta inte räcker för ett riktigt val |
| `/architecture/status` | Utvecklingsstatus | Vad som är byggt och inte (code-facts), vad det gamla flödet fortfarande gör och vad som återstår |

**Inget innehåll försvinner, det flyttas.** code-facts-markörerna och deras
tester följer med innehållet. `tests/security/known-limitations.test.ts` läser i
dag `src/app/architecture/page.tsx` och kräver att den importerar listan. Peka om
testet till den sida som visar listan, och kräv att huvudsidan länkar dit, så att
ingen läsare kan missa riskerna.

**Språket på huvudsidan**

Skriv för någon som aldrig har hört ordet kryptering. Använd inga fackord på
huvudsidan, alltså inte kryptering, chiffer, homomorf, tröskel, hash, Merkle eller
signatur i teknisk mening. Säg i stället vad sakerna gör, till exempel *"ett lås
som bara går upp när två av tre förtroendepersoner har lämnat
var sin nyckel"*. Fackorden står på Tekniska detaljer, och huvudsidan länkar dit för
den som vill veta mer. Skriv korta meningar och säg det viktigaste först.

**Liknelsen ska vara rätt, inte bara begriplig.** Varje förenkling måste
fortfarande vara sann. Det här får tidslinjen och texten inte visa fel:

- De inre kuverten **öppnas aldrig ett och ett**, inte i någon animation. Bara
  summan öppnas.
- Summan går bara att öppna med **två av tre** förtroendepersoner. Ingen av dem kan
  öppna den ensam. Skriv inte att den som driver systemet inte kan det. När låset
  tillverkas finns hela nyckeln ett ögonblick på ett ställe (spec 4.5 och 10), och
  svagheten ska nämnas i samma andetag.
- Före stängningen står ditt namn på det yttre kuvertet **med avsikt**, så att du
  kan byta röst.
- Din skärm **visar** din röst men kan **inte bevisa** den för någon (spec 3.1).
- Vid skalningen slängs de yttre kuverten, och de inre **sorteras** så att
  ordningen inte avslöjar vem som röstade när.
- Efter stängningen kan ingen se din röst i urnan, inte heller du. Du ser *att* du
  röstat. Den som kopierade urnan med namnen före stängningen kan fortfarande veta
  vilket kuvert som är ditt. Skriv därför aldrig att *ingen* kan peka ut det, bara
  att det inte går att se i urnan.
- Svagheten ska nämnas på vardagsspråk och länka vidare: den som kopierade urnan
  med namnen före stängningen, till exempel via en säkerhetskopia, har kopplingen.

**Tidslinjen**

Ett moment per steg, i ordning, med en knapp för varje moment. Ett klick spelar
momentets animation och visar en till tre meningar. Momenten nedan ska alla
täckas. Slå ihop eller dela upp dem om det blir tydligare.

1. Valet förbereds: låset delas i tre nycklar till tre förtroendepersoner
2. Du legitimerar dig med BankID
3. Du röstar: ditt val läggs i ett inre kuvert som ingen kan öppna ensam
4. Du skriver under med BankID, och ditt namn hamnar på det yttre kuvertet
5. Kuvertet läggs i urnan
6. Du ändrar dig: det gamla kuvertet byts ut, och din skärm visar din nuvarande röst
7. Röstningen stänger
8. Kontrollen: varje yttre kuvert granskas medan namnet finns kvar
9. Namnen tas bort: de yttre kuverten slängs, och de inre sorteras och flyttas till en urna utan namn
10. Räkningen: kuverten läggs ihop till ett summakuvert, utan att något öppnas
11. Summan öppnas: två av tre förtroendepersoner lämnar var sin del av nyckeln, och bara summan blir läsbar
12. Resultatet publiceras med bevis, så att vem som helst kan kontrollera att summan öppnades rätt
13. Efteråt: du ser att du röstat, inte vad, och ingen kan se din röst

Tidslinjen ska fungera så här:

- **Knapparna:** en knapp per moment. På bred skärm står de i en vågrät
  tidslinje, på mobil lodrätt eller skrollbart. Aktuellt moment är markerat, och
  det finns Föregående och Nästa. Ett nytt klick på samma moment spelar
  animationen igen.
- **`prefers-reduced-motion`:** ingen rörelse. Visa momentets slutläge direkt,
  med texten.
- **Tangentbord:** alla knappar ska gå att nå, och fokus ska synas.
- **Skärmläsare:** momentets text står i en `aria-live`-region. Animationen är
  dekorativ (`aria-hidden`), och texten ensam ska berätta hela historien.
- **Ingen data:** tidslinjen är en simulering. Den hämtar ingenting och fungerar
  därför också utanför demoläge.
- **Ärlighet:** tidslinjen visar hur valet är tänkt att fungera. En kort rad
  säger det och länkar till Utvecklingsstatus för vad som är byggt.

**Kvarvarande från granskningen av 11c, som den här uppgiften äger**, eftersom
den ändå rör filerna:

- `FollowAVote.tsx:150-166`: rutan "Efter stängningen" är alltid grön och säger
  att det inte går att säga ur databasen längre, också när
  `remainingEnvelopes > 0`, alltså just när kopplingen finns kvar. Gör den till en
  varning i det läget.
- `code-facts.ts`, `votedMarkerNotKept`: markören söker bara `voterBallotStatus` och
  `markBallotAsVoted` i tre filer. Uppgift 11d skriver markeringen "har röstat",
  kanske i en ny modell eller via en hjälpfunktion. Då skulle påståendet stå kvar
  grönt fast det är falskt. **Skärp markören innan 11d**, så att varje skrivning av
  en markering i skalningens transaktion fäller påståendet.
- `EnvelopeModel.tsx:31`: etiketten om att väljaren ser om hon redan har röstat
  gäller inte kuvertröster, eftersom `hasVoted` bara läses ur
  `voter_ballot_status`. Beskriv det som design, eller ta bort det.
- `known-limitations.ts`, posten `receipt-proves-choice`: texten säger att
  lösningen inte är att ta bort kvittot och att kontrollen är hela skälet. Det
  motsäger spec 3.1 på samma sida. Posten stämmer fortfarande för det gamla
  flödet, men motiveringen får inte argumentera mot det beslutade.
- Posten `live-results-in-old-flow` och metadataraden "Löpande resultat" nämner
  bara antal per parti. Men `/api/observer/votes` lämnar ut varje röst i det
  gamla flödet med innehåll (`ballotPartyId`, `candidateId`, `optionId`), utan
  inloggning och även under `OPEN`. Säg det. Meningen *"Kuvertmodellen räknar
  ingenting förrän kopplingen raderats"* låter som en spärr som är byggd. Skriv den
  som design.
- Reducern i livevyn: vägra att en fas går baklänges och att `linkClearedAt` blir
  null igen. Det stänger den teoretiska luckan att ordningen avgörs av när frågan
  skickades och inte av när servern läste.
- `known-limitations.test.ts`: kontrollen mot hårdkodade rubriker hittar bara
  formen `<td>Rubrik</td>`. Den ska också hitta listans egen form
  `<td><strong>…</strong></td>` och radbruten text. Kontrollen att listan
  importeras ska gälla filen som faktiskt renderar listan.

**Teknik**

- Inga nya npm-beroenden. Bygg med SVG, CSS-animationer och övergångar, och
  React-tillstånd. Håll det lätt nog för en mobil.
- Kontrollera under CSP:n i en riktig webbläsare. Ta skärmdumpar i 390 och
  1280 px av minst momenten 3, 9, 10 och 11, mitt i animationen och i slutläget,
  och samla konsolfel.

- [ ] **Tester**
  - enhetstest för momentlistan: ordningen, att alla moment finns och att vart och
    ett har en text
  - e2e: ett klick på varje knapp visar momentets text, Föregående och Nästa
    fungerar, emulerad `reduced-motion` visar slutläget, och inga konsolfel
  - de uppdaterade säkerhetstesterna för begränsningslistan och code-facts
- [ ] Hela sviten, och playwright en gång i slutet eftersom den nollställer
      dev-databasen. Committa.

---

## Task 14b: Kryptot blir snabbt nog, och servern står inte still

**Varför:** implementeraren av uppgift 14 mätte cirka 40 ms per modexp med 2048
bitar i ren BigInt, inte de 2 ms som planens globala regler och spec 4.1 bygger på.
En riksdagsvalsedel med personval har 26 alternativ. Den tar 1,2–1,7 s att kryptera
i Chromium, och servern verifierar den på cirka 11 s, **synkront i begäran**. Under
den tiden står Nodes händelseslinga still för alla andra besökare. Valideringen före
stängningen, omverifieringen vid skalningen och slutkontrollen verifierar dessutom
varje röst igen, så stängningen av ett val med tusen röster skulle ta timmar.

Regeln om inga nya npm-beroenden vilade på 2 ms. Den står kvar, eftersom det finns
snabba vägar utan beroenden:

1. **Mät först**, i Node och i Chromium: en modexp med full exponent, alltså mod `q`,
   med `g`, med den publika nyckeln `h` och med godtycklig bas. Granskaren av uppgift 14
   har redan mätt 39,7 ms i Node, 4,4 ms i Chromium och 1,6 ms i OpenSSL, och cirka 236
   respektive 290 modexp för att kryptera och verifiera en valsedel med 26 alternativ.
   Siffrorna står i spec 4.1. Bekräfta dem och mät igen efter varje steg nedan.
2. **Servern räknar nativt.** `node:crypto` har ingen modexp, men
   `createDiffieHellman(p, bas)` med `setPrivateKey(exponent)` räknar `bas^exponent mod
   p` i OpenSSL. Pröva att den ger exakt samma svar som BigInt-implementationen på
   slumpade indata och på gränsfall: bas 0, 1 och p−1, och exponent 0, 1 och q. OpenSSL
   kan vägra vissa värden som publik nyckel. Hantera det, och låt valideringen med
   `isInSubgroup` fortfarande gå först.
3. **Verifieringen får inte låsa händelseslingan.** Antingen i `worker_threads`, med
   ett litet tak på samtidiga arbeten i samma anda som inträdeskön, eller uppdelad och
   asynkron, så att händelseslingan släpps fram mellan alternativen. Med nativ modexp
   tar en riksdagsvalsedel omkring en halv sekund, och uppdelningen kan räcka. Välj det
   som fungerar både i `next dev` och i produktionsbygget, eftersom trådar och Next:s
   buntning inte alltid går ihop, och motivera valet. Ett test ska visa att en annan
   begäran besvaras medan en verifiering pågår.
   **Den nativa vägen får bara finnas på servern.** `tests/security/browser-bundle.test.ts`
   stoppar varje Node-modul i röstsidans importgraf. Klient och server delar
   verifieringskoden, så den snabbare exponentieringen ska kopplas in på serversidan,
   till exempel som en parameter eller en registrerad implementation. Den får inte
   importeras av någon modul i den grafen.
4. **Klienten får fasta baser.** `g` och `h` är desamma för varje röst i ett val, så
   förberäknade fönstertabeller ger en snabbare exponentiering utan beroenden.
   Mät före och efter.
5. **Mål:** en riksdagsvalsedel med 26 alternativ verifieras på under en sekund på
   servern och krypteras på under en sekund i Chromium. Mät också hur lång tid
   valideringen före stängningen tar för 100 röster, och skriv in siffran. I dag är det
   cirka 39 s per väljare med tre valsedlar, alltså ungefär en timme för 100 väljare.

Den oberoende verifieraren i uppgift 13 får inte importera `src`. Den kör i Node och
kan använda samma knep på egen hand.

- [ ] Mätningar först, sedan tester, implementation, hela sviten, committa.

---

## Task 14f: Certifikatkedjan valideras, så att underskriften binder på riktigt

**Beslut av användaren 2026-09-24:** *"Fixa sårbarhet: underskriften skyddar i dag inte
mot den som driver systemet. BankID-certifikatkedjan valideras inte."* Körs direkt
efter uppgift 14b, som rör samma verifieringsställen.

**Vad luckan är, i koden.** Attrappen (`MockBankIdService.ts`) skapar inga riktiga
certifikat. Den gör ett nytt RSA-nyckelpar per underskrift och ett eget format
(`formatMockCertificate`). `PendingVote` lagrar bara den publika nyckeln
(`bankIdPublicKey`), och `validateBeforeClose` prövar signaturen mot den nyckel raden
själv bär: `verifySignedPayload(vote.bankIdSignature, vote.bankIdPublicKey`. Den som kan
skriva i databasen bygger alltså ett eget nyckelpar och en egen rad som godkänns.
Testet med den äkta förfalskningen i `validate-before-close.test.ts` visar det.
`certificateBelongsTo` finns men används inte i produktionskoden.

**Vad som ska byggas**

1. **Attrappen blir en certifikatutfärdare.** Skapa en rot och en utfärdande
   mellannivå en gång, med `openssl`, som finns på utvecklingsdatorn. Rotens privata
   nyckel kastas efter genereringen, så att ingen kan skapa en ny mellannivå.
   Rotcertifikatet, mellannivåns certifikat och mellannivåns privata nyckel
   checkas in som tydligt märkta testfixturer. Attrappen utfärdar vid varje
   underskrift ett X.509-certifikat för väljaren, med personnumret som
   `serialNumber` i subject, med `keyUsage` digitalSignature och utan CA-rätt.
   `node:crypto` kan läsa och verifiera X.509 men inte skapa certifikat, så
   utfärdandet kräver en liten DER-kodare för `TBSCertificate`. Den hör bara till
   attrappen.
2. **Kedjan valideras mot ett fast rotcertifikat,** när rösten läggs
   (`/api/vote/encrypted`) och i valideringen före stängningen, och därmed även vid
   omverifieringen i skalningen. Använd `X509Certificate` i `node:crypto`: löv mot
   mellannivå mot rot, `ca` på mellannivån, giltighetstid vid underskriften, och
   `keyUsage` på lövet. Rotcertifikaten konfigureras, till exempel med en sökväg i
   miljön. I demoläget används attrappens rot. Uppgift 17 ska se till att skarpt läge
   vägrar starta med attrappens rot.
3. **Certifikatet knyts till väljaren.** Personnumret i lövets `serialNumber` hashas
   med samma peppar som `voter_status.identityHash`, och hashen ska vara väljarens.
   Använd den befintliga `certificateBelongsTo`, eller ersätt den. En giltig kedja för
   en annan väljare ska underkännas.
4. **Certifikatet lagras krypterat.** Det innehåller personnummer och namn i klartext.
   Lagrat som det är bryter det projektets princip att en databasdump utan pepparn inte
   avslöjar vem som röstat. `PendingVote` får därför kedjan krypterad med AES-256-GCM
   och en nyckel som härleds ur `IDENTITY_PEPPER`, med egen domänseparation. Den raderas
   med raden vid skalningen. `bankIdPublicKey` tas bort, eftersom nyckeln nu kommer ur
   lövet.
5. **Testet med den äkta förfalskningen vänds.** En rad med eget nyckelpar och
   självsignerat certifikat ska nu underkännas. Lägg till tester för:
   - en kedja till en annan rot
   - ett giltigt certifikat för en annan väljare
   - ett utgånget certifikat
   - en mellannivå utan CA-rätt
   - ett löv med CA-rätt
   Varje test ska underkännas av just sin kontroll.

**Vad fixen inte ger, och som ska stå som begränsningar i
`src/lib/known-limitations.ts` och på arkitektursidan**

Posten om certifikatkedjan försvinner när dess markör försvinner. Ersätt den med de
begränsningar som återstår. Säg dem lika rakt som den gamla:

- **Den som driver systemet kan ta bort ett kuvert eller återställa en väljares
  tidigare äkta röst.** Kedjan hindrar att nya underskrifter förfalskas, men inte
  att äkta tas bort eller spelas upp igen, eftersom räknaren för den senaste
  underskriften lagras i samma databas. Väljaren kan upptäcka båda på sin enhet före
  stängningen, där jämförelsen svarar "ändrad" eller "ingen röst", och efter
  stängningen genom markeringen "har röstat" (uppgift 11d).
- **Ingen spärrkontroll (OCSP).** Ett spärrat BankID-certifikat godkänns.
- **I demoläget utfärdar attrappen certifikaten själv.** Den som driver en demo kan
  därför fortfarande förfalska. Skyddet gäller med riktig BankID, där nyckeln finns
  hos BankID. Testerna visar egenskapen mot den inbyggda roten.
- **Riktig BankID kräver en adapter för XML-signaturen.** BankID v6 returnerar en
  XMLDSig med kedjan inbäddad. Kedjevalideringen ovan är oberoende av formatet, men
  att läsa ut kedjan och den signerade texten ur XML-signaturen är inte byggt, och
  kan inte testas utan BankID:s testmiljö.

Uppdatera också spec 4.6 och 10. Och uppdatera arkitektursidans svaghet *"Underskriften
skyddar i dag inte mot den som driver systemet"* till det som gäller efter fixen: den
som bara kan skriva i databasen kan inte längre lägga in röster för någon som inte
skrivit under, och en granskare med åtkomst under valideringen kan kontrollera varje
underskrift mot BankID:s rot.

**Schemaändringen** kräver en migrering och `npm run generate`, och den körande
dev-servern låser Prismas DLL. Implementeraren skriver all kod och migreringen först
och rapporterar sedan att generate behövs. Controllern stoppar servern, låter
implementeraren generera, testa och migrera dev-databasen, och startar sedan servern
igen.

- [ ] Tester först, implementation, hela sviten, committa.

---

## Task 11g: Arkitektursidan visar hur Key Vault används i hela flödet

**Beslut av användaren 2026-09-24:** *"Uppdatera arkitektur att visa hur key vault
används i hela flödet och ta med det i animationsstegen."* Körs direkt efter att
uppgift 14f är godkänd, eftersom båda ändrar arkitektursidan.

**Underlaget är Azure-infrastrukturen i `infra/azure/`**, som en annan session byggt och
committat (6ba50ec). Den här uppgiften **läser** de filerna men ändrar dem inte. Varje
påstående om Key Vault ska vara sant mot Bicep-filerna och mot koden, och bära en
markör i `code-facts.ts`. Ändrar den andra sessionen infrastrukturen blir testet rött,
och det är meningen.

**Vad Key Vault gör i Azure, enligt filerna**

| Hemlighet | Används till | Var |
|---|---|---|
| `identity-pepper` | Fingeravtrycket av personnumret (`hashPersonalNumber`, scrypt med pepparn som salt), och sedan 14f nyckeln som förseglar certifikatkedjan i kuvertet (HKDF i `sealed-chain.ts`) | `app.bicep`, `secretRef` |
| `voters-database-url`, `votes-database-url` | Anslutningarna. **Varje databas har en egen roll som bara kan ansluta till sin egen databas** (`db-init.sql`: `REVOKE CONNECT … FROM PUBLIC`, `voters_app` och `votes_app`). Lokalt är det samma användare | `app.bicep`, `db-init.sql` |
| `vapid-public-key`, `vapid-private-key` | Pushnotiser | `app.bicep` |
| `pg-admin-password` | Läses av distributionen, inte av appen | `infra.bicep`, `getSecret` |

Appens identitet har rollen Key Vault Secrets User på just det valvet och ingenting
annat (`infra.bicep`). Valvet har RBAC och mjuk radering i 90 dagar
(`keyvault.bicep`). `deploy.sh` skriver aldrig över en befintlig peppar, eftersom
ingen hash i röstlängden stämmer om den byts. Hemligheterna sätts som miljövariabler
när containern startar.

**Vad valvet INTE innehåller, och det ska sägas lika tydligt:**
- **förtroendepersonernas nycklar till summan.** Deras andelar ligger krypterade med
  var sin lösenfras i röstdatabasen, med avsikt. Tre nycklar i samma valv är inte tre
  innehavare (spec 4.5).
- valets privata nyckel, som raderas när den delats
- attrappens certifikatutfärdare, som ligger i repot som testnyckel

**Huvudsidan, på vardagsspråk**

Visa valvet i tidslinjen, i de moment där det används:

- **1, valet förbereds:** valvet håller systemets hemligheter. Låsets tre nycklar finns
  inte där.
- **2, du legitimerar dig:** personnumret blir ett fingeravtryck med hjälp av en
  hemlighet ur valvet, och databasen sparar bara fingeravtrycket.
- **4, du skriver under:** ditt BankID-certifikat, med namn och personnummer, låses in i
  det yttre kuvertet med en nyckel som görs av samma hemlighet.
- **8, kontrollen:** hemligheten öppnar certifikaten så att underskrifterna kan prövas
  medan namnen finns kvar.
- **9, namnen tas bort:** de inlåsta certifikaten slängs med de yttre kuverten.
  Efteråt kan hemligheten bara säga *att* någon röstat, inte vad.
- **11, summan öppnas:** valvet används inte alls. Nyckeln till summan finns bara hos
  förtroendepersonerna, och det ska synas i animationen.

Visa också att de två databaserna har var sin nyckel i Azure, så att den som har
röstlängdens nyckel inte ens kan öppna urnan.

**De åtta liknelsekraven från 11f gäller fortfarande.** Valvet får inte se ut att hålla
förtroendepersonernas nycklar, och ingenting får antyda att valvet gör kopplingen
omöjlig. Det gör raderingen vid stängningen.

**Svagheter, på huvudsidan och på Tekniska detaljer**

- Den som får läsa valvet får pepparn. Med den kan hen göra fingeravtryck av
  personnummer och, under röstningen, öppna certifikaten i kuverten, alltså namnen.
  Det är samma sak som posten `pepper-holder-reads-voter-names` säger, och den ska
  nämna valvet.
- Appen har hemligheterna i minnet medan den kör. Valvet skyddar dem i vila och loggar
  vem som läser, men en komprometterad app har dem.
- Båda databasernas nycklar finns i samma app. Rollerna skyddar mot en läckt enskild
  nyckel, inte mot appen. Avgör mot spec 2 om det ska bli en egen post i
  `known-limitations.ts`.
- Valvet är av typen Standard, alltså mjukvaruskyddat. Starkare vore att pepparn aldrig
  lämnade en HSM och att fingeravtrycken räknades där. Det är inte byggt.
- I demoläget och lokalt ligger hemligheterna i `.env`, inte i ett valv.

**Texter från omgranskningen av 14f som den här uppgiften äger**, eftersom den ändå rör
filerna:
- `Weaknesses.tsx:64–65` säger att "bara de röster som prövats räknas". Det stämmer för
  vad stängningen flyttar, men inte för vad som räknas: ingen räkning finns än, och
  ingenting kontrollerar urnan efter stängningen. "Databasen" där och i
  `WhatItDoesNotGive.tsx:33` ska vara röstlängden, eftersom den som skriver i röstdatabasen
  kan byta ut ett chiffer (spec 4.6, förbehåll 4).
- `validate-before-close.usecase.ts:35–36` säger "Ingen med databasåtkomst kan förfalska
  dem" utan avgränsning. Det är falskt i demon, och bevisen kan vem som helst ta fram.
- `known-limitations.ts:216` och `sealed-chain.ts:20` säger att förseglingen "avslöjar
  ingenting nytt". Det gäller kedjan, men inte signaturkolumnen med riktig BankID, vars
  längd följer lövets nyckeltyp och kan peka ut utfärdaren.
- Posten `bankid-xmldsig-adapter-missing` ska säga att BankID:s `signature` är en XMLDSig
  med kedjan inbäddad. En adapter som lagrar den som den är lägger namn och personnummer i
  klartext bredvid kuvertet. Den ska förseglas som kedjan.
- `close/route.ts:98` säger "INGENTING ÄR RADERAT", vilket är falskt när en andra
  stängning redan hunnit radera. Avgränsa till det som är känt.
- Ental "mellannivå" i `pending-vote.service.ts:210` och `prisma/voters/schema.prisma:376`
  ska vara "mellannivåer", eftersom kedjan nu har en till tre.

**Tekniska detaljer** får ett avsnitt om hemligheterna, med tabellen ovan, rollerna och
det valvet inte ger. **Utvecklingsstatus** säger att Azure-uppsättningen finns som Bicep
och vad som är byggt.

- [ ] Tester först: markörer mot `infra/azure/*.bicep`, `db-init.sql` och koden;
      tidslinjens moment; att valvet aldrig visas med förtroendepersonernas nycklar.
- [ ] Webbläsarkontroll i 390 och 1280 px med skärmdumpar av momenten 1, 2, 4, 8, 9
      och 11, sparade i `screenshots/11g-*.png`.
- [ ] Hela sviten, playwright en gång sist, committa. Rör inte `infra/`.

---

## Task 11h: Utvecklingsstatus säger direkt vad som är klart, vad som kommer och vad som inte ingår

**Varför:** användaren bad om det 2026-09-24. Azure-sessionen skickade vidare begäran för
användarens räkning. Sidan Utvecklingsstatus går i dag igenom delarna en i taget, så den
som vill veta vad som fungerar måste läsa hela sidan. Önskemålen:

- Överst tre grupper:
  - **Klart**
  - **Kommer att implementeras**, med uppgiftens nummer och i den ordning uppgifterna körs
  - **Saknas och ingår inte i demon**
- Samma status på varje punkt längre ned.
- Kort text.
- Markörerna finns kvar.

**Files:**
- Modify: `src/app/architecture/status/page.tsx`, `src/app/architecture/code-facts.ts` och
  de avsnitt under `src/app/architecture/sections/` som sidan använder: `StatusOverview`,
  `ReviewToday`, `PhasesToday`, `OldFlow`, `Remaining` och `AzureStatus`
- Test: `tests/security/architecture-page.test.ts` och Playwright-testerna för
  arkitektursidorna

**Krav**

1. **En enda källa för status.** Varje punkt får ett statusfält i `code-facts.ts`, med
   värdet `done`, `planned` med uppgiftens nummer eller `out_of_scope`. Både
   sammanfattningen överst och märkningen längre ned läser fältet, så att de inte kan
   säga olika saker.
2. **Klart** listar det som finns i koden i dag. Varje punkt bär en markör som visar att
   det finns.
3. **Kommer att implementeras** listar det som återstår, med uppgiftens nummer.
   - Varje punkt bär en markör som visar att det INTE finns än, som `REMAINING` gör i dag.
     En punkt kan då inte stå kvar här när den har byggts.
   - Ett test kräver att varje nummer finns som rubriken `## Task <nummer>:` i planen.
   - Ett test kräver att punkterna står i samma ordning som i planens rad
     **Exekveringsordning efter uppgift 11**.
   - Numren är planens, och sidan anger inga datum.
4. **Saknas och ingår inte i demon** listar vad ett riktigt val kräver som det här
   bevisprojektet inte bygger. Punkterna tas ur spec 10 och ur `known-limitations.ts`,
   och inga hittas på. En punkt om koden bär en markör. En punkt om något utanför koden,
   som ett avtal med BankID eller en säkerhetsgranskning, formuleras så snävt att den
   stämmer utan markör.
5. **Märkningen längre ned.** Varje punkt på resten av sidan får en liten etikett: Klart,
   Kommer (uppgift N) eller Ingår inte. Etiketten har text och inte bara färg.
6. **Kort text.** En till två meningar per punkt. De långa förklaringarna finns kvar på
   Tekniska detaljer, och sidan länkar dit.
7. **Markörerna finns kvar.** Varje påstående om koden läses fortfarande ur
   `code-facts.ts`. `tests/security/architecture-page.test.ts` går rött när koden ändras
   så att ett påstående inte längre stämmer.
8. **Formuleringar.** Varje "ingen", "aldrig", "bara" och "inte" avgränsas och prövas mot
   spec 10 och hela flödet. Det gäller även den som driver systemet, den som läser valvet
   och den som kan skriva i en av databaserna. En kortare text får inte lova mer än den
   långa.
9. **Layout.** Sidan fungerar vid 390 px utan sidledsskroll. Ta skärmdumpar vid 1280 och
   390 px, i ljust och i mörkt läge.

- [ ] Tester först, implementation, hela sviten, skärmdumpar, committa med uttryckliga
      sökvägar.

---

## Task 14e: Pollningen bär bara orderRef, och bevakningen läser den offentliga listan

**Varför:** två belastningsfel som granskningen av uppgift 14 hittade. De lyftes ur 14b,
som handlar om kryptots hastighet och ska granskas för kryptokorrekthet.

1. **Valsedeln skickas en gång, inte vid varje pollning.** Röstsidan skickar i dag hela
   valsedeln, cirka 160 kB, med varje pollning av signeringen
   (`BankIdSigning.tsx:43` och `:163`). Hastighetsgränsen 30 per minut ligger exakt på
   pollningstakten, så två väljare bakom samma NAT stryps. Låt servern hålla valsedeln
   med ordern från `sign-start`, och låt pollningen bara bära `orderRef`.
2. **Bevakningen av fasen läser den offentliga listan.** Röstsidan kontrollerar sedan
   uppgift 14 fasen när fliken blir synlig och med jämna mellanrum, så att enheten
   raderar sina uppgifter vid stängningen (spec 3.1 punkt 4). Bevakningen delar dock
   sessionsruttens gräns på 60 per minut och IP-adress, så ungefär 30 synliga flikar
   bakom samma adress fyller den, och då får en annan väljare där 429. Fasen är inte
   hemlig. Lägg den i den offentliga listan över omröstningar och låt bevakningen läsa
   den där i stället för i väljarens session. Listan väljer i dag omröstningar på tid
   och inte på fas. Se till att bevakningen ändå ser en omröstning som stängts före
   sin tid.
3. **Kön reserverar sin plats vid förkontrollen.** Omgranskningen av fixrundan i 14b
   visade att förkontrollen i `src/lib/crypto/server.ts:174–185` och
   `src/app/api/vote/encrypted/route.ts:114` inte reserverar någon plats. När en plats
   var kvar klarade fem samtidiga röster förkontrollen, men fyra av dem fick
   `VerificationQueueFull` först sedan deras BankID-order förbrukats, och väljarna fick
   skriva under igen. Reservera platsen vid förkontrollen och släpp den i `finally`.
   Rätta också kommentaren om att fönstret bara är några millisekunder.
4. **Kroppens gräns gäller hela vägen.** Next klonar varje POST-kropp upp till 10 MB i
   middleware (`middlewareClientMaxBodySize`) innan rutten körs, så minnet per begäran
   begränsas till 10 MB och inte till appens 2 MiB. Sätt
   `experimental.middlewareClientMaxBodySize` till samma gräns, eller rätta kommentaren
   i `validation.ts:374`. Gränsen på 2 MiB gäller dessutom varje rutt, fast
   `createElectionSchema` i teorin tillåter omkring 70 MB. Ge administratörens rutt en
   egen, högre gräns, eller sänk schemats tak, och lägg ett test som håller dem i
   samklang.

**Ett lager per order på servern.** Punkt 1 kräver att servern håller valsedeln
mellan `sign-start` och att signeringen är klar. Uppgift 11e kräver samma sak för
saltet: *"skapas i sign-start, hålls på serversidan med ordern"*. Bygg ett lager för
orderns tillstånd en gång, så att 11e kan lägga saltet där. Minnet per process räcker
för ett proof of concept, på samma villkor som inträdeskön
(`admission-queue-per-process` i begränsningslistan). Lägg det på `globalThis`, som
attrappens ordrar sedan uppgift 14, eftersom Next bygger om en rutt efter en stunds
inaktivitet. En order som aldrig blir klar ska förfalla efter orderns livslängd.

- [ ] Tester först, implementation, hela sviten, committa.

---

## Task 14d: Fiat–Shamir binder hela valsedeln

**Varför:** spec 4.4 säger att bevisens utmaning binder hela chifferlistan. Koden
binder varje alternativs OR-bevis bara till sitt eget chiffer (`proofs.ts:43-49`).
Granskaren av uppgift 14 hittade det och hittade ingen praktisk attack, men ett bevis
som inte binder sitt sammanhang kan i princip klippas ut ur en valsedel och sättas in
i en annan. Specen och koden ska säga samma sak, och den starkare egenskapen är den
specen lovar.

Låt utmaningen för varje OR-bevis och för summabeviset binda valets och valsedelns id,
alternativets index och hela listan av chiffer, med den domänseparation som redan
finns. Ändringen ändrar bevisens format. Den ska därför göras **före uppgift 13**, som
skriver den oberoende verifieraren mot formatet. Klienten och servern ska ändras i
samma commit, och e2e-sviten ska visa att en valsedel krypterad i Chromium fortfarande
godkänns på servern.

Lägg ett test som klipper ut ett giltigt OR-bevis ur en valsedel och sätter in det i en
annan, och som ska underkännas. Före ändringen ska testet bli rött eller visa att
attacken inte fungerar av annat skäl. Skriv i så fall ut skälet.

**Kuvert i det gamla formatet.** Efter ändringen godkänns inte längre kuvert vars bevis har
det gamla formatet, och då stoppar valideringen stängningen. Skriv i rapporten vad det
betyder för kuvert som redan ligger i demons databaser, lokalt och i Azure. Controllern
meddelar Azure-sessionen.

- [ ] Tester först, implementation i klient och server, hela sviten, committa.

---

## Task 11d: Faserna blir verkliga tillstånd

**Varför:** spec 6.1 säger att fasen går enkelriktat `OPEN → CLOSED → VALIDATED →
STRIPPED → TALLIED → CERTIFIED`, och användaren beskrev samma ordning: *"röstning
stängs först, sen validering, sen bort koppling, sen avkoda och räkna"*. Koden
skriver i dag bara `STRIPPED`. Det upptäcktes av implementeraren av
arkitektursidan, vars fastabell därför säger "skrivs aldrig" om de övriga.

**Files:** `src/orchestration/close-election.usecase.ts`,
`src/modules/eligibility/pending-vote.service.ts` om det behövs, tester.

1. **`CLOSED` skrivs först i stängningen**, före valideringen, i en egen skrivning.
   Från det ögonblicket öppnas röstningen aldrig igen, inte heller om valideringen
   hittar en avvikelse. I dag står fasen kvar i `OPEN` efter en misslyckad
   validering, och röster avvisas bara av klockan, alltså precis det spec 6.1
   varnar för.
2. **`VALIDATED` skrivs när valideringen passerat.**
3. **`STRIPPED` skrivs som i dag, inuti den atomära transaktionen.** Ändra inte
   det.
4. **Övergångarna är jämför-och-sätt:** en uppdatering med villkor på nuvarande
   fas, så att två samtidiga stängningar inte kan gå om varandra och ingen fas går
   baklänges. Pröva det med ett test som kör två stängningar samtidigt.
5. **`already_closed` betyder fas `STRIPPED` eller senare.** Från `CLOSED` eller
   `VALIDATED` fortsätter en omkörning, eftersom administratören utreder en
   avvikelse och kör om.
5b. **En röst i sista stund får inte gå förlorad.** Implementeraren av uppgift 14b
   hittade en kapplöpning som fanns redan före den uppgiften. En röst vars fas prövas
   före stängningen men som skrivs efter att `closeElection` läst kuverten raderas av
   `clearPendingVotes` utan att flyttas, och väljaren har fått beskedet att rösten är
   lagd. Verifieringskön från 14b kan göra fönstret längre. Stäng det på tre sätt:
   - `castEncryptedBallot` prövar att fasen är `OPEN` **i samma transaktion som
     skrivningen**, med ett villkor som databasen håller, inte med en läsning före
   - stängningen skriver `CLOSED` med jämför-och-sätt innan kuverten läses, så att
     ingen ny skrivning kan lyckas efteråt
   - **Radering efter id och jämförelsen mellan raderade och flyttade gjordes i 14f:s
     fixrunda**, tillsammans med att stängningen validerar exakt de rader den flyttar.
     Granskaren av 14f visade att punkten, som den först var skriven, inte stängde
     felet: en radering efter id märker inte en rad som försvunnit mellan läsningarna.
     Kvar här är att en röst som skrivs efter läsningen varken försvinner eller räknas
     tyst: den ska ligga kvar, och skalningen ska avbrytas innan något raderas.
   - **Omkörningen får inte låsas av rester i röstdatabasen.** Sedan 14f:s fixrunda
     lämnar ett kuvert som tagits bort eller bytts ut efter läsningen ett chiffer kvar i
     votes_db, eftersom infogningen sker före transaktionen i voters_db. Då stoppar
     antalskontrollen varje omkörning tills någon städar för hand. Den som kan skriva i
     databasen kan alltså låsa ett val. Städa automatiskt: ett chiffer i votes_db vars
     hash inte finns i den nya, validerade läsningen kommer från en avbruten körning och
     tas bort före infogningen. Det ska loggas och synas i rapporten.
   - **En andra stängning ger i dag ett falskt `untouched`** om den läser fasen före den
     förstas COMMIT men kuverten efter (`close-election.usecase.ts:614–627`). Svaret
     säger då att 0 kuvert skulle flyttas men 2 finns och att kopplingen är orörd, fast
     fasen är STRIPPED. Jämför-och-sätt på fasen, punkt 4 ovan, stänger det. Läs också
     fasen innan steget påstår `untouched`, som `settleChangedEnvelopes` redan gör.
   - **Städningen av rester kräver att bara en stängning kör åt gången.** Omgranskningen
     av 14f visade att en automatisk städning utan lås är farlig: i fel ordning ser den
     en tom läsning och raderar det en annan stängning just flyttat, när kopplingen
     redan är borta. Villkor för städningen: jämför-och-sätt, eller ett advisory lock,
     fasen skild från STRIPPED och roten null. Radera då exakt de rader i
     `encrypted_vote` på omröstningens valsedlar vars hash inte finns i den nyss
     validerade läsningen, logga antalet och peka ut dem i beskedet.
   - **Läs tillbaka varje flyttat chiffer.** Den som kan skriva i votes_db kan före
     infogningen lägga en rad med ett äkta kuverts hash men ett annat chiffer, och
     `skipDuplicates` behåller den. Steg 5 räknar bara rader, så stängningen svarar
     `closed` fast urnans chiffer inte ger sin egen hash (`:600–614`). Efter infogningen
     ska varje flyttat kuvert läsas tillbaka och vara byte för byte det validerade,
     chiffer och bevis.
   - **Läs kuverten i omgångar.** `readEnvelopes` (`validate-before-close.usecase.ts:426`)
     läser allt i en fråga, och Prisma kastar för svar över 536 870 888 tecken. Med
     14f:s utfyllnad på 32 KiB per kuvert blir taket cirka 9 850 kuvert per stängning
     vid 3 alternativ, och cirka 3 000 vid 26. Stängningen faller säkert till
     `untouched`, men ett större val går inte att stänga. Läs i omgångar och validera
     läsningen som helhet.
   - **Dubbel stängning med noll kuvert** ger i dag två `closed` och två LINK_CLEARED.
     Jämför-och-sätt stänger det.
   - **Fönstret W6:** en rad som committas mellan `left`-räkningen och COMMIT blir kvar,
     och då svarar stängningen `closed` och sedan `already_closed` med ett liggande
     kuvert. Det är punkt 5b:s fönster, som nu är smalare. CLOSED före läsningen och
     fasen i läggningens transaktion stänger det.
   Skriv ett test som låter en röst skrivas mellan läsningen och raderingen, och som
   kräver att den antingen flyttas eller att väljaren får ett fel, aldrig "lagd".
6. **Markeringen "har röstat", utan tidsstämpel.** Spec 3.1 punkt 6 säger att
   väljaren efter stängningen ser att den röstat, men i kuvertmodellen skriver
   ingenting en sådan markering. `castEncryptedBallot` skriver bara `pending_vote`,
   stängningen raderar raden, och `voter_ballot_status` skrivs bara av det gamla
   flödet. Upptäckt av implementeraren av 11c.
   Skriv markeringen per väljare och valsedel **inuti skalningens transaktion**,
   ur de rader som raderas och före raderingen. Den ska inte ha någon tidsstämpel,
   så att den säger att väljaren röstade men inte när. Den kan då aldrig säga
   något annat än att väljarens kuvert räknades. Antalet markeringar per valsedel
   ska vara lika med antalet kuvert som flyttades; kontrollera det i transaktionen.
   Återanvänd `VoterBallotStatus` om dess betydelse passar, annars en ny modell. Är
   det en schemaändring, kräver `prisma generate` att dev-servern först stoppas, eftersom
   den håller Prismas DLL. Sedan körordningen ändrades 2026-09-24 kommer 11e långt senare,
   så ändringarna samlas inte längre. Rätta samtidigt schemakommentaren i
   `prisma/voters/schema.prisma` som fortfarande kallar identitetshashen en HMAC.
   Uppgift 12b:s kontroll att antalet stämmer ska jämföra mot markeringarna.
   **Obs:** sedan uppgift 14 tolkar röstsidan en markering i `voter_ballot_status` som
   att väljaren röstat i det gamla flödet. Återanvänds modellen för den nya
   markeringen måste tolkningen hållas isär. Före stängningen finns den nya
   markeringen aldrig, och efter stängningen är röstsidan stängd, men säkerställ det
   med ett test.

**De invarianter som uppgift 11:s fem granskningsrundor slog fast ska hålla
efteråt, och granskaren ska pröva dem med prober mot testdatabasen:**
`STRIPPED` skrivs bara inuti transaktionen; allt som kastar i `prepareClose` är
`untouched`; beskedet `already_closed` betyder att kopplingen bevisligen är raderad.

`TALLIED` sätts i uppgift 12 och `CERTIFIED` i uppgift 12b. Arkitektursidans
fastabell styrs av markörer i `src/app/architecture/code-facts.ts`, och testet
tvingar fram en uppdatering när faserna blir verkliga. Gör uppdateringen.

- [ ] Tester först, sedan implementation, hela sviten, committa.

---

## Task 11e: BankID-ordern bär inte kopplingen ut ur systemet

**Varför (spec 10):** `sign-start` lägger chifferhashen i BankID-orderns
`userNonVisibleData`, i samma order som bär väljarens identitet. BankID sparar
signaturer, bland annat för tvister, så med skarp BankID skulle kopplingen mellan
väljaren och rösten finnas kvar hos BankID efter att den raderats här. Hittat av
granskningen av uppgift 11c.

1. **Det signerade bär `SHA-256(chifferhash ‖ salt)` i stället för chifferhashen.**
   Saltet är 32 slumpbyte som skapas i `sign-start`, hålls på serversidan med
   ordern, aldrig skickas till klienten, sparas i `PendingVote` när rösten läggs och
   raderas med raden vid skalningen. Efter stängningen går BankID:s kopia inte att
   matcha mot någonting.
2. **Kontrollera att `userVisibleData` inte heller bär hashen.**
3. **Verifieringen** i `/api/vote/encrypted` och i `validateBeforeClose` räknar
   fram åtagandet ur den lagrade chifferhashen och saltet och jämför. Använd en
   längdprefixad eller annars entydig kodning av `chifferhash ‖ salt`, som resten
   av nyttolasten.
4. **Attrappens `orders`** behåller i dag övergivna signeringsordrar med
   personnummer och `userNonVisibleData` tills processen startas om, eftersom de
   bara rensas när de hämtas med collect. Låt dem förfalla efter orderns
   livslängd.
5. **Specen:** uppdatera 4.6 med vad som signeras, och stryk BankID-posten i
   spec 10 när den är åtgärdad. Posten i `known-limitations.ts`, som lades till i
   uppgift 11c, försvinner när dess markör försvinner.

**Schemaändring:** `PendingVote` får en kolumn för saltet. Det kräver en migrering
och `npm run generate`, och den körande dev-servern låser Prismas DLL på Windows.
Implementeraren stoppar inte servern själv, utan rapporterar när generate behövs,
och controllern stoppar och startar om den.

- [ ] Tester först: det signerade innehåller inte chifferhashen; efter
      skalningen finns inget i `voters_db` eller i attrappens tillstånd som gör
      BankID:s kopia matchbar; den äkta förfalskningen från uppgift 10 beter sig
      fortfarande som dokumenterat.
- [ ] Implementation, hela sviten, committa.

---

**Exekveringsordning efter uppgift 11:** 11a (testdatabaser) → 11b → 11c → **11f** →
**14** → **14b** → **14f** → **11g** → **11h** → 11d → **14d** → 12 → 12b → **12c** → 13 → 17 →
**14e** → 11e → **17b** → **17c** → **14c** → 15 → 16 → 18.
Ordningen ändrades 2026-09-24 på användarens begäran: *"Gör klart ... allt som behövs för
att slutföra hela processen så röster kan valideras och räknas"*. Det som behövs för att
stänga, räkna och fastställa ett val går därför först, till och med adminsidan (12c) och
publiceringen (13). Sedan kommer läget (17), och därefter det som en riktig BankID-klient
kräver. 14e går före 11e, som återanvänder dess lager för orderns tillstånd, och båda går
före 17b och 17c, eftersom en riktig BankID-order annars bär kopplingen ut ur systemet.
14d ligger före 12, eftersom den ändrar bevisens format och slutkontrollen ska pröva det
slutliga formatet. Uppgift 11h, 12c, 17b och 17c lades in samma dag.
Uppgift 11g lades in 2026-09-24 på användarens begäran, direkt efter 14f.
Uppgift 14f lades in 2026-09-24 på användarens begäran och körs direkt efter 14b.
Uppgift 14b, 14c och 14d kom till efter uppgift 14 och ligger där de gör mest nytta:
14b innan något mer verifieras i stor skala, 14e före 11e, som återanvänder dess lager
för orderns tillstånd, 14d före den oberoende verifieraren i
uppgift 13, eftersom den ändrar bevisens format, och 14c före uppgift 15, som annars
hade gjort folkomröstningar omöjliga. Uppgift 11f ligger först
eftersom användaren prioriterade arkitektursidan. Uppgift 14 flyttades fram
2026-09-23 på användarens begäran, så att det gamla tokenflödet försvinner ur det
man klickar sig igenom. Beroendet är kontrollerat: uppgift 14 använder bara
rutterna från uppgift 7–9. Ändringen av det signerade i 11e sker på serversidan,
och sidan bygger aldrig något som signeras. Uppgift 14 flyttades upp eftersom "Följ en
röst" inte kan visas live förrän röstsidan lägger kuvert. Beroendet är
kontrollerat: uppgift 14 använder bara rutterna från uppgift 7–9, som är klara.

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

**Varje tal ur databasen tolkas strikt.** Sedan fixrundan i 14b går valsedlarna genom
`parseScalar` och `parseElement` i `group.ts`. Den här uppgiften läser nya tal ur
databasen: partiella värden, DLEQ-bevis och `publicShare`. De ska gå genom samma
funktioner, med undergruppskontroll för gruppelementen, innan något räknas med dem.
Granskningen av 14b fann att en negativ exponent tidigare räknades som 1, och att en
förfalskad valsedel därför godkändes förbi schemat.

**Spärr mellan det gamla flödets bok och kuverten.** Granskaren av uppgift 14 fann att
en väljare med direkta anrop kan ha både en röst i det gamla flödet (`vote`, med
markering i `voter_ballot_status`) och ett kuvert på samma valsedel. Röstsidan spärrar
det, men inte servern. Ingen räkning dubblerar i dag, eftersom de två böckerna aldrig
räknas ihop. Men den här uppgiften bygger kuvertens räkning, och spärren ska finnas på
servern innan dess: `castEncryptedBallot` ska vägra om väljaren har en markering från
det gamla flödet på valsedeln, och det gamla flödets utfärdande ska vägra om väljaren
har ett liggande kuvert. Spärren tas bort med det gamla flödet i uppgift 15.

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

1b. **Urnan kan ha flera rader med samma chifferhash** sedan ruling 130 i 11d. En kopia av
   någon annans valsedel räknas som en egen röst. Aggregeringen tar varje rad, och ingenting
   i räkningen får slå ihop rader per hash.

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

## Task 12b: Slutkontrollen byggs om mot kuvertmodellen

**Files:**
- Modify: `src/orchestration/final-check.usecase.ts`
- Test: `tests/integration/final-check.test.ts` (utöka eller skriv om; följ det som finns)

**Varför uppgiften finns**

Slutkontrollen är spärren före fastställandet. Åtta av dess elva kontroller läser den
gamla röstmodellen: `votesDb.vote` med `tokenHash`, `credentialId`,
`credentialSignature`, och valsedelns `signingPublicKeyPem`. För ett val i
kuvertmodellen är de tabellerna tomma, och kontrollerna passerar på `0 === 0`.
**Spärren som ska avgöra om ett val får fastställas är alltså i dag grön på tomma
tabeller.** Det är den värsta felklassen i en kontroll: ett falskt godkännande.

Ingen uppgift ägde det. Uppgift 15 raderar kolumnerna kontrollerna läser, men säger
bara "inga kvarvarande referenser". Det hade tvingat fram en ad hoc-radering av
kontroller i stället för en ombyggnad. Luckan hittades i förhandsgranskningen
inför uppgift 12, som fjärde fallet av samma sort i planen.

**Vad slutkontrollen ska pröva i kuvertmodellen**

Gå igenom varje befintlig kontroll och avgör en av tre saker, skriftligt i koden:
behålls som den är, skrivs om mot det nya underlaget, eller tas bort med ett
utskrivet skäl. Ingen kontroll försvinner tyst.

Kontroller som ska finnas efteråt, och som var och en ska kunna fallera:

1. **Antalet stämmer.** Antalet `EncryptedVote` per valsedel är lika med antalet
   kuvert som skalades. Spara antalet vid stängningen om det inte redan finns,
   så att det finns något att jämföra mot. Kontrollen ska inte kunna passera
   på två tomma mängder när kuvert faktiskt lades.
2. **Varje röst verifierar.** `verifyEncryptedBallot` på varje `EncryptedVote`,
   inramad vid anropsstället enligt ruling 37 så att skräp i databasen blir en
   avvikelse och inte en krasch.
3. **Varje partiell dekryptering verifierar** mot förtroendemannens publika
   andel och mot det aggregerade chiffret.
4. **Räkningen stämmer.** Summan av räkneverken per valsedel är lika med antalet
   röster, och en omkombination av de lagrade partiella dekrypteringarna ger de
   publicerade talen.
5. **Kuvertroten finns** och kopplingen är raderad (`link_cleared`, finns redan).
5b. **Urnroten stämmer.** Kuvertroten binder (chifferhash, signatur) och går inte att räkna
   om efter stängningen, eftersom signaturerna är raderade. Den som kan skriva i votes_db
   kan därför byta ut ett chiffer och dess hash mot en ny, självkonsekvent rad med
   giltiga bevis, och ingenting märker det. Omgranskningen av 14f hittade luckan.
   Stängningen ska därför också beräkna och publicera en **urnrot**, en Merklerot över
   de flyttade chifferhasharna sorterade, i samma transaktion som kuvertroten.
   Slutkontrollen räknar om den ur `encrypted_vote` och kräver att den är densamma.
   Roten är en hash och publicerar ingenting per röst, så den följer spec 3.1.
   Sedan ruling 130 kan två rader ha samma chifferhash. Roten tas då över den sorterade
   listan med alla rader, dubbletter inräknade, så att en borttagen kopia också ändrar roten.
6. **Fasen är `TALLIED`** innan fastställandet tillåts, och fastställandet sätter
   fasen `CERTIFIED` med jämför-och-sätt, som övergångarna i uppgift 11d.
7. **Revisionskedjan är obruten** (`audit_chain_intact`, finns redan).

Behåll `PRECONDITION` kontra `CRITICAL` enligt den princip ruling 42 slog fast:
en kontroll som fallerar för att valet inte kommit så långt är en förutsättning,
inte en avvikelse, och får aldrig låsa ett oskyldigt val i `UNDER_REVIEW`.

**Från granskningen av 11g (E5).** Kommentaren över kontroll 2 i `final-check.usecase.ts`
säger "DETTA ÄR KONTROLLEN SOM INTE KAN FÖRFALSKAS INIFRÅN". Det stämmer inte, eftersom
valsedlarnas signeringsnycklar ligger i röstlängden (posten `signing-keys-in-database`).
Frågan som administratören ser, "Har varje registrerad röst skapats genom den auktoriserade
processen?", lovar också mer än kontrollen prövar. Kontrollen skrivs ändå om här. Se till
att den nya kontrollens kommentar och fråga säger exakt vad den prövar, och vem den inte
skyddar mot.

- [ ] **Steg 1: Skriv tester som fallerar för varje kontroll, en manipulation per test**

Varje test ska manipulera databasen på ett sätt som bara den kontrollen fångar,
och kräva att just den fallerar. Ett test som kontrollerar att allt är grönt på
ett ärligt val bevisar ingenting om spärren.

- [ ] **Steg 2: Bygg om kontrollerna**
- [ ] **Steg 3: Kör hela sviten**
- [ ] **Steg 4: Committa**

---

## Task 12c: Adminsidan leder genom hela avslutningen

**Varför:** användaren hittade inte hur ett val avslutas och bad 2026-09-24: *"Gör klart
... allt som behövs för att slutföra hela processen så röster kan valideras och räknas"*.
Adminsidan (`src/app/admin/page.tsx`) är byggd för den gamla modellen:

- "Publicera åtagande" binder den gamla tabellen `vote`.
- Slutkontrollen är den gamla modellens fram till 12b.
- Det finns ingen knapp som stänger röstningen.
- Det finns ingen valideringsrapport.
- Det finns ingen plats där förtroendepersonerna lämnar sina fraser.
- Det finns inget resultat.

Rutterna finns redan eller byggs i 11d, 12 och 12b, men ingen uppgift ägde sidan.

**Beroenden:**
- 11d: faserna
- 12: räkningen och rutten för partiell dekryptering
- 12b: slutkontrollen och fastställandet

Uppgift 13 lägger sedan publiceringen sist i samma flöde.

**Files:**
- Modify: `src/app/admin/page.tsx`, som delas upp i komponenter under `src/app/admin/`
- Modify eller Create: rutter under `src/app/api/admin/elections/`, men bara om något saknas
- Test: ett Playwright-test för hela flödet, och integrationstester för nya rutter

**Krav**

1. **Serverns fas styr sidan.** Sidan visar den valda omröstningens fas som en rad steg:
   `OPEN → CLOSED → VALIDATED → STRIPPED → TALLIED → CERTIFIED`. Bara nästa tillåtna steg
   har en aktiv knapp. Sidan läser om fasen från servern efter varje åtgärd och drar
   aldrig slutsatser av sina egna klick. Servern är auktoriteten, och varje rutt prövar
   fasen med jämför-och-sätt, enligt 11d.
2. **Stänga röstningen** (från `OPEN`). Knappen ber om en bekräftelse som säger att steget
   inte går att ångra. Före stängningen visar sidan hur många kuvert som ligger, och bara
   antalet (spec 3.1).
3. **Valideringen** (`CLOSED → VALIDATED`). Sidan visar valideringens rapport:
   - hur många kuvert som godkändes
   - hur många som underkändes, med skälet som en kod och en förklaring
   - aldrig vem som har lagt ett kuvert

   Om valideringen faller visar sidan vad administratören kan göra, med stängningens
   egna meddelanden från 11d. Den kan köras om från `CLOSED` och `VALIDATED`.
4. **Kopplingen raderas** (`VALIDATED → STRIPPED`). Sidan visar hur många kuvert som
   flyttades, kuvertroten och urnroten från 12b. Är raderingen ett eget anrop i 11d får
   den en egen knapp. Görs den i samma anrop som valideringen, visar sidan båda stegen
   efter det anropet.
5. **Räkningen** (`STRIPPED → TALLIED`). Sidan säger att två av tre förtroendepersoner
   behövs.
   - Det finns tre platser, en per förtroendeperson, var och en med ett fält för frasen.
   - Varje inlämning visar serverns besked: godkänd, avvisad, redan lämnad eller fel fras.
   - När två är godkända blir knappen "Räkna" aktiv.
   - Resultatet visas per valsedel, med antalet per alternativ och summan.

   **Bara i demoläge** har varje plats en knapp som fyller i demofrasen. Den ligger
   bakom `isDemoMode()`, som `DEMO_IDENTITIES` vid inloggningen. Fraserna står redan i
   repot.

   **Sidan säger hur det går till.** I demon skickas frasen till servern. Servern låser
   upp andelen och räknar fram den partiella dekrypteringen, så den ser andelen en kort
   stund. I ett riktigt val räknar varje förtroendeperson på sin egen enhet, och servern
   ser aldrig en andel. Saknar `known-limitations.ts` en post om det, läggs en till med en
   markör.
6. **Slutkontrollen och fastställandet** (`TALLIED → CERTIFIED`). Slutkontrollens tabell
   står kvar. "Fastställ" är aktiv bara när slutkontrollen har passerat, och den ber om en
   bekräftelse.
7. **Den gamla modellens knapp "Publicera åtagande" tas bort från sidan.** Rutten tas bort
   i uppgift 15.
7b. **Bara i demoläge: demovalet kan återställas.** Sedan 11d lämnar en stängning som
   stoppas av valideringen omröstningen i `CLOSED`, och ingenting i appen går tillbaka till
   `OPEN`. Ett misslyckat försök stoppar alltså demon för gott, också i Azure.
   - En knapp återställer demovalet: fasen blir `OPEN`, urnan töms och markeringarna tas
     bort.
   - Knappen och dess rutt ligger bakom `isDemoMode()`, under `/api/demo`, och finns
     aldrig i skarpt läge.
   - `prisma/reset-votes.ts` återställer också fasen.
8. **Ingenting per väljare.** Sidan visar bara antal, och aldrig vem som röstat, när eller
   på vad (spec 3.1 och 3.2).
9. **Serverns besked visas som de är.**
   - Varje utfall från stängningen visas med serverns eget meddelande: closed, untouched,
     aborted och de övriga i 11d. Sedan 11d finns också `in_progress` (409): en annan
     stängning pågår. Sidan säger det och läser om fasen.
   - Detsamma gäller räkningen.
   - Sidan säger aldrig att ett steg är klart om inte serverns fas säger det.
10. **Tillgänglighet och layout.**
    - Knapparna har synlig text.
    - Besked kommer i en aria-live-region.
    - Sidan fungerar vid 390 px utan sidledsskroll.
11. **Playwright, hela flödet i demoläge.** Testet skapar sin egen omröstning, så att det
    inte ändrar demons.
    - Två väljare röstar.
    - Administratören loggar in, stänger och ser att valideringen har passerat.
    - Två demofraser lämnas, och räkningen ger rätt summor.
    - Slutkontrollen passerar, omröstningen fastställs, och fasen är `CERTIFIED`.
    - En fel fras visar "fel fras" och räknas inte.

- [ ] Tester först, implementation, hela sviten med Playwright, skärmdumpar vid 1280 och
      390 px, committa med uttryckliga sökvägar.

---

## Task 13: Publicering av summorna och oberoende verifiering

**Files:**
- Modify: `src/app/api/observer/votes/route.ts`, `src/app/api/observer/election/route.ts`, `tools/verify-election.mjs`
- Create: `src/app/verify/page.tsx` (ersätter tokenflödet; sidan flyttades från `/verifiera` i uppgift 11b)
- Test: `tests/integration/independent-verification.test.ts`

**Varför uppgiften skrevs om (spec 3.1, användarens beslut 2026-09-23)**

Den första versionen publicerade varje röst med sin chifferhash och lät väljaren
hitta sin i mängden efter stängningen. Det är köparens verktyg. Den som en gång
sett rösten läggas kontrollerar efteråt om hashen finns kvar och vet då om
väljaren ändrat sig. Beslutet: efter stängningen publiceras **bara summorna med
bevis**, och väljaren ser *att* hon röstat, inte vad.

**Vad som publiceras, per valsedel, först när valsedeln räknats**

- den krypterade summan per alternativ (`c1`, `c2`)
- varje förtroendemans partiella dekryptering med DLEQ-bevis, och
  förtroendemannens publika andel
- resultatet per alternativ och antalet röster
- kuvertroten och antalet kuvert som skalades

**Vad som aldrig publiceras:** enskilda chiffer, deras hashar eller bevis, och
ingenting per röst. `/api/observer/votes` lämnar i dag ut varje röst i det gamla
flödet med innehåll (`ballotPartyId`, `candidateId`, `optionId`), utan inloggning och
även under `OPEN`. Det ska bort, inte kompletteras. Att ett fält läcker på ett ställe räcker för att bygga
köparens verktyg.

**Under röstningen publiceras bara valdeltagandet, och ingen ser löpande
resultat, inte heller administratören.** Adminvyn hämtar samma siffror ur `vote`
under `OPEN` via `src/app/api/admin/stats/route.ts`. Arkitektursidans markör
`oldFlowLiveResults` ligger i den rutten, och testet blir rött om bara
observatörsrutten rättas. Spec 6.2 gäller
alla: den som kan titta på ett löpande resultat kan också påverka när det slutliga
kommer. `/api/observer/election`
lämnar i dag ut antal per parti ur den gamla tabellen `vote` medan röstningen
pågår, till vem som helst. Det är ett löpande resultat, och spec 6.2 förbjuder
det. Rutten ska under `OPEN` bara visa antalet som röstat, och resultat först när
valsedeln har en `BallotTally`. Posten om löpande resultat i
`known-limitations.ts`, som lades till i uppgift 11c, försvinner därmed; testet
tvingar bort den.

**Det oberoende verktyget** (`tools/verify-election.mjs`) importerar ingenting
från `src` och kontrollerar det som går att kontrollera utan de enskilda rösterna:

1. varje partiell dekryptering mot förtroendemannens publika andel och summans
   `c1` (DLEQ)
2. att Lagrange-kombinationen av k bidrag ger `g^antal` som `c2` delat med den
   kombinerade dekrypteringen
3. att summan av antalen per valsedel är lika med antalet röster
4. att kuvertroten finns och att antalet kuvert stämmer med antalet röster

**Verktyget tolkar varje tal lika strikt som appen**, på egen hand, eftersom det inte
får importera `src`. Uppgift 14b:s granskning fann att en negativ exponent räknades som
1 och att inga intervall prövades, så att en förfalskad valsedel med +1000 och −999
godkändes. Verktyget ska vägra allt annat än kanoniska decimaltal med högst 617 siffror,
svar och utmaningar i [0, q), gruppelement i [1, p) med undergruppskontroll, och
negativa exponenter. Ett test ska visa att verktyget underkänner samma förfalskning.

Säg i verktygets utskrift och på sidan vad det **inte** kan kontrollera: att
summan består av exakt de giltiga rösterna. Det vilar på valideringen medan
kopplingen fanns och på slutkontrollen i uppgift 12b.

**`/verify` efter stängningen:** väljaren legitimerar sig och ser per valsedel
*"Du har röstat"* eller *"Du har inte röstat"*. Uppgiften kommer ur röstlängden
och kräver ingen koppling till rösten. Sidan länkar till de publicerade summorna
och säger hur man kör verktyget själv. **Före stängningen** hänvisar sidan till
röstsidan, där väljaren ser sin nuvarande röst på enheten hon röstade från
(uppgift 14). Komponentnamnet byttes till `VerifyPage` i uppgift 14. Uppgift 14 ersatte
också tokenrutan med en förklaring, som den här uppgiften bygger ut.

- [ ] **Steg 1: Skriv de fallerande testerna**

```ts
it('verktyget kontrollerar dekrypteringen utan att importera något från src', async () => {
  // Bevisvärdet ligger i oberoendet. Delar verktyget kod med appen bevisar det
  // bara att appen är konsekvent med sig själv.
  const output = execSync('node tools/verify-election.mjs', { encoding: 'utf8' })

  expect(output).toContain('dekrypteringen stämmer')
})

it('en manipulerad partiell dekryptering upptäcks', async () => {
  await votesDb.$executeRaw`update partial_decryption set value = '2' where true`

  expect(() => execSync('node tools/verify-election.mjs', { encoding: 'utf8' })).toThrow()
})

it('ett manipulerat resultat upptäcks', async () => {
  await votesDb.$executeRaw`update ballot_tally set counts = '[99,0,0]' where true`

  expect(() => execSync('node tools/verify-election.mjs', { encoding: 'utf8' })).toThrow()
})

it('ingenting per röst publiceras', async () => {
  // Spec 3.1. Allt publicerat per röst är ett handtag en köpare kan matcha mot.
  const { ciphertextHash } = await castFor(anna, 'bp-s')
  await closeAndTally(electionId)

  const published = JSON.stringify(await fetchPublished(electionId))

  expect(published).not.toContain(ciphertextHash)
  expect(published).not.toMatch(/ciphertextHash/)
})

it('inga delsummor under röstningen', async () => {
  // Spec 6.2. Ett löpande resultat är en tröskeldekryptering per siffra, eller
  // som i det gamla flödet en räkning i klartext.
  await castFor(anna, 'bp-s')

  const observed = JSON.stringify(await fetchObserverElection(electionId))

  expect(observed).not.toMatch(/Socialdemokraterna.*\d|votesByParty|counts/)
})

it('verifieringssidan visar att man röstat, inte vad', async () => {
  // Täcks i e2e om det är enklare; kravet är detsamma.
})
```

Anpassa kolumnnamnen i manipulationstesterna efter schemat, och håll dem riktade:
varje test ska fällas av just sin kontroll i verktyget.

- [ ] **Steg 2–4:** Implementera, kör, committa enligt mönstret ovan.

```bash
git commit -m "Bara summorna publiceras, och vem som helst kan kontrollera dekrypteringen"
```

---

## Task 14: Röstsidan lägger och ändrar krypterade röster

**Files:**
- Modify: `src/app/vote/page.tsx` (flyttad från `src/app/rosta` i uppgift 11b)
- Test: `tests/e2e/voting-flow.spec.ts` (skrivs om mot det nya flödet)

**Interfaces:**
- Consumes: `/api/vote/session`, `/api/vote/ballot`, `/api/vote/sign-start`, `/api/vote/encrypted`; `encryptBallot` och `canonicalOptions` från klientmodulerna
- Produces: inget nytt API

**Varför den här uppgiften finns, och varför den ligger här**

Röstsidan anropar i dag `/api/vote/credential` och `/api/vote/cast`. Uppgift 15
raderar båda. Utan den här uppgiften har systemet en ny baksida och en framsida
som anropar rutter som inte längre finns — och felet syns först när någon
försöker rösta.

Luckan upptäcktes av granskningen av uppgift 9: filen stod i planens
filstruktur men ingen uppgift ägde den. Den ligger före raderingen med flit, så
att sviten aldrig passerar ett tillstånd där appen inte går att rösta i.

**Vad väljaren ska se, och varför (spec 3.1)**

Användarens modell, beslutad 2026-09-23: alla röster är förtidsröster. Fram till
stängningen kan väljaren se, kontrollera och ändra sin röst. Efter stängningen
kan ingen se eller ändra något. Väljaren ser då *att* hon röstat, inte på vad.
Läs spec 3.1 innan du börjar. Den förklarar varför den första versionen av den
här uppgiften, som visade en verifikationskod och aldrig visade valet, var fel.

Fyra egenskaper måste synas i gränssnittet:

1. **Att rösten går att ändra.** Har väljaren redan lagt en röst på valsedeln
   ska sidan säga det, visa att den kan ändras fram till stängningen, och göra
   ändringen lika lätt som den första röstningen. Det är skyddet mot röstköp: en
   köpare måste se själva läggningen vid slutet, eftersom allt tidigare kan
   ändras.

2. **Den nuvarande rösten, på den här enheten.** Efter varje läggning sparar
   sidan valet och chifferhashen per valsedel i webbläsarens lagring. Slumptalet
   sparas **aldrig**. När sidan laddas hämtar den chifferhashen för väljarens
   liggande röst från servern och jämför. Utöka `/api/vote/session` eller
   `/api/vote/ballot` om ingen av dem returnerar den i dag, och bara för den
   inloggade väljarens egna valsedlar. Tre lägen:
   - Hasharna stämmer: *"Din nuvarande röst: X"*, med beskedet att servern
     håller exakt den röst som lades från den här enheten.
   - Hasharna stämmer inte: *"Din röst har ändrats från en annan enhet.
     Innehållet visas bara där rösten lades."*
   - Inget sparat här: *"Du har en röst registrerad."* utan innehåll.

3. **Att det enheten visar inte är ett bevis.** Säg det rakt ut: utan
   slumptalet går det inte att bevisa för någon annan vad rösten innehåller, och
   det enheten visar kan väljaren ändra själv. Ingen ska kunna kräva ett bevis av
   henne, och ingen kan få ett. Det är skyddet mot röstköp i den här modellen.

4. **Ingen verifikationskod.** Visa ingen chifferhash och ingen annan kod. En
   kod på skärmen är just det handtag en köpare antecknar. När sidan ser att
   valets fas lämnat `OPEN` raderar den sina sparade uppgifter för valet.

Byt också komponentnamnen `RostaContent` och `RostaPage` mot engelska. Sidan
flyttades i uppgift 11b men behöll de svenska namnen.

**Verifieringssidan slutar fråga efter token.** Användaren påpekade 2026-09-23 att
appen fortfarande har den gamla verifieringen med token. Efter den här uppgiften
delar röstsidan inte längre ut några tokens, så rutan på `/verify` har inget att
verifiera. Ersätt den med en förklaring på vardagsspråk: fram till stängningen ser
du din röst på röstsidan, på enheten du röstade från, och efter stängningen kommer
den här sidan att visa att du röstat men inte vad. Säg att det sista inte är byggt
än. Hela sidan byggs i uppgift 13, som behöver markeringen "har röstat" från 11d.
Rör inte `/api/verify`. Rutten tillhör det gamla flödet och raderas i uppgift 15.
Skriv om eller ta bort e2e-testerna som verifierar med token.

**`prisma/reset-votes.ts` måste också tömma `pending_vote` och `encrypted_vote`**,
och `partial_decryption` och `ballot_tally` om de finns. E2e-svitens globalSetup
kör skriptet mot dev-databasen. Från och med den här uppgiften lägger e2e-testerna
kuvert, och utan tömningen samlas de mellan körningar.

- [ ] **Steg 1: Skriv de fallerande e2e-testerna**

Skriv om `tests/e2e/voting-flow.spec.ts` mot det nya flödet. Behåll varje
befintligt test som fortfarande beskriver en sann egenskap, särskilt att Gunvor
får Faluns kommunvalsedel och inte Stockholms och att Elis avvisas. Testet att
ingen kvittokod hamnar i webbläsarens lagring skrivs om: lagringen innehåller nu
avsiktligt valet och chifferhashen, men aldrig slumptalet och aldrig en token.

Nya tester:

```ts
test('en väljare kan ändra sin röst, och enheten visar den nya', async ({ page }) => {
  // Hela skyddet mot röstköp. Kan rösten inte ändras är en köpt röst köpt.
  await identify(page, VOTERS.canVote)
  await voteFor(page, 'Socialdemokraterna')
  await expect(page.getByText(/din nuvarande röst/i)).toContainText('Socialdemokraterna')
  await expect(page.getByText(/kan ändra/i)).toBeVisible()

  await voteFor(page, 'Moderaterna')
  await expect(page.getByText(/din nuvarande röst/i)).toContainText('Moderaterna')
})

test('en annan enhet ser att rösten finns, men inte vad den innehåller', async ({ browser }) => {
  // Innehållet finns bara där rösten lades. Servern vet det inte.
  const here = await browser.newPage()
  await identify(here, VOTERS.verifiesReceipt)
  await voteFor(here, 'Moderaterna')

  const elsewhere = await (await browser.newContext()).newPage()
  await identify(elsewhere, VOTERS.verifiesReceipt)
  await expect(elsewhere.getByText(/du har en röst registrerad/i)).toBeVisible()
  await expect(elsewhere.getByText('Moderaterna')).toHaveCount(0)
})

test('en röst ändrad från en annan enhet visas inte längre på den första', async ({ browser }) => {
  const first = await browser.newPage()
  await identify(first, VOTERS.doubleVote)
  await voteFor(first, 'Centerpartiet')

  const second = await (await browser.newContext()).newPage()
  await identify(second, VOTERS.doubleVote)
  await voteFor(second, 'Liberalerna')

  await first.reload()
  await expect(first.getByText(/ändrats från en annan enhet/i)).toBeVisible()
  await expect(first.getByText('Centerpartiet')).toHaveCount(0)
})

test('ingen verifikationskod visas och inget slumptal sparas', async ({ page }) => {
  await identify(page, VOTERS.canVote)
  await voteFor(page, 'Socialdemokraterna')

  // En 64-teckens hex på skärmen vore ett handtag en köpare kan anteckna.
  await expect(page.locator('body')).not.toContainText(/[0-9a-f]{64}/)

  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }))
  expect(stored).not.toMatch(/random|slump|nonce|token/i)
})
```

Behåll testet `signaturen begärs av BankID, inte av sidan` ur den tidigare
versionen oförändrat. Att den sparade uppgiften raderas när fasen lämnat `OPEN`
prövas i ett enhetstest av lagringsmodulen; en e2e-stängning är för tung.

- [ ] **Steg 2: Kör och se dem falla**

Kör: `npx playwright test tests/e2e/voting-flow.spec.ts`
Förväntat: FAIL — sidan använder fortfarande det gamla flödet.

- [ ] **Steg 3: Skriv om sidan**

Flödet per valsedel:

```
hämta valsedelns alternativ  →  canonicalOptions  →  väljaren väljer
        ↓
encryptBallot i webbläsaren  →  chiffer + bevis + hash, slumptalen kastas
        ↓
POST /api/vote/sign-start { ballotId, ciphertextHash }  →  orderRef + QR
        ↓
väljaren signerar i BankID
        ↓
POST /api/vote/encrypted { ballotId, orderRef, ballot }  →  pollas tills klar
        ↓
visa verifikationskoden, och att rösten går att ändra
```

Återanvänd `BankIdLogin`-komponentens QR- och autostartmönster om det passar,
men **starta ingen legitimering** — det här är en signering, och väljaren är
redan inloggad.

**Kryptering i webbläsaren tar tid.** Tre valsedlar kostar omkring 0,7 sekunder
sammanlagt, och en enskild riksdagsvalsedel omkring 0,3. Visa att något händer;
en sida som ser låst ut under en sekund tolkas som trasig.

- [ ] **Steg 4: Kör testerna**

Kör: `npx playwright test` och `npx vitest run`
Förväntat: PASS

- [ ] **Steg 5: Öppna sidan i en riktig webbläsare**

Starta dev-servern och rösta igenom hela flödet själv, inklusive en ändring.
Ett blockerat skript eller en död knapp syns inte som ett fel i bygget — det
här projektet har redan förlorat tid på exakt det två gånger.

- [ ] **Steg 6: Committa**

```bash
git add src/app/vote/page.tsx tests/e2e/voting-flow.spec.ts
git commit -m "Röstsidan lägger och ändrar krypterade röster"
```

---

## Task 14c: Folkomröstningsfrågor i kuvertmodellen

**Varför:** implementeraren av uppgift 14 fann att valsedlar av typen `FRAGA`
(folkomröstning) inte går att rösta på i kuvertmodellen. Röstsidan säger det. I det
gamla flödet gick det, och ingen uppgift ägde det. Uppgiften måste vara klar **före
uppgift 15**, som raderar det gamla flödet. Annars går en folkomröstning inte att
genomföra alls.

Ta reda på exakt vad som saknas, i valsedelns kanoniska alternativ, i formen på
chiffret, i seeden eller någon annanstans, och bygg det. Blankt ska vara ett
alternativ, så att summabeviset gäller som för de andra valsedlarna. Lägg ett e2e-test
som röstar på en fråga, och ett integrationstest som räknar en.

- [ ] Tester först, implementation, hela sviten, committa.

---

## Task 15: Slakta blindsigneringen

**Files:**
- Delete: `src/lib/blind-signature.ts`, `src/lib/blind-client.ts`, `src/modules/eligibility/credential.service.ts`, `src/app/api/vote/credential/route.ts`, `src/modules/ballot-box/token.service.ts`, och deras tester
- Modify: `prisma/*/schema.prisma` (ta bort `signingPrivateKeyPem`, `signingPublicKeyPem`, `credentialId`, `credentialSignature`, `tokenHash`), `tests/security/api-surface.test.ts`

- [ ] **Steg 1: Uppdatera ruttinventeringen i `api-surface.test.ts`**

Ta bort `src/app/api/vote/credential/route.ts`, lägg till `src/app/api/vote/encrypted/route.ts`,
`src/app/api/admin/elections/close/route.ts`, `src/app/api/admin/elections/decrypt/route.ts`.

**Posten `client-code-from-server` skrevs om i uppgift 14** till kuvertmodellens
klient, med en markör på röstsidan. Kontrollera att den fortfarande stämmer när
blindningen raderas. Problemet finns kvar i kuvertmodellen: klientkoden kommer från
servern, och en manipulerad klient kan kryptera ett annat val än väljaren gjorde
(spec 10, *klientintegriteten är fortfarande olöst*).

**Röstsidans tolkning av det gamla flödets markering tas bort här.** Sedan uppgift 14
visar röstsidan en valsedel med en markering i `voter_ballot_status` som att väljaren
röstat i det gamla flödet och inte kan byta. När det gamla flödet raderas ska den
tolkningen bort, och markeringarna från det gamla flödet med den.

**Om ingenting längre skriver till den gamla tabellen `vote`** efter uppgift 14,
ta bort modellen och allt som läser den, inte bara kolumnerna ovan.

**Kontrollera listan mot vad som redan står där.** `close/route.ts` lades in i
uppgift 11 och `decrypt/route.ts` i uppgift 12, eftersom testet annars fallerade.
Slutkontrollen byggdes om mot kuvertmodellen i uppgift 12b, så att raderingen av
kolumnerna här inte tvingar fram en ad hoc-radering av kontroller.

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

**Från granskningen av 11g (E5).** Kommentaren i `known-limitations.ts` om att
signeringsnycklarna "flyttar till Key Vault" hör hit. När blindsigneringen och dess nycklar
tas bort, tas kommentaren bort eller skrivs om, eftersom det då inte finns några nycklar
kvar att flytta.

---

## Task 16: Dokumentation och begränsningar

**Files:**
- Modify: `ARCHITECTURE.md`, `README.md`, `VERIFIABILITY.md`, `SECURITY.md`, `src/lib/known-limitations.ts`, `tests/security/known-limitations.test.ts`

**Varför uppgiften växte**

Den skrevs som en omskrivning av `ARCHITECTURE.md` avsnitt 4-7. Det räcker inte,
och luckan är densamma som redan upptäckts två gånger i den här planen: en fil
står i ingen uppgifts ägo och felet syns först när någon läser den.

- `ARCHITECTURE.md` avsnitt 3 är *Blinda signaturer, förklarat enkelt* — hela den
  mekanism uppgift 15 raderar. Avsnitt 1-2 beskriver samma gamla modell.
- `VERIFIABILITY.md` avsnitt 1 är i sin helhet *Röstintyg*, samma raderade
  mekanism. Filen ägdes av ingen uppgift.
- `README.md` ägdes av ingen uppgift, och dess rubrikpåstående är inte bara
  inaktuellt utan **fel om säkerhetsmodellen**. Se steg 5.

- [ ] **Steg 1: Ta bort de lösta begränsningarna**

Fyra poster försvinner: `signing-keys-in-database`, `receipt-proves-choice`,
`single-administrator`, `no-guaranteed-anonymity-set`. Testet i
`known-limitations.test.ts` går rött tills de tas bort — det är meningen, det failar
när något blir bättre.

- [ ] **Steg 2: Kontrollera de nya**

**`link-exists-during-voting`, `trusted-dealer` och posten om BankID-certifikatkedjan
lades till i uppgift 11c**, eftersom arkitektursidan läser listan och annars hade
visat kuvertmodellen utan dess risker. Lägg inte till dem igen; kontrollera att
de fortfarande stämmer. Koden nedan står kvar som referens för formuleringen.
Lydelsen i `link-exists-during-voting` skärptes i 11c:s fixrunda, eftersom
"därmed röstköp meningslöst" lovade mer än spec 3.1 medger. Den nya lydelsen,
som står nedan och i `known-limitations.ts`, är den som gäller.

```ts
{
  id: 'link-exists-during-voting',
  title: 'Kopplingen väljare↔röst finns medan röstningen pågår',
  why:
    'Modellen med dubbla kuvert kräver kopplingen — det är den som gör rösten utbytbar, så ' +
    'att en köpt röst kan ersättas ända fram till stängningen. Priset är att "kan inte existera" blivit "raderas enligt ' +
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

- [ ] **Steg 3: Skriv om `ARCHITECTURE.md` avsnitt 1-7**

Inte bara 4-7. Avsnitt 3 beskriver blindsigneringen, som uppgift 15 har raderat,
och avsnitt 1-2 beskriver separationen som den såg ut innan kuvertmodellen.

Ersätt blindsigneringens beskrivning med kuvertanalogin, sekvensdiagrammet över
kryptering → ändring → skalning → summering, och tabellen över vad varje egenskap
vilar på. Behåll formen från det befintliga avsnittet om blindsignering: analogin
först, matematiken sedan, och ett stycke om vad konstruktionen **inte** ger.

Gå också igenom avsnitt 10, *Vad arkitekturen ska vara, och var koden avviker*.
Avvikelserna där är skrivna mot den gamla koden.

- [ ] **Steg 4: Skriv om `VERIFIABILITY.md` avsnitt 1**

Avsnittet heter *Röstintyg: varför databasflaggor inte räcker* och beskriver en
mekanism som inte längre finns. Det som ersätter det är inte ett intyg utan en
signerad kuvertläggning: väljaren signerar sitt eget chiffer med BankID, och
kuvertroten publiceras innan signaturerna raderas.

**Skriv inte att roten är ett inklusionsbevis.** Det är den inte i dag —
`merkle.ts` exporterar ingen inklusionsvägsfunktion, inga syskonhashar lagras,
och efter skalningen är signaturerna borta så ingen utomstående kan räkna om
den. Den är ett åtagande över mängden kuvert, publicerat före raderingen.
Samma fel har redan rättats två gånger i det här projektet — i spec 4.6 och i
schemats kommentar om `envelopeRoot` — och ska inte återinföras här.

Behåll avsnitt 2-5 där de fortfarande är sanna, men kontrollera varje påstående
mot koden i stället för att anta det.

- [ ] **Steg 5: Skriv om `README.md`**

README:s rubrikpåstående är i dag **fel om säkerhetsmodellen**, inte bara
inaktuellt. Den säger:

> Den del som vet **"person X har röstat"** kan inte ta reda på
> **"person X röstade på parti Y"**.

I kuvertmodellen är det falskt medan röstningen pågår. `voters_db` bär
kopplingen med flit — det är den som gör rösten utbytbar, så att en köpt röst
kan ersättas ända fram till stängningen. Separationen **uppstår vid stängningen**, när kopplingen raderas.
Att beskriva den som en egenskap som gäller hela tiden är precis den sortens
överdrivna löfte som redan rättats på tre andra ställen i projektet.

Skriv om README så att den säger vad som faktiskt gäller, och när:

1. Under röstningen: kopplingen finns, rösten kan ändras, och det är avsikten.
2. Vid stängningen: chiffren flyttas, kopplingen raderas, kuvertroten publiceras.
3. Efter stängningen: ingen koppling finns kvar i den levande databasen — och
   säg rakt ut att backuper, läsreplikor och WAL-loggen inte omfattas av
   raderingen. Det är samma begränsning som `link-exists-during-voting` i steg 2,
   och README ska inte lova mer än begränsningslistan medger.

Rätta också det som är konkret fel i dag:

- Tabellen över sidor beskriver `/rosta` som *"Partival, bekräftelse och kvitto
  med token"* och `/verifiera` som *"Kontrollera en röst med sin token"*. Tokens
  finns inte i modellen. Sidorna har dessutom bytt sökväg i uppgift 11b:
  `/identify`, `/vote`, `/verify` och `/architecture`. De svenska sökvägarna
  omdirigeras, men README ska ange de nya.
- Genomgången säger *"Har redan röstat — avvisas"*. I den nya modellen kan en
  väljare rösta igen och ändra sig fram till stängningen. Demopersonnumrens
  utfall ska stämma med vad seeden faktiskt gör.
- *"Det enda som passerar gränsen när en röst läggs är ett parti-id"* är fel.
  Det som passerar är ett chiffer som ingen kan läsa utan k av n andelar.
- SQL-exemplet läser `anonymous_vote`. Den tabellen heter `vote` sedan
  omdöpningen, och den nya tabellen för krypterade röster heter `encrypted_vote`.
  Kör kommandona innan du skriver in dem — ett exempel som inte fungerar är
  värre än inget exempel.
- **Allt ska följa spec 3.1.** Ingen verifikationskod; väljaren ser sin nuvarande
  röst på enheten hon röstade från fram till stängningen; efter stängningen
  publiceras bara summorna med bevis. Det gäller README, ARCHITECTURE.md (särskilt
  avsnitt 6 om verifierbarhet) och VERIFIABILITY.md i sin helhet.
- **SECURITY.md ska förklara `TRUSTED_PROXY_HOPS`.** Sedan fixrundan i 14b litar
  hastighetsgränsen bara på `X-Forwarded-For` när variabeln är satt. Den står i
  `.env.example` men inte i SECURITY.md 4.3. Bakom en proxy utan variabeln delar alla
  besökare proxyns adress, och med den för högt satt kan en klient välja sin egen.
- **Behåll avsnittet om testdatabaserna** som lades in i uppgift 11a (att
  integrationstesterna kör mot `voters_test`/`votes_test`, att vakten frågar
  servern vilken databas den är ansluten till, och när testerna hoppas över
  respektive fallerar). Det är skrivet mot koden och stämmer. Notera också att
  e2e-sviten med flit nollställer röster och seedar om **dev**-databasen, eftersom
  den testar den körande appen.

- [ ] **Steg 6: Kör hela sviten och committa**

```bash
npx vitest run && npx playwright test
git add -A && git commit -m "Dokumentationen beskriver dubbla kuvert; fyra begränsningar lösta, två nya"
```

---

## Task 17: Demoläge och skarpt läge

**Ändrat 2026-09-24 efter användarens beslut (ruling 121).** Användaren frågade efter en
knapp på adminsidan som växlar mellan demoläge och skarpt läge. Beslutet blev att
**läget sätts vid driftsättning, och adminsidan visar det.** Ingen knapp växlar läget
inifrån appen, eftersom den som kommer åt en adminsession annars kunde slå på
attrapp-BankID för alla. Texten längre ned skrevs före beslutet och före Azure-demon. Där
den skiljer sig från punkterna här gäller punkterna.

1. **Demoläge tillåts i ett produktionsbygge.** Den publika demon i Azure är ett
   produktionsbygge (`NODE_ENV=production` i `infra/azure/app.bicep`) som kör i demoläge.
   Med koden längre ned hade `runtimeMode()` gett `SHARP` där, och `assertBootable()` hade
   kraschat.
   - Läget följer därför bara `DEMO_MODE=true`. Skarpt är förvalt oavsett `NODE_ENV`.
   - Testet "production + DEMO_MODE kraschar" ersätts med ett test som visar att
     production + DEMO_MODE startar i demoläge och skriver det i loggen vid varje start.

   Ett riktigt val skyddas i stället av:
   - att skarpt är förvalt
   - en banderoll på varje sida i demoläge
   - omröstningens eget läge (steg 4). En demoomröstning kan då aldrig fastställas i
     skarpt läge, och demoröster hamnar aldrig i en skarp omröstning.
   - uppstartsvakten i skarpt läge
2. **Samordning med Azure.** Innan uppgiften distribueras måste `DEMO_MODE=true` sättas i
   `infra/azure/app.bicep`. Annars startar Azure-demon i skarpt läge och kraschar på de
   ouppfyllda kraven. Filen är Azure-sessionens, så implementeraren rör inte `infra/`.
   Controllern meddelar Azure-sessionen när uppgiften är committad.
3. **Adminsidan visar läget.** Överst efter inloggningen står ett kort med:
   - läget ("Demoläge" eller "Skarpt läge") och en mening om vad det innebär
   - vilken BankID som används: attrappen, testmiljön eller produktion
   - checklistan ur `sharpModeRequirements()`, med uppfyllt eller inte per krav
   - sist meningen "Läget sätts vid driftsättning och kan inte ändras här."

   I demoläge visar listan vad som saknas för skarpt läge.
4. **Checklistan är inte offentlig.** `/api/mode` ger bara läget, som banderollen behöver.
   Checklistan beskriver konfigurationen och går därför via en adminrutt bakom
   adminsessionen.
5. **Kraven får en allvarlighetsgrad:** `Requirement = { id; met; detail; blocking }`.
   - BankID:s testmiljö är en varning och inget stopp. I skarpt läge med
     `BANKID_ENV=test` säger adminsidan att inloggningarna är riktiga BankID-flöden med
     test-BankID, inte med riktiga personer.
   - Fastställandets granskningshändelse skriver ned BankID-miljön.
   - Den riktiga klienten kommer i 17b och 17c. Till dess är `bankid-real` ouppfyllt och
     stoppar, så skarpt läge kan inte starta. Det är sanningen om koden.
6. **Kända fraser vägras när en omröstning skapas.** `trustee-passphrases-changed` får inte
   bero på en miljövariabel som driften måste komma ihåg att sätta
   (`SEEDED_TRUSTEE_PASSPHRASES`).
   - I skarpt läge vägrar skapandet av en omröstning demofraserna.
   - I skarpt läge vägrar seed-skriptet att köra.
   - Posten om demofraserna i `known-limitations.ts`, som kom till i 11g:s fixrunda,
     skrivs om eller tas bort här.
7. **Banderollen.** Kontrollera först vad som finns. Finns ingen banderoll, visar varje
   sida i demoläge en smal banderoll: "Demo, inte ett riktigt val. BankID är en attrapp."

**Vakten för demoläget, som växeln bygger på, ska skärpas först.** Uppgift 11c
samlade demoläget i `isDemoMode()` i `src/lib/demo-mode.ts`, med ett strukturtest i
`tests/security/api-surface.test.ts`. Granskningen visade att testet släpper igenom:

- en hanterare skriven som `export const POST = async …`, `export function PUT`
  eller `export { leak as PATCH }`
- `HEAD` och `OPTIONS`
- ett villkor som svarar 200 i stället för 404
- filer under `src/app/api/demo` som inte heter `route.ts`

Lägg dessutom till ett **beteendetest**. Det byter `isDemoMode` mot `false` och båda
databasklienterna mot proxies som kastar vid all åtkomst, importerar varje rutt
under `src/app/api/demo`, anropar varje exporterad metod och kräver 404 utan någon
databasåtkomst. Lägg också ett test som visar att växeln faktiskt styr
`isDemoMode()`. Det finns inget som prövar det i dag.

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

## Task 17b: BankID:s underskrift prövas i BankID:s eget format

**Varför:** användaren valde 2026-09-24 en riktig BankID mot BankID:s testmiljö (ruling
122). En riktig BankID lämnar underskriften i `completionData.signature`, ett
XMLDSig-dokument där både det signerade innehållet och certifikatkedjan är inbäddade.
Kuvertets underskrift följer i dag attrappens eget format, och posten
`bankid-xmldsig-adapter-missing` säger att läsaren saknas. Uppgiften bygger läsaren och
låter attrappen ge underskrifter i samma format, så att samma väg prövas i varje test.
Den riktiga klienten i 17c behöver då bara lämna över XML:en.

**Inga nya beroenden** (Global Constraints). XMLDSig-bibliotek har haft upprepade fel där
en underskrift kunde flyttas eller lindas in (signature wrapping), så att det som prövas
inte är det som läses. Bygg i stället en strikt läsare för just BankID:s format. Den
godtar exakt den struktur som BankID ger och avvisar allt annat:

- DOCTYPE och entiteter
- kommentarer och bearbetningsinstruktioner
- okända element och attribut
- dubbla `Id`
- fler referenser än väntat
- andra algoritmer

Ta formatet ur BankID:s dokumentation (developers.bankid.com) och den exklusiva
kanoniseringen ur W3C:s specifikation, och ange källorna i koden.

**Files:**
- Create: `src/modules/eligibility/bankid/xmldsig.ts`
- Modify: `src/modules/eligibility/bankid/MockBankIdService.ts`,
  `src/modules/eligibility/bankid/envelope-signature.ts`,
  `src/modules/eligibility/bankid/trusted-roots.ts`,
  `src/modules/eligibility/sealed-chain.ts`, `src/lib/known-limitations.ts`
- Test: `tests/unit/bankid-xmldsig.test.ts` och de befintliga testerna för underskrift
  och försegling

**Krav**

1. **Läsaren** är strikt och har gränser för storlek och djup.
2. **Kanoniseringen** är exklusiv XML-kanonisering 1.0 för det BankID signerar, och bara
   för den delmängd läsaren godtar.
3. **Prövningen** omfattar:
   - varje referens digest (SHA-256) över det kanoniserade element som referensen pekar på
   - `SignatureValue` över kanoniserad `SignedInfo`, med lövets publika nyckel och de
     algoritmer BankID använder
   - den inbäddade kedjan, med `certificate-chain.ts` mot betrodda rötter: BankID:s
     testrot för `BANKID_ENV=test`, produktionsroten för produktion och attrappens rot i
     demoläge
   - att referensernas `URI` pekar på exakt de element vars innehåll används. Det
     `usrNonVisibleData` som läses ska ligga i det element som har prövats, och ingen
     annan kopia får godtas.
4. **Bindningen.** Kuvertets signerade innehåll, alltså det saltade värdet från 11e,
   jämförs med `usrNonVisibleData` i det prövade elementet.
5. **Attrappen ger underskrifter i BankID:s format**, med attrappens CA, så att varje
   befintligt test går genom läsaren.
6. **Förseglingen.** Hela underskriftens XML förseglas som kedjan förseglas i dag, med
   samma nyckel, samma AAD och fast längd.
   - BankID:s svar på spärrfrågan (`ocspResponse`) förseglas med, så att en senare
     uppgift kan pröva det.
   - Mät den största realistiska underskriften och skriv marginalen i koden.
   - Formatet får en ny version. Skriv vad som händer med kuvert i det gamla formatet i
     demons databaser. En stängning får aldrig tyst tappa dem.
7. **Tester.** Ett test per sorts avvisning, och varje test ska bli rött mot en läsare som
   saknar just den kontrollen:
   - ett flyttat `Id`
   - ett dubbelt `Id`
   - ett andra `bankIdSignedData` utanför referensen
   - ändrat `usrNonVisibleData`
   - ändrad `SignedInfo`
   - fel algoritm
   - en inskjuten kommentar
   - namnrymdsknep
   - ändrade blanktecken i det signerade
8. **Ett riktigt exempel.** När det finns en underskrift från BankID:s testmiljö (17c)
   läggs den till som testfall. Till dess används ett exempel ur BankID:s dokumentation,
   om den publicerar ett fullständigt.
9. **Posterna.** `bankid-xmldsig-adapter-missing` skrivs om eller tas bort. `revocation`
   står kvar, med tillägget att svaret på spärrfrågan nu sparas förseglat men inte prövas.

- [ ] Tester först, implementation, hela sviten, committa med uttryckliga sökvägar.

---

## Task 17c: En riktig BankID-klient mot BankID:s testmiljö

**Varför:** användarens beslut 2026-09-24 (ruling 122). Med klienten loggar man in och
röstar med den riktiga BankID-appen och ett test-BankID från demo.bankid.com. Samma klient
kan senare pekas mot produktion, med ett eget certifikat och ett avtal med en bank.

**Beroenden:**
- 17: läget
- 14e och 11e: BankID-ordern bär inte kopplingen ut ur systemet
- 17b: läsaren

**Files:**
- Create: `src/modules/eligibility/bankid/BankIdRpClient.ts`, `scripts/fetch-bankid-test-cert.*`
- Modify: `src/modules/eligibility/bankid/index.ts`, inloggningskomponenten, röstsidans
  BankID-steg, `src/lib/runtime-mode.ts` och README
- Test: enhetstester mot en falsk RP-server, och ett frivilligt test mot testmiljön

**Krav**

1. **Klienten** implementerar `IBankIdService` mot RP API v6.0, med `auth`, `sign`,
   `collect` och `cancel`, över ömsesidig TLS.
   - RP-certifikatet kommer från `BANKID_CERT_PATH` och `BANKID_CERT_PASSPHRASE`: BankID:s
     publika testcertifikat för testmiljön och ett eget för produktion.
   - BankID:s server-CA är förankrad, och systemets CA-lager används aldrig.
2. **`BANKID_ENV=test|production`** väljer adress och rötter. Skarpt läge använder
   klienten och demoläget attrappen (17).
3. **Testcertifikatet committas inte.** `scripts/fetch-bankid-test-cert` hämtar det från
   BankID:s webbplats och kontrollerar det mot en förankrad SHA-256. README beskriver hur
   man skaffar ett test-BankID på demo.bankid.com och ställer in BankID-appen för
   testmiljön.
4. **Ordern:**
   - `endUserIp` kommer från de betrodda proxyleden, som i dag.
   - `userVisibleData` säger på svenska vad som signeras.
   - `userNonVisibleData` bär det saltade värdet från 11e.
   - Ordern bär ingenting som kopplar person till röst utanför systemet (11e).
5. **Pollningen:**
   - `collect` går bara på `orderRef` (14e).
   - `hintCode` översätts till BankID:s rekommenderade meddelanden (RFA) på svenska.
   - QR-koden animeras ur `qrStartToken` och `qrStartSecret` (`qr.ts`).
   - "BankID på den här enheten" använder `autoStartToken`.
6. **Felkoderna** hanteras som BankID rekommenderar: `alreadyInProgress`,
   `invalidParameters`, `unauthorized`, `notFound`, `requestTimeout`, `maintenance` och
   `internalError`. Tidsgränser och omförsök är begränsade.
7. **Ett frivilligt test mot testmiljön** (`BANKID_LIVE_TEST=1`) kör `auth`, `collect` på
   en väntande order och `cancel`. Det ingår inte i den vanliga sviten.
8. **Efter uppgiften** kan skarpt läge starta med `BANKID_ENV=test`, och adminsidan visar
   "Skarpt läge, BankID testmiljö". En signering kräver appen, så rapporten säger vad en
   människa med test-BankID behöver pröva för hand.
9. **Azure.** Certifikatet och frasen läggs i Key Vault. Det gör Azure-sessionen, och
   controllern meddelar den.

- [ ] Tester först, implementation, hela sviten, committa med uttryckliga sökvägar.

---

## Task 18: OpenAPI-spec genererad ur valideringsschemana

**Files:**
- Create: `src/lib/openapi.ts`, `src/app/api/openapi/route.ts`, `src/app/api-dokumentation/page.tsx`
- Modify: `src/lib/validation.ts` (registrera schemana), `package.json`, `ARCHITECTURE.md`
- Test: `tests/security/openapi-coverage.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function openApiDocument(): OpenAPIObject
  ```

**Beroendeundantaget, och varför det är motiverat**

Projektets globala krav säger inga nya npm-beroenden. Det skrevs för kryptot —
poängen var att inget kryptobibliotek behövs, eftersom OpenSSL:s modexp nås via
`node:crypto` (spec 4.1 och uppgift 14b), och att varje kryptoberoende är en
angreppsyta i just den kod som bär valhemligheten. Skriv inte in siffran 2 ms i
ARCHITECTURE.md. Den gällde OpenSSL och inte ren BigInt, och de rättade siffrorna står
i spec 4.1.

Den här uppgiften gör ett undantag för två paket, och skälet ska stå i
`ARCHITECTURE.md`, inte bara i ett commit-meddelande:

- `@asteasolutions/zod-to-openapi` — härleder specen ur de Zod-scheman rutterna
  **faktiskt validerar med**. En handskriven spec beskriver vad någon trodde att
  API:et gjorde vid skrivtillfället; en härledd beskriver vad det gör.
- `swagger-ui-react` — CSP:n tillåter inga externa skript, så ett CDN-laddat
  Swagger UI blockeras tyst. Paketerat med appen serveras det från `'self'`.

Ingetdera rör krypto, röstdata eller identiteter. De läser scheman och renderar
en sida.

- [ ] **Steg 1: Skriv det fallerande testet**

```ts
// tests/security/openapi-coverage.test.ts
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openApiDocument } from '@/lib/openapi'

/**
 * SPECEN FÅR INTE TIGA OM EN RUTT.
 *
 * En API-dokumentation som missar en rutt är värre än ingen alls: läsaren drar
 * slutsatsen att ytan är mindre än den är. Samma mönster som
 * api-surface.test.ts, som redan räknar upp varje ruttfil — här krävs att
 * inventeringen och specen täcker varandra.
 *
 * Demorutterna undantas med flit. De existerar bara när BankID är en attrapp
 * och hör inte till det API någon ska integrera mot.
 */
function routeFiles(directory: string, prefix = ''): string[] {
  const found: string[] = []

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...routeFiles(path, `${prefix}/${entry.name}`))
    else if (entry.name === 'route.ts') found.push(prefix)
  }

  return found
}

const routes = routeFiles(join(process.cwd(), 'src/app/api'))
  .filter((path) => !path.startsWith('/demo'))
  .sort()

describe('OpenAPI-specen mot den faktiska ruttinventeringen', () => {
  it('varje rutt finns i specen', () => {
    const documented = Object.keys(openApiDocument().paths ?? {})
      .map((path) => path.replace(/^\/api/, ''))
      .sort()

    expect(documented).toEqual(routes)
  })

  it('varje dokumenterad rutt finns på disk', () => {
    // Andra riktningen. En spec som beskriver rutter som inte finns skickar
    // den som integrerar mot ett API som svarar 404.
    const documented = Object.keys(openApiDocument().paths ?? {}).map((path) =>
      path.replace(/^\/api/, ''),
    )

    for (const path of documented) {
      expect(routes, `${path} finns i specen men inte på disk`).toContain(path)
    }
  })

  it('ingen rutt dokumenteras utan att beskriva sina fel', () => {
    /**
     * Rutterna svarar 403 på fel origin, 429 vid hastighetsgräns och 400 på
     * ogiltig indata. En spec som bara visar lyckofallet får den som
     * integrerar att tro att de svaren är buggar.
     */
    for (const [path, item] of Object.entries(openApiDocument().paths ?? {})) {
      for (const [method, operation] of Object.entries(item as Record<string, any>)) {
        if (!['get', 'post'].includes(method)) continue

        const codes = Object.keys(operation.responses ?? {})
        expect(codes, `${method.toUpperCase()} ${path} saknar felsvar`).not.toEqual(['200'])
      }
    }
  })

  it('inget svarsexempel innehåller ett personnummer eller en token', () => {
    /**
     * Ett exempel är dokumentation, men det kopieras också. Ett personnummer
     * eller en kvittokod i specen blir ett personnummer i varje kodexempel
     * någon klistrar in.
     */
    const serialised = JSON.stringify(openApiDocument())

    expect(serialised).not.toMatch(/\b(19|20)\d{6}[-\s]?\d{4}\b/)
    expect(serialised).not.toMatch(/"token"\s*:\s*"[0-9a-f]{40,}"/)
  })
})
```

- [ ] **Steg 2: Kör och se att det fallerar**

Kör: `npx vitest run tests/security/openapi-coverage.test.ts`
Förväntat: FAIL, `Failed to resolve import '@/lib/openapi'`

- [ ] **Steg 3: Installera de två paketen**

```bash
npm install @asteasolutions/zod-to-openapi swagger-ui-react --save
```

Kör `npm install` med `--ignore-scripts` om postinstall faller — projektets
postinstall kör `prisma generate`, som kräver att dev-servern är stoppad.

- [ ] **Steg 4: Registrera schemana och bygg dokumentet**

`src/lib/validation.ts` innehåller redan varje rutts indataschema. Utöka dem med
`.openapi()`-metadata via `extendZodWithOpenApi`, och bygg dokumentet i
`src/lib/openapi.ts`:

```ts
/**
 * SPECEN HÄRLEDS UR VALIDERINGEN, INTE UR PROSA.
 *
 * Varje rutt validerar sin indata med ett Zod-schema i validation.ts. Genereras
 * specen ur samma scheman beskriver den vad API:et FAKTISKT accepterar. En
 * handskriven spec beskriver vad någon trodde att det accepterade när den
 * skrevs, och de två glider isär tyst.
 *
 * Täckningen vaktas av tests/security/openapi-coverage.test.ts, som jämför mot
 * samma ruttinventering som api-surface-testet använder.
 */
```

Varje operation ska beskriva `403` (fel origin), `429` (hastighetsgräns) och
`400` (ogiltig indata) utöver lyckofallet — testet i steg 1 kräver det.

**Svarsexemplen får inte innehålla riktiga personnummer eller kvittokoder.**
Använd uppenbart påhittade värden.

- [ ] **Steg 5: Servera specen och sidan**

`src/app/api/openapi/route.ts` returnerar dokumentet som JSON. Rutten kräver
ingen inloggning — API-ytan är offentlig information, och att dölja den gör
systemet svårare att granska utan att göra det säkrare. Den ska ha
origin-kontroll och hastighetsgräns som övriga rutter.

`src/app/api-dokumentation/page.tsx` renderar `swagger-ui-react` mot den rutten.
Sidan är en klientkomponent. **Kontrollera att den faktiskt laddar under CSP:n**
— starta dev-servern och öppna sidan i en riktig webbläsare, för ett blockerat
skript syns inte som ett fel i bygget. Det här projektet har redan förlorat tid
på exakt det.

- [ ] **Steg 6: Skriv in undantaget i ARCHITECTURE.md**

Ett stycke som säger vilka två paket som lagts till, att de inte rör krypto,
röstdata eller identiteter, och varför en genererad spec valdes framför en
handskriven. Utan det ser nästa läsare bara att regeln brutits.

- [ ] **Steg 7: Kör testerna**

Kör: `npx vitest run` — hela sviten, inte bara den nya filen.
Förväntat: PASS

- [ ] **Steg 8: Committa**

```bash
git add package.json package-lock.json src/lib/openapi.ts src/lib/validation.ts \
        src/app/api/openapi src/app/api-dokumentation \
        tests/security/openapi-coverage.test.ts ARCHITECTURE.md
git commit -m "OpenAPI-spec genererad ur valideringsschemana"
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
