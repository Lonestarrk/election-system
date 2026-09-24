import { execFileSync } from 'node:child_process'
import { createPrivateKey, randomBytes, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * SKAPAR ATTRAPPENS BANKID-ROT OCH DESS UTFÄRDANDE MELLANNIVÅ, MED OPENSSL.
 *
 *   npx tsx scripts/generate-mock-bankid-ca.ts                  vägrar skriva över
 *                                                               befintliga fixturer
 *   npx tsx scripts/generate-mock-bankid-ca.ts --ersatt         skriver över dem
 *   npx tsx scripts/generate-mock-bankid-ca.ts --katalog <dir>  skriver någon
 *                                                               annanstans, för att
 *                                                               pröva skriptet
 *
 * Resultatet är två testfixturer i src/modules/eligibility/bankid/mock-ca:
 * rotcertifikatet (root-certificate.ts) och mellannivåns certifikat med dess
 * privata nyckel (issuing-ca-test-key.ts). Attrappen utfärdar väljarnas
 * certifikat med mellannivån, och i demoläget prövas varje kedja mot roten.
 *
 * Mellannivåns nyckel är en testnyckel och inte hemlig, och både filnamnet och
 * filens första rad säger det. En hemlighetsskanner larmar på den vid push, och
 * larmet ska gå att avfärda utan att någon behöver läsa koden.
 *
 * ROTENS PRIVATA NYCKEL KASTAS.
 *
 * Den behövs bara för att utfärda mellannivån, och skriptet skriver över den
 * med slumpdata och tar bort den så fort det är gjort. Därefter kan ingen
 * utfärda en ny mellannivå under roten, inte heller den som kör skriptet. Det
 * är det som gör testerna meningsfulla: en kedja som inte går genom attrappens
 * egen mellannivå underkänns, och det finns ingen nyckel i repot som kan ändra
 * på det. tests/unit/bankid/mock-ca-fixture.test.ts prövar att ingen incheckad
 * nyckel hör till roten.
 *
 * ATT KÖRA OM SKRIPTET GER EN NY ROT.
 *
 * Varje kuvert som redan ligger i en databas bär en kedja till den gamla roten
 * och underkänns av valideringen före stängningen. I utvecklingsdatabasen är
 * det ofarligt, eftersom väljaren bara behöver rösta igen, men det är skälet
 * till att skriptet inte skriver över utan --ersatt.
 *
 * openssl hittas i PATH, eller i miljövariabeln OPENSSL.
 */

const OUTPUT_DIRECTORY = 'src/modules/eligibility/bankid/mock-ca'
const ROOT_FILE = 'root-certificate.ts'
const ISSUING_FILE = 'issuing-ca-test-key.ts'

/** Tjugo år, så att demon inte slutar fungera av sig själv. Mellannivån går ut fem dagar före roten. */
const ROOT_VALIDITY_DAYS = 7305
const INTERMEDIATE_VALIDITY_DAYS = 7300

const ROOT_CONFIG = `[req]
distinguished_name = dn
prompt = no
utf8 = yes
string_mask = utf8only

[dn]
C = SE
O = Valsystemets attrapp
CN = Attrappens BankID-rot, testfixtur, aldrig i drift

[root]
basicConstraints = critical, CA:TRUE, pathlen:1
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
`

const INTERMEDIATE_CONFIG = `[req]
distinguished_name = dn
prompt = no
utf8 = yes
string_mask = utf8only

[dn]
C = SE
O = Valsystemets attrapp
CN = Attrappens BankID-utfärdare, testfixtur, aldrig i drift

[intermediate]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
`

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function openssl(args: string[], cwd: string): string {
  return execFileSync(process.env.OPENSSL ?? 'openssl', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Ett positivt serienummer på 16 slumpade byte, som openssl vill ha det. */
function serialNumber(): string {
  const bytes = randomBytes(16)
  bytes[0]! &= 0x7f
  return `0x${bytes.toString('hex')}`
}

/** Skriver över filen med slumpdata innan den tas bort, så att nyckeln inte ligger kvar på disken. */
function destroy(path: string): void {
  writeFileSync(path, randomBytes(statSync(path).size))
  rmSync(path)
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Det genererade stämmer inte: ${message}`)
}

function rootModule(pem: string, fingerprint: string, created: string): string {
  return `/**
 * TESTFIXTUR: ATTRAPPENS BANKID-ROT. ALDRIG I DRIFT.
 *
 * Skapad av scripts/generate-mock-bankid-ca.ts med openssl, ${created}.
 * Redigera inte för hand, kör skriptet igen.
 *
 * I demoläget prövas varje BankID-kedja mot den här roten, se
 * ../trusted-roots.ts. Rotens privata nyckel finns inte: skriptet skrev över
 * den och tog bort den så fort mellannivån var utfärdad. Därför kan ingen
 * utfärda en ny mellannivå under roten, och bara attrappens egen mellannivå,
 * ./issuing-ca-test-key.ts, kan utfärda certifikat som roten godtar.
 *
 * Skarpt läge får aldrig lita på den här roten, se UPPGIFT 17 i
 * ../trusted-roots.ts.
 *
 * Fingeravtryck, SHA-256: ${fingerprint}
 */
export const MOCK_BANKID_ROOT_CERTIFICATE = \`${pem}\`
`
}

function issuingModule(certificatePem: string, keyPem: string, created: string): string {
  return `/**
 * TESTNYCKEL, INTE HEMLIG. HÖR BARA TILL BANKID-ATTRAPPEN OCH ANVÄNDS ALDRIG I DRIFT.
 *
 * Larmar en hemlighetsskanner på den privata nyckeln nedan kan larmet avfärdas.
 * Nyckeln är attrappens egen utfärdande mellannivå, incheckad med avsikt så att
 * attrappen är självständig. Den ger ingen åtkomst till något system: den kan
 * bara utfärda certifikat som attrappens egen rot godtar, och den roten litar
 * bara demoläget på.
 *
 * Skapad av scripts/generate-mock-bankid-ca.ts med openssl, ${created}.
 * Redigera inte för hand, kör skriptet igen.
 *
 * VARFÖR DEN ÄR INCHECKAD.
 *
 * Attrappen utfärdar ett certifikat vid varje underskrift, som BankID:s CA
 * gör, och till det behöver den nyckeln. Följden står i
 * src/lib/known-limitations.ts: i demoläget kan den som driver demon utfärda
 * ett giltigt certifikat för vem som helst och förfalska en underskrift.
 * Skyddet gäller med riktig BankID, där nyckeln finns hos BankID och inte hos
 * den som driver systemet.
 *
 * Bara attrappen och testerna får importera filen, och
 * tests/security/module-boundaries.test.ts kräver det.
 */
export const MOCK_BANKID_INTERMEDIATE_CERTIFICATE = \`${certificatePem}\`

export const MOCK_BANKID_INTERMEDIATE_PRIVATE_KEY = \`${keyPem}\`
`
}

function main(): void {
  const directory = resolve(argument('--katalog') ?? OUTPUT_DIRECTORY)
  const rootPath = join(directory, ROOT_FILE)
  const issuingPath = join(directory, ISSUING_FILE)

  if ((existsSync(rootPath) || existsSync(issuingPath)) && !process.argv.includes('--ersatt')) {
    throw new Error(
      `Fixturerna finns redan i ${directory}. En ny rot gör varje liggande kuvert med en kedja ` +
        'till den gamla ogiltigt. Kör med --ersatt om det är meningen.',
    )
  }

  const work = mkdtempSync(join(tmpdir(), 'attrapp-bankid-ca-'))

  try {
    writeFileSync(join(work, 'root.cnf'), ROOT_CONFIG, 'utf8')
    writeFileSync(join(work, 'intermediate.cnf'), INTERMEDIATE_CONFIG, 'utf8')

    openssl(['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', 'root.key'], work)
    // prettier-ignore
    openssl(['req', '-new', '-x509', '-config', 'root.cnf', '-extensions', 'root', '-key', 'root.key',
      '-sha256', '-days', String(ROOT_VALIDITY_DAYS), '-set_serial', serialNumber(), '-out', 'root.pem'], work)

    openssl(
      ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', 'intermediate.key'],
      work,
    )
    // prettier-ignore
    openssl(['req', '-new', '-config', 'intermediate.cnf', '-key', 'intermediate.key',
      '-out', 'intermediate.csr'], work)
    // prettier-ignore
    openssl(['x509', '-req', '-in', 'intermediate.csr', '-CA', 'root.pem', '-CAkey', 'root.key',
      '-extfile', 'intermediate.cnf', '-extensions', 'intermediate', '-sha256',
      '-days', String(INTERMEDIATE_VALIDITY_DAYS), '-set_serial', serialNumber(),
      '-out', 'intermediate.pem'], work)

    // Rotens nyckel har gjort sitt. Den kastas innan något annat görs.
    destroy(join(work, 'root.key'))
    check(!existsSync(join(work, 'root.key')), 'rotens privata nyckel finns kvar')

    // openssl själv, och sedan node:crypto, som systemet prövar kedjan med.
    const verified = openssl(['verify', '-CAfile', 'root.pem', 'intermediate.pem'], work)
    check(verified.trim().endsWith('OK'), `openssl verify svarade ${verified.trim()}`)

    const rootPem = readFileSync(join(work, 'root.pem'), 'utf8').replace(/\r\n/g, '\n')
    const intermediatePem = readFileSync(join(work, 'intermediate.pem'), 'utf8').replace(/\r\n/g, '\n')
    const keyPem = readFileSync(join(work, 'intermediate.key'), 'utf8').replace(/\r\n/g, '\n')

    const root = new X509Certificate(rootPem)
    const intermediate = new X509Certificate(intermediatePem)
    check(root.ca && root.checkIssued(root) && root.verify(root.publicKey), 'roten är ingen självsignerad CA')
    check(intermediate.ca, 'mellannivån är ingen CA')
    check(
      intermediate.checkIssued(root) && intermediate.verify(root.publicKey),
      'mellannivån är inte utfärdad av roten',
    )
    check(intermediate.checkPrivateKey(createPrivateKey(keyPem)), 'nyckeln hör inte till mellannivån')
    check(!/PRIVATE KEY/.test(rootPem + intermediatePem), 'ett certifikat bär en privat nyckel')

    const created = new Date().toISOString().slice(0, 10)
    mkdirSync(directory, { recursive: true })
    writeFileSync(rootPath, rootModule(rootPem, root.fingerprint256, created), 'utf8')
    writeFileSync(issuingPath, issuingModule(intermediatePem, keyPem, created), 'utf8')

    console.log(`Roten:       ${root.subject.replace(/\n/g, ', ')}`)
    console.log(`             SHA-256 ${root.fingerprint256}`)
    console.log(`Mellannivån: ${intermediate.subject.replace(/\n/g, ', ')}`)
    console.log(`Giltiga till ${root.validToDate.toISOString()} respektive ${intermediate.validToDate.toISOString()}.`)
    console.log('Rotens privata nyckel är överskriven och borttagen.')
    console.log(`Skrev ${rootPath} och ${issuingPath}.`)
  } finally {
    // Allt annat i arbetskatalogen, också mellannivåns nyckelfil, som nu finns i fixturen.
    rmSync(work, { recursive: true, force: true })
  }
}

main()
