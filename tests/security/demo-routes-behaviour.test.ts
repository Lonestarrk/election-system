import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HTTP_METHODS } from './demo-route-source'

/**
 * BETEENDET HOS DEMORUTTERNA UTANFÖR DEMOLÄGET (uppgift 17).
 *
 * Strukturtestet läser källkoden. Det här testet kör den. Läget byts mot
 * `false`, båda databasklienterna mot proxyer som kastar vid all åtkomst, och
 * varje exporterad metod i varje rutt under src/app/api/demo anropas. Varje
 * anrop ska ge 404, och ingen databasåtkomst får ha skett. Hur hanteraren är
 * skriven spelar då ingen roll.
 */

const accesses: string[] = []

function throwingClient(name: string) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        accesses.push(`${name}.${String(property)}`)
        throw new Error(`databasåtkomst i skarpt läge: ${name}.${String(property)}`)
      },
    },
  )
}

vi.mock('@/lib/demo-mode', () => ({ isDemoMode: () => false }))
vi.mock('@/modules/eligibility/db', () => ({ votersDb: throwingClient('votersDb') }))
vi.mock('@/modules/ballot-box/db', () => ({ votesDb: throwingClient('votesDb') }))

const DEMO_ROOT = join(process.cwd(), 'src/app/api/demo')

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry)
    return statSync(full).isDirectory() ? routeFiles(full) : [full]
  })
}

const files = routeFiles(DEMO_ROOT)

describe('demorutterna utanför demoläget', () => {
  it('hittar rutterna', () => {
    expect(files.length).toBeGreaterThanOrEqual(5)
  })

  it.each(files)('%s svarar 404 på varje metod och rör ingen databas', async (file) => {
    const module = (await import(/* @vite-ignore */ file)) as Record<string, unknown>

    const exportedMethods = Object.keys(module).filter((name) => (HTTP_METHODS as readonly string[]).includes(name))
    expect(exportedMethods.length, `${file} exporterar ingen metod`).toBeGreaterThan(0)

    // Varje värde som exporteras och är en funktion ska vara en HTTP-metod. En
    // hjälpfunktion som någon exporterar vore en väg förbi granskningen.
    const functions = Object.entries(module)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
    expect(functions.filter((name) => !exportedMethods.includes(name))).toEqual([])

    accesses.length = 0
    for (const method of exportedMethods) {
      const handler = module[method] as (request: Request) => Promise<Response>
      const request = new Request('http://localhost:3000/api/demo/x', {
        method,
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? undefined : '{}',
      })

      const response = await handler(request)

      expect(response.status, `${method} ${file}`).toBe(404)
    }
    expect(accesses).toEqual([])
  })
})
