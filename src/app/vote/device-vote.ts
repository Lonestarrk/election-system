import type { BallotOption } from '@/lib/crypto/ballot-encoding'

/**
 * VAD ENHETEN SPARAR OM EN RÖST DEN LAGT, OCH VAD DEN ALDRIG SPARAR.
 *
 * Spec 3.1 punkt 1: före stängningen ser väljaren sin nuvarande röst på den
 * enhet hon röstade från. Enheten sparar därför, per valsedel, valet och
 * chifferhashen för den senaste röst den lade.
 *
 * SLUMPTALET SPARAS ALDRIG, och det är hela poängen. Det finns inte ens här:
 * krypteringen kastar det innan den lämnar ifrån sig valsedeln (se
 * src/lib/encrypt-client.ts). Utan slumptalet går det inte att visa att
 * chiffret innehåller det enheten säger, och det enheten visar kan väljaren
 * dessutom skriva om själv. Visningen är alltså inget kvitto: ingen kan kräva
 * ett bevis av henne, och ingen kan få ett.
 *
 * Ingen kod visas heller. Hashen sparas för att enheten ska kunna fråga
 * servern om rösten fortfarande ligger kvar, inte för att visas: en kod på
 * skärmen är just det handtag en köpare antecknar (spec 3.1 punkt 3).
 *
 * Posterna ligger i webbläsarens localStorage, en nyckel per omröstning, så
 * att hela omröstningens uppgifter kan raderas på en gång när fasen lämnat
 * OPEN (spec 3.1 punkt 4). Varje funktion tar lagringen som parameter, så att
 * reglerna går att pröva utan webbläsare, i tests/unit/device-vote.test.ts.
 */

/** En röst som lagts från den här enheten. */
export type DeviceVote = {
  /** Hashen över chiffret som lades härifrån. Skickas till servern för jämförelse, visas aldrig. */
  ciphertextHash: string
  /** Valet, som ett alternativ på valsedeln. */
  choice: BallotOption
  /** Valet som det visas: partiet, och kandidaten om väljaren kryssat en. */
  label: string
}

/** Det enda sidan behöver av webbläsarens lagring. */
export type DeviceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

/**
 * Nyckeln för en omröstnings poster.
 *
 * Namnet säger vad som ligger där, och ingenting i det liknar en kod eller ett
 * slumptal: e2e-testerna letar efter sådana ord i hela lagringen.
 */
const KEY_PREFIX = 'valsystem.enhetens-rost.'

function keyFor(electionId: string): string {
  return `${KEY_PREFIX}${electionId}`
}

/**
 * Webbläsarens lagring, eller ingenting.
 *
 * Åtkomsten kan kasta, till exempel i ett privat fönster där lagringen är
 * avstängd. Då röstar väljaren ändå; enheten kan bara inte visa rösten
 * efteråt, och sidan säger i stället att det finns en röst registrerad.
 */
export function browserStorage(): DeviceStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const HASH = /^[0-9a-f]{64}$/

/** Plockar ut ett giltigt alternativ fält för fält, och ingenting annat. */
function asChoice(value: unknown): BallotOption | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>

  if (candidate.kind === 'BLANK') return { kind: 'BLANK' }
  if (candidate.kind === 'PARTY' && typeof candidate.ballotPartyId === 'string') {
    return { kind: 'PARTY', ballotPartyId: candidate.ballotPartyId }
  }
  if (
    candidate.kind === 'CANDIDATE' &&
    typeof candidate.ballotPartyId === 'string' &&
    typeof candidate.candidateId === 'string'
  ) {
    return {
      kind: 'CANDIDATE',
      ballotPartyId: candidate.ballotPartyId,
      candidateId: candidate.candidateId,
    }
  }
  return null
}

/**
 * En post i den form den får ha, eller ingenting.
 *
 * FÄLTEN RÄKNAS UPP ETT OCH ETT, både när en post läses och när den skrivs.
 * Ett objekt som sprids in i lagringen tar med sig allt det råkar bära, och
 * det är så ett slumptal eller en kod skulle hamna där av misstag.
 */
function asDeviceVote(value: unknown): DeviceVote | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const choice = asChoice(candidate.choice)

  if (
    typeof candidate.ciphertextHash !== 'string' ||
    !HASH.test(candidate.ciphertextHash) ||
    typeof candidate.label !== 'string' ||
    !choice
  ) {
    return null
  }

  return { ciphertextHash: candidate.ciphertextHash, choice, label: candidate.label }
}

/**
 * Enhetens poster för en omröstning, per valsedel.
 *
 * En post som inte går att läsa hoppas över i stället för att fälla sidan:
 * värsta följden är att enheten inte visar en röst den kunde ha visat.
 */
export function readDeviceVotes(
  storage: DeviceStorage,
  electionId: string,
): Record<string, DeviceVote> {
  let raw: string | null
  try {
    raw = storage.getItem(keyFor(electionId))
  } catch {
    return {}
  }
  if (!raw) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

  const votes: Record<string, DeviceVote> = {}
  for (const [ballotId, value] of Object.entries(parsed)) {
    const vote = asDeviceVote(value)
    if (vote) votes[ballotId] = vote
  }
  return votes
}

function writeDeviceVotes(
  storage: DeviceStorage,
  electionId: string,
  votes: Record<string, DeviceVote>,
): void {
  try {
    if (Object.keys(votes).length === 0) storage.removeItem(keyFor(electionId))
    else storage.setItem(keyFor(electionId), JSON.stringify(votes))
  } catch {
    // Full eller avstängd lagring. Rösten är lagd ändå; enheten kan bara inte
    // visa den nästa gång.
  }
}

/** Sparar rösten som just lagts härifrån, i stället för en tidigare på samma valsedel. */
export function rememberDeviceVote(
  storage: DeviceStorage,
  electionId: string,
  ballotId: string,
  vote: DeviceVote,
): void {
  const clean = asDeviceVote(vote)
  if (!clean) return

  const votes = readDeviceVotes(storage, electionId)
  votes[ballotId] = clean
  writeDeviceVotes(storage, electionId, votes)
}

/** Glömmer en valsedels post, när den inte längre stämmer med det servern håller. */
export function forgetDeviceVote(storage: DeviceStorage, electionId: string, ballotId: string): void {
  const votes = readDeviceVotes(storage, electionId)
  if (!(ballotId in votes)) return
  delete votes[ballotId]
  writeDeviceVotes(storage, electionId, votes)
}

/** Glömmer allt enheten sparat om en omröstning. */
export function forgetElection(storage: DeviceStorage, electionId: string): void {
  try {
    storage.removeItem(keyFor(electionId))
  } catch {
    // Går lagringen inte att nå finns heller ingenting att radera.
  }
}

/**
 * Har röstningen tagit slut, så att ingenting längre ska visas eller sparas?
 *
 * Spec 3.1 punkt 4 säger att enheten raderar sina uppgifter när sidan ser att
 * fasen lämnat OPEN. Här räcker det också att servern slutat ta emot röster,
 * alltså att `closesAt` passerats medan fasen ännu står i OPEN: rösten kan då
 * inte längre ändras, och efter stängningen ska ingen kunna se något. Att
 * radera en stund tidigare kostar ingenting.
 */
export function votingHasEnded(state: { phase: string | null; acceptsVotes: boolean }): boolean {
  return state.phase !== 'OPEN' || !state.acceptsVotes
}

/** Raderar omröstningens poster om röstningen tagit slut. Svarar om den gjorde det. */
export function forgetIfVotingEnded(
  storage: DeviceStorage,
  electionId: string,
  state: { phase: string | null; acceptsVotes: boolean },
): boolean {
  if (!votingHasEnded(state)) return false
  forgetElection(storage, electionId)
  return true
}

/** Omröstningar som enheten har poster om. */
export function storedElectionIds(storage: DeviceStorage): string[] {
  const ids: string[] = []
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(KEY_PREFIX)) ids.push(key.slice(KEY_PREFIX.length))
    }
  } catch {
    return []
  }
  return ids
}

/**
 * Raderar posterna för varje omröstning som inte längre är öppen.
 *
 * VÄGEN FÖR EN SIDA UTAN SESSION. Efter stängningen går det inte att
 * legitimera sig för omröstningen, och sidan kan därför inte fråga
 * sessionsrutten om fasen. Den offentliga listan över öppna omröstningar
 * svarar på samma fråga utan att veta vem som frågar: en omröstning som inte
 * står där tar inte emot röster, eftersom stängningen kräver att `closesAt`
 * passerats. Utan den här vägen hade uppgifterna legat kvar på varje enhet vars
 * väljare kom tillbaka först efter stängningen, vilket är det vanliga.
 */
export function forgetElectionsNotOpen(storage: DeviceStorage, openElectionIds: string[]): string[] {
  const open = new Set(openElectionIds)
  const closed = storedElectionIds(storage).filter((electionId) => !open.has(electionId))
  for (const electionId of closed) forgetElection(storage, electionId)
  return closed
}

// ---------------------------------------------------------------------------
// Vad valsedeln visar
// ---------------------------------------------------------------------------

/** Serverns svar per valsedel i /api/vote/compare. */
export type DeviceComparison = 'same' | 'different' | 'none'

/** Det sessionsrutten säger om en valsedel. */
export type ServerBallot = {
  id: string
  kind: string
  label: string
  hasPendingVote: boolean
  votedInOldFlow: boolean
}

/**
 * De sju lägen en valsedel kan visas i.
 *
 * `current` är det enda som bär ett innehåll, och bara när servern bekräftat
 * att den håller exakt den röst som lades härifrån.
 */
export type BallotStatus =
  | { kind: 'closed'; hasPendingVote: boolean }
  | { kind: 'unsupported' }
  | { kind: 'old-flow' }
  | { kind: 'current'; label: string }
  | { kind: 'changed-elsewhere' }
  | { kind: 'registered' }
  | { kind: 'not-voted' }

/**
 * Avgör vad en valsedel visar.
 *
 * DET GAMLA FLÖDETS MARKERING RESPEKTERAS, men bara som ett eget läge. En röst
 * lagd med röstintyg ligger i tabellen vote utan någon koppling till väljaren,
 * så den går inte att byta ut, och ett kuvert ovanpå vore en andra röst på
 * samma valsedel. Sidan erbjuder därför ingen röstning där. Ingen sida lägger
 * sådana röster längre, så läget uppstår bara om någon anropat det gamla
 * flödets rutter direkt, och det försvinner med dem.
 *
 * "Du har en röst registrerad" kommer ur kuvertmodellens egen uppgift,
 * `hasPendingVote`, aldrig ur markeringen.
 */
export function ballotStatus(input: {
  ballot: ServerBallot
  acceptsVotes: boolean
  deviceVote: DeviceVote | undefined
  comparison: DeviceComparison | undefined
}): BallotStatus {
  const { ballot, acceptsVotes, deviceVote, comparison } = input

  if (!acceptsVotes) return { kind: 'closed', hasPendingVote: ballot.hasPendingVote }
  // En fråga i en allmän omröstning har ingen plats i kuvertmodellens
  // kodning, och servern tar inte emot den (getEncryptedBallotShape).
  if (ballot.kind === 'FRAGA') return { kind: 'unsupported' }
  if (ballot.votedInOldFlow) return { kind: 'old-flow' }

  if (ballot.hasPendingVote) {
    if (deviceVote && comparison === 'same') return { kind: 'current', label: deviceVote.label }
    if (deviceVote && comparison === 'different') return { kind: 'changed-elsewhere' }
    return { kind: 'registered' }
  }

  return { kind: 'not-voted' }
}

/**
 * De poster enheten ska fråga servern om: bara valsedlar där ett kuvert ligger.
 *
 * Utan ett liggande kuvert finns ingenting att jämföra med, och posten ska
 * bort i stället för att skickas; se `staleDeviceVotes`.
 */
export function hashesToCompare(
  deviceVotes: Record<string, DeviceVote>,
  ballots: ServerBallot[],
): Array<{ ballotId: string; ciphertextHash: string }> {
  return ballots
    .filter((ballot) => ballot.hasPendingVote && deviceVotes[ballot.id])
    .map((ballot) => ({ ballotId: ballot.id, ciphertextHash: deviceVotes[ballot.id]!.ciphertextHash }))
}

/**
 * Poster som inte längre kan visas något för, och därför raderas.
 *
 * En post vars röst ersatts från en annan enhet visar ingenting mer här, men
 * den skulle fortsätta säga något om väljaren: att hon en gång röstade på det
 * som står i den, och att hon sedan ändrade sig. Det senare är just vad en
 * köpare vill veta. Samma sak gäller en post utan kuvert bakom sig, och en
 * post för en valsedel som inte längre gäller väljaren.
 */
export function staleDeviceVotes(
  deviceVotes: Record<string, DeviceVote>,
  ballots: ServerBallot[],
  comparisons: Record<string, DeviceComparison>,
): string[] {
  const withEnvelope = new Set(ballots.filter((ballot) => ballot.hasPendingVote).map((ballot) => ballot.id))

  return Object.keys(deviceVotes).filter(
    (ballotId) =>
      !withEnvelope.has(ballotId) ||
      comparisons[ballotId] === 'different' ||
      comparisons[ballotId] === 'none',
  )
}
