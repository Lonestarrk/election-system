/**
 * HÄMTAR BANKID:S PUBLIKA RP-CERTIFIKAT FÖR TESTMILJÖN (uppgift 17c).
 *
 *   npx tsx scripts/fetch-bankid-test-cert.ts [katalog]
 *
 * Certifikatet committas inte. Skriptet hämtar zip-filen från BankID, prövar den
 * mot en förankrad SHA-256, packar upp den med node:zlib och prövar varje fil mot
 * sin egen förankrade SHA-256. Förvald katalog är certs/bankid-test, som är
 * git-ignorerad.
 *
 * KÄLLA: developers.bankid.com/test-portal/test-information, avsnittet "Download a
 * certificate for test", hämtad 2026-10-03. Sidan länkar till
 * https://cdn.bankid.com/tools/FPTestcert5_20240703.zip och anger frasen
 * qwerty123. BankID publicerar ingen kontrollsumma. Summorna nedan räknades på
 * filen som hämtades från den adressen 2026-10-03, och förankrar alltså just den
 * filen: byter BankID certifikatet slutar skriptet fungera, och den nya filen
 * måste granskas och summorna bytas för hand.
 *
 * Certifikatet är publikt, och frasen står på BankID:s sida. Det ger ingen
 * behörighet utanför BankID:s testmiljö, och skarpt läge med BANKID_ENV=production
 * vägrar det (`rpCredentialProblem` i src/modules/eligibility/bankid/rp-certificate.ts).
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const SOURCE = 'https://cdn.bankid.com/tools/FPTestcert5_20240703.zip'
const ZIP_SHA256 = '62f3b661edce5095a692c083456dc20d72b1422e7b6682e55704fd61619ad4c2'

/** Filerna i zip-filen och deras summor, 2026-10-03. */
const FILES: Record<string, string> = {
  'FPTestcert5_20240610.p12': '0453c963ed432c1b9d6f96d6938684d47b79ffe94fa76fc8d94cc96ffa8840ac',
  'FPTestcert5_20240610.pem': '7efe6b8216bfd4fbac31ce54fe20f8dd1bb7c6a95b912efe1d3d0f3960641a2d',
  'FPTestcert5_20240610-legacy.pfx.pfx': '64e5473d6391884fae7e2c82b2a581b221682048815b926634245ab4303d4327',
  'README.md': '0c5f7b8ac6e2012e775459cac6c8348d6ebf66912e2bb1d439e2c6c93b369bcd',
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** Packar upp en zip-fil ur centralkatalogen. Bara lagrade och deflate-komprimerade filer, som BankID:s. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const END = 0x06054b50
  let end = -1
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 22 - 0xffff); offset -= 1) {
    if (zip.readUInt32LE(offset) === END) {
      end = offset
      break
    }
  }
  if (end === -1) throw new Error('Zip-filen saknar en centralkatalog.')

  const count = zip.readUInt16LE(end + 10)
  let entry = zip.readUInt32LE(end + 16)
  const files = new Map<string, Buffer>()

  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(entry) !== 0x02014b50) throw new Error('Trasig post i zip-filens centralkatalog.')
    const method = zip.readUInt16LE(entry + 10)
    const compressedSize = zip.readUInt32LE(entry + 20)
    const nameLength = zip.readUInt16LE(entry + 28)
    const extraLength = zip.readUInt16LE(entry + 30)
    const commentLength = zip.readUInt16LE(entry + 32)
    const localHeader = zip.readUInt32LE(entry + 42)
    const name = zip.subarray(entry + 46, entry + 46 + nameLength).toString('utf8')

    if (zip.readUInt32LE(localHeader) !== 0x04034b50) throw new Error(`Trasig lokal post för ${name}.`)
    const dataStart = localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28)
    const data = zip.subarray(dataStart, dataStart + compressedSize)

    if (method === 0) files.set(name, Buffer.from(data))
    else if (method === 8) files.set(name, inflateRawSync(data))
    else throw new Error(`${name} är komprimerad med metod ${method}, som skriptet inte läser.`)

    entry += 46 + nameLength + extraLength + commentLength
  }
  return files
}

async function main(): Promise<void> {
  const directory = resolve(process.argv[2] ?? join('certs', 'bankid-test'))

  const response = await fetch(SOURCE)
  if (!response.ok) throw new Error(`${SOURCE} svarade ${response.status}.`)
  const zip = Buffer.from(await response.arrayBuffer())

  const actual = sha256(zip)
  if (actual !== ZIP_SHA256) {
    throw new Error(
      `Zip-filen har SHA-256 ${actual}, och den förankrade är ${ZIP_SHA256}. Ingenting skrevs. ` +
        'Har BankID bytt certifikat måste den nya filen granskas och summorna i skriptet bytas.',
    )
  }

  const files = unzip(zip)
  const names = [...files.keys()].sort()
  if (names.join('\n') !== Object.keys(FILES).sort().join('\n')) {
    throw new Error(`Zip-filen innehåller ${names.join(', ')}, inte de förväntade filerna.`)
  }
  for (const [name, expected] of Object.entries(FILES)) {
    if (sha256(files.get(name)!) !== expected) throw new Error(`${name} har fel SHA-256. Ingenting skrevs.`)
  }

  mkdirSync(directory, { recursive: true })
  for (const [name, bytes] of files) writeFileSync(join(directory, name), bytes)

  process.stdout.write(
    `BankID:s testcertifikat ligger i ${directory}.\n` +
      `  BANKID_CERT_PATH=${join(directory, 'FPTestcert5_20240610.p12')}\n` +
      '  BANKID_CERT_PASSPHRASE=qwerty123\n' +
      'Frasen är BankID:s publika för testcertifikatet.\n',
  )
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`)
  process.exit(1)
})
