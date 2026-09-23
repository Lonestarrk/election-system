/**
 * Applikationslogg med obligatorisk maskering.
 *
 * Loggar är den vanligaste vägen för känsliga uppgifter att läcka ut ur ett
 * system som i övrigt är korrekt byggt. En enda `console.log(request.body)` i
 * en felsökningssituation räcker för att skriva en väljares token till disk,
 * och därifrån vidare till loggaggregering, backuper och supportärenden.
 *
 * Därför får ingenting i den här applikationen logga direkt. All loggning går
 * genom `logger`, som maskerar kända hemlighetsmönster på väg ut — även när
 * anroparen råkat skicka med något den inte borde. Maskeringen är ett
 * skyddsnät, inte en ursäkt för att slarva vid anropsstället.
 */

const REDACTED = '[MASKERAT]'

/**
 * Mönster som aldrig får nå loggutdata.
 *
 * Ordningen spelar roll: token matchas före generiska hexsträngar så att en
 * token maskeras som token.
 */
const SENSITIVE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    // Röst-token i visningsformat: 6 grupper om 8 Crockford-base32-tecken.
    label: 'token',
    pattern: /\b[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}(?:-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}){5}\b/gi,
  },
  {
    // Röst-token utan gruppering.
    label: 'token',
    pattern: /\b[0-9ABCDEFGHJKMNPQRSTVWXYZ]{48}\b/gi,
  },
  {
    // Personnummer: ÅÅÅÅMMDD-NNNN, ÅÅMMDD-NNNN, med eller utan skiljetecken.
    label: 'personnummer',
    pattern: /\b(?:19|20)?\d{6}[-+]?\d{4}\b/g,
  },
  {
    // SHA-256/HMAC som hex. Ett token-hash i loggen låter den som har
    // databasen slå upp exakt vilken röst en loggrad hör till.
    label: 'hash',
    pattern: /\b[a-f0-9]{64}\b/gi,
  },
]

/** Maskerar kända hemlighetsmönster i en sträng. */
export function redact(input: string): string {
  let output = input
  for (const { pattern } of SENSITIVE_PATTERNS) {
    output = output.replace(pattern, REDACTED)
  }
  return output
}

/**
 * Hela orsakskedjan i ett fel, som en läsbar sträng.
 *
 * `Error.cause` är den enda platsen ett omslutande fel kan bära VARFÖR det
 * kastades. Ett fel som paketeras om — "stängningen kunde inte bekräftas", med
 * det verkliga databasfelet i `cause` — tappar alltså hela sin diagnostik om
 * loggen bara skriver ut det yttersta lagret. Det var precis vad som hände i
 * fixrunda 3: omslaget gjorde felsökningen sämre på den väg där
 * administratören har minst information, och både ruttens text och
 * felmeddelandet lovade en logg som inte innehöll orsaken.
 *
 * Kedjan följs med både djupgräns och cykelskydd: `cause` sätts av
 * anropskoden och kan peka var som helst, även tillbaka på sig själv.
 *
 * FUNKTIONEN KASTAR ALDRIG (fixrunda 5, uppgift 11). Ett led i kedjan kan vara
 * vad som helst — `String(Object.create(null))` kastar `TypeError`, och en
 * getter på `name`, `message` eller `cause` kan kasta vad den vill. Det här
 * anropas bland annat INNE i stängningsruttens catch-block, före svaret med
 * säkerhetsbeskedet: ett kast där hade blivit en naken 500 i stället för
 * beskedet om huruvida kopplingen mellan väljare och röst finns kvar. Ett led
 * som inte går att beskriva ersätts därför med en reservtext, och kedjan
 * avbryts där i stället för att ta loggraden med sig.
 */
export function describeErrorChain(error: unknown): string {
  const seen = new Set<unknown>()
  const parts: string[] = []
  let current: unknown = error

  try {
    while (current !== undefined && current !== null && !seen.has(current) && parts.length < 5) {
      seen.add(current)
      parts.push(describeLink(current))
      current = current instanceof Error ? current.cause : undefined
    }
  } catch {
    // `instanceof` eller en getter på `cause` kastade. Det som redan hunnit
    // beskrivas behålls; resten av kedjan går inte att följa.
    parts.push(UNDESCRIBABLE_LINK)
  }

  return parts.join(' <- orsakat av: ')
}

const UNDESCRIBABLE_LINK = '[led i orsakskedjan kunde inte beskrivas]'

/** Ett enskilt led. Kastar aldrig — se `describeErrorChain`. */
function describeLink(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  } catch {
    return UNDESCRIBABLE_LINK
  }
}

function serialise(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return describeErrorChain(value)
  try {
    return JSON.stringify(value)
  } catch {
    return '[kunde inte serialiseras]'
  }
}

type Level = 'info' | 'warn' | 'error'

/**
 * Gör om `Error`-värden i kontexten till läsbar text INNAN JSON-serialiseringen.
 *
 * `JSON.stringify(new Error('x'))` ger `{}` — namn, meddelande och orsak är
 * inte uppräkningsbara egenskaper. En anropare som skickar med felet självt
 * fick alltså tidigare en tom rad i loggen utan att någonting sa ifrån, vilket
 * är exakt den sortens tysta förlust den här rundan handlat om. Nu blir samma
 * anrop hela orsakskedjan i klartext.
 */
function normaliseContext(context: Record<string, unknown>): Record<string, unknown> {
  const normalised: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(context)) {
    normalised[key] = value instanceof Error ? describeErrorChain(value) : value
  }

  return normalised
}

/**
 * Kontexten som text. Kastar aldrig.
 *
 * `normaliseContext` läser varje värde genom `Object.entries`, och det
 * anropar getters — en getter som kastar gjorde förut att `serialise`s egen
 * try/catch svarade med reservtexten, men sedan normaliseringen infördes låg
 * läsningen UTANFÖR det skyddet och tog hela loggraden med sig. Hela vägen från
 * kontextobjekt till sträng ligger därför inom samma skydd.
 *
 * Loggerns invariant: en loggrad som kastar är värre än en som saknas. Loggern
 * anropas från felhanterare, och ett kast där ersätter det fel som skulle
 * loggas med ett nytt, som ingen ser.
 */
function serialiseContext(context: Record<string, unknown>): string | null {
  try {
    if (Object.keys(context).length === 0) return null
    return serialise(normaliseContext(context))
  } catch {
    return '[kunde inte serialiseras]'
  }
}

function write(level: Level, message: string, context?: Record<string, unknown>): void {
  const parts = [`[${level.toUpperCase()}]`, redact(message)]
  const serialisedContext = context ? serialiseContext(context) : null
  if (serialisedContext !== null) {
    parts.push(redact(serialisedContext))
  }
  const line = parts.join(' ')

  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>) => write('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => write('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => write('error', message, context),
}
