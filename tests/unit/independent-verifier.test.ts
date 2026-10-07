import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { encrypt, generateKeyPair, multiply, type Ciphertext } from '@/lib/crypto/elgamal'
import { G, P, Q, modPow, randomScalar } from '@/lib/crypto/group'
import { partialDecryptionChallenge, partialDecryptionTranscript } from '@/lib/crypto/proofs'
// Serverns ingång registrerar OpenSSL, så att publiceringarna nedan byggs fort.
import { partiallyDecrypt, publicShare, splitSecret } from '@/lib/crypto/server'
import { serialisePartialDecryptionProof, TRUSTEE_COUNT, TRUSTEE_THRESHOLD, type Share } from '@/lib/crypto/threshold'

/**
 * DET OBEROENDE VERKTYGET, tools/verify-election.mjs (uppgift 13).
 *
 * Verktyget läser den publicerade summan per alternativ, förtroendepersonernas
 * bidrag med bevis och resultatet, och räknar om det som går att räkna om utan
 * de enskilda rösterna. Bevisvärdet ligger i oberoendet: det importerar
 * ingenting ur src, och transkriptet är skrivet på nytt ur spec 4.5. Delade det
 * kod med appen bevisade det bara att appen är konsekvent med sig själv.
 *
 * Publiceringarna här byggs med appens egen kryptografi, men utan databas, så
 * att varje kontroll i verktyget kan fällas för sig med en enda ändring. Samma
 * verktyg körs mot en riktig publicering ur rutten i
 * tests/integration/independent-verification.test.ts.
 */

const TOOL = join(process.cwd(), 'tools/verify-election.mjs')

type Tool = {
  P: bigint
  Q: bigint
  G: bigint
  partialDecryptionTranscript: (
    binding: { electionId: string; ballotId: string; optionIndex: number; trusteeIndex: number },
    values: bigint[],
  ) => Uint8Array
  partialDecryptionChallenge: (
    binding: { electionId: string; ballotId: string; optionIndex: number; trusteeIndex: number },
    values: bigint[],
  ) => bigint
  verifyPublication: (publication: unknown, options?: { electionId?: string }) => { ok: boolean; lines: string[] }
  expectedElectionIdFrom: (source: string) => string | undefined
  modPow: (base: bigint, exponent: bigint, modulus: bigint) => bigint
  bigintModPow: (base: bigint, exponent: bigint, modulus: bigint) => bigint
}

let tool: Tool

beforeAll(async () => {
  tool = (await import(pathToFileURL(TOOL).href)) as Tool
})

// ---------------------------------------------------------------------------
// En publicering, byggd med appens kryptografi
// ---------------------------------------------------------------------------

type Publication = {
  status: string
  format: string
  election: { id: string; name: string; phase: string; bankIdEnvironment?: string }
  group: { p: string; q: string; g: string }
  trustees: { count: number; threshold: number; publicShares: Array<{ trusteeIndex: number; publicShare: string }> }
  encryptionPublicKey: string
  envelopeRoot: string
  urnRoot: string
  markedAsVotedTotal: number
  ballots: Array<{
    ballotId: string
    label: string
    kind: string
    rows: number
    markedAsVoted: number
    options: Array<{ optionIndex: number; label: string; c1: string; c2: string; count: number }>
    contributions: Array<{
      trusteeIndex: number
      partials: Array<{
        optionIndex: number
        value: string
        proof: { format: number; a: string; b: string; challenge: string; response: string }
      }>
    }>
  }>
  notCheckable: string[]
}

const ELECTION_ID = '0b9d1c8e-8a43-4e0b-9a59-0f3c2d7b6a11'
const BALLOT_ID = '5e2f7a10-3c4d-4e8f-9b1a-2d3c4e5f6a7b'
const keys = generateKeyPair()
const shares = splitSecret(keys.privateKey, TRUSTEE_COUNT, TRUSTEE_THRESHOLD)

/**
 * Summan av en valsedels röster, ett chiffer per alternativ. `votes` är
 * röstetalen. Ett negativt tal krypteras som g^(q − |m|), alltså som den
 * förfalskning 14b:s granskning visade, med +1000 och −999.
 */
function sumsFor(votes: readonly bigint[]): Ciphertext[] {
  return votes.map((count) => {
    const exponent = ((count % Q) + Q) % Q
    // Två chiffer multiplicerade, så att summan inte är ett enda chiffer.
    const half = encrypt(keys.publicKey, 0n, randomScalar())
    return multiply(half, encrypt(keys.publicKey, exponent, randomScalar()))
  })
}

function contributionFrom(share: Share, sums: readonly Ciphertext[], electionId = ELECTION_ID, ballotId = BALLOT_ID) {
  return {
    trusteeIndex: share.index,
    partials: sums.map((sum, optionIndex) => {
      const partial = partiallyDecrypt(share, sum, { electionId, ballotId, optionIndex })
      return {
        optionIndex,
        value: partial.value.toString(),
        proof: serialisePartialDecryptionProof(partial.proof),
      }
    }),
  }
}

function publicationFor(
  votes: readonly bigint[],
  options: { counts?: number[]; rows?: number; trustees?: Share[]; sums?: Ciphertext[] } = {},
): Publication {
  const sums = options.sums ?? sumsFor(votes)
  const counts = options.counts ?? votes.map((count) => Number(count))
  const rows = options.rows ?? counts.reduce((total, count) => total + count, 0)
  const trustees = options.trustees ?? [shares[0]!, shares[2]!]
  return {
    status: 'published',
    format: 'valsystem/publicering/v1',
    election: { id: ELECTION_ID, name: 'Verktygstestet', phase: 'TALLIED', bankIdEnvironment: 'none' },
    group: { p: P.toString(), q: Q.toString(), g: G.toString() },
    trustees: {
      count: TRUSTEE_COUNT,
      threshold: TRUSTEE_THRESHOLD,
      publicShares: shares.map((share) => ({ trusteeIndex: share.index, publicShare: publicShare(share).toString() })),
    },
    encryptionPublicKey: keys.publicKey.toString(),
    envelopeRoot: 'a'.repeat(64),
    urnRoot: 'b'.repeat(64),
    markedAsVotedTotal: rows,
    ballots: [
      {
        ballotId: BALLOT_ID,
        label: 'Riksdagen',
        kind: 'RIKSDAG',
        rows,
        markedAsVoted: rows,
        options: sums.map((sum, optionIndex) => ({
          optionIndex,
          label: ['Blankt', 'Parti A', 'Parti B'][optionIndex] ?? `Alternativ ${optionIndex}`,
          c1: sum.c1.toString(),
          c2: sum.c2.toString(),
          count: counts[optionIndex]!,
        })),
        contributions: trustees.map((share) => contributionFrom(share, sums)),
      },
    ],
    notCheckable: [],
  }
}

/** En djup kopia, så att varje test ändrar sin egen. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Kör verktyget som en egen process mot en fil, som en granskare gör. */
function runTool(publication: unknown, ...extra: string[]): { status: number | null; output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'verify-election-'))
  const file = join(directory, 'publicering.json')
  writeFileSync(file, JSON.stringify(publication))
  const result = spawnSync(process.execPath, [TOOL, file, ...extra], { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** Raderna som verktyget underkände. */
function failed(result: { lines: string[] }): string[] {
  return result.lines.filter((line) => line.trimStart().startsWith('FEL'))
}

// En ärlig publicering: tre väljare, två på parti A och en på parti B.
const honest = publicationFor([0n, 2n, 1n])

// ---------------------------------------------------------------------------
// Oberoendet
// ---------------------------------------------------------------------------

describe('verktyget är oberoende av appen', () => {
  const source = readFileSync(TOOL, 'utf8')

  it('importerar bara inbyggda moduler i Node, och ingenting ur src', () => {
    // Bevisvärdet ligger i oberoendet. Delar verktyget kod med appen bevisar det
    // bara att appen är konsekvent med sig själv.
    const imports = [...source.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1])
    const dynamic = [...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
    const required = [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1])

    expect(imports.length).toBeGreaterThan(0)
    for (const specifier of [...imports, ...dynamic, ...required]) {
      expect(specifier, `verktyget importerar ${specifier}`).toMatch(/^node:/)
    }
    expect(source).not.toMatch(/['"](?:@\/|\.\.?\/|src\/)/)
  })

  it('räknar potenser i OpenSSL med samma svar som i BigInt, också i kantfallen (fixrunda 1)', () => {
    const cases: Array<[bigint, bigint]> = [
      [0n, 5n],
      [1n, 5n],
      [2n, 0n],
      [2n, 1n],
      [P - 1n, 2n],
      [P - 1n, 3n],
      [4n, Q],
      [4n, Q - 1n],
      [P + 7n, 3n],
    ]
    for (let round = 0; round < 8; round += 1) cases.push([randomScalar() % P, randomScalar()])
    for (const [base, exponent] of cases) {
      expect(tool.modPow(base, exponent, P), `${base} ^ ${exponent}`).toBe(tool.bigintModPow(base, exponent, P))
      expect(tool.modPow(base, exponent, P)).toBe(modPow(((base % P) + P) % P, exponent, P))
    }
    expect(() => tool.modPow(2n, -1n, P)).toThrow()
  })

  it('har gruppen ur RFC 3526 på egen hand, och den är appens', () => {
    expect(tool.P).toBe(P)
    expect(tool.Q).toBe(Q)
    expect(tool.G).toBe(4n)
  })

  it('kodar transkriptet som appen, byte för byte, för samma tal som transcript.test.ts prövar', () => {
    // Testvektorn i tests/unit/crypto/transcript.test.ts: slumpade tal i [0, p),
    // id:n med tecken utanför ASCII och index upp mot U32.
    for (let round = 0; round < 20; round += 1) {
      const binding = {
        electionId: round % 2 === 0 ? `val-${round}` : `val-å-${round}`,
        ballotId: `valsedel-${round}`,
        optionIndex: round * 3,
        trusteeIndex: 1 + (round % 3),
      }
      const values = Array.from({ length: 6 }, () => randomScalar() % P) as [bigint, bigint, bigint, bigint, bigint, bigint]
      const theirs = Buffer.from(partialDecryptionTranscript(binding, values))
      expect(Buffer.from(tool.partialDecryptionTranscript(binding, values)).equals(theirs)).toBe(true)
      expect(tool.partialDecryptionChallenge(binding, values)).toBe(partialDecryptionChallenge(binding, values))
    }
  })

  it('räknar samma utmaning som en riktig partiell dekryptering bär', () => {
    const sum = sumsFor([2n])[0]!
    const share = shares[1]!
    const binding = { electionId: ELECTION_ID, ballotId: BALLOT_ID, optionIndex: 4 }
    const partial = partiallyDecrypt(share, sum, binding)

    expect(
      tool.partialDecryptionChallenge({ ...binding, trusteeIndex: share.index }, [
        publicShare(share),
        sum.c1,
        sum.c2,
        partial.value,
        partial.proof.a,
        partial.proof.b,
      ]),
    ).toBe(partial.proof.challenge)
  })
})

// ---------------------------------------------------------------------------
// En ärlig publicering
// ---------------------------------------------------------------------------

describe('en ärlig publicering', () => {
  it('godkänns, och utskriften säger vad verktyget inte kan kontrollera', () => {
    const result = runTool(honest)

    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('dekrypteringen stämmer')
    // Urnroten och kuvertroten går inte att räkna om utan de enskilda chiffren.
    expect(result.output).toMatch(/kan inte räknas om/i)
    expect(result.output).toMatch(/att summan består av exakt de giltiga rösterna/i)
    // Härdningen, punkt 3: miljön publiceras, och verktyget visar den.
    expect(result.output).toMatch(/BankID-miljö: ingen riktig BankID/)
    expect(result.output).not.toMatch(/Publiceringen bär inte miljön/)
    // Miljön är det omröstningen skapades med. Underskrifterna går inte att pröva efteråt.
    expect(result.output).toMatch(/Att BankID-miljön som publiceringen anger är den som underskrifterna kom från/)
  })

  it('visar BankID:s testmiljö och säger att det inte är ett riktigt val', () => {
    const test = copy(honest)
    test.election.bankIdEnvironment = 'test'
    const result = tool.verifyPublication(test)

    expect(failed(result)).toEqual([])
    expect(result.lines.join('\n')).toMatch(/BankID:s testmiljö/)
    expect(result.lines.join('\n')).toMatch(/inte ett riktigt val/)
  })

  it('visar produktionen', () => {
    const production = copy(honest)
    production.election.bankIdEnvironment = 'production'
    const result = tool.verifyPublication(production)

    expect(failed(result)).toEqual([])
    expect(result.lines.join('\n')).toMatch(/BankID:s produktionsmiljö/)
  })

  it('underkänner en publicering utan BankID-miljö, eller med en okänd', () => {
    const missing = copy(honest)
    delete missing.election.bankIdEnvironment
    expect(failed(tool.verifyPublication(missing)).join('\n')).toMatch(/BankID-miljön/)

    const unknown = copy(honest)
    unknown.election.bankIdEnvironment = 'staging'
    expect(failed(tool.verifyPublication(unknown)).join('\n')).toMatch(/BankID-miljön/)
  })

  it('godkänns också med alla tre förtroendepersonernas bidrag', () => {
    expect(failed(tool.verifyPublication(publicationFor([1n, 1n, 1n], { trustees: shares })))).toEqual([])
  })

  it('godkänns för en valsedel utan röster, där summan är (1, 1)', () => {
    const none = publicationFor([0n, 0n, 0n], { sums: [0, 1, 2].map(() => ({ c1: 1n, c2: 1n })) })
    expect(failed(tool.verifyPublication(none))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Varje kontroll fälls för sig
// ---------------------------------------------------------------------------

describe('verktyget underkänner', () => {
  it('ett bevis där en enda byte ändrats', () => {
    const forged = copy(honest)
    const proof = forged.ballots[0]!.contributions[0]!.partials[1]!.proof
    // Sista siffran i svaret, en byte i JSON-texten. Talet är fortfarande
    // kanoniskt och under q, så det är bevisets ekvationer som fäller det.
    const last = proof.response.at(-1)!
    proof.response = proof.response.slice(0, -1) + (last === '9' ? '8' : String(Number(last) + 1))

    const result = runTool(forged)
    expect(result.status).toBe(1)
    expect(result.output).toMatch(/FEL.*förtroendeperson 1.*alternativ 1/)
    expect(result.output).not.toContain('dekrypteringen stämmer')
  })

  it('ett partiellt värde som bytts ut', () => {
    const forged = copy(honest)
    const partial = forged.ballots[0]!.contributions[1]!.partials[2]!
    partial.value = modPow(BigInt(partial.value), 2n, P).toString()

    expect(failed(tool.verifyPublication(forged)).join('\n')).toMatch(/förtroendeperson 3.*alternativ 2/)
  })

  it('ett resultat som inte är dekrypteringen av summan, också när summan av talen stämmer', () => {
    // Två räkneverk som bytt plats: summan är densamma, bara dekrypteringen visar det.
    const forged = copy(honest)
    forged.ballots[0]!.options[1]!.count = 1
    forged.ballots[0]!.options[2]!.count = 2

    const lines = failed(tool.verifyPublication(forged)).join('\n')
    expect(lines).toMatch(/alternativ 1/)
    expect(lines).toMatch(/alternativ 2/)
  })

  it('räkneverk som inte summerar till antalet rader i urnan', () => {
    const forged = copy(honest)
    forged.ballots[0]!.rows = 4
    forged.ballots[0]!.markedAsVoted = 4
    forged.markedAsVotedTotal = 4

    expect(failed(tool.verifyPublication(forged)).join('\n')).toMatch(/summerar/)
  })

  it('en summa av markeringarna som inte stämmer med antalet röster', () => {
    const forged = copy(honest)
    forged.markedAsVotedTotal = 4
    expect(failed(tool.verifyPublication(forged)).join('\n')).toMatch(/markeringarna/)

    const markers = copy(honest)
    markers.ballots[0]!.markedAsVoted = 2
    expect(failed(tool.verifyPublication(markers)).join('\n')).toMatch(/markeringar/)
  })

  it('en kuvertrot eller urnrot som saknas', () => {
    const forged = copy(honest) as Partial<Publication>
    delete forged.urnRoot
    expect(failed(tool.verifyPublication(forged)).join('\n')).toMatch(/urnrot/i)

    const envelope = copy(honest)
    envelope.envelopeRoot = 'A'.repeat(64)
    expect(failed(tool.verifyPublication(envelope)).join('\n')).toMatch(/kuvertrot/i)
  })

  it('färre bidrag än tröskeln, och två bidrag från samma förtroendeperson', () => {
    const one = publicationFor([0n, 2n, 1n], { trustees: [shares[0]!] })
    expect(failed(tool.verifyPublication(one)).join('\n')).toMatch(/2 förtroendepersoner/)

    const twice = copy(honest)
    twice.ballots[0]!.contributions[1] = copy(twice.ballots[0]!.contributions[0]!)
    expect(failed(tool.verifyPublication(twice)).join('\n')).toMatch(/två gånger/)
  })

  it('en förtroendeperson utanför de tre', () => {
    const forged = copy(honest)
    forged.ballots[0]!.contributions[1]!.trusteeIndex = 4
    expect(failed(tool.verifyPublication(forged)).join('\n')).toMatch(/förtroendeperson 4/)
  })
})

describe('verktyget tolkar varje tal lika strikt som appen', () => {
  it('underkänner 14b:s förfalskning med +1000 och −999, skriven som ett negativt tal', () => {
    // Summan krypterar 1000 på ett parti och −999 på ett annat, och bidragen är
    // ärliga dekrypteringar av den. Räkneverken summerar till en röst, så bara
    // tolkningen av talen fäller den.
    const forged = publicationFor([0n, 1000n, -999n], { counts: [0, 1000, -999], rows: 1 })
    const lines = failed(tool.verifyPublication(forged)).join('\n')
    expect(lines).toMatch(/alternativ 2/)
    expect(runTool(forged).status).toBe(1)
  })

  it('underkänner samma förfalskning med −999 skrivet som q − 999', () => {
    // Som tal är q − 999 rätt dekryptering, eftersom g har ordning q. Det
    // ryms inte i ett räkneverk, och det får inget alternativ ha fler röster än
    // urnan har rader.
    const forged = publicationFor([0n, 1000n, -999n], { counts: [0, 1000, Number(Q - 999n)], rows: 1 })
    expect(failed(tool.verifyPublication(forged)).join('\n')).toMatch(/alternativ 2/)
  })

  it('underkänner ett svar eller en utmaning som förlängts med q', () => {
    // Samma ekvationer håller för response + q. Bara intervallet fäller det.
    const response = copy(honest)
    const proof = response.ballots[0]!.contributions[0]!.partials[0]!.proof
    proof.response = (BigInt(proof.response) + Q).toString()
    expect(failed(tool.verifyPublication(response)).join('\n')).toMatch(/förtroendeperson 1.*alternativ 0/)

    const challenge = copy(honest)
    const other = challenge.ballots[0]!.contributions[0]!.partials[0]!.proof
    other.challenge = (BigInt(other.challenge) + Q).toString()
    expect(failed(tool.verifyPublication(challenge)).join('\n')).toMatch(/förtroendeperson 1.*alternativ 0/)
  })

  it('underkänner tal som inte är kanoniska decimaltal', () => {
    for (const write of [
      (value: string) => `0${value}`,
      (value: string) => `+${value}`,
      (value: string) => ` ${value}`,
      (value: string) => `0x${BigInt(value).toString(16)}`,
      (value: string) => `${value}.0`,
      (value: string) => `-${value}`,
    ]) {
      const forged = copy(honest)
      const option = forged.ballots[0]!.options[1]!
      option.c1 = write(option.c1)
      expect(failed(tool.verifyPublication(forged)).length, `c1 skrivet som ${option.c1.slice(0, 8)}…`).toBeGreaterThan(0)
    }

    const long = copy(honest)
    long.ballots[0]!.contributions[0]!.partials[0]!.value = '1'.repeat(618)
    expect(failed(tool.verifyPublication(long)).length).toBeGreaterThan(0)
  })

  it('underkänner ett partiellt värde utanför undergruppen, p − v', () => {
    // Beviset binder värdet bara upp till tecknet: med jämn utmaning håller det
    // också för p − v. Undergruppskontrollen fäller det.
    let found: Publication | null = null
    for (let attempt = 0; attempt < 40 && !found; attempt += 1) {
      const candidate = publicationFor([0n, 2n, 1n])
      const partial = candidate.ballots[0]!.contributions[0]!.partials[1]!
      if (BigInt(partial.proof.challenge) % 2n === 0n) {
        partial.value = (P - BigInt(partial.value)).toString()
        found = candidate
      }
    }
    expect(found, 'ingen jämn utmaning på 40 försök').not.toBeNull()
    expect(failed(tool.verifyPublication(found)).join('\n')).toMatch(/förtroendeperson 1.*alternativ 1/)
  })

  it('underkänner en publik andel eller en summa utanför undergruppen', () => {
    const share = copy(honest)
    share.trustees.publicShares[0]!.publicShare = (P - 1n).toString()
    expect(failed(tool.verifyPublication(share)).join('\n')).toMatch(/förtroendeperson 1/)

    const sum = copy(honest)
    sum.ballots[0]!.options[0]!.c1 = (P - 1n).toString()
    expect(failed(tool.verifyPublication(sum)).join('\n')).toMatch(/alternativ 0/)
  })

  it('underkänner en publicering i en annan grupp', () => {
    const forged = copy(honest)
    forged.group.g = '2'
    expect(failed(tool.verifyPublication(forged)).join('\n')).toMatch(/grupp/i)
  })

  it('underkänner ett bevis utan formatet 2', () => {
    const forged = copy(honest)
    forged.ballots[0]!.contributions[0]!.partials[0]!.proof.format = 1
    expect(failed(tool.verifyPublication(forged)).join('\n')).toMatch(/förtroendeperson 1.*alternativ 0/)
  })

  it('underkänner ett svar som inte är en publicering, och säger varför', () => {
    const result = runTool({ status: 'result_mismatch', message: 'Resultatet stämmer inte.' })
    expect(result.status).toBe(1)
    expect(result.output).toContain('Resultatet stämmer inte.')
  })
})

/**
 * VARJE DEL AV BEVISET FÄLLS FÖR SIG (mutationsprovet i uppgift 13).
 *
 * Ett bevis med en ändrad byte fäller flera av ekvationerna på en gång, så en
 * verifierare som saknade en av dem hade ändå underkänt det. Här byggs bevis
 * som bara en enda del av prövningen kan fälla: utmaningen räknas om ur rätt
 * transkript, och talen väljs så att de andra ekvationerna håller.
 */
describe('varje del av prövningen behövs', () => {
  const share = shares[0]!
  const option = 1

  /**
   * Ett bidrag för alternativ 1 i en ärlig publicering, räknat med exponenten
   * `valueExponent` för värdet och `responseExponent` i svaret, och med
   * utmaningen ur transkriptet med den publika andelen. Med båda lika med
   * andelen är det ett ärligt bevis.
   */
  function forge(valueExponent: bigint, responseExponent: bigint, transform: (v: bigint) => bigint = (v) => v) {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const publication = copy(honest)
      const ballot = publication.ballots[0]!
      const sum = { c1: BigInt(ballot.options[option]!.c1), c2: BigInt(ballot.options[option]!.c2) }
      const w = randomScalar()
      const a = modPow(G, w, P)
      const b = modPow(sum.c1, w, P)
      const value = transform(modPow(sum.c1, valueExponent, P))
      const challenge = partialDecryptionChallenge(
        { electionId: ELECTION_ID, ballotId: BALLOT_ID, optionIndex: option, trusteeIndex: share.index },
        [publicShare(share), sum.c1, sum.c2, value, a, b],
      )
      // p − v håller i C1-ekvationen bara med jämn utmaning.
      if (transform(1n) !== 1n && challenge % 2n !== 0n) continue
      const response = (w + challenge * responseExponent) % Q
      ballot.contributions[0]!.partials[option] = {
        optionIndex: option,
        value: value.toString(),
        proof: { format: 2, a: a.toString(), b: b.toString(), challenge: challenge.toString(), response: response.toString() },
      }
      return publication
    }
    throw new Error('Ingen jämn utmaning på 64 försök.')
  }

  const partialLine = (publication: Publication) =>
    failed(tool.verifyPublication(publication)).filter((line) => line.includes('förtroendeperson 1:s bidrag för alternativ 1'))

  it('ett ärligt bevis byggt på samma sätt godkänns, som kontrast', () => {
    expect(partialLine(forge(share.value, share.value))).toEqual([])
  })

  it('utmaningen: ett ärligt bevis för en annan valsedel', () => {
    // Ekvationerna håller, eftersom beviset är äkta. Bara utmaningen binder det
    // till valsedeln, så bara den fäller det.
    const publication = copy(honest)
    const ballot = publication.ballots[0]!
    const sum = { c1: BigInt(ballot.options[option]!.c1), c2: BigInt(ballot.options[option]!.c2) }
    const elsewhere = partiallyDecrypt(share, sum, { electionId: ELECTION_ID, ballotId: 'en-annan-valsedel', optionIndex: option })
    ballot.contributions[0]!.partials[option] = {
      optionIndex: option,
      value: elsewhere.value.toString(),
      proof: serialisePartialDecryptionProof(elsewhere.proof),
    }
    expect(partialLine(publication).join('\n')).toMatch(/utmaningen är inte den som transkriptet ger/)
  })

  it('g^svar = a · Y^utmaning: ett värde och ett svar räknade med en annan andel än den publika', () => {
    const other = randomScalar()
    expect(partialLine(forge(other, other)).join('\n')).toMatch(/g\^svar är inte a · Y\^utmaning/)
  })

  it('C1^svar = b · v^utmaning: ett annat värde, med svaret räknat med den rätta andelen', () => {
    expect(partialLine(forge(randomScalar(), share.value)).join('\n')).toMatch(/C1\^svar är inte b · v\^utmaning/)
  })

  it('undergruppen: p − v, med ett bevis som håller i båda ekvationerna', () => {
    const publication = forge(share.value, share.value, (v) => P - v)
    expect(partialLine(publication).join('\n')).toMatch(/värdet ligger inte i undergruppen/)
  })

  it('valets nyckel: andelarna kombineras inte till den publicerade nyckeln', () => {
    const publication = copy(honest)
    publication.encryptionPublicKey = modPow(G, randomScalar(), P).toString()
    expect(failed(tool.verifyPublication(publication)).join('\n')).toMatch(/hör inte till valets publika nyckel/)
  })

  it('undergruppen för en publik andel och en summa, med skälet utskrivet', () => {
    const shareOutside = copy(honest)
    shareOutside.trustees.publicShares[0]!.publicShare = (P - 1n).toString()
    expect(failed(tool.verifyPublication(shareOutside)).join('\n')).toMatch(
      /Förtroendeperson 1:s publika andel — .*undergruppen/,
    )

    const sumOutside = copy(honest)
    sumOutside.ballots[0]!.options[0]!.c1 = (P - 1n).toString()
    expect(failed(tool.verifyPublication(sumOutside)).join('\n')).toMatch(/summan för alternativ 0 — c1 är varken 1/)
  })

  it('kanoniska tal: en inledande nolla, ett plustecken och ett blanksteg i ett kort tal', () => {
    // De flesta tal har 616 eller 617 siffror, och då fäller längden en
    // inledande nolla redan. Summan av inga röster är (1, 1), och där prövas
    // tolkningen för sig.
    for (const written of ['01', '+1', ' 1', '1 ', '1.0']) {
      const none = publicationFor([0n, 0n, 0n], { sums: [0, 1, 2].map(() => ({ c1: 1n, c2: 1n })) })
      none.ballots[0]!.options[0]!.c1 = written
      expect(failed(tool.verifyPublication(none)).join('\n'), JSON.stringify(written)).toMatch(
        /summan för alternativ 0 — c1 är inte ett kanoniskt skrivet decimaltal/,
      )
    }
  })
})

/**
 * FIXRUNDA 1 AV UPPGIFT 13.
 *
 * Granskningens förfalskning 07f, samma valsedel publicerad två gånger med
 * antalet dubblat, godkändes: inget resultat per valsedel ändrades, men antalet
 * röster blåstes upp förbi kontrollen av antalen (Viktigt 3). Slutsatsen skrevs
 * dessutom ut också när något annat underkändes (Mindre 1), och verktyget
 * jämförde inte omröstningens id med det som efterfrågades (Mindre 4).
 */
describe('fixrunda 1', () => {
  /** Granskningens fil, med fältet för antalet döpt om som publiceringen nu gör. */
  function forgery07f(): Publication {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'tests/unit/fixtures/publication-07f-ballot-twice.json'), 'utf8'))
    raw.markedAsVotedTotal = raw.envelopeCount
    delete raw.envelopeCount
    return raw as Publication
  }

  it('underkänner granskningens 07f: samma valsedel två gånger, med antalet dubblat', () => {
    const publication = forgery07f()
    expect(publication.ballots.map((ballot) => ballot.ballotId)).toEqual([BALLOT_ID, BALLOT_ID])

    const result = runTool(publication)
    expect(result.status, result.output).toBe(1)
    expect(result.output).toMatch(/FEL.*valsedeln 5e2f7a10-3c4d-4e8f-9b1a-2d3c4e5f6a7b står två gånger/)
    expect(result.output).not.toContain('ALLT SOM VERKTYGET KAN KONTROLLERA STÄMMER')
    expect(result.output).not.toContain('dekrypteringen stämmer')
  })

  it('underkänner samma dubblett byggd här, och bara den', () => {
    const publication = copy(honest)
    publication.ballots.push(copy(publication.ballots[0]!))
    publication.markedAsVotedTotal *= 2
    expect(failed(tool.verifyPublication(publication))).toEqual([expect.stringMatching(/valsedeln .* står två gånger/)])
  })

  it('säger att det inte vet vilka valsedlar omröstningen har', () => {
    expect(tool.verifyPublication(honest).lines.join('\n')).toMatch(/vilka valsedlar omröstningen har/i)
  })

  it('skriver slutsatsen bara när ingenting har underkänts', () => {
    // Granskningens 09: en annan nyckel. Varje bevis och varje kombination
    // håller, men andelarna hör inte till nyckeln.
    const key = copy(honest)
    key.encryptionPublicKey = modPow(G, randomScalar(), P).toString()
    const keyResult = tool.verifyPublication(key)
    expect(keyResult.ok).toBe(false)
    expect(keyResult.lines.join('\n')).not.toContain('dekrypteringen stämmer')

    // Granskningens 09b: en rot som inte har formen av en.
    const root = copy(honest)
    root.urnRoot = 'inte en rot'
    expect(tool.verifyPublication(root).lines.join('\n')).not.toContain('dekrypteringen stämmer')

    expect(tool.verifyPublication(honest).lines.join('\n')).toContain('dekrypteringen stämmer')
  })

  it('underkänner en publicering för en annan omröstning än den som efterfrågades', () => {
    const other = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a'
    expect(failed(tool.verifyPublication(honest, { electionId: other })).join('\n')).toMatch(
      /gäller omröstningen 0b9d1c8e-8a43-4e0b-9a59-0f3c2d7b6a11, men 9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a efterfrågades/,
    )
    expect(failed(tool.verifyPublication(honest, { electionId: ELECTION_ID }))).toEqual([])

    // Som program: omröstningens id som andra argument, för en fil.
    expect(runTool(honest, other).status).toBe(1)
    expect(runTool(honest, ELECTION_ID).status).toBe(0)
  })

  it('läser omröstningens id ur adressen, när underlaget är en adress', () => {
    expect(tool.expectedElectionIdFrom('https://val.example/api/observer/results?electionId=abc-123')).toBe('abc-123')
    expect(tool.expectedElectionIdFrom('publicering.json')).toBeUndefined()
  })
})

describe('verktyget som program', () => {
  it('kräver ett argument och säger hur det används', () => {
    const result = spawnSync(process.execPath, [TOOL], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(`${result.stdout}${result.stderr}`).toMatch(/Använd/)
  })

  it('läser en fil och lämnar 0 när allt stämmer', () => {
    const directory = mkdtempSync(join(tmpdir(), 'verify-election-'))
    const file = join(directory, 'publicering.json')
    writeFileSync(file, JSON.stringify(honest))
    expect(() => execFileSync(process.execPath, [TOOL, file], { encoding: 'utf8' })).not.toThrow()
  })
})
