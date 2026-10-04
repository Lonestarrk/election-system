import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import nextConfig from '../../next.config'
import {
  MAX_ADMIN_JSON_BODY_BYTES,
  MAX_CANDIDATES_PER_ELECTION,
  MAX_JSON_BODY_BYTES,
  createElectionSchema,
  parseJsonBody,
} from '@/lib/validation'

/**
 * KROPPENS GRÄNS GÄLLER HELA VÄGEN (uppgift 14e, omgranskningen av 14b).
 *
 * Tre gränser ska hålla ihop:
 *
 *   – Nexts klon i middleware, \`experimental.middlewareClientMaxBodySize\`, som
 *     annars är 10 MB och gör att minnet per begäran begränsas av den och inte
 *     av appens egen gräns;
 *   – appens gräns för varje rutt, 2 MiB;
 *   – administratörens rutt för att skapa en omröstning, som får en egen, högre
 *     gräns, i samklang med vad schemat faktiskt kan släppa igenom.
 *
 * Före uppgiften tillät schemat omkring 70 MB, och rutten läste 2 MiB.
 */

const MIB = 1024 * 1024

describe('gränserna hänger ihop', () => {
  it('administratörens gräns är högre än den för varje annan rutt', () => {
    expect(MAX_JSON_BODY_BYTES).toBe(2 * MIB)
    expect(MAX_ADMIN_JSON_BODY_BYTES).toBeGreaterThan(MAX_JSON_BODY_BYTES)
  })

  it('Nexts klon i middleware har samma gräns som den högsta rutten', () => {
    // Klonen gäller varje rutt. Den måste därför vara minst den högsta gränsen,
    // och mer än så ger bara minne per begäran som ingen rutt läser.
    const configured = nextConfig.experimental?.middlewareClientMaxBodySize
    expect(configured).toBe(`${MAX_ADMIN_JSON_BODY_BYTES / MIB}mb`)
  })
})

describe('schemat för att skapa en omröstning', () => {
  const ARBITRARY_PARTY = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

  /** Den största omröstning schemat släpper igenom, med en tecken per tecken. */
  function largestElection() {
    const candidate = 'a'.repeat(120)
    let remaining = MAX_CANDIDATES_PER_ELECTION
    let chars = 200 // namnet

    const ballots = Array.from({ length: 50 }, (_, index) => {
      const parties = Array.from({ length: 60 }, () => {
        const take = Math.min(200, remaining)
        remaining -= take
        chars += 36 + take * 120
        return { partyId: ARBITRARY_PARTY, candidates: Array(take).fill(candidate) as string[] }
      })
      // Svarsalternativ finns bara på en fråga, som i sin tur inte har partier och är mindre än denna.
      chars += 200 + 20
      return {
        kind: index % 2 === 0 ? 'RIKSDAG' : 'KOMMUN',
        label: 'c'.repeat(200),
        areaCode: 'd'.repeat(20),
        allowsCandidateVote: true,
        parties,
      }
    })

    return {
      chars,
      body: {
        name: 'n'.repeat(200),
        kind: 'RIKSDAGSVAL',
        opensAt: '2026-10-01T00:00:00.000Z',
        closesAt: '2026-10-02T00:00:00.000Z',
        ballots,
        trusteePassphrases: ['a'.repeat(8), 'b'.repeat(8), 'c'.repeat(8)],
      },
    }
  }

  it('den största omröstning schemat släpper igenom godtas av schemat', () => {
    expect(createElectionSchema.safeParse(largestElection().body).success).toBe(true)
  })

  it('och ryms i administratörens gräns också när varje tecken skickas som en \\u-sekvens', () => {
    const { body, chars } = largestElection()
    // Ett tecken skrivs som högst sex byte (\\uXXXX) av en klient som väljer det.
    const worstCase = Buffer.byteLength(JSON.stringify(body)) + 5 * chars

    // En MiB lämnas åt lösenfraserna, som schemat inte sätter något tak på:
    // en lång fras ska aldrig avvisas, så den begränsas av kroppens gräns.
    expect(worstCase).toBeLessThanOrEqual(MAX_ADMIN_JSON_BODY_BYTES - MIB)
  })

  it('fler kandidater än taket avvisas av schemat', () => {
    const { body } = largestElection()
    // Den sista partilistan är tom, eftersom taket är uppnått före den. Ingen lista
    // överskrider sitt eget tak på 200, så det är taket för hela omröstningen som avvisar.
    const last = body.ballots.at(-1)!.parties.at(-1)!
    last.candidates = ['en till']
    expect(createElectionSchema.safeParse(body).success).toBe(false)
  })

  it('en vanlig omröstning, med tre valsedlar och tio partier med femtio kandidater, godtas', () => {
    const parties = Array.from({ length: 10 }, () => ({
      partyId: ARBITRARY_PARTY,
      candidates: Array.from({ length: 50 }, (_, index) => `Kandidat ${index}`),
    }))
    const result = createElectionSchema.safeParse({
      name: 'Riksdagsval',
      kind: 'RIKSDAGSVAL',
      opensAt: '2026-10-01T00:00:00.000Z',
      closesAt: '2026-10-02T00:00:00.000Z',
      ballots: ['RIKSDAG', 'LANDSTING', 'KOMMUN'].map((kind) => ({
        kind,
        label: kind,
        parties,
      })),
      trusteePassphrases: ['fras-nummer-ett', 'fras-nummer-tva', 'fras-nummer-tre'],
    })
    expect(result.success).toBe(true)
  })
})

describe('parseJsonBody med en egen gräns', () => {
  const body = (size: number) =>
    new Request('http://localhost/x', {
      method: 'POST',
      body: JSON.stringify({ text: 'a'.repeat(size) }),
    })
  const schema = { safeParse: (value: unknown) => ({ success: true as const, data: value }) }

  it('standardgränsen är 2 MiB', async () => {
    const result = await parseJsonBody(body(3 * MIB), schema as never)
    expect(result).toEqual({ ok: false, message: 'Begäran är för stor.' })
  })

  it('en högre gräns släpper igenom en större kropp, och stoppar en större än den', async () => {
    expect((await parseJsonBody(body(3 * MIB), schema as never, { maxBytes: 4 * MIB })).ok).toBe(true)
    expect(await parseJsonBody(body(5 * MIB), schema as never, { maxBytes: 4 * MIB })).toEqual({
      ok: false,
      message: 'Begäran är för stor.',
    })
  })
})

describe('bara administratörens rutt för att skapa en omröstning har den högre gränsen', () => {
  const API = join(process.cwd(), 'src/app/api')

  function routes(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) return routes(path)
      return entry === 'route.ts' ? [path] : []
    })
  }

  it('och den använder den', () => {
    const using = routes(API)
      .filter((path) => readFileSync(path, 'utf8').includes('MAX_ADMIN_JSON_BODY_BYTES'))
      .map((path) => relative(process.cwd(), path).split(sep).join('/'))

    expect(using).toEqual(['src/app/api/admin/elections/route.ts'])
  })

  it('och skickar den till parseJsonBody, inte bara importerar den', () => {
    const route = readFileSync(join(API, 'admin/elections/route.ts'), 'utf8')
    expect(route).toMatch(
      /parseJsonBody\(request, createElectionSchema, \{\s*maxBytes: MAX_ADMIN_JSON_BODY_BYTES,?\s*\}\)/,
    )
  })
})
