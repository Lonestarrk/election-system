import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CURRENTLY } from '@/app/architecture/code-facts'
import { KNOWN_LIMITATIONS } from '@/lib/known-limitations'
import { signingText } from '@/modules/eligibility/bankid/envelope-signature'

/**
 * TEXTERNA OM BANKID:S KOPIA (fixrunda 1 av uppgift 11e, ruling 138 och 141).
 *
 * BankID:s kopia bär valsedelns id och väljarens personnummer. På en valsedel
 * med så få röster att summan visar dem pekar den därför ut rösten, salt eller
 * inte. Varje text som säger att kopian inte går att matcha ska säga det.
 */

/** Filens text med radbrytningar och indrag ihopslagna, som en läsare ser den. */
function prose(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf8').replace(/\s+/g, ' ')
}

const QUALIFIER = 'utom när valsedeln har så få röster att summan visar dem'

describe('texterna om BankID:s kopia lovar inte för mycket', () => {
  it.each([
    'src/app/architecture/sections/Weaknesses.tsx',
    'src/app/architecture/sections/WhatItDoesNotGive.tsx',
    'src/app/architecture/FollowAVote.tsx',
    'src/app/architecture/sections/Phases.tsx',
    'src/app/architecture/sections/FromMetaphorToTechnology.tsx',
  ])('%s avgränsar påståendet till valsedlar med tillräckligt många röster', (file) => {
    expect(prose(file)).toContain(QUALIFIER)
  })

  it('påståendet om kopior i metadatatabellen gör det också', () => {
    expect(CURRENTLY.copiesKeepLink.text).toContain(QUALIFIER)
  })

  it('posten om vad BankID vet finns och hänvisar till posten om valsedlar med en röst', () => {
    const post = KNOWN_LIMITATIONS.find((entry) => entry.id === 'bankid-knows-who-voted')
    const single = KNOWN_LIMITATIONS.find((entry) => entry.id === 'single-row-ballot-publishes-the-vote')

    expect(post, 'posten saknas').toBeDefined()
    expect(post!.stillTrueIf, 'posten saknar markör').toBeDefined()
    expect(post!.why).toMatch(/vilken valsedel/)
    expect(post!.why).toMatch(/hur många gånger/)
    expect(post!.why).toContain(single!.title)
  })
})

describe('röstsidan beskriver texten i BankID-appen som den är', () => {
  it('inte den gamla texten, och samma löfte som signingText', () => {
    const page = prose('src/app/vote/BankIdSigning.tsx')

    expect(page).not.toContain('Bekräfta din röst')
    expect(signingText('Valet 2026', 'RIKSDAG')).toContain('det visar inte vad jag har röstat på')
    expect(page).toContain('det visar inte vad du har röstat på')
  })
})

describe('granskarens lista beskriver kuvertroten som den räknas', () => {
  it('bladet är chifferhash, salt och signatur', () => {
    const rows = prose('src/app/architecture/sections/review-rows.tsx')

    expect(rows).not.toContain('par av chifferhash och signatur')
    expect(rows).toContain('chifferhash, salt och signatur')
  })
})
