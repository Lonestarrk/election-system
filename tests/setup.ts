import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Laddar .env för testkörningen.
 *
 * Enkel egen parser i stället för dotenv: det är tjugo rader, och ett
 * beroende mindre i ett projekt vars hela poäng är att gå att granska.
 */

const envPath = resolve(process.cwd(), '.env')

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const separator = trimmed.indexOf('=')
    if (separator === -1) continue

    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '')

    if (!(key in process.env)) process.env[key] = value
  }
}

// Standardvärden så att enhetstesterna kan köras utan .env och utan databas.
process.env.IDENTITY_PEPPER ??= 'test-pepper-minst-trettiotva-tecken-langt-0000'
process.env.APP_ORIGIN ??= 'http://localhost:3000'
process.env.MOCK_BANKID_POLLS_UNTIL_COMPLETE ??= '0'
