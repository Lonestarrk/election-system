import { createDiffieHellman, randomBytes } from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { canonicalOptions, type BallotOption, type BallotShape } from '../src/lib/crypto/ballot-encoding'
import { G, P, Q, bigintModPow, randomScalar, registerGroupExponentiation } from '../src/lib/crypto/group'
import { nativeModPow } from '../src/lib/crypto/native-exponentiation'
import { verifyEncryptedBallot, verifyEncryptedBallotInSteps } from '../src/lib/crypto/verify-ballot'
import { encryptBallot } from '../src/lib/encrypt-client'

/**
 * MÄTNINGAR AV KRYPTOTS HASTIGHET, FÖR SPEC 4.1 OCH UPPGIFT 14b.
 *
 *   npx tsx scripts/measure-crypto.ts                  exponentiering, kryptering och
 *                                                      verifiering i Node
 *   npx tsx scripts/measure-crypto.ts --chromium       dessutom krypteringen i Chromium,
 *                                                      och röstsidans bunt utan node:crypto
 *   npx tsx scripts/measure-crypto.ts --jamfor 5000    OpenSSL mot BigInt på 5000 slumpade
 *                                                      indata med full exponent
 *   npx tsx scripts/measure-crypto.ts --validering     valideringen före stängningen och
 *                                                      stängningen, 100 väljare med tre
 *                                                      valsedlar, mot testdatabaserna
 *
 * VARFÖR ETT SKRIPT OCH INTE ETT TEST
 *
 * Siffrorna beror på maskinen. Ett test med tidsgränser som målvärden blir
 * rött på en långsammare dator utan att något är fel, och grönt på en snabbare
 * dator när något är det. Testerna prövar därför ordning och svar, och det här
 * skriptet skriver ut tiderna. Spec 4.1 har siffrorna från en körning.
 *
 * --validering skriver i voters_test och votes_test, samma databaser som
 * integrationstesterna tömmer före varje test, och vägrar köra mot något annat.
 * Kör det inte samtidigt som vitest. Det tar några minuter och städar efter sig.
 *
 * --chromium buntar med esbuild och kör i Playwrights Chromium. Esbuild finns
 * bara som ett beroende till andra paket, så den delen kan sluta fungera om de
 * byter. Det är skälet till att browser-bundle.test.ts läser källtexten själv i
 * stället; här är en riktig bunt poängen.
 */

const RIKSDAG_SHAPE: BallotShape = {
  allowsCandidateVote: true,
  parties: Array.from({ length: 5 }, (_, party) => ({
    id: `parti-${party + 1}`,
    displayOrder: party + 1,
    candidates: Array.from({ length: 4 }, (_, candidate) => ({
      id: `kandidat-${party + 1}-${candidate + 1}`,
      displayOrder: candidate + 1,
    })),
  })),
}
const RIKSDAG_CHOICE: BallotOption = { kind: 'CANDIDATE', ballotPartyId: 'parti-3', candidateId: 'kandidat-3-2' }

const rows: Array<[string, string]> = []

function report(label: string, value: string): void {
  rows.push([label, value])
  console.log(`${label.padEnd(66)} ${value}`)
}

const ms = (value: number) => `${value.toFixed(value < 10 ? 2 : 0)} ms`

function timed(run: () => void, rounds = 1): number {
  const start = performance.now()
  for (let round = 0; round < rounds; round += 1) run()
  return (performance.now() - start) / rounds
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function randomBits(bits: number): bigint {
  const bytes = randomBytes(Math.ceil(bits / 8))
  return BigInt('0x' + bytes.toString('hex')) >> BigInt(bytes.length * 8 - bits)
}

function toBytes(value: bigint): Buffer {
  const hex = value.toString(16)
  return Buffer.from(hex.length % 2 === 0 ? hex : '0' + hex, 'hex')
}

/** Kör något med en viss exponentiering registrerad, och lämnar gruppen som den var. */
function withExponentiation<T>(pow: ((base: bigint, exponent: bigint) => bigint) | null, run: () => T): T {
  registerGroupExponentiation(pow)
  try {
    return run()
  } finally {
    registerGroupExponentiation(null)
  }
}

const onlyBigInt = (base: bigint, exponent: bigint) => bigintModPow(base, exponent, P)

/** Största fördröjningen i händelseslingan medan `run` pågår. */
async function eventLoopStall(run: () => Promise<unknown>): Promise<{ elapsed: number; stall: number }> {
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  histogram.enable()
  const start = performance.now()
  // Ett varv först, så att mätningen har en tidpunkt att räkna fördröjningen från.
  await new Promise((resolve) => setTimeout(resolve, 5))
  await run()
  const elapsed = performance.now() - start - 5
  await new Promise((resolve) => setTimeout(resolve, 5))
  histogram.disable()
  return { elapsed, stall: histogram.max / 1e6 }
}

async function measureNode(): Promise<void> {
  console.log(`\nNode ${process.version}, OpenSSL ${process.versions.openssl}\n`)

  const h = bigintModPow(G, randomScalar(), P)
  const exponents = Array.from({ length: 200 }, () => randomScalar())
  const bases = exponents.map((exponent) => bigintModPow(G, exponent % 100_000n, P))
  let index = 0
  const nextExponent = () => exponents[index++ % exponents.length]!
  const nextBase = () => bases[index % bases.length]!

  // --- En exponentiering med full exponent ----------------------------------
  report('modexp, BigInt, bas g', ms(timed(() => bigintModPow(G, nextExponent(), P), 8)))
  report('modexp, BigInt, bas h', ms(timed(() => bigintModPow(h, nextExponent(), P), 8)))
  report('modexp, BigInt, godtycklig bas', ms(timed(() => bigintModPow(nextBase(), nextExponent(), P), 8)))

  const created = timed(() => createDiffieHellman(toBytes(P), toBytes(G)))
  nativeModPow(G, 5n) // objektet i modulen skapas här, utanför mätningarna nedan
  report('modexp, OpenSSL, bas g', ms(timed(() => nativeModPow(G, nextExponent()), 200)))
  report('modexp, OpenSSL, bas h', ms(timed(() => nativeModPow(h, nextExponent()), 200)))
  report('modexp, OpenSSL, godtycklig bas', ms(timed(() => nativeModPow(nextBase(), nextExponent()), 200)))
  report('modexp, OpenSSL, 256-bitars exponent', ms(timed(() => nativeModPow(nextBase(), randomBits(256)), 200)))
  report('  y^q = 1, två anrop (vägen över e + 1)', ms(timed(() => nativeModPow(nextBase(), Q), 100)))

  // Konstant tid för en hemlig exponent: två exponenter med lika många bitar,
  // den ena med två ettor och den andra med bara ettor. Kvadrera och
  // multiplicera gör en multiplikation per etta, OpenSSL:s DH gör lika mycket
  // arbete för båda.
  const sparse = (1n << 2046n) + 1n
  const dense = (1n << 2047n) - 1n
  report('  BigInt, exponent med två ettor', ms(timed(() => bigintModPow(nextBase(), sparse, P), 8)))
  report('  BigInt, exponent med 2047 ettor', ms(timed(() => bigintModPow(nextBase(), dense, P), 8)))
  report('  OpenSSL, exponent med två ettor', ms(timed(() => nativeModPow(nextBase(), sparse), 200)))
  report('  OpenSSL, exponent med 2047 ettor', ms(timed(() => nativeModPow(nextBase(), dense), 200)))

  report('DH-objekt med g = 4: att skapa ett', ms(created))
  report(
    '  ett nytt objekt per anrop, g = 4',
    ms(
      timed(() => {
        const dh = createDiffieHellman(toBytes(P), toBytes(G))
        dh.setPrivateKey(toBytes(nextExponent()))
        dh.computeSecret(toBytes(nextBase()))
      }, 5),
    ),
  )
  const named = createDiffieHellman(toBytes(P), toBytes(2n))
  report(
    '  återanvänt objekt, g = 2 (namngiven grupp, prövar basen)',
    ms(
      timed(() => {
        named.setPrivateKey(toBytes(nextExponent()))
        named.computeSecret(toBytes(nextBase()))
      }, 200),
    ),
  )

  // --- Antal exponentieringar per valsedel ------------------------------------
  const options = canonicalOptions(RIKSDAG_SHAPE)
  let counted = 0
  const counting = (base: bigint, exponent: bigint) => {
    counted += 1
    return nativeModPow(base, exponent)
  }
  const ballot = withExponentiation(counting, () =>
    encryptBallot(h.toString(), 'val-mätning', 'valsedel-mätning', options, RIKSDAG_CHOICE),
  )
  const encryptionCount = counted
  counted = 0
  const verdict = withExponentiation(counting, () =>
    verifyEncryptedBallot(h.toString(), 'val-mätning', 'valsedel-mätning', options.length, ballot),
  )
  if (!verdict) throw new Error('Valsedeln som mätningen krypterade underkändes.')
  report(`exponentieringar, kryptering av ${options.length} alternativ`, `${encryptionCount} st`)
  report(`exponentieringar, verifiering av ${options.length} alternativ`, `${counted} st`)

  // --- Kryptering ---------------------------------------------------------------
  const encrypt = () =>
    encryptBallot(h.toString(), 'val-mätning', 'valsedel-mätning', options, RIKSDAG_CHOICE)
  report('kryptering 26 alternativ, Node, bara BigInt', ms(withExponentiation(onlyBigInt, () => timed(encrypt))))
  report('kryptering 26 alternativ, Node, med tabeller för g och h', ms(timed(encrypt)))
  report(
    'kryptering 26 alternativ, Node, OpenSSL',
    ms(withExponentiation(nativeModPow, () => median([0, 1, 2].map(() => timed(encrypt))))),
  )

  // --- Verifiering --------------------------------------------------------------
  const verify = () =>
    verifyEncryptedBallot(h.toString(), 'val-mätning', 'valsedel-mätning', options.length, ballot)

  registerGroupExponentiation(onlyBigInt)
  const slow = await eventLoopStall(async () => verify())
  report('verifiering 26 alternativ, bara BigInt, i ett svep', ms(slow.elapsed))
  report('  händelseslingan stod still', ms(slow.stall))

  registerGroupExponentiation(nativeModPow)
  const sweep = await eventLoopStall(async () => verify())
  report('verifiering 26 alternativ, OpenSSL, i ett svep', ms(sweep.elapsed))
  report('  händelseslingan stod still', ms(sweep.stall))

  const pauseForIo = () => new Promise<void>((resolve) => setImmediate(resolve))
  const steps = await eventLoopStall(() =>
    verifyEncryptedBallotInSteps(
      h.toString(),
      'val-mätning',
      'valsedel-mätning',
      options.length,
      ballot,
      pauseForIo,
    ),
  )
  report('verifiering 26 alternativ, OpenSSL, i steg (serverns väg)', ms(steps.elapsed))
  report('  längsta steget utan att släppa fram något', ms(steps.stall))

  const concurrent = await eventLoopStall(async () => {
    const { verifyEncryptedBallotOnServer } = await import('../src/lib/crypto/server')
    await Promise.all(
      Array.from({ length: 10 }, () =>
        verifyEncryptedBallotOnServer(h.toString(), 'val-mätning', 'valsedel-mätning', options.length, ballot),
      ),
    )
  })
  report('tio samtidiga verifieringar genom kön, totalt', ms(concurrent.elapsed))
  report('  längsta fördröjning i händelseslingan', ms(concurrent.stall))
  registerGroupExponentiation(null)
}

async function compareWithBigInt(count: number): Promise<void> {
  console.log(`\nOpenSSL mot BigInt, ${count} slumpade indata med full exponent\n`)
  const pool = Array.from({ length: 32 }, () => bigintModPow(G, randomBits(256), P))
  const start = performance.now()
  let mismatches = 0

  for (let round = 0; round < count; round += 1) {
    const inside = (pool[round % 32]! * pool[(round * 7) % 32]!) % P
    const base = round % 3 === 0 ? inside : round % 3 === 1 ? P - inside : randomBits(2048) % P
    const exponent = round % 25 === 0 ? Q * BigInt(1 + (round % 4)) : randomBits(2047) % Q
    if (nativeModPow(base, exponent) !== bigintModPow(base, exponent, P)) mismatches += 1
    if ((round + 1) % 1000 === 0) console.log(`  ${round + 1} jämförda, ${mismatches} olika`)
  }

  report(`jämförda indata`, `${count} st`)
  report(`olika svar`, `${mismatches} st`)
  report(`tid`, `${((performance.now() - start) / 1000).toFixed(0)} s`)
  if (mismatches > 0) process.exitCode = 1
}

async function measureChromium(): Promise<void> {
  const { build } = await import('esbuild')
  const { chromium } = await import('@playwright/test')

  // Röstsidan som den buntas för webbläsaren. Plattformen är webbläsaren, så en
  // node:-import hade stoppat bygget. Texten prövas ändå, för säkerhets skull.
  const page = await build({
    entryPoints: ['src/app/vote/page.tsx'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    target: 'es2022',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const bundle = page.outputFiles[0]!.text
  console.log('\nRöstsidans bunt (esbuild, plattform webbläsare)\n')
  report('storlek', `${(bundle.length / 1024).toFixed(0)} kB`)
  report('nämner node:crypto', /node:crypto/.test(bundle) ? 'JA' : 'nej')
  report('drar in OpenSSL-vägen', /createDiffieHellman|native-exponentiation/.test(bundle) ? 'JA' : 'nej')

  const measurements = await build({
    entryPoints: ['scripts/measure-crypto.browser.ts'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    logLevel: 'silent',
  })

  const browser = await chromium.launch()
  try {
    console.log(`\nChromium ${browser.version()}\n`)
    const tab = await browser.newPage()
    await tab.goto('about:blank')
    await tab.addScriptTag({ content: measurements.outputFiles[0]!.text })
    const result = await tab.evaluate(
      () =>
        (globalThis as unknown as { measureCrypto: () => Promise<Array<{ label: string; value: number; unit: string }>> })
          .measureCrypto(),
    )
    for (const row of result) {
      report(row.label, row.unit === 'ms' ? ms(row.value) : `${row.value.toFixed(row.unit === 'MB' ? 2 : 0)} ${row.unit}`)
    }
  } finally {
    await browser.close()
  }
}

/**
 * Valideringen före stängningen och stängningen, med riktiga väljare, riktiga
 * signaturer och riktiga databaser: voters_test och votes_test.
 *
 * Varje väljare har demovalets tre valsedlar (prisma/seed.ts): kommun och
 * region med blank röst och åtta partier, och riksdagen med 26 alternativ.
 */
async function measureValidation(voterCount: number): Promise<void> {
  const { isTestDatabaseName, loadDotEnvFile, redirectToTestDatabases } = await import(
    '../tests/test-databases'
  )

  // Samma ordning som tests/setup.ts: miljön först, sedan omdirigeringen, och
  // först därefter en databasklient.
  loadDotEnvFile()
  redirectToTestDatabases()
  process.env.IDENTITY_PEPPER ??= 'test-pepper-minst-trettiotva-tecken-langt-0000'
  process.env.APP_ORIGIN ??= 'http://localhost:3000'
  process.env.MOCK_BANKID_POLLS_UNTIL_COMPLETE = '0'

  const { votersDb } = await import('../src/modules/eligibility/db')
  const { votesDb } = await import('../src/modules/ballot-box/db')

  for (const [label, client] of [
    ['röstlängden', votersDb],
    ['röstdatabasen', votesDb],
  ] as const) {
    const [row] = await (client as typeof votersDb).$queryRaw<Array<{ name: string }>>`
      SELECT current_database()::text AS name`
    if (!row || !isTestDatabaseName(row.name)) {
      throw new Error(`Mätningen vägrar köra: ${label} är ansluten till "${row?.name}", inte en testdatabas.`)
    }
  }

  const { createElection } = await import('../src/orchestration/create-election.usecase')
  const { validateBeforeClose } = await import('../src/orchestration/validate-before-close.usecase')
  const { closeElection } = await import('../src/orchestration/close-election.usecase')
  const { getEncryptedBallotShape } = await import('../src/modules/ballot-box')
  const { hashPersonalNumber } = await import('../src/modules/eligibility/identity')
  const { MockBankIdService, selectDemoIdentity } = await import(
    '../src/modules/eligibility/bankid/MockBankIdService'
  )
  const { envelopePayload } = await import('../src/modules/eligibility/bankid/envelope-signature')
  const { castEncryptedBallot } = await import('../src/modules/eligibility/pending-vote.service')

  const tag = `m14b-${Date.now()}`
  const candidateCounts = [3, 2, 2, 2, 2, 2, 2, 2]
  const parties = []
  for (const [index] of candidateCounts.entries()) {
    parties.push(
      await votesDb.party.create({
        data: {
          name: `Mätpartiet ${index + 1} ${tag}`,
          abbreviation: `${tag}-${index + 1}`,
          color: '#777777',
          displayOrder: 900 + index,
        },
      }),
    )
  }

  let electionId: string | null = null
  const voterIds: string[] = []

  try {
    const outcome = await createElection({
      name: `Mätning ${tag}`,
      kind: 'RIKSDAGSVAL',
      opensAt: new Date(Date.now() - 60_000),
      closesAt: new Date(Date.now() + 3_600_000),
      ballots: [
        {
          kind: 'KOMMUN',
          label: 'Kommunfullmäktige',
          areaCode: '0180',
          parties: parties.map((party) => ({ partyId: party.id })),
        },
        {
          kind: 'LANDSTING',
          label: 'Regionfullmäktige',
          areaCode: '01',
          parties: parties.map((party) => ({ partyId: party.id })),
        },
        {
          kind: 'RIKSDAG',
          label: 'Riksdagen',
          allowsCandidateVote: true,
          parties: parties.map((party, index) => ({
            partyId: party.id,
            candidates: Array.from({ length: candidateCounts[index]! }, (_, c) => `Kandidat ${index + 1}.${c + 1}`),
          })),
        },
      ],
      trusteePassphrases: ['matning-ett', 'matning-tva', 'matning-tre'],
    })
    if (outcome.status !== 'created') throw new Error('Kunde inte skapa mätvalet.')
    electionId = outcome.election.id

    const { encryptionPublicKey } = await votesDb.election.findUniqueOrThrow({
      where: { id: electionId },
      select: { encryptionPublicKey: true },
    })
    const ballots = []
    for (const { id } of outcome.election.ballotIds) {
      const row = await votesDb.electionBallot.findUniqueOrThrow({
        where: { id },
        include: { parties: { include: { candidates: true } } },
      })
      const shape: BallotShape = {
        allowsCandidateVote: row.allowsCandidateVote,
        parties: row.parties.map((party) => ({
          id: party.id,
          displayOrder: party.displayOrder,
          candidates: party.candidates.map((candidate) => ({
            id: candidate.id,
            displayOrder: candidate.displayOrder,
          })),
        })),
      }
      ballots.push({ id, options: canonicalOptions(shape), wireShape: await getEncryptedBallotShape(id) })
    }

    console.log(
      `\nValideringen före stängningen: ${voterCount} väljare, valsedlar med ` +
        `${ballots.map((ballot) => ballot.options.length).join(', ')} alternativ\n`,
    )

    // Serverns väg, som server.ts kopplar in när den importeras. Mätningarna
    // ovan kopplade ur den igen, och modulen importeras bara en gång per
    // process. Klientens kryptering räknas då också i OpenSSL, för att hinna;
    // det som mäts är castEncryptedBallot, validateBeforeClose och closeElection.
    registerGroupExponentiation(nativeModPow)

    const bankId = new MockBankIdService()
    const castStart = performance.now()

    for (let voter = 0; voter < voterCount; voter += 1) {
      const personalNumber = `19800101${String(voter).padStart(4, '0')}`
      const created = await votersDb.voterStatus.create({
        data: {
          externalIdentityHash: await hashPersonalNumber(personalNumber),
          isEligible: true,
          municipalityCode: '0180',
          regionCode: '01',
        },
        select: { id: true },
      })
      voterIds.push(created.id)

      for (const ballot of ballots) {
        const choice = ballot.options[1 + (voter % (ballot.options.length - 1))]!
        const sealed = encryptBallot(encryptionPublicKey!, electionId, ballot.id, ballot.options, choice)
        const order = await bankId.sign({
          endUserIp: '127.0.0.1',
          userVisibleData: 'Bekräfta din röst',
          userNonVisibleData: envelopePayload({
            electionId,
            ballotId: ballot.id,
            ciphertextHash: sealed.ciphertextHash,
            castSequence: 1,
          }),
        })
        selectDemoIdentity(order.orderRef, personalNumber)
        const collected = await bankId.collect(order.orderRef)
        if (collected.status !== 'complete') throw new Error('Signeringen blev inte klar.')

        const cast = await castEncryptedBallot(
          created.id,
          electionId,
          ballot.id,
          sealed,
          {
            signature: collected.completionData.signature,
            certificateChain: collected.completionData.certificateChain,
            signedData: collected.completionData.signedData,
          },
          ballot.wireShape,
        )
        if (cast.status !== 'recorded') throw new Error(`Rösten lades inte (${cast.status}).`)
      }
      if ((voter + 1) % 20 === 0) console.log(`  ${voter + 1} väljare har röstat`)
    }
    report(
      `att lägga ${voterCount * ballots.length} röster (kryptering, signering, verifiering)`,
      `${((performance.now() - castStart) / 1000).toFixed(1)} s`,
    )

    const validation = await eventLoopStall(async () => {
      const result = await validateBeforeClose(electionId!)
      if (!result.summary.passed) throw new Error('Valideringen hittade avvikelser i mätvalet.')
    })
    report(
      `validateBeforeClose, ${voterCount} väljare, ${voterCount * ballots.length} röster`,
      `${(validation.elapsed / 1000).toFixed(1)} s`,
    )
    report('  per väljare med tre valsedlar', ms(validation.elapsed / voterCount))
    report('  längsta fördröjning i händelseslingan', ms(validation.stall))

    const past = new Date(Date.now() - 1000)
    await votesDb.election.update({ where: { id: electionId }, data: { closesAt: past } })
    await votersDb.election.update({ where: { id: electionId }, data: { closesAt: past } })

    const closing = await eventLoopStall(async () => {
      const result = await closeElection(electionId!)
      if (result.status !== 'closed') throw new Error(`Stängningen blev ${result.status}.`)
    })
    report(
      `closeElection (validering, omverifiering, flytt), ${voterCount} väljare`,
      `${(closing.elapsed / 1000).toFixed(1)} s`,
    )
    report('  per väljare med tre valsedlar', ms(closing.elapsed / voterCount))
    report('  längsta fördröjning i händelseslingan', ms(closing.stall))
  } finally {
    // Städningen i den ordning raderna beror på varandra.
    if (electionId) {
      const ballotIds = (
        await votersDb.electionBallot.findMany({ where: { electionId }, select: { id: true } })
      ).map((ballot) => ballot.id)
      await votersDb.pendingVote.deleteMany({ where: { ballotId: { in: ballotIds } } })
      await votersDb.election.deleteMany({ where: { id: electionId } })
      await votesDb.election.deleteMany({ where: { id: electionId } })
    }
    await votersDb.voterStatus.deleteMany({ where: { id: { in: voterIds } } })
    await votesDb.party.deleteMany({ where: { id: { in: parties.map((party) => party.id) } } })
    await votersDb.$disconnect()
    await votesDb.$disconnect()
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  await measureNode()
  if (args.includes('--chromium')) await measureChromium()

  const compare = args.indexOf('--jamfor')
  if (compare !== -1) await compareWithBigInt(Number(args[compare + 1] ?? 2000))

  if (args.includes('--validering')) await measureValidation(100)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
