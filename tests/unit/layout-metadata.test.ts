import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Sidans metabeskrivning ska stämma med spec 10 (uppgift 17, fixrunda 1).
 *
 * Kopplingen mellan väljare och röst finns medan röstningen pågår, och raderas
 * vid stängningen. Beskrivningen får därför inte lova att den "aldrig" finns.
 */
describe('layout.tsx', () => {
  const source = readFileSync('src/app/layout.tsx', 'utf8')
  const description = source.match(/description:\s*([\s\S]*?),\n\s*\/\//)?.[1] ?? ''

  it('har en beskrivning', () => {
    expect(description.length).toBeGreaterThan(20)
  })

  it('lovar inte att kopplingen aldrig finns', () => {
    expect(description).not.toMatch(/aldrig/i)
    expect(description).not.toMatch(/kan kopplas ihop/)
  })

  it('säger inte att namn och röst hålls isär, eftersom de är kopplade före stängningen', () => {
    expect(description).not.toMatch(/hålls isär|isär/)
    expect(description).not.toMatch(/dubbla kuvert: väljarens namn/)
  })

  it('säger att kopplingen finns tills stängningen', () => {
    expect(description).toMatch(/stängning/)
  })
})
