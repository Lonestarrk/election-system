import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
import { ADMIN_COOKIE, SESSION_COOKIE } from './cookies'
import { CSRF_HEADER } from './csrf'
import {
  MAX_ADMIN_JSON_BODY_BYTES,
  MAX_JSON_BODY_BYTES,
  adminLoginSchema,
  ballotLookupSchema,
  bankIdQrSchema,
  castEncryptedBallotSchema,
  collectAuthSchema,
  compareDeviceVotesSchema,
  createElectionSchema,
  observerResultsSchema,
  partialDecryptionRequestSchema,
  pushSubscriptionSchema,
  pushUnsubscribeSchema,
  signStartSchema,
  startAuthSchema,
  statsRequestSchema,
  tallyRequestSchema,
} from './validation'

/**
 * SPECEN HÄRLEDS UR VALIDERINGEN, INTE UR PROSA.
 *
 * Varje rutt validerar sin indata med ett Zod-schema i validation.ts. Genereras
 * specen ur samma scheman beskriver den vad API:et FAKTISKT accepterar. En
 * handskriven spec beskriver vad någon trodde att det accepterade när den
 * skrevs, och de två glider isär tyst.
 *
 * Det som inte finns som ett schema, svarens form och vilken åtkomst en rutt
 * kräver, står här, och prövas mot ruttens kod av
 * tests/security/openapi-coverage.test.ts: varje rutt, varje metod, varje
 * statuskod som koden returnerar och varje status i svaren. Täckningen jämför
 * mot samma ruttinventering som api-surface-testet använder.
 *
 * SPECEN BESKRIVER BARA DET SOM ÄR OFFENTLIGT ELLER LIGGER BAKOM EN SESSION.
 * Demorutterna under /api/demo finns bara när BankID är en attrapp och hör inte
 * till något API någon ska integrera mot, så de står inte här.
 *
 * INGA EXEMPEL. Ett exempel kopieras, och här skulle det bli ett personnummer,
 * en fras eller en hash i varje kodrad någon klistrar in. Fälten beskrivs med
 * typ och regel, aldrig med ett värde.
 *
 * Filen importeras bara av servern: av /api/openapi, och av testerna. Paketet
 * zod-to-openapi får inte nå webbläsaren, och inte röstsidan.
 */

extendZodWithOpenApi(z)

type Access = 'public' | 'voter' | 'admin'
type Responses = NonNullable<RouteConfig['responses']>

const registry = new OpenAPIRegistry()

registry.registerComponent('securitySchemes', 'voterSession', {
  type: 'apiKey',
  in: 'cookie',
  name: SESSION_COOKIE,
  description:
    'Röstsessionen. Sätts av POST /api/auth/bankid/collect när väljaren legitimerat sig med BankID, ' +
    'som en HttpOnly-cookie. Webbläsaren skickar den själv.',
})

registry.registerComponent('securitySchemes', 'adminSession', {
  type: 'apiKey',
  in: 'cookie',
  name: ADMIN_COOKIE,
  description:
    'Adminsessionen. Sätts av POST /api/admin/login när en administratör legitimerat sig med BankID, ' +
    'som en HttpOnly-cookie. Behörigheten är en flagga på personens rad i röstlängden.',
})

registry.registerComponent('securitySchemes', 'csrfToken', {
  type: 'apiKey',
  in: 'header',
  name: CSRF_HEADER,
  description:
    'CSRF-skydd för dubbel inlämning. Samma värde som den läsbara cookien valcsrf, som sätts ' +
    'tillsammans med sessionen. Servern jämför det med en hemlighet knuten till sessionen.',
})

// ---------------------------------------------------------------------------
// Svar
// ---------------------------------------------------------------------------

const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string().describe('Maskinläsbar felkod.'),
      message: z.string().describe('Beskedet på svenska, för slutanvändaren.'),
    }),
  })
  .openapi({
    description:
      'Felsvar. Innehåller aldrig interna identifierare, stacktracear eller databasfel. Varje operation ' +
      'säger vilka koder den kan ge.',
  })

registry.register('ErrorResponse', ErrorResponse)

/** Ett felsvar med en bestämd uppsättning koder, så att specen säger vilka det kan vara. */
function error(description: string, codes: [string, ...string[]]) {
  return {
    description,
    content: {
      'application/json': {
        schema: z.object({
          error: z.object({
            code: codes.length === 1 ? z.literal(codes[0]) : z.enum(codes),
            message: z.string(),
          }),
        }),
      },
    },
  }
}

/** Ett svar där `status` är en fast sträng, som stängningens och räkningens besked. */
function statusReply(description: string, status: string | [string, ...string[]], fields: z.ZodRawShape = {}) {
  return {
    description,
    content: {
      'application/json': {
        schema: z.object({
          status: Array.isArray(status) ? z.enum(status) : z.literal(status),
          message: z.string().optional(),
          ...fields,
        }),
      },
    },
  }
}

function json(description: string, schema: z.ZodTypeAny) {
  return { description, content: { 'application/json': { schema } } }
}

const phase = z
  .string()
  .describe('Omröstningens fas: OPEN, CLOSED, VALIDATED, STRIPPED, TALLIED eller CERTIFIED.')

const retryAfter = {
  description: 'För många förfrågningar. Rubriken Retry-After anger hur många sekunder som återstår.',
  headers: z.object({ 'Retry-After': z.string() }),
}

const wrongOrigin = error('Begäran kom från en origin som inte är tillåten.', ['FORBIDDEN_ORIGIN'])

function rateLimited(): Responses[string] {
  return {
    ...retryAfter,
    content: {
      'application/json': { schema: z.object({ error: z.object({ code: z.literal('RATE_LIMITED'), message: z.string() }) }) },
    },
  } as Responses[string]
}

/**
 * BankID svarade med ett fel när en order skulle startas (uppgift 17c). Svaret byggs av
 * `startErrorReply` i src/modules/eligibility/bankid/replies.ts, och meddelandet är
 * BankID:s text för felet (helgrensgranskningen, B6).
 */
function bankIdStartFailed(): Responses[string] {
  return error('BankID svarade med ett fel, och ordern startades inte. Meddelandet är BankID:s text för felet.', [
    'BANKID_ERROR',
  ]) as Responses[string]
}

/**
 * BankID svarade med ett fel under en pollning, som inte går över av sig självt. Ordern
 * avslutas och avbryts hos BankID. Se `collectErrorReply` i samma fil.
 */
function bankIdCollectFailed(): Responses[string] {
  return {
    description: 'BankID svarade med ett fel. Ordern är avslutad, och meddelandet är BankID:s text för felet.',
    content: {
      'application/json': { schema: z.object({ status: z.literal('failed'), message: z.string() }) },
    },
  } as Responses[string]
}

/** BankID:s svar under en pollning: pågår, misslyckades, eller klart. */
const pollingFields = {
  hintCode: z.string().nullable().optional().describe('BankID:s hintCode, om en publik sådan finns.'),
}

// ---------------------------------------------------------------------------
// Rutterna
// ---------------------------------------------------------------------------

type Operation = {
  method: 'get' | 'post' | 'delete'
  path: string
  summary: string
  description: string
  tags: string[]
  access: Access
  /** Kräver rutten CSRF-token utöver sessionen. */
  csrf?: boolean
  body?: z.ZodTypeAny
  /** Största kropp, om det inte är den vanliga. */
  bodyLimitBytes?: number
  query?: z.AnyZodObject
  ok: Responses[string]
  /** Statuskoden för lyckofallet. */
  okStatus?: 200 | 202
  /** Utöver de gemensamma: fler svar, per statuskod. */
  responses?: Responses
}

function register(operation: Operation) {
  const responses: Responses = { [operation.okStatus ?? 200]: operation.ok }
  const needsOrigin = operation.method !== 'get'

  if (needsOrigin) {
    responses[403] = {
      description:
        'Begäran avvisades: fel origin' +
        (operation.csrf ? ', eller ett CSRF-token som inte hör till sessionen' : '') +
        '.',
      content: {
        'application/json': {
          schema: z.object({
            error: z.object({
              code: operation.csrf
                ? z.enum(['FORBIDDEN_ORIGIN', 'CSRF_FAILED'])
                : z.literal('FORBIDDEN_ORIGIN'),
              message: z.string(),
            }),
          }),
        },
      },
    }
  }

  if (operation.body || operation.query) {
    responses[400] = error('Indata som inte klarar valideringen.', ['INVALID_INPUT'])
  }

  if (operation.access === 'voter') {
    responses[401] = error('Ingen giltig röstsession. Väljaren legitimerar sig igen.', [
      'NO_SESSION',
      'SESSION_EXPIRED',
    ])
  }
  if (operation.access === 'admin') {
    responses[401] = error('Inte inloggad som administratör.', ['UNAUTHORISED'])
  }

  // Egna svar sist, så att en rutt kan fylla på en kod som redan finns (403 med fler skäl).
  Object.assign(responses, operation.responses ?? {})

  const security: Array<Record<string, string[]>> =
    operation.access === 'public'
      ? []
      : [
          operation.access === 'voter'
            ? { voterSession: [], ...(operation.csrf ? { csrfToken: [] } : {}) }
            : { adminSession: [], ...(operation.csrf ? { csrfToken: [] } : {}) },
        ]

  const limit = operation.bodyLimitBytes ?? MAX_JSON_BODY_BYTES

  registry.registerPath({
    method: operation.method,
    path: operation.path,
    summary: operation.summary,
    description: operation.description + (operation.body ? ` Kroppen får vara högst ${limit} byte.` : ''),
    tags: operation.tags,
    security,
    request: {
      ...(operation.body
        ? { body: { required: true, content: { 'application/json': { schema: operation.body } } } }
        : {}),
      ...(operation.query ? { query: operation.query } : {}),
    },
    responses,
  })
}

const election = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: z.string(),
  opensAt: z.string().datetime(),
  closesAt: z.string().datetime(),
})

const electionList = z.object({ elections: z.array(election) })

const wrongModeAdmin = (what: string) =>
  statusReply(`Omröstningen skapades i ett annat läge eller mot en annan BankID-miljö än den servern kör i, och ${what}. Läget sätts vid driftsättning.`, 'wrong_mode')

// --- Offentligt -----------------------------------------------------------

register({
  method: 'get',
  path: '/api/openapi',
  summary: 'Den här specen',
  description:
    'OpenAPI-dokumentet, som JSON. Offentligt: ytan är offentlig information, och att dölja den ' +
    'gör systemet svårare att granska utan att göra det säkrare.',
  tags: ['Offentligt'],
  access: 'public',
  ok: json('Dokumentet.', z.object({ openapi: z.string() }).passthrough()),
  responses: { 429: rateLimited() },
})

register({
  method: 'get',
  path: '/api/mode',
  summary: 'Driftläget',
  description:
    'Bara läget, DEMO eller SHARP, och ingenting om konfigurationen. Ingen rutt byter läge: det ' +
    'sätts vid driftsättning.',
  tags: ['Offentligt'],
  access: 'public',
  ok: json('Läget.', z.object({ mode: z.enum(['DEMO', 'SHARP']) })),
  responses: { 429: rateLimited() },
})

register({
  method: 'get',
  path: '/api/elections',
  summary: 'Öppna omröstningar',
  description:
    'Omröstningar som är öppna just nu, med alla sina valsedlar, och fasen för varje omröstning. ' +
    'Vilka valsedlar som gäller en viss väljare avgörs först efter legitimering. Inget antal och ' +
    'inget tal lämnas ut medan röstningen pågår. Gränsen är generös, 600 i minuten per adress, eftersom ' +
    'röstsidan frågar efter fasen medan den är öppen.',
  tags: ['Offentligt'],
  access: 'public',
  ok: json(
    'Omröstningarna.',
    z.object({
      phases: z.array(z.object({ id: z.string().uuid(), name: z.string(), phase })),
      elections: z.array(
        election.extend({
          ballots: z.array(
            z.object({
              id: z.string().uuid(),
              kind: z.string(),
              label: z.string(),
              areaCode: z.string().nullable(),
              allowsCandidateVote: z.boolean(),
            }),
          ),
        }),
      ),
    }),
  ),
  responses: { 429: rateLimited() },
})

register({
  method: 'post',
  path: '/api/vote/ballot',
  summary: 'Innehållet i en valsedel',
  description:
    'Valsedelns val, och den offentliga nyckel och det antal alternativ som rösten krypteras med. ' +
    'Offentligt, eftersom valsedelns innehåll är offentligt. Kräver ingen session och bär ingenting om en väljare.',
  tags: ['Offentligt'],
  access: 'public',
  body: ballotLookupSchema,
  ok: json(
    'Valsedeln.',
    z.object({
      ballotId: z.string().uuid(),
      choices: z.unknown().describe('Valsedelns val. Formen följer valsedelns typ.'),
      encryption: z
        .object({ publicKey: z.string(), optionCount: z.number().int() })
        .nullable()
        .describe('Null när valsedeln inte tar emot krypterade röster.'),
    }),
  ),
  responses: { 404: error('Valsedeln finns inte.', ['UNKNOWN_BALLOT']), 429: rateLimited() },
})

register({
  method: 'post',
  path: '/api/observer/election',
  summary: 'Observatörens överblick',
  description:
    'Utan electionId: listan över omröstningar. Med electionId: fasen, valdeltagandet per valsedel och ' +
    'rötterna. Inget resultat i någon fas, och inget per väljare. Resultatet med bevis hämtas från ' +
    'GET /api/observer/results efter räkningen.',
  tags: ['Observatör'],
  access: 'public',
  body: statsRequestSchema,
  ok: json(
    'Listan, eller överblicken över en omröstning.',
    z.union([
      electionList,
      z.object({
        election: election.extend({ phase }),
        ballots: z.array(z.object({ id: z.string().uuid(), label: z.string(), kind: z.string(), voted: z.number().int() })),
        turnoutBasis: z.enum(['envelopes', 'markers']).describe('Var siffran kommer ifrån: liggande kuvert före skalningen, markeringar efter.'),
        envelopeRoot: z.string().nullable(),
        urnRoot: z.string().nullable(),
        markedAsVotedTotal: z.number().int().nullable(),
        publishedResults: z.string().nullable().describe('Sökvägen till det publicerade resultatet, när det finns.'),
        howToVerify: z.string(),
      }),
    ]),
  ),
  responses: { 404: error('Omröstningen finns inte.', ['UNKNOWN_ELECTION']), 429: rateLimited() },
})

register({
  method: 'get',
  path: '/api/observer/results',
  summary: 'Det publicerade resultatet, med bevis',
  description:
    'Summorna per valsedel med förtroendepersonernas bidrag och bevis, när varje valsedel är räknad. ' +
    'Servern räknar om resultatet ur urnan och bidragen innan det lämnas ut, och lämnar inget tal om ' +
    'omräkningen inte stämmer. Det oberoende verktyget tools/verify-election.mjs läser det här svaret.',
  tags: ['Observatör'],
  access: 'public',
  query: observerResultsSchema,
  ok: json(
    'Publiceringen. Formen är Publication i src/orchestration/publish-results.usecase.ts, och verktyget som läser den kontrollerar den.',
    z
      .object({
        status: z.literal('published'),
        format: z.string(),
        election: z.object({
          id: z.string().uuid(),
          name: z.string(),
          phase: z.string(),
          bankIdEnvironment: z
            .enum(['none', 'test', 'production'])
            .describe('BankID-miljön omröstningen skapades mot. none: attrappen i demoläget. test: BankID:s testmiljö, inget riktigt val.'),
        }),
        group: z.object({ p: z.string(), q: z.string(), g: z.string() }),
        trustees: z.object({
          count: z.number().int(),
          threshold: z.number().int(),
          publicShares: z.array(z.object({ trusteeIndex: z.number().int(), publicShare: z.string() })),
        }),
        encryptionPublicKey: z.string(),
        envelopeRoot: z.string(),
        urnRoot: z.string(),
        markedAsVotedTotal: z.number().int(),
        ballots: z.array(z.object({ ballotId: z.string().uuid(), label: z.string(), kind: z.string() }).passthrough()),
        notCheckable: z.array(z.string()).describe('Det publiceringen själv säger att ingen utanför kan kontrollera.'),
        howToVerify: z.string(),
      })
      .passthrough(),
  ),
  responses: {
    404: error('Omröstningen finns inte.', ['UNKNOWN_ELECTION']),
    409: {
      description:
        'Inget resultat lämnas ut. not_published: omröstningen är inte räknad. wrong_mode: omröstningen ' +
        'skapades i ett annat läge eller mot en annan BankID-miljö än serverns. result_mismatch: en omräkning stämmer inte med de sparade räkneverken.',
      content: {
        'application/json': {
          schema: z.object({
            status: z.enum(['not_published', 'wrong_mode', 'result_mismatch']),
            phase: z.string().optional(),
            message: z.string(),
          }),
        },
      },
    },
    429: rateLimited(),
  },
})

register({
  method: 'get',
  path: '/api/push/subscribe',
  summary: 'Den publika VAPID-nyckeln',
  description:
    'Nyckeln webbläsaren behöver för att skapa en prenumeration på notiser. Publik per definition.',
  tags: ['Notiser'],
  access: 'public',
  ok: json('Nyckeln.', z.object({ enabled: z.boolean(), publicKey: z.string().nullable() })),
  responses: { 429: rateLimited() },
})

register({
  method: 'post',
  path: '/api/push/subscribe',
  summary: 'Prenumerera på notiser',
  description:
    'Sparar en enhets prenumeration på notiser om nya omröstningar. Utan inloggning och utan koppling till en identitet, med flit.',
  tags: ['Notiser'],
  access: 'public',
  body: pushSubscriptionSchema,
  ok: json('Sparad.', z.object({ status: z.literal('subscribed') })),
  responses: { 429: rateLimited() },
})

register({
  method: 'delete',
  path: '/api/push/subscribe',
  summary: 'Avsluta prenumerationen',
  description: 'Tar bort en enhets prenumeration. Bara endpointen behövs för att hitta raden.',
  tags: ['Notiser'],
  access: 'public',
  body: pushUnsubscribeSchema,
  ok: json('Borttagen.', z.object({ status: z.literal('unsubscribed') })),
  responses: { 429: rateLimited() },
})

// --- Legitimering ---------------------------------------------------------

const launchUrls = z.object({
  ios: z.string().describe('Adressen för iOS, som en universal link.'),
  other: z.string().describe('Adressen för övriga plattformar.'),
})

const pollingReply = (description: string) =>
  json(
    description,
    z.union([
      z.object({ status: z.literal('pending'), message: z.string(), ...pollingFields }),
      z.object({ status: z.literal('failed'), message: z.string(), ...pollingFields }),
    ]),
  )

register({
  method: 'post',
  path: '/api/auth/bankid/start',
  summary: 'Starta en legitimering',
  description:
    'Startar en BankID-order. Inget personnummer skickas hit: väljaren legitimerar sig med QR-kod eller ' +
    'autostart, och personnumret kommer i BankID:s svar. purpose styr bara texten i BankID-appen.',
  tags: ['Legitimering'],
  access: 'public',
  body: startAuthSchema,
  ok: json(
    'Ordern.',
    z.object({
      orderRef: z.string().uuid(),
      launchUrls,
      qrImage: z.string().nullable().describe('Första QR-koden som en data-URI. Null om ingen finns.'),
    }),
  ),
  responses: { 429: rateLimited(), 502: bankIdStartFailed() },
})

register({
  method: 'post',
  path: '/api/auth/bankid/qr',
  summary: 'Nästa QR-kod',
  description: 'Den animerade QR-kodens aktuella bild. Samma svar när ordern saknas, är avbruten eller har gått ut.',
  tags: ['Legitimering'],
  access: 'public',
  body: bankIdQrSchema,
  ok: json(
    'Bilden, eller ett besked om att ordern inte längre finns.',
    z.union([
      z.object({ qrImage: z.string(), elapsedSeconds: z.number(), expired: z.literal(false) }),
      z.object({ qrImage: z.null(), expired: z.literal(true) }),
    ]),
  ),
  responses: { 429: rateLimited() },
})

register({
  method: 'post',
  path: '/api/auth/bankid/collect',
  summary: 'Fråga om legitimeringen är klar',
  description:
    'Pollas medan väljaren legitimerar sig. Vid complete sätts röstsessionen och CSRF-cookien. ' +
    'queued betyder att många legitimerar sig samtidigt: sidan fortsätter fråga.',
  tags: ['Legitimering'],
  access: 'public',
  body: collectAuthSchema,
  ok: json(
    'Läget. Varje utfall svarar 200, också ett avslag.',
    z.union([
      z.object({ status: z.literal('pending'), message: z.string(), ...pollingFields }),
      z.object({ status: z.literal('failed'), message: z.string(), ...pollingFields }),
      z.object({ status: z.literal('queued'), message: z.string(), estimatedWaitSeconds: z.number() }),
      z.object({ status: z.literal('rejected'), reason: z.literal('not_eligible'), message: z.string() }),
      z.object({
        status: z.literal('complete'),
        name: z.string().describe('Namnet ur BankID:s svar, som bekräftelse. Det lagras inte.'),
        ballots: z.array(z.object({ id: z.string().uuid(), kind: z.string(), label: z.string() })),
      }),
    ]),
  ),
  responses: { 429: rateLimited(), 502: bankIdCollectFailed() },
})

// --- Väljarens session ----------------------------------------------------

register({
  method: 'post',
  path: '/api/vote/session',
  summary: 'Sessionens läge',
  description:
    'Omröstningen, fasen, om den tar emot röster, och väljarens valsedlar med en uppgift om ett kuvert ligger på dem. ' +
    'Ingenting om VAD som ligger i kuvertet. Inget CSRF-token: rutten ändrar ingenting.',
  tags: ['Väljare'],
  access: 'voter',
  ok: json(
    'Sessionen.',
    z.object({
      electionId: z.string().uuid(),
      electionName: z.string().nullable(),
      phase: z.string().nullable().describe('Null när omröstningen saknas i röstlängden, och sidan behandlar den då som stängd.'),
      closesAt: z.string().datetime().nullable(),
      acceptsVotes: z.boolean(),
      ballots: z.array(
        z.object({ id: z.string().uuid(), kind: z.string(), label: z.string(), hasPendingVote: z.boolean() }),
      ),
    }),
  ),
  responses: { 429: rateLimited() },
})

register({
  method: 'post',
  path: '/api/vote/participation',
  summary: 'Har jag röstat',
  description:
    'Ett ja eller nej per valsedel för sessionens väljare. Inget chiffer, ingen hash, ingen räknare och ingen tid. ' +
    'Efter stängningen är det allt väljaren får veta om sin röst.',
  tags: ['Väljare'],
  access: 'voter',
  ok: json(
    'Svaret.',
    z.object({
      electionId: z.string().uuid(),
      electionName: z.string(),
      phase: z.string(),
      ballots: z.array(z.object({ id: z.string().uuid(), kind: z.string(), label: z.string(), voted: z.boolean() })),
    }),
  ),
  responses: { 404: error('Omröstningen finns inte längre.', ['UNKNOWN_ELECTION']), 429: rateLimited() },
})

register({
  method: 'post',
  path: '/api/vote/compare',
  summary: 'Jämför enhetens sparade röst',
  description:
    'Enheten skickar den chifferhash den sparade för varje valsedel. Servern svarar lika, olika eller ingen röst, ' +
    'och lämnar aldrig ut sin egen hash. Högst en post per valsedel. Bara medan omröstningen tar emot röster: ' +
    'efter closesAt, eller när fasen lämnat OPEN, svarar rutten 409 utan att jämföra.',
  tags: ['Väljare'],
  access: 'voter',
  csrf: true,
  body: compareDeviceVotesSchema,
  ok: json(
    'Utfallet per valsedel.',
    z.object({
      ballots: z.array(
        z.object({
          ballotId: z.string().uuid(),
          result: z.string().describe('Lika, olika eller ingen röst. Värdena är CompareResult i koden.'),
        }),
      ),
    }),
  ),
  responses: {
    400: error('Indata som inte klarar valideringen, eller en valsedel som inte hör till omröstningen.', [
      'INVALID_INPUT',
      'INVALID_BALLOT',
    ]),
    409: error('Omröstningen tar inte längre emot röster, och ingenting jämförs (spec 3.1).', ['VOTING_CLOSED']),
    429: rateLimited(),
  },
})

register({
  method: 'post',
  path: '/api/vote/sign-start',
  summary: 'Starta underskriften av en krypterad röst',
  description:
    'Tar emot den krypterade valsedeln, en gång, och startar en BankID-signering som binder underskriften till ' +
    'chiffret. Servern räknar själv fram räknaren castSequence, och klientens värde skulle ändå inte läsas.',
  tags: ['Väljare'],
  access: 'voter',
  csrf: true,
  body: signStartSchema,
  ok: json(
    'Ordern.',
    z.object({ orderRef: z.string().uuid(), launchUrls, qrImage: z.string().nullable() }),
  ),
  responses: {
    400: error('Indata som inte klarar valideringen, eller en valsedel som inte kan ta emot rösten.', [
      'INVALID_INPUT',
      'INVALID_BALLOT',
    ]),
    409: error(
      'Omröstningen tar inte emot röster: fasen har lämnat OPEN eller closesAt har passerats, eller så hör den ' +
        'till ett annat läge eller en annan BankID-miljö än serverns. Ingen BankID-order skapades.',
      ['VOTING_CLOSED', 'WRONG_MODE'],
    ),
    429: rateLimited(),
    502: bankIdStartFailed(),
    503: error('Servern har för mycket att göra, och rösten lades inte. Rubriken Retry-After anger sekunder.', ['BUSY']),
  },
})

register({
  method: 'post',
  path: '/api/vote/encrypted',
  summary: 'Lägg den signerade, krypterade rösten',
  description:
    'Pollas efter sign-start. Kroppen pekar bara ut ordern: valsedeln hålls av servern sedan sign-start, och ' +
    'signaturen hämtas från serverns egen BankID-hämtning, aldrig ur kroppen. Statuskoden följer utfallet: ' +
    '200 recorded, 409 closed, wrong_mode eller stale_sequence, 400 invalid_proof, 403 invalid_signature eller ' +
    'not_eligible, 500 signature_too_large, 503 queued.',
  tags: ['Väljare'],
  access: 'voter',
  csrf: true,
  body: castEncryptedBallotSchema,
  ok: {
    description:
      'recorded: rösten är lagd. Pågår signeringen svarar rutten 200 med pending, och har den misslyckats 200 med failed.',
    content: {
      'application/json': {
        schema: z.union([
          z.object({ status: z.literal('recorded'), replaced: z.boolean(), ciphertextHash: z.string().describe('Hashen över det chiffer som lades. Servern lämnar den till väljarens egen session.') }),
          z.object({ status: z.literal('pending'), message: z.string(), ...pollingFields }),
          z.object({ status: z.literal('failed'), message: z.string(), ...pollingFields }),
        ]),
      },
    },
  },
  responses: {
    400: {
      description: 'invalid_proof: bevisen i valsedeln håller inte. Eller ogiltig indata.',
      content: {
        'application/json': {
          schema: z.union([
            z.object({ status: z.literal('invalid_proof') }),
            z.object({ error: z.object({ code: z.literal('INVALID_INPUT'), message: z.string() }) }),
          ]),
        },
      },
    },
    403: {
      description:
        'invalid_signature eller not_eligible, eller fel origin eller CSRF-token (FORBIDDEN_ORIGIN, CSRF_FAILED).',
      content: {
        'application/json': {
          schema: z.union([
            z.object({ status: z.enum(['invalid_signature', 'not_eligible']) }),
            z.object({ error: z.object({ code: z.enum(['FORBIDDEN_ORIGIN', 'CSRF_FAILED']), message: z.string() }) }),
          ]),
        },
      },
    },
    409: statusReply('Rösten lades inte: omröstningen är stängd, i ett annat läge eller en annan BankID-miljö, eller räknaren är gammal.', [
      'closed',
      'wrong_mode',
      'stale_sequence',
    ]),
    429: rateLimited(),
    499: error('Besökaren stängde begäran innan rösten lades. Ingenting lades.', ['CLIENT_CLOSED']),
    500: statusReply('BankID:s underskrift är större än servern tar emot. Ett fel i serverns tak, inte väljarens.', 'signature_too_large'),
    502: bankIdCollectFailed(),
    503: statusReply('Många röstar just nu. Rösten prövas så fort det finns plats. Rubriken Retry-After anger sekunder.', 'queued'),
  },
})

// --- Administration -------------------------------------------------------

const idOnly = statsRequestSchema

register({
  method: 'post',
  path: '/api/admin/login',
  summary: 'Logga in som administratör',
  description:
    'Pollas medan administratören legitimerar sig med BankID. Vid complete sätts adminsessionen och CSRF-cookien. ' +
    'Samma svar rejected oavsett om personen saknas i röstlängden eller inte är administratör.',
  tags: ['Administration'],
  access: 'public',
  body: adminLoginSchema,
  ok: json(
    'Läget. Varje utfall svarar 200, också ett avslag.',
    z.union([
      z.object({ status: z.literal('pending'), message: z.string(), ...pollingFields }),
      z.object({ status: z.literal('failed'), message: z.string(), ...pollingFields }),
      z.object({ status: z.literal('rejected'), message: z.string() }),
      z.object({ status: z.literal('complete'), name: z.string() }),
    ]),
  ),
  responses: { 429: rateLimited(), 502: bankIdCollectFailed() },
})

register({
  method: 'delete',
  path: '/api/admin/login',
  summary: 'Logga ut',
  description: 'Raderar sessionsraden, inte bara cookien.',
  tags: ['Administration'],
  access: 'public',
  ok: json('Utloggad.', z.object({ status: z.literal('logged_out') })),
  responses: { 429: rateLimited() },
})

register({
  method: 'get',
  path: '/api/admin/mode',
  summary: 'Läget och kraven för skarpt läge',
  description: 'Läget och checklistan för skarpt läge, för adminsidans kort. Bara läsning: ingen rutt byter läge.',
  tags: ['Administration'],
  access: 'admin',
  ok: json(
    'Läget och kraven.',
    z
      .object({
        mode: z.enum(['DEMO', 'SHARP']),
        title: z.string(),
        summary: z.string(),
        meaning: z.string(),
        bankId: z.object({ kind: z.string(), label: z.string() }),
        requirements: z.array(z.object({ id: z.string(), met: z.boolean(), blocking: z.boolean(), detail: z.string() }).passthrough()),
      })
      .passthrough(),
  ),
  responses: { 429: rateLimited() },
})

register({
  method: 'post',
  path: '/api/admin/stats',
  summary: 'Valdeltagande',
  description:
    'Utan electionId: listan över omröstningar. Med electionId: antalet röstberättigade och antalet som röstat per ' +
    'valsedel. Bara aggregat, ingen sökfunktion och inget löpande resultat.',
  tags: ['Administration'],
  access: 'admin',
  body: statsRequestSchema,
  ok: json(
    'Listan, eller valdeltagandet.',
    z.union([
      electionList,
      z.object({
        electionId: z.string().uuid(),
        phase: z.string(),
        electorate: z.object({ totalEligible: z.number().int() }),
        turnoutBasis: z.string(),
        ballots: z.array(
          z.object({
            ballotId: z.string().uuid(),
            ballot: z.string(),
            kind: z.string(),
            voted: z.number().int(),
            turnoutPercent: z.number(),
          }),
        ),
      }),
    ]),
  ),
  responses: { 404: error('Omröstningen finns inte.', ['UNKNOWN_ELECTION']), 429: rateLimited() },
})

register({
  method: 'post',
  path: '/api/admin/elections',
  summary: 'Skapa en omröstning',
  description:
    'Skapar omröstningen i båda databaserna, med tre förtroendepersoners lösenfraser. Frasen sparas aldrig. ' +
    'Notis skickas efter att omröstningen finns i båda.',
  tags: ['Administration'],
  access: 'admin',
  csrf: true,
  body: createElectionSchema,
  bodyLimitBytes: MAX_ADMIN_JSON_BODY_BYTES,
  ok: json(
    'Skapad.',
    z.object({
      status: z.literal('created'),
      election: z.object({ id: z.string().uuid(), name: z.string(), ballots: z.array(z.string().uuid()) }),
      notifications: z.object({ sent: z.number().int(), failed: z.number().int() }),
    }),
  ),
  responses: { 429: rateLimited(), 500: error('Omröstningen kunde inte skapas.', ['CREATION_FAILED']) },
})

register({
  method: 'post',
  path: '/api/admin/elections/state',
  summary: 'Omröstningens fas och antal',
  description:
    'Fasen och antalen för adminsidan, och om demoknapparna ska visas. Inget per väljare. Kräver electionId. ' +
    'Formen på overview är ElectionOverview i src/orchestration/election-overview.usecase.ts.',
  tags: ['Administration'],
  access: 'admin',
  body: idOnly,
  ok: json(
    'Överblicken.',
    z.object({
      overview: z
        .object({
          electionId: z.string().uuid(),
          name: z.string(),
          phase,
          underReview: z.boolean(),
          opensAt: z.string(),
          closesAt: z.string(),
          waitingEnvelopes: z.number().int(),
          urnEnvelopes: z.number().int(),
          envelopeRoot: z.string().nullable(),
          urnRoot: z.string().nullable(),
          linkCleared: z.boolean(),
          trusteeCount: z.number().int(),
          trusteeThreshold: z.number().int(),
        })
        .passthrough(),
      demoMode: z.boolean(),
      demoReset: z.boolean(),
    }),
  ),
  responses: {
    400: error('Ogiltig indata, eller electionId saknas.', ['INVALID_INPUT']),
    404: error('Omröstningen finns inte.', ['UNKNOWN_ELECTION']),
    429: rateLimited(),
  },
})

register({
  method: 'post',
  path: '/api/admin/elections/close',
  summary: 'Stäng omröstningen',
  description:
    'Flyttar chiffren till den anonyma sidan och raderar kopplingen mellan väljare och röst. Oåterkallelig, och med flit ' +
    'inte schemalagd. En omkörning är ofarlig: en stängd omröstning svarar already_closed. Alla utfall utom closed och ' +
    'already_closed svarar 409.',
  tags: ['Administration'],
  access: 'admin',
  csrf: true,
  body: idOnly,
  ok: {
    description: 'closed: stängd och kopplingen raderad. already_closed: redan stängd, ofarligt att köra om.',
    content: {
      'application/json': {
        schema: z.union([
          z.object({
            status: z.literal('closed'),
            message: z.string(),
            moved: z.number().int(),
            cleared: z.number().int(),
            envelopeRoot: z.string(),
            urnRoot: z.string(),
            residueRemoved: z.array(z.string()),
            urnRowsReplaced: z.array(z.string()),
          }),
          z.object({ status: z.literal('already_closed'), message: z.string(), urnRowsReplaced: z.array(z.string()).optional() }),
        ]),
      },
    },
  },
  responses: {
    404: error('Omröstningen finns inte.', ['UNKNOWN_ELECTION']),
    409: {
      description:
        'Stängningen gjordes inte, eller avbröts. aborted: ett skydd löste ut, och linkState säger om kopplingen är orörd. ' +
        'too_early: omröstningen är öppen till closesAt. in_progress: en annan stängning pågår. ' +
        'validation_failed och invalid_ballot: valideringen hittade avvikelser och kopplingen är kvar. ' +
        'wrong_mode: omröstningen hör till det andra läget eller en annan BankID-miljö.',
      content: {
        'application/json': {
          schema: z.object({
            status: z.enum(['aborted', 'too_early', 'in_progress', 'validation_failed', 'invalid_ballot', 'wrong_mode']),
            message: z.string(),
            linkState: z.string().optional().describe('Bara vid aborted: om kopplingen mellan väljare och röst är orörd.'),
            closesAt: z.string().datetime().optional(),
            summary: z.unknown().optional().describe('Antal och kategorier av avvikelser. Aldrig vilka väljare.'),
            ciphertextHash: z.string().optional().describe('Bara vid invalid_ballot.'),
            urnRowsReplaced: z.array(z.string()).optional(),
          }),
        },
      },
    },
    429: rateLimited(),
  },
})

register({
  method: 'post',
  path: '/api/admin/elections/check',
  summary: 'Starta slutkontrollen',
  description:
    'Startar slutkontrollen i bakgrunden och svarar 202. Resultatet läses med POST /api/admin/elections/check-status. ' +
    'En kontroll som redan körs startas inte om.',
  tags: ['Administration'],
  access: 'admin',
  csrf: true,
  body: idOnly,
  okStatus: 202,
  ok: statusReply('Kontrollen har startat, eller körs redan.', ['started', 'already_running']),
  responses: {
    400: error('Ogiltig indata, eller electionId saknas.', ['INVALID_INPUT']),
    404: error('Omröstningen finns inte.', ['UNKNOWN_ELECTION']),
    409: wrongModeAdmin('ingen kontroll startades'),
    429: rateLimited(),
  },
})

register({
  method: 'post',
  path: '/api/admin/elections/check-status',
  summary: 'Slutkontrollens läge',
  description:
    'Läser kontrollens läge och rapport. none betyder att ingen kontroll körts sedan processen startade: ' +
    'resultatet ligger i minnet och går förlorat vid en omstart. Ändrar ingenting.',
  tags: ['Administration'],
  access: 'admin',
  body: idOnly,
  ok: json(
    'Läget.',
    z.union([
      z.object({ status: z.literal('none') }),
      z.object({ status: z.literal('running'), startedAt: z.string() }),
      z.object({ status: z.literal('done'), report: z.unknown().describe('FinalCheckReport i koden.'), finishedAt: z.string() }),
      z.object({ status: z.literal('failed'), message: z.string(), finishedAt: z.string() }),
    ]),
  ),
  responses: {
    400: error('Ogiltig indata, eller electionId saknas.', ['INVALID_INPUT']),
    429: rateLimited(),
  },
})

register({
  method: 'post',
  path: '/api/admin/elections/decrypt',
  summary: 'En förtroendepersons bidrag',
  description:
    'Låser upp en andel med frasen och sparar förtroendepersonens bidrag till en valsedels summa. Frasen lagras aldrig ' +
    'och loggas aldrig, men den lämnas till servern, se de kända begränsningarna. Hastighetsgränsen räknas per förtroendeperson.',
  tags: ['Administration'],
  access: 'admin',
  csrf: true,
  body: partialDecryptionRequestSchema,
  ok: statusReply('Bidraget är godkänt och sparat.', 'accepted'),
  responses: {
    403: {
      description: 'wrong_passphrase: frasen låste inte upp andelen, och ingenting sparades. Eller fel origin eller CSRF-token.',
      content: {
        'application/json': {
          schema: z.union([
            z.object({ status: z.literal('wrong_passphrase'), message: z.string() }),
            z.object({ error: z.object({ code: z.enum(['FORBIDDEN_ORIGIN', 'CSRF_FAILED']), message: z.string() }) }),
          ]),
        },
      },
    },
    404: statusReply('Valsedeln finns inte eller saknar nyckel, eller förtroendepersonen har ingen andel.', ['unknown_ballot', 'unknown_trustee']),
    409: statusReply('Bidraget sparades inte.', ['duplicate', 'wrong_phase', 'wrong_mode', 'aborted'], {
      phase: z.string().nullable().optional(),
    }),
    422: statusReply('Bidraget avvisades.', 'rejected'),
    429: rateLimited(),
    500: error('Bidraget kunde inte tas emot, av ett skäl som står i serverloggen.', ['INTERNAL']),
  },
})

register({
  method: 'post',
  path: '/api/admin/elections/tally',
  summary: 'Räkna en valsedel',
  description: 'Räknar valsedeln när två bidrag finns. Summan öppnas först då. Räkneverken sparas, och ett nytt anrop ger dem igen.',
  tags: ['Administration'],
  access: 'admin',
  csrf: true,
  body: tallyRequestSchema,
  ok: statusReply('Valsedeln är räknad.', 'tallied', {
    counts: z.array(z.number().int()),
    votes: z.number().int(),
    phase: z.string(),
  }),
  responses: {
    404: statusReply('Valsedeln finns inte, eller omröstningen saknar nyckel.', 'unknown_ballot'),
    409: statusReply('Valsedeln räknades inte.', ['needs_more_trustees', 'wrong_phase', 'wrong_mode', 'aborted'], {
      have: z.number().int().optional(),
      need: z.number().int().optional(),
      phase: z.string().nullable().optional(),
    }),
    429: rateLimited(),
    500: error('Räkningen kunde inte slutföras, av ett skäl som står i serverloggen.', ['INTERNAL']),
  },
})

register({
  method: 'post',
  path: '/api/admin/elections/results',
  summary: 'Räkneverken per valsedel',
  description:
    'Räkneverken efter TALLIED, bakom adminsessionen. Servern räknar om dem ur urnan och bidragen, och lämnar inga tal ' +
    'om omräkningen inte stämmer. Den offentliga publiceringen är GET /api/observer/results.',
  tags: ['Administration'],
  access: 'admin',
  body: idOnly,
  ok: json(
    'Räkneverken.',
    z.object({ status: z.literal('ok'), phase: z.string(), ballots: z.array(z.object({}).passthrough()) }),
  ),
  responses: {
    400: error('Ogiltig indata, eller electionId saknas.', ['INVALID_INPUT']),
    404: error('Omröstningen finns inte.', ['UNKNOWN_ELECTION']),
    409: statusReply('Inga tal lämnas ut.', ['not_tallied', 'wrong_mode', 'result_mismatch'], {
      phase: z.string().optional(),
    }),
    429: rateLimited(),
  },
})

register({
  method: 'post',
  path: '/api/admin/elections/certify',
  summary: 'Fastställ resultatet',
  description:
    'Kör slutkontrollen och sätter fasen CERTIFIED om inget avvikande hittas. Ett nytt anrop efter fastställandet ' +
    'svarar already_certified.',
  tags: ['Administration'],
  access: 'admin',
  csrf: true,
  body: idOnly,
  ok: statusReply('certified: fastställt nu. already_certified: var redan fastställt.', ['certified', 'already_certified'], {
    report: z.unknown().describe('FinalCheckReport i koden.'),
  }),
  responses: {
    404: error('Omröstningen finns inte.', ['UNKNOWN_ELECTION']),
    409: statusReply(
      'Resultatet fastställdes inte. not_ready: förutsättningarna saknas, och ingenting markerades som avvikande. blocked: omröstningen är markerad som avvikande. wrong_mode: omröstningen hör till det andra läget eller en annan BankID-miljö.',
      ['not_ready', 'blocked', 'wrong_mode'],
      { report: z.unknown().optional().describe('FinalCheckReport, utom vid wrong_mode.') },
    ),
    429: rateLimited(),
    500: error('Fastställandet kunde inte slutföras. Läs om fasen för att se om resultatet blev fastställt.', ['INTERNAL']),
  },
})

// ---------------------------------------------------------------------------

export function openApiDocument() {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Valsystemets API',
      version: '1.0.0',
      description:
        'Härledd ur valideringsschemana i src/lib/validation.ts. Beskriver det som är offentligt eller ligger bakom ' +
        'en röstsession eller adminsessionen. Demorutterna under /api/demo finns bara när BankID är en attrapp och ' +
        'står inte här. Alla svar är JSON, och felsvar har formen ErrorResponse. Alla rutter svarar 403 på en origin ' +
        'som inte är tillåten.',
    },
    tags: [
      { name: 'Offentligt', description: 'Kräver ingen inloggning.' },
      { name: 'Observatör', description: 'Offentligt: överblick och publicerat resultat.' },
      { name: 'Legitimering', description: 'BankID-flödet som ger en röstsession.' },
      { name: 'Väljare', description: 'Kräver en röstsession.' },
      { name: 'Notiser', description: 'Offentligt, utan koppling till en identitet.' },
      { name: 'Administration', description: 'Inloggningen är offentlig. Resten kräver en adminsession.' },
    ],
  })
}
