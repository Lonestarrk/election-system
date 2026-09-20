import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { votersDb } from '@/modules/eligibility/db'
import { votesDb } from '@/modules/anonymous-vote/db'
import { evaluateEligibility } from '@/modules/eligibility/voter-status.service'
import { issueCredential } from '@/modules/eligibility/credential.service'
import { castAnonymousVote, verifyToken } from '@/modules/anonymous-vote'
import { hashToken } from '@/modules/anonymous-vote/token.service'
import { createBlindedCredential, unblindSignature } from '@/lib/blind-client'
import {
  createTestElection,
  createVoter,
  disconnect,
  isDatabaseAvailable,
  resetElectionData,
  voteOnce,
  type TestElection,
} from './helpers'

const databaseAvailable = await isDatabaseAvailable()

if (!databaseAvailable) {
  process.stderr.write('\n  Ingen databas tillgänglig — integrationstesterna hoppas över.\n')
}

afterAll(async () => {
  if (databaseAvailable) await disconnect()
})

describe.skipIf(!databaseAvailable)('röstningsflödet mot riktig databas', () => {
  let election: TestElection

  beforeEach(async () => {
    await resetElectionData()
    election = await createTestElection()
  })

  /** Testpunkt 2: en röstberättigad väljare kan rösta. */
  it('en röstberättigad väljare kan rösta och får en token', async () => {
    const voterId = await createVoter('199001011234')

    const outcome = await voteOnce(voterId, election)

    expect(outcome.status).toBe('voted')
    if (outcome.status !== 'voted') return

    expect(outcome.token).toMatch(/^[0-9A-Z-]+$/)
    expect(await votesDb.anonymousVote.count()).toBe(1)
    expect(await votersDb.voterBallotStatus.count({ where: { voterStatusId: voterId } })).toBe(1)
  })

  /** Testpunkt 3: samma väljare kan inte rösta två gånger. */
  it('samma väljare kan inte rösta två gånger på samma valsedel', async () => {
    const voterId = await createVoter('199001011234')

    expect((await voteOnce(voterId, election)).status).toBe('voted')

    const second = await voteOnce(voterId, election)

    expect(second.status).toBe('blocked')
    expect(await votesDb.anonymousVote.count()).toBe(1)
  })

  it('två samtidiga röstförsök från samma väljare ger bara en röst', async () => {
    /**
     * Spärren ligger i databasens unika index på (väljare, valsedel), inte i
     * koden. Två parallella begäranden kan båda passera en kontroll i
     * JavaScript, men bara en kan skapa raden.
     */
    const voterId = await createVoter('199001011234')

    const results = await Promise.all([
      voteOnce(voterId, election),
      voteOnce(voterId, election),
    ])

    const succeeded = results.filter((result) => result.status === 'voted')

    expect(succeeded).toHaveLength(1)
    expect(await votesDb.anonymousVote.count()).toBe(1)
  })

  it('ett redan inlöst röstintyg kan inte lösas in igen', async () => {
    /**
     * IDEMPOTENSEN SOM ERSATTE TRANSAKTIONEN ÖVER TVÅ DATABASER.
     *
     * Väljaren kan skicka om samma röst hur många gånger som helst — efter ett
     * nätavbrott, en omladdning, ett dubbelklick. Bara den första registreras.
     * Det är därför ordningen mellan röstlängdens och röstdatabasens
     * skrivningar inte längre kan ge vare sig dubbelröstning eller förlorad
     * röst.
     */
    const voterId = await createVoter('199001011234')

    const keys = await votersDb.electionBallot.findUniqueOrThrow({
      where: { id: election.ballotId },
      select: { signingPublicKeyPem: true },
    })

    const credential = await createBlindedCredential(keys.signingPublicKeyPem)

    const issued = await issueCredential(
      voterId,
      election.electionId,
      election.ballotId,
      credential.blinded,
    )
    if (issued.status !== 'issued') throw new Error('Intyget utfärdades inte')

    const signature = await unblindSignature(
      issued.blindSignature,
      credential.blindingFactor,
      keys.signingPublicKeyPem,
    )

    const vote = {
      ballotId: election.ballotId,
      ballotPartyId: election.ballotPartyId,
      credentialId: credential.credentialId,
      credentialSignature: signature,
    }

    expect((await castAnonymousVote(vote)).status).toBe('recorded')
    expect((await castAnonymousVote(vote)).status).toBe('credential_already_used')

    expect(await votesDb.anonymousVote.count()).toBe(1)
  })

  it('en röst utan giltigt röstintyg avvisas', async () => {
    /**
     * DETTA ÄR KRAVET "röster kan inte läggas till utanför den normala
     * processen", prövat.
     *
     * Försöket nedan har allt utom en äkta signatur: rätt valsedel, rätt
     * parti, ett välformat intyg. Utan myndighetens signatur går det ändå inte
     * igenom — och ingen kan skapa signaturen utan valsedelns privata nyckel.
     */
    const outcome = await castAnonymousVote({
      ballotId: election.ballotId,
      ballotPartyId: election.ballotPartyId,
      credentialId: 'f'.repeat(64),
      credentialSignature: 'a'.repeat(512),
    })

    expect(outcome.status).toBe('invalid_credential')
    expect(await votesDb.anonymousVote.count()).toBe(0)
  })

  it('ett röstintyg för en valsedel gäller inte på en annan', async () => {
    const other = await createTestElection('Annat testval')
    const voterId = await createVoter('199001011234')

    const keys = await votersDb.electionBallot.findUniqueOrThrow({
      where: { id: election.ballotId },
      select: { signingPublicKeyPem: true },
    })

    const credential = await createBlindedCredential(keys.signingPublicKeyPem)
    const issued = await issueCredential(
      voterId,
      election.electionId,
      election.ballotId,
      credential.blinded,
    )
    if (issued.status !== 'issued') throw new Error('Intyget utfärdades inte')

    const signature = await unblindSignature(
      issued.blindSignature,
      credential.blindingFactor,
      keys.signingPublicKeyPem,
    )

    // Samma intyg, men inlämnat på den andra omröstningens valsedel.
    const outcome = await castAnonymousVote({
      ballotId: other.ballotId,
      ballotPartyId: other.ballotPartyId,
      credentialId: credential.credentialId,
      credentialSignature: signature,
    })

    expect(outcome.status).toBe('invalid_credential')
  })

  it('en icke röstberättigad person avvisas', async () => {
    await createVoter('201001014567', { isEligible: false })

    const decision = await evaluateEligibility('201001014567', election.electionId)

    expect(decision.outcome).toBe('not_eligible')
  })

  it('en person som inte finns i röstlängden avvisas', async () => {
    const decision = await evaluateEligibility('190001011111', election.electionId)

    expect(decision.outcome).toBe('not_in_roll')
  })

  it('en person som redan röstat avvisas redan vid legitimeringen', async () => {
    const voterId = await createVoter('199001011234')
    await voteOnce(voterId, election)

    const decision = await evaluateEligibility('199001011234', election.electionId)

    expect(decision.outcome).toBe('already_voted')
  })

  it('ett ogiltigt val bränner inte väljarens rösträtt', async () => {
    /**
     * Väljaren får sitt intyg först, och kan lösa in det när valet är rätt.
     * Ett felformat val kostar alltså ingenting — till skillnad från den
     * tidigare konstruktionen, där markeringen skedde före röstregistreringen.
     */
    const voterId = await createVoter('199001011234')

    const keys = await votersDb.electionBallot.findUniqueOrThrow({
      where: { id: election.ballotId },
      select: { signingPublicKeyPem: true },
    })

    const credential = await createBlindedCredential(keys.signingPublicKeyPem)
    const issued = await issueCredential(
      voterId,
      election.electionId,
      election.ballotId,
      credential.blinded,
    )
    if (issued.status !== 'issued') throw new Error('Intyget utfärdades inte')

    const signature = await unblindSignature(
      issued.blindSignature,
      credential.blindingFactor,
      keys.signingPublicKeyPem,
    )

    // Först ett ogiltigt parti-id.
    const rejected = await castAnonymousVote({
      ballotId: election.ballotId,
      ballotPartyId: '00000000-0000-0000-0000-000000000000',
      credentialId: credential.credentialId,
      credentialSignature: signature,
    })
    expect(rejected.status).toBe('invalid_choice')

    // Intyget är oförbrukat och fungerar med ett giltigt val.
    const accepted = await castAnonymousVote({
      ballotId: election.ballotId,
      ballotPartyId: election.ballotPartyId,
      credentialId: credential.credentialId,
      credentialSignature: signature,
    })
    expect(accepted.status).toBe('recorded')
  })
})

describe.skipIf(!databaseAvailable)('väljarens egen verifiering', () => {
  let election: TestElection

  beforeEach(async () => {
    await resetElectionData()
    election = await createTestElection()
  })

  it('en token bekräftar rösten och visar valet', async () => {
    const voterId = await createVoter('199001011234')
    const outcome = await voteOnce(voterId, election)
    if (outcome.status !== 'voted') throw new Error('Röstningen misslyckades')

    const result = await verifyToken(outcome.token)

    expect(result.registered).toBe(true)
    if (!result.registered) return

    expect(result.ballot).toBe('Riksdagsvalet')
    expect(result.choice).toBe('Socialdemokraterna')
  })

  it('en okänd token ger inget svar om någon röst', async () => {
    const result = await verifyToken('ZZZZZZZZ-ZZZZZZZZ-ZZZZZZZZ')

    expect(result.registered).toBe(false)
  })

  it('svaret avslöjar ingenting om väljaren', async () => {
    const voterId = await createVoter('199001011234')
    const outcome = await voteOnce(voterId, election)
    if (outcome.status !== 'voted') throw new Error('Röstningen misslyckades')

    const result = await verifyToken(outcome.token)

    // Inga fält som kan peka tillbaka mot en person, och ingen tidsstämpel som
    // går att korrelera mot en legitimering.
    expect(Object.keys(result).sort()).toEqual([
      'ballot',
      'candidate',
      'choice',
      'election',
      'registered',
    ])
  })

  it('flera väljare får olika tokens', async () => {
    const first = await voteOnce(await createVoter('199001011234'), election)
    const second = await voteOnce(await createVoter('198505152345'), election)

    if (first.status !== 'voted' || second.status !== 'voted') {
      throw new Error('Röstningen misslyckades')
    }

    expect(first.token).not.toEqual(second.token)
  })
})

describe.skipIf(!databaseAvailable)('separationen mellan identitet och röst', () => {
  let election: TestElection

  beforeEach(async () => {
    await resetElectionData()
    election = await createTestElection()
  })

  it('ingen rad i någon databas kopplar väljaren till rösten', async () => {
    const voterId = await createVoter('199001011234')
    const outcome = await voteOnce(voterId, election)
    if (outcome.status !== 'voted') throw new Error('Röstningen misslyckades')

    const voter = await votersDb.voterStatus.findUniqueOrThrow({ where: { id: voterId } })
    const ballotStatus = await votersDb.voterBallotStatus.findFirstOrThrow({
      where: { voterStatusId: voterId },
    })
    const vote = await votesDb.anonymousVote.findFirstOrThrow()

    // Samtliga värden på väljarsidan, mot samtliga värden på röstsidan.
    const voterValues = new Set([
      voter.id,
      voter.externalIdentityHash,
      ballotStatus.id,
      ballotStatus.voterStatusId,
    ])

    const voteValues = [vote.id, vote.tokenHash, vote.credentialId, vote.credentialSignature]

    for (const value of voteValues) {
      expect(voterValues.has(value)).toBe(false)
    }
  })

  it('röstintyget finns inte någonstans i röstlängden', async () => {
    /**
     * Intyget är det enda som passerar båda sidorna — väljaren bar det över
     * gränsen. Men myndigheten såg det aldrig i klartext: den signerade ett
     * blindat värde. Ingenting i röstlängden ska därför kunna matchas mot
     * intyget i röstdatabasen.
     */
    const voterId = await createVoter('199001011234')
    await voteOnce(voterId, election)

    const vote = await votesDb.anonymousVote.findFirstOrThrow()

    const rows = await votersDb.$queryRawUnsafe<Array<{ found: bigint }>>(
      `SELECT count(*) AS found FROM voter_ballot_status
       WHERE id::text = $1 OR voter_status_id::text = $1`,
      vote.credentialId,
    )

    expect(Number(rows[0]?.found ?? 0)).toBe(0)
  })

  it('rösterna överlever att hela röstlängden raderas', async () => {
    const voterId = await createVoter('199001011234')
    await voteOnce(voterId, election)

    await votersDb.voterBallotStatus.deleteMany()
    await votersDb.voterStatus.deleteMany()

    expect(await votesDb.anonymousVote.count()).toBe(1)
  })

  it('tidsstämplarna är grovkorniga i båda databaserna', async () => {
    const voterId = await createVoter('199001011234')
    await voteOnce(voterId, election)

    const ballotStatus = await votersDb.voterBallotStatus.findFirstOrThrow()
    const vote = await votesDb.anonymousVote.findFirstOrThrow()

    // Dygn respektive timme. Med millisekundsupplösning skulle raderna gå att
    // para ihop på tid, och hela separationen vore verkningslös.
    expect(ballotStatus.votedAt.getUTCHours()).toBe(0)
    expect(ballotStatus.votedAt.getUTCMinutes()).toBe(0)
    expect(vote.createdAt.getUTCMinutes()).toBe(0)
    expect(vote.createdAt.getUTCSeconds()).toBe(0)
  })

  it('token-hashen finns i röstdatabasen och ingen annanstans', async () => {
    const voterId = await createVoter('199001011234')
    const outcome = await voteOnce(voterId, election)
    if (outcome.status !== 'voted') throw new Error('Röstningen misslyckades')

    const tokenHash = hashToken(outcome.token)

    expect(await votesDb.anonymousVote.count({ where: { tokenHash } })).toBe(1)

    const rows = await votersDb.$queryRawUnsafe<Array<{ found: bigint }>>(
      `SELECT count(*) AS found FROM voter_status WHERE external_identity_hash = $1`,
      tokenHash,
    )

    expect(Number(rows[0]?.found ?? 0)).toBe(0)
  })
})
