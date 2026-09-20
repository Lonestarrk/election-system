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

function serialise(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value)
  } catch {
    return '[kunde inte serialiseras]'
  }
}

type Level = 'info' | 'warn' | 'error'

function write(level: Level, message: string, context?: Record<string, unknown>): void {
  const parts = [`[${level.toUpperCase()}]`, redact(message)]
  if (context && Object.keys(context).length > 0) {
    parts.push(redact(serialise(context)))
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
