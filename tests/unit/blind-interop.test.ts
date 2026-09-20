import { describe, expect, it } from 'vitest'
import { generateElectionKeyPair, signBlinded, verify } from '@/lib/blind-signature'
import {
  createBlindedCredential,
  unblindSignature,
  verifySignature,
} from '@/lib/blind-client'

/**
 * KLIENT OCH SERVER MÅSTE RÄKNA EXAKT LIKA.
 *
 * Blindningen sker i väljarens webbläsare med WebCrypto och BigInt.
 * Signeringen sker på servern med Nodes RSA. Det är två helt separata
 * implementationer av samma matematik, och om de skiljer sig på minsta punkt —
 * en annan MGF1-räkning, en annan padding, en byte fel i modulusbredden —
 * blir varje utfärdat röstintyg obrukbart.
 *
 * Det värsta är att felet inte skulle synas förrän en riktig väljare försöker
 * rösta. Servern skulle signera villigt, klienten avblinda villigt, och först
 * vid inlösen skulle signaturen visa sig ogiltig — efter att väljaren redan
 * markerats som röstande.
 */

const authority = generateElectionKeyPair()

describe('blindning i webbläsaren mot signering på servern', () => {
  it('ett intyg blindat på klienten och signerat på servern verifierar på båda sidor', async () => {
    // 1. Väljarens webbläsare skapar och blindar ett intyg.
    const credential = await createBlindedCredential(authority.publicKeyPem)

    // 2. Servern signerar det blindade värdet utan att se intyget.
    const blindSignature = signBlinded(credential.blinded, authority.privateKeyPem)

    // 3. Väljarens webbläsare avblindar.
    const signature = await unblindSignature(
      blindSignature,
      credential.blindingFactor,
      authority.publicKeyPem,
    )

    // 4. Båda sidor ska nu godta signaturen över intyget.
    await expect(
      verifySignature(credential.credentialId, signature, authority.publicKeyPem),
    ).resolves.toBe(true)

    expect(verify(credential.credentialId, signature, authority.publicKeyPem)).toBe(true)
  })

  it('servern ser aldrig intyget i det blindade värdet', async () => {
    const credential = await createBlindedCredential(authority.publicKeyPem)

    // Det enda servern tar emot är `blinded`. Intygsvärdet får inte gå att
    // läsa ur det.
    expect(credential.blinded).not.toContain(credential.credentialId)
    expect(credential.blinded).not.toEqual(credential.credentialId)
  })

  it('två intyg från samma nyckel blir olika och oberoende', async () => {
    const first = await createBlindedCredential(authority.publicKeyPem)
    const second = await createBlindedCredential(authority.publicKeyPem)

    expect(first.credentialId).not.toEqual(second.credentialId)
    expect(first.blinded).not.toEqual(second.blinded)

    // Signaturen för det ena intyget får inte gälla för det andra.
    const signature = await unblindSignature(
      signBlinded(first.blinded, authority.privateKeyPem),
      first.blindingFactor,
      authority.publicKeyPem,
    )

    expect(verify(first.credentialId, signature, authority.publicKeyPem)).toBe(true)
    expect(verify(second.credentialId, signature, authority.publicKeyPem)).toBe(false)
  })

  it('ett intyg för en valsedel gäller inte på en annan', async () => {
    /**
     * Bindningen till valsedel kommer från NYCKELN, inte från intygets
     * innehåll — myndigheten signerar blint och kan inte se vilken valsedel
     * det gäller. Utan eget nyckelpar per valsedel skulle en väljare kunna
     * begära tre intyg och lösa in alla tre på samma valsedel.
     */
    const kommunBallot = generateElectionKeyPair()
    const riksdagBallot = generateElectionKeyPair()

    const credential = await createBlindedCredential(kommunBallot.publicKeyPem)
    const signature = await unblindSignature(
      signBlinded(credential.blinded, kommunBallot.privateKeyPem),
      credential.blindingFactor,
      kommunBallot.publicKeyPem,
    )

    expect(verify(credential.credentialId, signature, kommunBallot.publicKeyPem)).toBe(true)
    expect(verify(credential.credentialId, signature, riksdagBallot.publicKeyPem)).toBe(false)
  })

  it('väljaren upptäcker om servern svarar med skräp i stället för en signatur', async () => {
    // Utan den här kontrollen på klienten skulle väljaren lämna in en
    // oanvändbar röst och upptäcka felet först när rösträtten redan är
    // förbrukad.
    const credential = await createBlindedCredential(authority.publicKeyPem)

    const garbage = 'ab'.repeat(256)
    const unblinded = await unblindSignature(
      garbage,
      credential.blindingFactor,
      authority.publicKeyPem,
    )

    await expect(
      verifySignature(credential.credentialId, unblinded, authority.publicKeyPem),
    ).resolves.toBe(false)
  })
})
