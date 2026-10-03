import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Demoläget kan inte nå ett skarpt läge (uppgift 17).
 *
 * Läget sätts vid driftsättning. Den här filen vaktar att ingen väg i appen
 * byter det, att varje ställe som läser det går genom en enda funktion, och att
 * skarpt läge aldrig kan få attrappens BankID, demofraserna eller attrappens rot.
 */

const SRC = join(process.cwd(), 'src')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

// Åtkomst till variabeln. Ett omnämnande i en text eller ett felmeddelande är ingen läsning.
const READS_DEMO_MODE = /process\.env(?:\.DEMO_MODE|\[\s*['"`]DEMO_MODE['"`]\s*\])/
const WRITES_DEMO_MODE = /process\.env(?:\.DEMO_MODE|\[\s*['"`]DEMO_MODE['"`]\s*\])\s*=(?!=)/

const rel = (file: string) => relative(process.cwd(), file).split(sep).join('/')

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('läget avgörs på ett enda ställe', () => {
  it('bara src/lib/mode-flag.ts läser DEMO_MODE', () => {
    const readers = sourceFiles(SRC)
      .filter((file) => READS_DEMO_MODE.test(withoutComments(readFileSync(file, 'utf8'))))
      .map(rel)
      .sort()

    expect(readers).toEqual(['src/lib/mode-flag.ts'])
  })

  it('läget följer bara DEMO_MODE och läser inte NODE_ENV', () => {
    // Ett produktionsbygge får köra i demoläge (den publika demon), och ett
    // utvecklingsbygge får köra skarpt. Skarpt är förvalt, så en glömd variabel
    // ger det säkra utfallet.
    const code = withoutComments(readFileSync('src/lib/mode-flag.ts', 'utf8'))
    expect(code).toContain("process.env.DEMO_MODE === 'true'")
    expect(code).not.toContain('NODE_ENV')
  })

  it('isDemoMode() är lägesfunktionen och ingenting annat', () => {
    const code = withoutComments(readFileSync('src/lib/demo-mode.ts', 'utf8'))
    expect(code).toMatch(/return runtimeMode\(\) === 'DEMO'/)
  })
})

describe('växeln styr isDemoMode()', () => {
  it.each([
    ['true', true],
    ['', false],
    ['false', false],
    ['TRUE', false],
  ])('DEMO_MODE=%j ger isDemoMode() = %s', async (value, expected) => {
    vi.resetModules()
    vi.stubEnv('DEMO_MODE', value)
    const { isDemoMode } = await import('@/lib/demo-mode')

    expect(isDemoMode()).toBe(expected)
  })

  it('läget läses vid varje anrop', async () => {
    vi.resetModules()
    vi.stubEnv('DEMO_MODE', 'true')
    const { isDemoMode } = await import('@/lib/demo-mode')
    expect(isDemoMode()).toBe(true)

    vi.stubEnv('DEMO_MODE', '')
    expect(isDemoMode()).toBe(false)
  })
})

describe('ingen väg i appen byter läge', () => {
  it('ingen fil under src skriver till process.env.DEMO_MODE', () => {
    for (const file of sourceFiles(SRC)) {
      const code = withoutComments(readFileSync(file, 'utf8'))
      expect(code, `${rel(file)} skriver DEMO_MODE`).not.toMatch(WRITES_DEMO_MODE)
      expect(code, `${rel(file)} tar bort ur process.env`).not.toMatch(/delete\s+process\.env/)
    }
  })

  it('lägesrutterna svarar bara på GET, och inget i dem tar emot ett nytt läge', () => {
    for (const path of ['src/app/api/mode/route.ts', 'src/app/api/admin/mode/route.ts']) {
      const code = withoutComments(readFileSync(path, 'utf8'))
      expect(code, path).toMatch(/export async function GET\(/)
      expect(code, path).not.toMatch(/export (async )?function (POST|PUT|PATCH|DELETE)\b/)
      expect(code, path).not.toMatch(/request\.(json|formData|text)\(/)
    }
  })

  it('adminkortet har ingen knapp och inget formulär, och säger att läget inte kan ändras där', () => {
    const code = withoutComments(readFileSync('src/app/admin/ModeCard.tsx', 'utf8'))
    expect(code).not.toMatch(/<button|<form|onClick|onSubmit|method:/)
    expect(code).toContain('Läget sätts vid driftsättning och kan inte ändras här.')
  })
})

describe('checklistan är inte offentlig', () => {
  it('/api/mode ger bara läget', () => {
    const code = withoutComments(readFileSync('src/app/api/mode/route.ts', 'utf8'))
    expect(code).not.toMatch(/sharpModeRequirements|requirements|BANKID|process\.env/)
    expect(code).toMatch(/runtimeMode\(\)/)
  })

  it('/api/admin/mode kräver adminsessionen före allt annat', () => {
    const code = withoutComments(readFileSync('src/app/api/admin/mode/route.ts', 'utf8'))
    expect(code).toMatch(/isAdminAuthenticated/)
    expect(code.indexOf('isAdminAuthenticated()')).toBeLessThan(code.indexOf('sharpModeRequirements()'))
  })
})

describe('skarpt läge får aldrig attrapp-BankID', () => {
  it('attrappen byggs bara i demoläget, och skarpt läge får en tjänst som vägrar', async () => {
    vi.resetModules()
    vi.stubEnv('DEMO_MODE', '')
    const { bankIdService } = await import('@/modules/eligibility/bankid')
    const { MockBankIdService } = await import('@/modules/eligibility/bankid/MockBankIdService')

    expect(bankIdService).not.toBeInstanceOf(MockBankIdService)
    await expect(bankIdService.auth({ endUserIp: '127.0.0.1' })).rejects.toThrow(/BankID/)
    await expect(bankIdService.collect('x')).rejects.toThrow(/BankID/)
  })

  it('demoläget får attrappen', async () => {
    vi.resetModules()
    vi.stubEnv('DEMO_MODE', 'true')
    const { bankIdService } = await import('@/modules/eligibility/bankid')
    const { MockBankIdService } = await import('@/modules/eligibility/bankid/MockBankIdService')

    expect(bankIdService).toBeInstanceOf(MockBankIdService)
  })

  it('skarpt läge faller aldrig tillbaka på attrappens rot', async () => {
    vi.resetModules()
    vi.stubEnv('DEMO_MODE', '')
    vi.stubEnv('BANKID_ROOT_CERTIFICATES', '')
    const { trustedBankIdRoots } = await import('@/modules/eligibility/bankid/trusted-roots')

    expect(() => trustedBankIdRoots()).toThrow(/BANKID_ROOT_CERTIFICATES/)
  })
})

describe('skarpt läge får aldrig demofraserna', () => {
  it('prisma/seed.ts vägrar köra utanför demoläget, före varje databasåtkomst', () => {
    const seed = withoutComments(readFileSync('prisma/seed.ts', 'utf8'))
    const guard = seed.indexOf('assertSeedAllowed()')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(seed.indexOf('votesDb.party.upsert'))
  })

  it('entrypoint seedar bara i demoläget', () => {
    const entrypoint = readFileSync('docker/entrypoint.sh', 'utf8')
    expect(entrypoint).toMatch(/if \[ "\$DEMO_MODE" = "true" \]/)
  })
})
