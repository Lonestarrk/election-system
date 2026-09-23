import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

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
 * Saltet är andelens index, så att två förtroendemän som råkar välja samma
 * fras ändå får olika nycklar.
 */
function keyFor(passphrase: string, trusteeIndex: number): Buffer {
  return scryptSync(passphrase, `trustee-share-${trusteeIndex}`, 32)
}

export function encryptShare(value: bigint, passphrase: string, trusteeIndex: number): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(passphrase, trusteeIndex), iv)
  const encrypted = Buffer.concat([cipher.update(value.toString(), 'utf8'), cipher.final()])

  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(
    ':',
  )
}

export function decryptShare(stored: string, passphrase: string, trusteeIndex: number): bigint {
  const [iv, tag, payload] = stored.split(':')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyFor(passphrase, trusteeIndex),
    Buffer.from(iv!, 'hex'),
  )
  decipher.setAuthTag(Buffer.from(tag!, 'hex'))

  return BigInt(
    Buffer.concat([decipher.update(Buffer.from(payload!, 'hex')), decipher.final()]).toString(
      'utf8',
    ),
  )
}
