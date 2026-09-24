import { describe, expect, it } from 'vitest'
import {
  derChildren,
  readDerElement,
  readTbsCertificate,
  splitDerSequences,
} from '@/modules/eligibility/bankid/der-reader'

/**
 * DEN STRIKTA DER-LÄSAREN.
 *
 * Läsaren tolkar två saker som kan komma ur databasen förbi varje schema: den
 * dekrypterade certifikatkedjan, som ska delas upp i sina certifikat, och
 * lövets keyUsage och serialNumber, som node:crypto inte lämnar ut. En läsare
 * som gissar, läser utanför bufferten eller godtar två kodningar av samma sak
 * vore precis den sortens tolkning som uppgift 14b tog bort ur valsedlarna.
 *
 * Förväntade värden är handräknade ur bytena i varje test.
 */

const bytes = (...values: number[]) => Uint8Array.from(values)

describe('ett element', () => {
  it('läser kort längd', () => {
    // 30 03 | 02 01 05: en SEQUENCE med ett INTEGER 5.
    const der = bytes(0x30, 0x03, 0x02, 0x01, 0x05)

    expect(readDerElement(der, 0)).toEqual({ tag: 0x30, start: 0, contentStart: 2, end: 5 })
  })

  it('läser lång längd', () => {
    // 04 81 80 och 128 byte innehåll: längden står i en egen byte efter 0x81.
    const der = new Uint8Array(3 + 128)
    der.set([0x04, 0x81, 0x80])

    expect(readDerElement(der, 0)).toEqual({ tag: 0x04, start: 0, contentStart: 3, end: 131 })
  })

  it('läser ett element mitt i en buffert', () => {
    const der = bytes(0xff, 0xff, 0x02, 0x01, 0x07, 0xff)

    expect(readDerElement(der, 2, 5)).toEqual({ tag: 0x02, start: 2, contentStart: 4, end: 5 })
  })

  it('avvisar obestämd längd, som DER förbjuder', () => {
    expect(readDerElement(bytes(0x30, 0x80, 0x00, 0x00), 0)).toBeNull()
  })

  it('avvisar en lång längd som hade fått plats i den korta formen', () => {
    // 5 ska skrivas 05, inte 81 05. Två kodningar av samma längd är två sätt
    // att skriva samma certifikat, och då är bytena inte längre entydiga.
    expect(readDerElement(bytes(0x04, 0x81, 0x05, 1, 2, 3, 4, 5), 0)).toBeNull()
  })

  it('avvisar en lång längd med inledande nolla', () => {
    const der = new Uint8Array(4 + 128)
    der.set([0x04, 0x82, 0x00, 0x80])

    expect(readDerElement(der, 0)).toBeNull()
  })

  it('avvisar en längd som går förbi slutet', () => {
    expect(readDerElement(bytes(0x30, 0x05, 0x02, 0x01), 0)).toBeNull()
    expect(readDerElement(bytes(0x04, 0x82, 0x01), 0)).toBeNull()
    expect(readDerElement(bytes(0x30), 0)).toBeNull()
  })

  it('avvisar en längd som går förbi gränsen, fast bufferten räcker', () => {
    expect(readDerElement(bytes(0x02, 0x02, 0x01, 0x02), 0, 3)).toBeNull()
  })

  it('avvisar höga taggnummer, som inget certifikat använder', () => {
    expect(readDerElement(bytes(0x1f, 0x81, 0x00, 0x00), 0)).toBeNull()
  })

  it('avvisar en förskjutning utanför bufferten', () => {
    const der = bytes(0x02, 0x01, 0x05)

    expect(readDerElement(der, 3)).toBeNull()
    expect(readDerElement(der, -1)).toBeNull()
    expect(readDerElement(der, 0.5)).toBeNull()
  })
})

describe('barnen i ett sammansatt element', () => {
  it('räknar upp dem i ordning', () => {
    // 30 06 | 02 01 01 | 02 01 02
    const der = bytes(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02)
    const parent = readDerElement(der, 0)!

    expect(derChildren(der, parent)).toEqual([
      { tag: 0x02, start: 2, contentStart: 4, end: 5 },
      { tag: 0x02, start: 5, contentStart: 7, end: 8 },
    ])
  })

  it('avvisar ett barn som går förbi föräldern', () => {
    // Föräldern är tre byte lång, men barnet påstår två byte innehåll efter
    // sitt eget huvud, och den sista av dem ligger utanför.
    const der = bytes(0x30, 0x03, 0x02, 0x02, 0x05, 0x06)

    expect(derChildren(der, readDerElement(der, 0)!)).toBeNull()
  })

  it('avvisar ett primitivt element, vars innehåll inte är struktur', () => {
    // En OCTET STRING som råkar innehålla bytes som ser ut som ett INTEGER.
    const der = bytes(0x04, 0x03, 0x02, 0x01, 0x05)

    expect(derChildren(der, readDerElement(der, 0)!)).toBeNull()
  })
})

describe('en kedja av certifikat efter varandra', () => {
  it('delas upp i sina delar', () => {
    const der = bytes(0x30, 0x01, 0x05, 0x30, 0x02, 0x06, 0x07)

    expect(splitDerSequences(der)?.map((part) => [...part])).toEqual([
      [0x30, 0x01, 0x05],
      [0x30, 0x02, 0x06, 0x07],
    ])
  })

  it('avvisar skräp efter sista delen', () => {
    expect(splitDerSequences(bytes(0x30, 0x01, 0x05, 0x00))).toBeNull()
  })

  it('avvisar en del som inte är en SEQUENCE', () => {
    expect(splitDerSequences(bytes(0x30, 0x01, 0x05, 0x04, 0x01, 0x05))).toBeNull()
  })

  it('avvisar en tom buffert', () => {
    expect(splitDerSequences(new Uint8Array(0))).toBeNull()
  })
})

describe('TBSCertificate', () => {
  /**
   * Ett handbyggt certifikat, utan riktiga värden men med rätt form:
   *
   *   30 ..                                   Certificate
   *     30 ..                                 TBSCertificate
   *       a0 03 02 01 02                      version v3
   *       02 01 01                            serialNumber
   *       30 00                               signature
   *       30 02 31 00                         issuer
   *       30 00                               validity
   *       30 04 31 02 30 00                   subject
   *       30 00                               subjectPublicKeyInfo
   *       a3 06 30 04 30 02 06 00             extensions, en post
   *     30 00                                 signatureAlgorithm
   *     03 01 00                              signatureValue
   */
  const TBS_FIELDS = [
    [0xa0, 0x03, 0x02, 0x01, 0x02],
    [0x02, 0x01, 0x01],
    [0x30, 0x00],
    [0x30, 0x02, 0x31, 0x00],
    [0x30, 0x00],
    [0x30, 0x04, 0x31, 0x02, 0x30, 0x00],
    [0x30, 0x00],
    [0xa3, 0x06, 0x30, 0x04, 0x30, 0x02, 0x06, 0x00],
  ]

  function certificate(fields: number[][], trailer: number[] = []): Uint8Array {
    const tbsContent = fields.flat()
    const tbs = [0x30, tbsContent.length, ...tbsContent]
    const content = [...tbs, 0x30, 0x00, 0x03, 0x01, 0x00]
    return Uint8Array.from([0x30, content.length, ...content, ...trailer])
  }

  it('hittar utfärdare, subject och tilläggen', () => {
    const tbs = readTbsCertificate(certificate(TBS_FIELDS))

    // Certificate 2 byte, TBSCertificate 2, version 5, serienummer 3 och
    // algoritm 2: utfärdaren börjar på 14, giltighetstiden på 18 och subject
    // på 20. Nyckeln ligger på 26 och tilläggen på 28, och deras enda post
    // kommer efter a3 06 30 04, alltså på 32.
    expect(tbs?.issuer).toEqual({ tag: 0x30, start: 14, contentStart: 16, end: 18 })
    expect(tbs?.subject).toEqual({ tag: 0x30, start: 20, contentStart: 22, end: 26 })
    expect(tbs?.extensions).toEqual([{ tag: 0x30, start: 32, contentStart: 34, end: 36 }])
  })

  it('läser ett certifikat utan version och utan tillägg', () => {
    const tbs = readTbsCertificate(certificate(TBS_FIELDS.slice(1, 7)))

    // Utan versionens fem byte börjar subject fem byte tidigare.
    expect(tbs?.subject.start).toBe(15)
    expect(tbs?.extensions).toEqual([])
  })

  it('avvisar skräp efter certifikatet', () => {
    expect(readTbsCertificate(certificate(TBS_FIELDS, [0x00]))).toBeNull()
  })

  it('avvisar ett okänt fält efter tilläggen', () => {
    expect(readTbsCertificate(certificate([...TBS_FIELDS, [0x02, 0x01, 0x00]]))).toBeNull()
  })

  it('avvisar två fält med tillägg', () => {
    expect(readTbsCertificate(certificate([...TBS_FIELDS, TBS_FIELDS[7]!]))).toBeNull()
  })

  it('avvisar ett certifikat där ett obligatoriskt fält saknas', () => {
    expect(readTbsCertificate(certificate(TBS_FIELDS.filter((_, index) => index !== 6)))).toBeNull()
  })
})
