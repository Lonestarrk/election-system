import { randomBytes } from 'node:crypto'
import { encodeCrockfordBase32 } from '../src/lib/base32'
import { hmacSha256Hex, sha256Hex } from '../src/lib/crypto'
import { PrismaClient as VotersClient } from '.prisma/voters'
import { PrismaClient as VotesClient } from '.prisma/votes'

/**
 * Demodata.
 *
 * Skriptet är idempotent och kan köras om utan att skapa dubbletter — det körs
 * vid varje uppstart av containern.
 *
 * Krypto- och kodningsfunktionerna importeras relativt från src/lib. De
 * filerna har inga egna beroenden till Next.js sökvägsalias, vilket gör att
 * tsx kan köra det här skriptet utan applikationens modulupplösning. Att
 * använda samma implementation som applikationen är viktigt: en seedad
 * identitetshash som räknats fram på ett annat sätt skulle inte matcha när
 * väljaren sedan legitimerar sig.
 */

const votersDb = new VotersClient()
const votesDb = new VotesClient()

function hashPersonalNumber(personalNumber: string, pepper: string): string {
  return hmacSha256Hex(personalNumber.replace(/\D/g, ''), pepper)
}

function generateTokenHash(): string {
  // Klartexten används aldrig och returneras inte: den seedade rösten hör inte
  // till någon riktig väljare, och ingen ska kunna verifiera den.
  return sha256Hex(encodeCrockfordBase32(randomBytes(30)))
}

/** Riksdagens åtta partier. */
const PARTIES = [
  { name: 'Socialdemokraterna', abbreviation: 'S', color: '#E8112D', displayOrder: 1 },
  { name: 'Moderaterna', abbreviation: 'M', color: '#52BDEC', displayOrder: 2 },
  { name: 'Sverigedemokraterna', abbreviation: 'SD', color: '#DDDD00', displayOrder: 3 },
  { name: 'Centerpartiet', abbreviation: 'C', color: '#009933', displayOrder: 4 },
  { name: 'Vänsterpartiet', abbreviation: 'V', color: '#DA291C', displayOrder: 5 },
  { name: 'Kristdemokraterna', abbreviation: 'KD', color: '#000077', displayOrder: 6 },
  { name: 'Liberalerna', abbreviation: 'L', color: '#006AB3', displayOrder: 7 },
  { name: 'Miljöpartiet', abbreviation: 'MP', color: '#83CF39', displayOrder: 8 },
]

/**
 * Demoväljare. Personnumren är påhittade och följer bara formatet.
 *
 * Täcker de fyra fall som behöver kunna demonstreras: röstberättigad, ej
 * röstberättigad, redan röstad, och (genom frånvaro) någon som inte finns i
 * röstlängden alls.
 */
const VOTERS = [
  { personalNumber: '199001011234', isEligible: true, hasVoted: false, note: 'röstberättigad' },
  { personalNumber: '198505152345', isEligible: true, hasVoted: false, note: 'röstberättigad' },
  { personalNumber: '197012123456', isEligible: true, hasVoted: false, note: 'röstberättigad' },
  { personalNumber: '196003015678', isEligible: true, hasVoted: false, note: 'röstberättigad' },
  { personalNumber: '195507076789', isEligible: true, hasVoted: false, note: 'röstberättigad' },
  { personalNumber: '199912317890', isEligible: true, hasVoted: false, note: 'röstberättigad' },
  { personalNumber: '201001014567', isEligible: false, hasVoted: false, note: 'ej röstberättigad' },
  { personalNumber: '194204048901', isEligible: true, hasVoted: true, note: 'har redan röstat' },
]

async function main() {
  const pepper = process.env.IDENTITY_PEPPER
  if (!pepper || pepper.length < 32) {
    throw new Error('IDENTITY_PEPPER saknas eller är för kort (minst 32 tecken).')
  }

  // --- Partier -------------------------------------------------------------
  for (const party of PARTIES) {
    await votesDb.party.upsert({
      where: { name: party.name },
      update: { color: party.color, displayOrder: party.displayOrder },
      create: party,
    })
  }

  // --- Röstlängd -----------------------------------------------------------
  for (const voter of VOTERS) {
    const externalIdentityHash = hashPersonalNumber(voter.personalNumber, pepper)

    await votersDb.voterStatus.upsert({
      where: { externalIdentityHash },
      update: {},
      create: {
        externalIdentityHash,
        isEligible: voter.isEligible,
        hasVoted: voter.hasVoted,
        votedAt: voter.hasVoted ? new Date(Date.UTC(2026, 8, 1)) : null,
      },
    })
  }

  // --- En motsvarande anonym röst för den seedade väljare som "redan röstat"
  //
  // Utan den skulle adminvyns integritetskontroll (antal markerade väljare
  // minus antal registrerade röster) visa en avvikelse redan vid start, och
  // dölja en verklig avvikelse om en sådan uppstod senare.
  //
  // Lägg märke till att rösten INTE skapas utifrån väljaren. Den skapas
  // fristående, med slumpad token och slumpat parti. Det finns ingen kod här
  // som kopplar ihop dem, och inget sätt att i efterhand se att de hör ihop.
  const alreadyVotedCount = VOTERS.filter((voter) => voter.hasVoted).length
  const existingVotes = await votesDb.anonymousVote.count()

  if (existingVotes < alreadyVotedCount) {
    const parties = await votesDb.party.findMany({ select: { id: true } })

    for (let index = existingVotes; index < alreadyVotedCount; index += 1) {
      const party = parties[randomBytes(1)[0]! % parties.length]!
      await votesDb.anonymousVote.create({
        data: {
          tokenHash: generateTokenHash(),
          partyId: party.id,
          createdAt: new Date(Date.UTC(2026, 8, 1, 9)),
        },
      })
    }
  }

  const eligible = VOTERS.filter((voter) => voter.isEligible).length
  console.log(`Seedat: ${PARTIES.length} partier, ${VOTERS.length} personer (${eligible} röstberättigade).`)
}

main()
  .then(async () => {
    await votersDb.$disconnect()
    await votesDb.$disconnect()
  })
  .catch(async (error) => {
    console.error('Seed misslyckades:', error)
    await votersDb.$disconnect()
    await votesDb.$disconnect()
    process.exit(1)
  })
