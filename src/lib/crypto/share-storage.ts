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
function keyFor(passphrase: string, electionId: string, trusteeIndex: number): Buffer {
  return scryptSync(passphrase, `trustee-share-${electionId}-${trusteeIndex}`, 32)
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

export function decryptShare(
  stored: string,
  passphrase: string,
  electionId: string,
  trusteeIndex: number,
): bigint {
  const [iv, tag, payload] = stored.split(':')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyFor(passphrase, electionId, trusteeIndex),
    Buffer.from(iv!, 'hex'),
  )
  decipher.setAuthTag(Buffer.from(tag!, 'hex'))

  return BigInt(
    Buffer.concat([decipher.update(Buffer.from(payload!, 'hex')), decipher.final()]).toString(
      'utf8',
    ),
  )
}
