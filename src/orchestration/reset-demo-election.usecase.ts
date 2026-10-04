import { DEMO_ELECTION_NAME, demoElectionWindow } from '@/lib/demo-election'
import { votesDb } from '@/modules/ballot-box/db'
import { AUDIT_EVENTS, recordAuditEvent } from '@/modules/eligibility/audit.service'
import { votersDb } from '@/modules/eligibility/db'
import { withClosingLock } from './close-election.usecase'
import { forgetFinalCheck } from './final-check-job'

/**
 * Återställer demovalet till OPEN (uppgift 12c, punkt 7b).
 *
 * VARFÖR DEN FINNS. Sedan 11d lämnar en stängning som stoppas av valideringen
 * omröstningen i CLOSED, och ingenting i appen går tillbaka till OPEN. Ett
 * misslyckat försök stoppar alltså demon för gott, också i Azure. I skarpt läge
 * ska det vara så: en läggning som stängts ska inte kunna öppnas igen av någon
 * knapp. I demon är det ett hinder.
 *
 * RUTTEN, SOM ANROPAR DEN HÄR FUNKTIONEN, LIGGER UNDER /api/demo och FINNS BARA I
 * DEMOLÄGET. Funktionen själv frågar inte efter läget, eftersom den frågan hör
 * till rutten och vaktas av tests/security/api-surface.test.ts. Den vägrar
 * däremot varje omröstning utom demovalet, på namn: den som kan nå rutten kan
 * alltså inte tömma en omröstning som någon skapat.
 *
 * VAD SOM TÖMS, FÖR HELA OMRÖSTNINGENS VALSEDLAR
 *   – i röstdatabasen: urnan, förtroendepersonernas bidrag och räkneverken.
 *     Statusen blir OPEN, och fastställandets och räkningens tidpunkter tas bort.
 *   – i röstlängden: de liggande kuverten, markeringarna "har röstat", och i
 *     omröstningens rad fasen (OPEN), kuvertroten, urnroten och tidpunkten för
 *     raderingen av kopplingen.
 * Förtroendepersonernas andelar och omröstningens nyckel behålls, som
 * omröstningen själv och röstlängden.
 *
 * REVISIONSKEDJAN BRYTS INTE. Återställningen skriver en ny post
 * (ELECTION_DEMO_RESET) sist i kedjan och rör ingen gammal. Posten skrivs i
 * samma transaktion som tömningen av röstlängden, med tabellen låst mot andra
 * skrivare som fastställandet gör, så att löpnumret inte kan tas av en annan.
 *
 * STÄNGNINGENS LÅS. Återställningen tar samma lås som stängningen, och väntar
 * inte: kör en stängning svarar den `in_progress`. Utan låset kunde en
 * stängning skala medan återställningen tömde, och urnan hamna halv.
 *
 * ORDNINGEN MELLAN DATABASERNA. Röstdatabasen töms först, röstlängden sedan.
 * Bryts körningen mitt emellan står fasen kvar, med en tom urna, och
 * administratören kan köra återställningen igen. Omvänt hade fasen stått i OPEN
 * med en urna som innehöll rader, som stängningen sedan tar bort som rester.
 *
 * Filen läser och skriver båda databaserna, som skalningen, och står på
 * modulgränstestets undantagslista. Ingenting här läser en väljares identitet:
 * raderna tas bort på valsedel, och bara antalet lämnas tillbaka.
 */
export type ResetOutcome =
  | {
      status: 'reset'
      /** Antalet rader som togs bort, per slag. Bara antal. */
      removed: { envelopes: number; urnRows: number; contributions: number; tallies: number; markers: number }
    }
  | { status: 'unknown_election' }
  | { status: 'not_demo_election' }
  /** En stängning av samma omröstning pågår. Ingenting är rört. */
  | { status: 'in_progress' }

export async function resetDemoElection(electionId: string): Promise<ResetOutcome> {
  const election = await votersDb.election.findUnique({
    where: { id: electionId },
    select: { name: true, ballots: { select: { id: true } } },
  })
  if (!election) return { status: 'unknown_election' }
  if (election.name !== DEMO_ELECTION_NAME) return { status: 'not_demo_election' }

  const ballotIds = election.ballots.map((ballot) => ballot.id)

  const locked = await withClosingLock(electionId, () => clear(electionId, ballotIds))
  if (!locked.taken) return { status: 'in_progress' }

  // Slutkontrollens sparade resultat gäller en urna som inte finns längre.
  forgetFinalCheck(electionId)

  return { status: 'reset', removed: locked.value }
}

async function clear(electionId: string, ballotIds: string[]) {
  const inBallots = { ballotId: { in: ballotIds } }

  // Tiderna flyttas fram från idag (ruling 136), så att den återställda omröstningen är öppen.
  const window = demoElectionWindow()

  const [urnRows, contributions, tallies] = await votesDb.$transaction([
    votesDb.encryptedVote.deleteMany({ where: inBallots }),
    votesDb.partialDecryption.deleteMany({ where: inBallots }),
    votesDb.ballotTally.deleteMany({ where: inBallots }),
    votesDb.election.update({
      where: { id: electionId },
      data: { status: 'OPEN', certifiedAt: null, tallyCompletedAt: null, ...window },
    }),
  ])

  const voters = await votersDb.$transaction(
    async (tx) => {
      const envelopes = await tx.pendingVote.deleteMany({ where: inBallots })
      const markers = await tx.votedMarker.deleteMany({ where: inBallots })
      await tx.election.update({
        where: { id: electionId },
        data: { phase: 'OPEN', envelopeRoot: null, urnRoot: null, linkClearedAt: null, ...window },
      })
      await tx.$queryRaw`LOCK TABLE audit_event IN SHARE ROW EXCLUSIVE MODE`
      await recordAuditEvent(AUDIT_EVENTS.ELECTION_DEMO_RESET, tx)
      return { envelopes: envelopes.count, markers: markers.count }
    },
    { isolationLevel: 'ReadCommitted' },
  )

  return {
    envelopes: voters.envelopes,
    urnRows: urnRows.count,
    contributions: contributions.count,
    tallies: tallies.count,
    markers: voters.markers,
  }
}
