import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Q } from '@/lib/crypto/group'
import {
  decryptShare,
  encryptShare,
  SHARE_SCRYPT_PARAMETERS,
  unlockShare,
} from '@/lib/crypto/share-storage'

/**
 * ANDELARNA MÅSTE GÅ ATT ÖPPNA LÅNGT SENARE (ruling 66).
 *
 * Andelarna låstes fram till uppgift 12 med scrypt och Nodes förvalda
 * parametrar, utan att de stod någonstans. Ändrar en framtida Node sitt förval
 * blir varje lagrad andel oläslig, och inget val går att räkna. Parametrarna
 * står därför uttryckligen, med exakt de värden förvalet har i dag, och
 * testerna visar att andelar låsta på det gamla sättet fortfarande öppnas.
 */

/** Andelen låst som koden gjorde före uppgift 12: scrypt utan parametrar. */
function lockedTheOldWay(plaintext: string, passphrase: string, electionId: string, trusteeIndex: number): string {
  const key = scryptSync(passphrase, `trustee-share-${electionId}-${trusteeIndex}`, 32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(':')
}

describe('andelens nyckel', () => {
  it('parametrarna är Nodes förval, uttryckligen', () => {
    expect(SHARE_SCRYPT_PARAMETERS).toEqual({ N: 16384, r: 8, p: 1 })
    expect(scryptSync('fras', 'salt', 32, SHARE_SCRYPT_PARAMETERS).equals(scryptSync('fras', 'salt', 32))).toBe(true)
  })

  it('en andel låst med de uttryckliga parametrarna öppnas med standardanropet', () => {
    const stored = encryptShare(123456789n, 'fras-for-provet', 'val-id', 2)
    const [iv, tag, payload] = stored.split(':')
    const decipher = createDecipheriv(
      'aes-256-gcm',
      scryptSync('fras-for-provet', 'trustee-share-val-id-2', 32),
      Buffer.from(iv!, 'hex'),
    )
    decipher.setAuthTag(Buffer.from(tag!, 'hex'))

    expect(Buffer.concat([decipher.update(Buffer.from(payload!, 'hex')), decipher.final()]).toString('utf8')).toBe(
      '123456789',
    )
  })

  it('en andel låst på det gamla sättet öppnas av koden', () => {
    const stored = lockedTheOldWay('987654321', 'fras', 'val', 2)
    expect(decryptShare(stored, 'fras', 'val', 2)).toBe(987654321n)
    expect(unlockShare(stored, 'fras', 'val', 2)).toEqual({ status: 'unlocked', value: 987654321n })
  })
})

describe('att låsa upp en andel', () => {
  const stored = encryptShare(42n, 'rätt fras', 'val', 1)

  it('fel fras, fel val och fel index låser inte upp andelen', () => {
    expect(unlockShare(stored, 'fel fras', 'val', 1)).toEqual({ status: 'wrong_passphrase' })
    expect(unlockShare(stored, 'rätt fras', 'annat val', 1)).toEqual({ status: 'wrong_passphrase' })
    expect(unlockShare(stored, 'rätt fras', 'val', 2)).toEqual({ status: 'wrong_passphrase' })
    expect(unlockShare(stored, 'rätt fras', 'val', 1)).toEqual({ status: 'unlocked', value: 42n })
  })

  it('en lagrad andel med fel form är trasig, inte en fel fras', () => {
    for (const broken of ['', 'a:b', 'inte:hex:alls', `${stored}:extra`, `zz${stored.slice(2)}`, stored.toUpperCase()]) {
      expect(unlockShare(broken, 'rätt fras', 'val', 1), broken).toEqual({ status: 'malformed' })
    }
  })

  it('en klartext som inte är en exponent i [0, q) räknas inte, fast frasen stämmer', () => {
    // Bara den som har frasen kan låsa in en sådan andel. Den ska ändå inte
    // bli en exponent, som ett negativt tal en gång blev en etta.
    for (const text of ['-5', 'inte-ett-tal', Q.toString(), '007', '']) {
      expect(unlockShare(lockedTheOldWay(text, 'fras', 'val', 1), 'fras', 'val', 1), text).toEqual({
        status: 'malformed',
      })
    }
  })
})
