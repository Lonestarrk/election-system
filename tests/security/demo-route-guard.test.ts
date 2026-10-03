import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { demoRouteProblems } from './demo-route-source'

/**
 * Vakten för demorutterna, skärpt i uppgift 17.
 *
 * Två delar. Den första kör kontrollen mot de riktiga rutterna. Den andra visar
 * att kontrollen faktiskt fäller de sätt granskningen hittade att komma förbi
 * den, med en mutant per sätt. En kontroll som aldrig prövats mot ett fel är
 * ett påstående och inget skydd.
 */

const DEMO_ROOT = join(process.cwd(), 'src/app/api/demo')

function everyFile(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry)
    return statSync(full).isDirectory() ? everyFile(full) : [full]
  })
}

const files = everyFile(DEMO_ROOT).map((file) => relative(process.cwd(), file).split(sep).join('/'))

describe('de riktiga demorutterna', () => {
  it('varje fil under src/app/api/demo heter route.ts, och det finns fem', () => {
    expect(files.filter((file) => !file.endsWith('/route.ts'))).toEqual([])
    expect(files).toHaveLength(5)
  })

  it.each(files)('%s godkänns av kontrollen', (file) => {
    expect(demoRouteProblems(file, readFileSync(file, 'utf8'))).toEqual([])
  })
})

const GOOD = `
import { isDemoMode } from '@/lib/demo-mode'
import { errorResponse, jsonResponse } from '@/lib/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export type Shape = { a: number }

export async function POST(request: Request) {
  if (!isDemoMode()) {
    return errorResponse('NOT_FOUND', 'Rutten finns inte.', 404)
  }
  return jsonResponse({ ok: true })
}
`

describe('kontrollen fäller varje sätt att komma förbi den', () => {
  const route = 'src/app/api/demo/x/route.ts'

  it('godkänner en rätt skriven rutt, så att mutanterna nedan är rättvisa', () => {
    expect(demoRouteProblems(route, GOOD)).toEqual([])
  })

  const mutants: Array<[string, string]> = [
    [
      'en hanterare som en const med pilfunktion',
      GOOD.replace('export async function POST(request: Request) {', 'export const POST = async (request: Request) => {'),
    ],
    [
      'en hanterare som en const med funktionsuttryck',
      GOOD.replace('export async function POST(request: Request) {', 'export const POST = async function (request: Request) {'),
    ],
    [
      'en hanterare som en funktion utan async',
      GOOD.replace('export async function POST(', 'export function PUT('),
    ],
    [
      'en hanterare som exporteras under ett annat namn',
      GOOD.replace('export async function POST(', 'async function leak(') + "\nexport { leak as PATCH }\n",
    ],
    [
      'en hanterare som exporteras i flera rader',
      GOOD.replace('export async function POST(', 'async function leak(') + '\nexport {\n  leak as PATCH,\n}\n',
    ],
    [
      'en återexport',
      GOOD + "\nexport { POST as DELETE } from './other'\n",
    ],
    [
      'en standardexport',
      GOOD + '\nexport default async function handler() {}\n',
    ],
    [
      'HEAD utan villkor',
      GOOD + '\nexport async function HEAD() {\n  return new Response(null)\n}\n',
    ],
    [
      'OPTIONS utan villkor',
      GOOD + '\nexport async function OPTIONS() {\n  return new Response(null)\n}\n',
    ],
    [
      'ett villkor som svarar 200 i stället för 404',
      GOOD.replace("errorResponse('NOT_FOUND', 'Rutten finns inte.', 404)", "jsonResponse({ ok: false }, 200)"),
    ],
    [
      'ett villkor som svarar med ett annat fel än 404',
      GOOD.replace("'Rutten finns inte.', 404)", "'Rutten finns inte.', 403)"),
    ],
    [
      'ett villkor som saknas',
      GOOD.replace(/if \(!isDemoMode\(\)\) \{[\s\S]*?\n  \}\n/, ''),
    ],
    [
      'ett villkor som inte står först',
      GOOD.replace(
        'export async function POST(request: Request) {\n',
        'export async function POST(request: Request) {\n  await request.text()\n',
      ),
    ],
    [
      'en rutt som läser läget själv',
      GOOD.replace('!isDemoMode()', "process.env.DEMO_MODE !== 'true'"),
    ],
  ]

  it.each(mutants)('fäller %s', (_name, source) => {
    expect(demoRouteProblems(route, source)).not.toEqual([])
  })

  it('fäller en fil som inte heter route.ts', () => {
    expect(demoRouteProblems('src/app/api/demo/x/helper.ts', GOOD)).not.toEqual([])
    expect(demoRouteProblems('src/app/api/demo/x/route.tsx', GOOD)).not.toEqual([])
  })
})
