/**
 * Kontrollen av en demorutts källkod (uppgift 17).
 *
 * Den första versionen i api-surface-testet släppte igenom en hanterare skriven
 * som `export const POST = async …`, `export function PUT` och
 * `export { leak as PATCH }`, metoderna HEAD och OPTIONS, ett villkor som svarar
 * 200 i stället för 404, och filer som inte heter route.ts. Den här kontrollen
 * är därför strikt åt andra hållet: en demorutt får bara skrivas på ett enda
 * sätt, och allt annat är ett fel.
 *
 *   - Exporterna är `runtime`, `dynamic`, typer, och hanterare skrivna som
 *     `export async function METHOD(...)`. Allt annat är ett fel: ett annat
 *     skrivsätt går inte att pröva textuellt, så den som behöver ett får
 *     skriva om kontrollen och dess mutanttest först.
 *   - Varje hanterare börjar med `if (!isDemoMode()) { return
 *     errorResponse('NOT_FOUND', '…', 404) }`.
 *
 * Beteendet prövas separat, mot de riktiga rutterna, i
 * tests/security/demo-routes-behaviour.test.ts.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

/** Kommentarerna bort, så att en förklaring varken kan fälla eller rädda kontrollen. */
export function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const ALLOWED_CONFIG_EXPORTS = ['runtime', 'dynamic']

/** Det som är fel med rutten. Tom lista betyder att rutten är godkänd. */
export function demoRouteProblems(file: string, source: string): string[] {
  const problems: string[] = []

  if (!/(^|\/)route\.ts$/.test(file)) {
    problems.push(`${file}: filer under src/app/api/demo ska heta route.ts`)
    return problems
  }

  const code = withoutComments(source)

  if (!/import \{ isDemoMode \} from '@\/lib\/demo-mode'/.test(code)) {
    problems.push(`${file}: importerar inte isDemoMode`)
  }
  if (/bankIdIsMocked|DEMO_MODE|runtimeMode/.test(code)) {
    problems.push(`${file}: läser läget på egen hand i stället för genom isDemoMode()`)
  }

  // Alla exporter som inte är typer.
  const exportLines = code.split('\n').filter((line) => /^export\b/.test(line))
  const handlers: string[] = []

  for (const line of exportLines) {
    if (/^export (type|interface)\b/.test(line)) continue

    const handler = line.match(/^export async function (\w+)\(/)
    if (handler) {
      if (!(HTTP_METHODS as readonly string[]).includes(handler[1]!)) {
        problems.push(`${file}: exporterar funktionen ${handler[1]}, som inte är en HTTP-metod`)
      } else {
        handlers.push(handler[1]!)
      }
      continue
    }

    const config = line.match(/^export const (\w+) = /)
    if (config && ALLOWED_CONFIG_EXPORTS.includes(config[1]!)) continue

    problems.push(`${file}: exporten "${line.trim()}" är inte skriven som en hanterare eller en konfiguration`)
  }

  if (handlers.length === 0) problems.push(`${file}: har ingen hanterare`)

  for (const method of handlers) {
    const gate = new RegExp(
      `export async function ${method}\\([^)]*\\)\\s*\\{\\s*if \\(!isDemoMode\\(\\)\\) \\{\\s*return errorResponse\\('NOT_FOUND',\\s*'[^']*',\\s*404\\)`,
    )
    if (!gate.test(code)) {
      problems.push(`${file}: ${method} börjar inte med villkoret som svarar 404 utanför demoläget`)
    }
  }

  return problems
}
