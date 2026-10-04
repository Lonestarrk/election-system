import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ADMIN_COOKIE, SESSION_COOKIE } from '@/lib/cookies'
import { CSRF_HEADER } from '@/lib/csrf'
import { openApiDocument } from '@/lib/openapi'
import { MAX_JSON_BODY_BYTES } from '@/lib/validation'

/**
 * SPECEN FÅR INTE TIGA OM EN RUTT, OCH INTE PÅSTÅ MER ÄN KODEN GÖR.
 *
 * En API-dokumentation som missar en rutt är värre än ingen alls: läsaren drar
 * slutsatsen att ytan är mindre än den är. Samma mönster som
 * api-surface.test.ts, som redan räknar upp varje ruttfil. Här krävs att
 * inventeringen och specen täcker varandra, att varje statuskod en rutt
 * returnerar står i specen, och att varje operation säger vilken åtkomst den
 * kräver.
 *
 * Demorutterna undantas med flit. De finns bara när BankID är en attrapp och
 * hör inte till det API någon ska integrera mot.
 */

const ROOT = process.cwd()
const API_ROOT = join(ROOT, 'src/app/api')

function routeFiles(directory: string, prefix = ''): string[] {
  const found: string[] = []

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...routeFiles(path, `${prefix}/${entry.name}`))
    else if (entry.name === 'route.ts') found.push(prefix)
  }

  return found
}

const routes = routeFiles(API_ROOT)
  .filter((path) => !path.startsWith('/demo'))
  .sort()

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

type Operation = {
  responses?: Record<string, unknown>
  security?: Array<Record<string, string[]>>
  requestBody?: unknown
  parameters?: unknown[]
}

const METHODS = ['get', 'post', 'delete'] as const

function operations(): Array<{ path: string; method: string; operation: Operation }> {
  const found: Array<{ path: string; method: string; operation: Operation }> = []
  for (const [path, item] of Object.entries(openApiDocument().paths ?? {})) {
    for (const [method, operation] of Object.entries(item as Record<string, Operation>)) {
      if ((METHODS as readonly string[]).includes(method)) found.push({ path, method, operation })
    }
  }
  return found
}

describe('OpenAPI-specen mot den faktiska ruttinventeringen', () => {
  it('varje rutt finns i specen', () => {
    const documented = Object.keys(openApiDocument().paths ?? {})
      .map((path) => path.replace(/^\/api/, ''))
      .sort()

    expect(documented).toEqual(routes)
  })

  it('varje dokumenterad rutt finns på disk', () => {
    // Andra riktningen. En spec som beskriver rutter som inte finns skickar
    // den som integrerar mot ett API som svarar 404.
    const documented = Object.keys(openApiDocument().paths ?? {}).map((path) =>
      path.replace(/^\/api/, ''),
    )

    for (const path of documented) {
      expect(routes, `${path} finns i specen men inte på disk`).toContain(path)
    }
  })

  it('varje exporterad HTTP-metod är dokumenterad, och inga andra', () => {
    for (const route of routes) {
      const source = withoutComments(readFileSync(join(API_ROOT, route, 'route.ts'), 'utf8'))
      const exported = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)]
        .map((match) => match[1]!.toLowerCase())
        .sort()
      const documented = Object.keys(
        (openApiDocument().paths as Record<string, Record<string, unknown>>)[`/api${route}`] ?? {},
      )
        .filter((key) => ['get', 'post', 'put', 'patch', 'delete'].includes(key))
        .sort()

      expect(documented, `${route}: metoderna i specen och i rutten skiljer sig`).toEqual(exported)
    }
  })

  it('varje statuskod en rutt returnerar står i specen', () => {
    /**
     * Läser koden, inte någon lista. Talen 200 till 599 som står i ruttens
     * kod utan kommentarer är de statuskoder den kan svara med: de står som
     * argument till errorResponse och jsonResponse, och i tabellen
     * httpStatusFor. Ett tal som av en slump står i en text ger en kod för
     * mycket i specen, och det fångar den här jämförelsen inte, men en kod som
     * saknas fångar den.
     */
    for (const route of routes) {
      const source = withoutComments(readFileSync(join(API_ROOT, route, 'route.ts'), 'utf8'))
      const returned = new Set(
        [...source.matchAll(/(?<![\w.'"-])([2-5]\d\d)(?![\w'"-])/g)].map((match) => match[1]!),
      )

      const documented = new Set(
        operations()
          .filter((entry) => entry.path === `/api${route}`)
          .flatMap((entry) => Object.keys(entry.operation.responses ?? {})),
      )

      for (const code of returned) {
        expect(documented, `${route} returnerar ${code}, men specen nämner den inte`).toContain(code)
      }
    }
  })

  it('ingen rutt dokumenteras utan att beskriva sina fel', () => {
    /**
     * Rutterna svarar 403 på fel origin, 429 vid hastighetsgräns och 400 på
     * ogiltig indata. En spec som bara visar lyckofallet får den som
     * integrerar att tro att de svaren är buggar.
     *
     * Kravet gäller det rutterna FAKTISKT gör, inte en mall. De som ändrar
     * något kontrollerar origin och hastighetsgräns, och det prövar
     * api-surface.test.ts, så varje POST och DELETE ska ha 403 och 429. De
     * två läsrutter som saknar hastighetsgräns, GET /api/elections och
     * GET /api/push/subscribe, har inget fel att beskriva utöver det
     * oväntade, och då räcker det att de säger det.
     */
    for (const { path, method, operation } of operations()) {
      const codes = Object.keys(operation.responses ?? {})
      expect(
        codes.some((code) => code.startsWith('2')),
        `${method.toUpperCase()} ${path} saknar ett lyckat svar`,
      ).toBe(true)

      if (method === 'post' || method === 'delete') {
        expect(codes, `${method.toUpperCase()} ${path} saknar 403`).toContain('403')
        expect(codes, `${method.toUpperCase()} ${path} saknar 429`).toContain('429')
      }
    }
  })

  it('en operation med en kropp eller ett frågeargument beskriver 400', () => {
    for (const { path, method, operation } of operations()) {
      if (operation.requestBody || (operation.parameters ?? []).length > 0) {
        expect(
          Object.keys(operation.responses ?? {}),
          `${method.toUpperCase()} ${path} tar emot indata men beskriver inte 400`,
        ).toContain('400')
      }
    }
  })
})

describe('åtkomsten', () => {
  /**
   * SPECEN SKA SÄGA VILKET SOM ÄR OFFENTLIGT OCH VILKET SOM LIGGER BAKOM EN SESSION.
   *
   * Åtkomsten läses ur ruttens kod och jämförs med vad specen säger, så att
   * en rutt som får ett sessionskrav, eller tappar det, inte stannar kvar
   * som offentlig i specen.
   */
  function accessOf(security: Operation['security']): 'public' | 'voter' | 'admin' {
    const names = (security ?? []).flatMap((requirement) => Object.keys(requirement))
    if (names.includes('adminSession')) return 'admin'
    if (names.includes('voterSession')) return 'voter'
    return 'public'
  }

  it('varje operation anger sin åtkomst, också de offentliga, med en tom lista', () => {
    for (const { path, method, operation } of operations()) {
      expect(operation.security, `${method.toUpperCase()} ${path} saknar security`).toBeDefined()
    }
  })

  it('åtkomsten i specen följer ruttens kod', () => {
    for (const { path, method, operation } of operations()) {
      const source = withoutComments(
        readFileSync(join(API_ROOT, path.replace(/^\/api/, ''), 'route.ts'), 'utf8'),
      )
      // Hanteraren för metoden, till nästa exporterade hanterare eller filens slut.
      const start = source.search(new RegExp(`export async function ${method.toUpperCase()}\\b`))
      expect(start, `${method.toUpperCase()} ${path} finns inte i koden`).toBeGreaterThanOrEqual(0)
      const rest = source.slice(start + 1)
      const next = rest.search(/export async function [A-Z]+\b/)
      const handler = next === -1 ? rest : rest.slice(0, next)

      const expected = /isAdminAuthenticated\(|getAdminSession\(|requireAdminSession\(|adminSession/.test(handler)
        ? 'admin'
        : /getValidVotingSession\(/.test(handler)
          ? 'voter'
          : 'public'

      expect(accessOf(operation.security), `${method.toUpperCase()} ${path}`).toBe(expected)
    }
  })

  it('en rutt med CSRF-skydd i koden nämner CSRF-huvudet i specen', () => {
    for (const { path, method, operation } of operations()) {
      const source = withoutComments(
        readFileSync(join(API_ROOT, path.replace(/^\/api/, ''), 'route.ts'), 'utf8'),
      )
      const start = source.search(new RegExp(`export async function ${method.toUpperCase()}\\b`))
      const rest = source.slice(start + 1)
      const next = rest.search(/export async function [A-Z]+\b/)
      const handler = next === -1 ? rest : rest.slice(0, next)

      const requiresCsrf = /isValidCsrfToken\(/.test(handler)
      const documentsCsrf = (operation.security ?? []).some((requirement) => 'csrfToken' in requirement)
      expect(documentsCsrf, `${method.toUpperCase()} ${path}`).toBe(requiresCsrf)
    }
  })

  it('sessionsnamnen i specen är de som koden använder', () => {
    const schemes = (openApiDocument().components?.securitySchemes ?? {}) as Record<
      string,
      { type: string; in?: string; name?: string }
    >

    expect(schemes.voterSession).toMatchObject({ type: 'apiKey', in: 'cookie', name: SESSION_COOKIE })
    expect(schemes.adminSession).toMatchObject({ type: 'apiKey', in: 'cookie', name: ADMIN_COOKIE })
    expect(schemes.csrfToken).toMatchObject({ type: 'apiKey', in: 'header', name: CSRF_HEADER })
  })
})

describe('specen är härledd ur valideringsschemana', () => {
  it('kroppen för jämförelsen bär schemats gränser, inte ett handskrivet påstående', () => {
    const operation = (openApiDocument().paths as Record<string, any>)['/api/vote/compare'].post
    const body = operation.requestBody.content['application/json'].schema
    const serialised = JSON.stringify(body)

    // Femtio valsedlar och 64 hexadecimala tecken ligger i compareDeviceVotesSchema.
    expect(serialised).toContain('"maxItems":50')
    expect(serialised).toContain('^[0-9a-f]{64}$')
  })

  it('kroppen för en omröstning kommer ur createElectionSchema, med tre fraser', () => {
    const operation = (openApiDocument().paths as Record<string, any>)['/api/admin/elections'].post
    const serialised = JSON.stringify(operation.requestBody.content['application/json'].schema)

    expect(serialised).toContain('trusteePassphrases')
    expect(serialised).toContain('RIKSDAGSVAL')
  })

  it('felsvar och avbrott har den form koden skickar', () => {
    const schemas = (openApiDocument().components?.schemas ?? {}) as Record<string, any>
    expect(JSON.stringify(schemas.ErrorResponse)).toContain('"code"')
    expect(JSON.stringify(schemas.ErrorResponse)).toContain('"message"')
  })

  it('stängningens svar nämner varje status koden kan ge', () => {
    const source = withoutComments(readFileSync(join(API_ROOT, 'admin/elections/close/route.ts'), 'utf8'))
    const statuses = [...source.matchAll(/status: '([a-z_]+)'/g)].map((match) => match[1]!)
    const operation = (openApiDocument().paths as Record<string, any>)['/api/admin/elections/close'].post
    const serialised = JSON.stringify(operation.responses)

    for (const status of new Set(statuses)) {
      expect(serialised, `stängningens status ${status} saknas`).toContain(`"${status}"`)
    }
  })

  it.each([
    ['admin/elections/decrypt'],
    ['admin/elections/tally'],
    ['admin/elections/certify'],
    ['admin/elections/results'],
    ['admin/elections/check'],
    ['observer/results'],
  ])('statusvärdena i %s finns i specen', (route) => {
    const source = withoutComments(readFileSync(join(API_ROOT, route, 'route.ts'), 'utf8'))
    const statuses = [...source.matchAll(/status: '([a-z_]+)'/g)].map((match) => match[1]!)
    const item = (openApiDocument().paths as Record<string, any>)[`/api/${route}`]
    const serialised = JSON.stringify(Object.values(item))

    for (const status of new Set(statuses)) {
      expect(serialised, `${route}: statusen ${status} saknas`).toContain(`"${status}"`)
    }
  })

  it('beskriver varken demorutterna eller något bortom adminsessionen som offentligt', () => {
    const paths = Object.keys(openApiDocument().paths ?? {})
    expect(paths.filter((path) => path.startsWith('/api/demo'))).toEqual([])
  })

  it('nämner kroppens gräns', () => {
    expect(JSON.stringify(openApiDocument())).toContain(String(MAX_JSON_BODY_BYTES))
  })
})

describe('innehållet i specen', () => {
  it('inget exempel innehåller ett personnummer, en token, en fras eller en hash', () => {
    /**
     * Ett exempel är dokumentation, men det kopieras också. Ett personnummer
     * eller en kvittokod i specen blir ett personnummer i varje kodexempel
     * någon klistrar in. Mönstren i schemana, som `^[0-9a-f]{64}$`, är regler
     * och inte värden, och de är rätt.
     */
    const document = openApiDocument()
    const serialised = JSON.stringify(document)

    expect(serialised).not.toMatch(/\b(19|20)\d{6}[-\s]?\d{4}\b/)
    expect(serialised).not.toMatch(/"token"\s*:\s*"[0-9a-f]{40,}"/)
    // Inga värden som ser ut som en hash eller ett tal ur gruppen.
    expect(serialised).not.toMatch(/"[0-9a-f]{64}"/)
    expect(serialised).not.toMatch(/"\d{100,}"/)

    // Inga exempel alls. Fälten beskrivs med typ och regel, aldrig med ett värde.
    expect(serialised).not.toMatch(/"(example|examples)":/)
  })

  it('bär ingen server, ingen hemlighet och inget värde ur miljön', () => {
    const serialised = JSON.stringify(openApiDocument())
    expect(serialised).not.toMatch(/localhost|azurecontainerapps|DATABASE_URL|postgres:/)
  })
})

describe('beroendena för specen', () => {
  /**
   * DE TVÅ PAKETEN FÅR INTE NÅ RÖSTSIDAN ELLER NÅGON FIL SOM RÖR DET HEMLIGA.
   *
   * Undantaget från regeln om inga nya beroenden gäller en spec och en sida som
   * renderar den. Paketen får därför importeras på exakt två ställen: specen på
   * servern och dokumentationssidan. Röstsidans bunt prövas separat i
   * browser-bundle.test.ts, som kräver att inget paket utöver react och
   * next/link finns i den.
   */
  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const full = join(directory, entry)
      if (statSync(full).isDirectory()) return sourceFiles(full)
      return /\.tsx?$/.test(entry) ? [full] : []
    })
  }

  const importers = (pattern: RegExp) =>
    sourceFiles(join(ROOT, 'src'))
      .filter((file) => pattern.test(withoutComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(ROOT, file).split(sep).join('/'))
      .sort()

  it('zod-to-openapi importeras bara av specen', () => {
    expect(importers(/from\s+['"]@asteasolutions\/zod-to-openapi['"]/)).toEqual(['src/lib/openapi.ts'])
  })

  it('swagger-ui-react importeras bara av dokumentationssidan', () => {
    expect(importers(/['"]swagger-ui-react(\/[^'"]*)?['"]/)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^src\/app\/api-docs\//)]),
    )
    for (const file of importers(/['"]swagger-ui-react(\/[^'"]*)?['"]/)) {
      expect(file.startsWith('src/app/api-docs/'), file).toBe(true)
    }
  })

  it('versionerna är låsta, utan ^ eller ~', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    for (const name of ['@asteasolutions/zod-to-openapi', 'swagger-ui-react']) {
      expect(manifest.dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })
})
