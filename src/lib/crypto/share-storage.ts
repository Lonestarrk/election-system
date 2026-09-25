import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { parseScalar } from './group'

/**
 * Andelarna skyddas med AES-256-GCM under en nyckel härledd ur
 * FÖRTROENDEMANNENS LÖSENFRAS, aldrig ur appens miljö.
 *
 * Alternativet skyddar ingenting: en andel krypterad med en nyckel härledd ur
 * miljön (t.ex. IDENTITY_PEPPER) är läsbar för var och en som har databasen
 * och miljön — och appen behöver båda för att fungera, så en komprometterad
 * appserver ger båda på en gång. Tre andelar i samma låda är inte tre
 * innehavare. Lösenfrasen finns bara i förtroendemannens huvud och skickas
 * bara in vid det ögonblick andelen ska användas; den lagras aldrig.
 *
 * SALTET ÄR BÅDE OMRÖSTNINGENS ID OCH ANDELENS INDEX, INTE BARA INDEXET.
 *
 * Förtroendemän utses ofta om — samma person är sannolikt förtroendeman 1 i
 * flera val efter varandra, och en människa återanvänder sin fras. Saltades
 * bara på index (1, 2 eller 3, i evighet, i varje val systemet någonsin
 * skapar) skulle den återkommande förtroendemannens vanliga fras ge exakt
 * samma AES-nyckel varje gång, oavsett vilket val det gäller — och saltets
 * enda uppgift, att göra varje krypteringsoperation unik, vore om intet. Med
 * bara tre möjliga salt kan en angripare dessutom förberäkna scrypt över en
 * ordlista EN gång och sedan pröva den mot varje andel i varje val, i stället
 * för att behöva göra om det arbetet per val. Att väva in electionId gör
 * varje väls tre salt unika för just det valet.
 */

/**
 * SCRYPTS PARAMETRAR STÅR UTTRYCKLIGEN (ruling 66).
 *
 * Fram till uppgift 12 anropades scrypt utan parametrar, med Nodes förval.
 * Andelarna måste gå att låsa upp långt efter att de låstes, och ändrar en
 * framtida Node sitt förval blir varje lagrad andel oläslig, och inget val går
 * att räkna. Värdena är därför exakt Nodes förval i dag, så att andelar som
 * redan ligger i databasen öppnas som förut. tests/unit/crypto/share-storage.test.ts
 * låser upp en andel som låsts utan parametrar.
 */
export const SHARE_SCRYPT_PARAMETERS = { N: 16384, r: 8, p: 1 } as const

function keyFor(passphrase: string, electionId: string, trusteeIndex: number): Buffer {
  return scryptSync(passphrase, `trustee-share-${electionId}-${trusteeIndex}`, 32, SHARE_SCRYPT_PARAMETERS)
}

export function encryptShare(
  value: bigint,
  passphrase: string,
  electionId: string,
  trusteeIndex: number,
): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(passphrase, electionId, trusteeIndex), iv)
  const encrypted = Buffer.concat([cipher.update(value.toString(), 'utf8'), cipher.final()])

  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(
    ':',
  )
}

/**
 * Den lagrade formen: tolv byte IV, sexton byte tagg och klartextens byte,
 * som små hextecken, åtskilda av kolon. En andel är högst 617 siffror.
 */
const STORED_SHARE = /^[0-9a-f]{24}:[0-9a-f]{32}:(?:[0-9a-f]{2}){1,617}$/

/**
 * Vad som hände när andelen skulle låsas upp.
 *
 * `wrong_passphrase`  AES-GCM godtog inte nyckeln: frasen, valet eller indexet
 *                     är fel, eller så har den låsta andelen ändrats. Utan
 *                     nyckeln går de inte att skilja åt, och därför är svaret
 *                     detsamma.
 * `malformed`         den lagrade andelen har inte den form som
 *                     `encryptShare` skriver, eller så är klartexten inte en
 *                     exponent i [0, q). Det senare kan bara den som har
 *                     frasen ha låst in.
 */
export type UnlockedShare =
  | { status: 'unlocked'; value: bigint }
  | { status: 'wrong_passphrase' }
  | { status: 'malformed' }

/**
 * Låser upp andelen utan att kasta för det som kan hända en förtroendeperson.
 *
 * Frasen används bara här, till nyckeln, och lämnar aldrig funktionen. Varken
 * frasen eller andelen står i något svar eller i något fel.
 */
export function unlockShare(
  stored: string,
  passphrase: string,
  electionId: string,
  trusteeIndex: number,
): UnlockedShare {
  if (typeof stored !== 'string' || !STORED_SHARE.test(stored)) return { status: 'malformed' }
  const [iv, tag, payload] = stored.split(':')

  let plaintext: string
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyFor(passphrase, electionId, trusteeIndex),
      Buffer.from(iv!, 'hex'),
    )
    decipher.setAuthTag(Buffer.from(tag!, 'hex'))
    plaintext = Buffer.concat([decipher.update(Buffer.from(payload!, 'hex')), decipher.final()]).toString('utf8')
  } catch {
    return { status: 'wrong_passphrase' }
  }

  const value = parseScalar(plaintext)
  return value === null ? { status: 'malformed' } : { status: 'unlocked', value }
}

/** Som `unlockShare`, men kastar när andelen inte går att låsa upp. */
export function decryptShare(
  stored: string,
  passphrase: string,
  electionId: string,
  trusteeIndex: number,
): bigint {
  const unlocked = unlockShare(stored, passphrase, electionId, trusteeIndex)
  if (unlocked.status === 'wrong_passphrase') throw new Error('Frasen låser inte upp andelen.')
  if (unlocked.status === 'malformed') throw new Error('Den lagrade andelen har fel form.')
  return unlocked.value
}
