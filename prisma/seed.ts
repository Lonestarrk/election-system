import { hmacSha256Hex } from '../src/lib/crypto'
import { generateElectionKeyPair } from '../src/lib/blind-signature'
import { PrismaClient as VotersClient } from '.prisma/voters'
import { PrismaClient as VotesClient } from '.prisma/votes'

/**
 * Demodata.
 *
 * Skriptet är idempotent och kan köras om utan att skapa dubbletter — det körs
 * vid varje uppstart av containern.
 *
 * Krypto- och nyckelfunktionerna importeras relativt från src/lib. De filerna
 * har inga egna beroenden till Next.js sökvägsalias, vilket gör att tsx kan
 * köra det här skriptet utan applikationens modulupplösning. Att använda samma
 * implementation som applikationen är viktigt: en seedad identitetshash som
 * räknats fram på ett annat sätt skulle inte matcha när väljaren sedan
 * legitimerar sig.
 *
 * VARFÖR INGA SEEDADE RÖSTER
 *
 * Tidigare seedades en anonym röst för den väljare som markerats som "har
 * redan röstat", så att integritetskontrollen inte skulle visa en avvikelse
 * direkt vid start. Det går inte längre: varje röst måste bära ett röstintyg
 * signerat av valsedelns privata nyckel, och ett seedat intyg vore ett intyg
 * som aldrig utfärdats genom den auktoriserade processen.
 *
 * Det är precis den egenskapen systemet ska ha. Att det blev omöjligt att
 * seeda en röst är inte ett problem med seed-skriptet — det är beviset på att
 * röster inte kan läggas till utanför den normala processen, och det gäller
 * även för oss som skriver koden.
 */

const votersDb = new VotersClient()
const votesDb = new VotesClient()

function hashPersonalNumber(personalNumber: string, pepper: string): string {
  return hmacSha256Hex(personalNumber.replace(/\D/g, ''), pepper)
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

const MUNICIPALITY = '0180'
const REGION = '01'

/**
 * Demoväljare. Personnumren är påhittade och följer bara formatet.
 *
 * Täcker fallen som behöver kunna demonstreras: röstberättigad, ej
 * röstberättigad, administratör, väljare i en annan kommun, och (genom
 * frånvaro) någon som inte finns i röstlängden alls.
 */
const VOTERS = [
  { personalNumber: '199001011234', note: 'röstberättigad' },
  { personalNumber: '198505152345', note: 'röstberättigad' },
  { personalNumber: '197012123456', note: 'röstberättigad' },
  { personalNumber: '196003015678', note: 'röstberättigad' },
  { personalNumber: '195507076789', note: 'röstberättigad' },
  { personalNumber: '199912317890', note: 'röstberättigad' },
  { personalNumber: '201001014567', isEligible: false, note: 'ej röstberättigad' },
  {
    personalNumber: '194204048901',
    municipalityCode: '1480',
    regionCode: '14',
    note: 'folkbokförd i annan kommun',
  },
  {
    personalNumber: '198001019876',
    isAdmin: true,
    note: 'ADMINISTRATÖR — legitimera dig med detta personnummer för adminvyn',
  },
]

/** Kandidater för personröst i riksdagsvalet. Påhittade namn. */
const CANDIDATES: Record<string, string[]> = {
  S: ['Anna Lindqvist', 'Erik Sandberg', 'Maria Öberg'],
  M: ['Johan Ekström', 'Sofia Bergman'],
  SD: ['Peter Nilsson', 'Karin Holm'],
  C: ['Lars Åkerlund', 'Emma Sjögren'],
  V: ['Nils Forsberg', 'Elsa Wikström'],
  KD: ['Gustav Hallberg', 'Ingrid Sundqvist'],
  L: ['Oskar Lindell', 'Frida Norén'],
  MP: ['Hanna Björk', 'Viktor Almgren'],
}

async function main() {
  const pepper = process.env.IDENTITY_PEPPER
  if (!pepper || pepper.length < 32) {
    throw new Error('IDENTITY_PEPPER saknas eller är för kort (minst 32 tecken).')
  }

  // --- Partiregistret ------------------------------------------------------
  //
  // Förskapat och gemensamt för alla omröstningar. Skrevs partinamnet fritt per
  // omröstning skulle stavningsvarianter bli separata partier i rösträkningen,
  // och felet upptäckas först när resultatet är fel.
  for (const party of PARTIES) {
    await votesDb.party.upsert({
      where: { name: party.name },
      update: { color: party.color, displayOrder: party.displayOrder },
      create: party,
    })
  }

  const parties = await votesDb.party.findMany({ orderBy: { displayOrder: 'asc' } })

  // --- Valet 2026 ----------------------------------------------------------
  const existing = await votesDb.election.findFirst({ where: { name: 'Valet 2026' } })

  if (!existing) {
    const ballotSpecs = [
      { kind: 'KOMMUN', label: 'Kommunfullmäktige, Stockholms kommun', areaCode: MUNICIPALITY },
      { kind: 'LANDSTING', label: 'Regionfullmäktige, Region Stockholm', areaCode: REGION },
      { kind: 'RIKSDAG', label: 'Riksdagen', areaCode: null },
    ]

    // Ett nyckelpar per valsedel. Bindningen mellan röstintyg och valsedel
    // kommer från vilken nyckel som signerade — myndigheten signerar blint och
    // ser aldrig vilken valsedel intyget gäller.
    const keyPairs = ballotSpecs.map(() => generateElectionKeyPair())

    const election = await votesDb.election.create({
      data: {
        name: 'Valet 2026',
        kind: 'RIKSDAGSVAL',
        opensAt: new Date(Date.UTC(2026, 8, 1)),
        closesAt: new Date(Date.UTC(2026, 8, 30)),
      },
    })

    const createdBallots: Array<{ id: string; kind: string; label: string; areaCode: string | null }> =
      []

    for (const [index, spec] of ballotSpecs.entries()) {
      const ballot = await votesDb.electionBallot.create({
        data: {
          electionId: election.id,
          kind: spec.kind,
          label: spec.label,
          areaCode: spec.areaCode,
          // Personröst bara i riksdagsvalet, för att hålla demodatan hanterlig.
          allowsCandidateVote: spec.kind === 'RIKSDAG',
          signingPublicKeyPem: keyPairs[index]!.publicKeyPem,
          displayOrder: index + 1,
        },
      })

      for (const [partyIndex, party] of parties.entries()) {
        const ballotParty = await votesDb.ballotParty.create({
          data: { ballotId: ballot.id, partyId: party.id, displayOrder: partyIndex + 1 },
        })

        if (spec.kind === 'RIKSDAG') {
          const names = CANDIDATES[party.abbreviation] ?? []
          for (const [candidateIndex, name] of names.entries()) {
            await votesDb.candidate.create({
              data: {
                ballotPartyId: ballotParty.id,
                name,
                displayOrder: candidateIndex + 1,
              },
            })
          }
        }
      }

      createdBallots.push({
        id: ballot.id,
        kind: ballot.kind,
        label: ballot.label,
        areaCode: ballot.areaCode,
      })
    }

    // Speglingen till röstlängden. Samma UUID, ingen foreign key emellan — en
    // sådan är fysiskt omöjlig mellan två PostgreSQL-databaser, och det är
    // hela poängen.
    await votersDb.election.create({
      data: {
        id: election.id,
        name: election.name,
        kind: election.kind,
        opensAt: election.opensAt,
        closesAt: election.closesAt,
      },
    })

    for (const [index, ballot] of createdBallots.entries()) {
      await votersDb.electionBallot.create({
        data: {
          id: ballot.id,
          electionId: election.id,
          kind: ballot.kind,
          label: ballot.label,
          areaCode: ballot.areaCode,
          signingPrivateKeyPem: keyPairs[index]!.privateKeyPem,
          signingPublicKeyPem: keyPairs[index]!.publicKeyPem,
          displayOrder: index + 1,
        },
      })
    }
  }

  // --- Röstlängd -----------------------------------------------------------
  for (const voter of VOTERS) {
    const externalIdentityHash = hashPersonalNumber(voter.personalNumber, pepper)

    /**
     * `update` MÅSTE sätta fälten, inte vara tomt.
     *
     * Ett tomt update gör skriptet idempotent i den svaga meningen "skapar
     * inga dubbletter" — men det rättar inte en rad som redan finns i ett
     * annat skick. Integrationstesterna lämnar kvar väljare utan
     * folkbokföringskod, och en omseedning som hoppar över dem ger en
     * demoväljare som inte kan rösta på kommunvalsedeln. Felet visar sig först
     * som "valsedeln gäller inte dig" mitt i en demonstration.
     *
     * Notera att identitetshashen är oförändrad — raden identifieras av den,
     * så det som skrivs är bara det deklarerade demotillståndet.
     */
    await votersDb.voterStatus.upsert({
      where: { externalIdentityHash },
      update: {
        isEligible: voter.isEligible ?? true,
        isAdmin: voter.isAdmin ?? false,
        municipalityCode: voter.municipalityCode ?? MUNICIPALITY,
        regionCode: voter.regionCode ?? REGION,
      },
      create: {
        externalIdentityHash,
        isEligible: voter.isEligible ?? true,
        isAdmin: voter.isAdmin ?? false,
        municipalityCode: voter.municipalityCode ?? MUNICIPALITY,
        regionCode: voter.regionCode ?? REGION,
      },
    })
  }

  const eligible = VOTERS.filter((voter) => voter.isEligible !== false).length
  const admin = VOTERS.find((voter) => voter.isAdmin)

  process.stdout.write(
    `Seedat: ${PARTIES.length} partier, ${VOTERS.length} personer (${eligible} röstberättigade).\n` +
      `Omröstning: Valet 2026 med tre valsedlar.\n` +
      `Administratör: ${admin?.personalNumber ?? '—'}\n`,
  )
}

main()
  .then(async () => {
    await votersDb.$disconnect()
    await votesDb.$disconnect()
  })
  .catch(async (error) => {
    process.stderr.write(`Seed misslyckades: ${String(error)}\n`)
    await votersDb.$disconnect()
    await votesDb.$disconnect()
    process.exit(1)
  })
