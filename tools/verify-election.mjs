#!/usr/bin/env node
/**
 * OBEROENDE VERIFIERING AV ETT VAL
 *
 * Det här skriptet är avsiktligt fristående. Det importerar ingenting från
 * src/ — inte Merkle-implementationen, inte signaturverifieringen, ingenting.
 * Allt räknas fram på nytt ur det som observatörs-API:t lämnar ut.
 *
 * Det är hela poängen. Ett verifieringsverktyg som återanvänder systemets egen
 * kod bevisar bara att koden är konsekvent med sig själv. Skulle
 * Merkle-konstruktionen vara felimplementerad skulle båda räkna fel på samma
 * sätt, och felet aldrig synas.
 *
 * Använd:
 *   node tools/verify-election.mjs [bas-URL] [omröstningens namn]
 *
 * Kräver ingen inloggning och ingen behörighet. Det är meningen.
 */

import { createHash, createPublicKey, constants, publicDecrypt } from 'node:crypto'

const BASE = process.argv[2] ?? 'http://localhost:3000'
const NAME = process.argv[3] ?? 'Valet 2026'

const ORIGIN = new URL(BASE).origin

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path} svarade ${response.status}`)
  return response.json()
}

// --- Merkleträd, egen implementation --------------------------------------

const LEAF = Buffer.from([0x00])
const NODE = Buffer.from([0x01])
const ROOT = Buffer.from([0x02])

const sha256 = (...parts) => {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest()
}

function merkleRoot(leaves) {
  const count = Buffer.alloc(8)
  count.writeBigUInt64BE(BigInt(leaves.length))

  if (leaves.length === 0) return sha256(ROOT, count, sha256(LEAF)).toString('hex')

  let level = [...leaves].sort().map((hex) => Buffer.from(hex, 'hex'))

  while (level.length > 1) {
    const next = []
    for (let i = 0; i < level.length; i += 2) {
      const right = level[i + 1]
      next.push(right ? sha256(NODE, level[i], right) : level[i])
    }
    level = next
  }

  return sha256(ROOT, count, level[0]).toString('hex')
}

// --- RSA-signaturverifiering, egen implementation --------------------------

function mgf1(seed, length) {
  const blocks = []
  let counter = 0
  while (Buffer.concat(blocks).length < length) {
    const c = Buffer.alloc(4)
    c.writeUInt32BE(counter, 0)
    blocks.push(sha256(seed, c))
    counter += 1
  }
  return Buffer.concat(blocks).subarray(0, length)
}

function toBigInt(buffer) {
  let value = 0n
  for (const byte of buffer) value = (value << 8n) | BigInt(byte)
  return value
}

function verifySignature(message, signatureHex, publicKeyPem) {
  const jwk = createPublicKey(publicKeyPem).export({ format: 'jwk' })
  const modulus = Buffer.from(jwk.n, 'base64url')
  const n = toBigInt(modulus)

  const expanded = mgf1(sha256(Buffer.from(message, 'utf8')), modulus.length - 1)
  const expected = toBigInt(expanded) % n

  const signature = toBigInt(Buffer.from(signatureHex, 'hex'))
  if (signature <= 0n || signature >= n) return false

  // s^e mod n via Nodes RSA — samma operation, annan väg än systemets egen.
  const recovered = toBigInt(
    publicDecrypt(
      { key: createPublicKey(publicKeyPem), padding: constants.RSA_NO_PADDING },
      Buffer.from(signatureHex, 'hex'),
    ),
  )

  return recovered === expected
}

// --- Verifieringen ---------------------------------------------------------

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  OK  ' : '  FEL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const list = await post('/api/observer/election', {})
const summary = list.elections.find((election) => election.name === NAME)
if (!summary) throw new Error(`Hittade ingen omröstning som heter "${NAME}"`)

const data = await post('/api/observer/election', { electionId: summary.id })

console.log(`\nOmröstning: ${data.election.name}`)
console.log(`Stänger: ${data.election.closesAt}`)
console.log(`Valsedlar: ${data.ballots.length}\n`)

// Hämta hela underlaget, sidvis.
const votes = []
let offset = 0
for (;;) {
  const page = await post('/api/observer/votes', {
    electionId: summary.id,
    offset,
    pageSize: 500,
  })
  votes.push(...page.votes)
  offset += page.votes.length
  if (offset >= page.total || page.votes.length === 0) break
}

console.log(`Hämtade ${votes.length} röster.\n`)

const keyByBallot = new Map(data.ballots.map((ballot) => [ballot.id, ballot.signingPublicKeyPem]))

// 1. Varje röst bär ett äkta röstintyg.
const invalid = votes.filter(
  (vote) => !verifySignature(vote.credentialId, vote.credentialSignature, keyByBallot.get(vote.ballotId)),
)
check(
  'Varje röst bär ett röstintyg signerat av valsedelns nyckel',
  invalid.length === 0,
  invalid.length ? `${invalid.length} ogiltiga` : `${votes.length} verifierade`,
)

// 2. Inget intyg använt mer än en gång.
const unique = new Set(votes.map((vote) => vote.credentialId))
check('Inget röstintyg förekommer mer än en gång', unique.size === votes.length)

// 3. Den kanoniska formen stämmer med fälten.
const canonicalMismatch = votes.filter((vote) => {
  const rebuilt = [
    vote.tokenHash,
    vote.credentialId,
    vote.credentialSignature,
    vote.ballotId,
    vote.ballotPartyId ?? '-',
    vote.candidateId ?? '-',
    vote.optionId ?? '-',
  ].join('|')
  return rebuilt !== vote.canonical
})
check(
  'Den kanoniska formen stämmer med rösternas fält',
  canonicalMismatch.length === 0,
  canonicalMismatch.length ? `${canonicalMismatch.length} avviker` : 'byggd om från fälten',
)

// 4. Merkleroten, omräknad från grunden.
const leaves = votes.map((vote) => sha256(LEAF, Buffer.from(vote.canonical, 'utf8')).toString('hex'))
const recomputed = merkleRoot(leaves)
check(
  'Merkleroten stämmer med systemets',
  recomputed === data.currentRoot.root,
  `${recomputed.slice(0, 16)}…`,
)

// 5. Åtagandekedjan.
let previousHash = null
let chainOk = data.commitments.length > 0
for (const [index, commitment] of data.commitments.entries()) {
  const expected = sha256(
    NODE,
    Buffer.from(
      [commitment.sequence, commitment.root, commitment.voteCount, previousHash ?? 'GENESIS'].join('|'),
      'utf8',
    ),
  ).toString('hex')

  if (
    commitment.sequence !== index + 1 ||
    commitment.previousHash !== previousHash ||
    expected !== commitment.entryHash
  ) {
    chainOk = false
    break
  }
  previousHash = commitment.entryHash
}
check('Åtagandekedjan är obruten', chainOk, `${data.commitments.length} åtaganden`)

// 6. Det senaste åtagandet stämmer med underlaget.
const latest = data.commitments.at(-1)
check(
  'Senaste åtagandet stämmer med det hämtade underlaget',
  latest !== undefined && latest.root === recomputed && latest.voteCount === votes.length,
  latest ? `#${latest.sequence}` : 'inget åtagande',
)

// 7. Egen rösträkning mot systemets redovisade resultat.
let tallyOk = true
for (const ballot of data.results) {
  const own = new Map()
  for (const vote of votes.filter((vote) => vote.ballotId === ballot.ballotId)) {
    const key = vote.ballotPartyId ?? vote.optionId ?? 'okänt'
    own.set(key, (own.get(key) ?? 0) + 1)
  }

  const ownTotal = [...own.values()].reduce((sum, count) => sum + count, 0)
  const reportedTotal = ballot.rows.reduce((sum, row) => sum + row.votes, 0)

  if (ownTotal !== ballot.totalVotes || reportedTotal !== ballot.totalVotes) tallyOk = false
}
check('Egen rösträkning ger samma totaler som systemet redovisar', tallyOk)

// 8. Godkända röstningar mot registrerade röster.
let approvalOk = true
for (const row of data.approvedVotings) {
  const recorded = votes.filter((vote) => vote.ballotId === row.ballotId).length
  if (row.issued !== recorded) approvalOk = false
}
check('Antal godkända röstningar motsvarar antal registrerade röster', approvalOk)

// 9. Inget i underlaget pekar mot en person.
const serialised = JSON.stringify(votes)
const leaky = ['personalNumber', 'externalIdentityHash', 'voterStatusId', 'createdAt', 'votedAt']
  .filter((field) => serialised.includes(field))
check('Underlaget innehåller inget som pekar mot en person', leaky.length === 0, leaky.join(', '))

console.log(`\n${failures === 0 ? 'ALLT VERIFIERAT' : `${failures} KONTROLL(ER) FALLERADE`}\n`)
process.exit(failures === 0 ? 0 : 1)
