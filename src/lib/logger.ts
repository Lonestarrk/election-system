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
 */
export function describeErrorChain(error: unknown): string {
  const seen = new Set<unknown>()
  const parts: string[] = []
  let current: unknown = error

  while (current !== undefined && current !== null && !seen.has(current) && parts.length < 5) {
    seen.add(current)
    parts.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current))
    current = current instanceof Error ? current.cause : undefined
  }

  return parts.join(' <- orsakat av: ')
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

function write(level: Level, message: string, context?: Record<string, unknown>): void {
  const parts = [`[${level.toUpperCase()}]`, redact(message)]
  if (context && Object.keys(context).length > 0) {
    parts.push(redact(serialise(normaliseContext(context))))
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
