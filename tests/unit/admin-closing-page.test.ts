import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CertifyStep } from '@/app/admin/CertifyStep'
import { CloseStep } from '@/app/admin/CloseStep'
import type { CloseView, ElectionOverview } from '@/app/admin/types'
import { DEMO_ELECTION_NAME, demoElectionWindow } from '@/lib/demo-election'

/**
 * Hur adminsidan återger stängningens utfall (uppgift 12c, fixrunda 1).
 *
 * Sidan visar serverns besked ordagrant och påstår inget om fasen på egen hand:
 * fasen läses ur översikten. "Godkända" och "Underkända" hör bara till
 * `validation_failed`, där valideringen själv föll. Vid `invalid_ballot` har
 * valideringen passerat och omverifieringen före skalningen fallit, och att då
 * skriva "godkända N" vore motsatsen till vad servern säger.
 */

function overview(over: Partial<ElectionOverview> = {}): ElectionOverview {
  return {
    electionId: 'e1',
    name: 'Val',
    phase: 'CLOSED',
    underReview: false,
    opensAt: '2026-10-01T00:00:00.000Z',
    closesAt: '2026-10-02T00:00:00.000Z',
    waitingEnvelopes: 3,
    urnEnvelopes: 0,
    envelopeRoot: null,
    urnRoot: null,
    linkCleared: false,
    trusteeCount: 3,
    trusteeThreshold: 2,
    ballots: [],
    trusteesReady: [],
    ...over,
  }
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ')
}

function renderClose(view: CloseView | null, over: Partial<ElectionOverview> = {}): string {
  return text(
    renderToStaticMarkup(
      createElement(CloseStep, { overview: overview(over), closeView: view, busy: false, onClose: () => {} }),
    ),
  )
}

const passedSummary = { votes: 5, voters: 5, rejected: 0, byKind: {}, passed: true }

describe('stängningens utfall på sidan', () => {
  it('invalid_ballot säger inte godkända eller underkända, och återger serverns besked', () => {
    const page = renderClose({
      status: 'invalid_ballot',
      httpStatus: 409,
      message: 'Minst en valsedel verifierar inte längre.',
      summary: passedSummary,
      ciphertextHash: 'ab'.repeat(32),
    })

    expect(page).toContain('Minst en valsedel verifierar inte längre.')
    expect(page).not.toMatch(/Godkända/)
    expect(page).not.toMatch(/Underkända/)
    expect(page).toMatch(/omverifieringen/)
    expect(page).not.toContain('Ingenting har flyttats')
  })

  it('validation_failed visar godkända och underkända med koderna', () => {
    const page = renderClose({
      status: 'validation_failed',
      httpStatus: 409,
      message: 'Valideringen hittade avvikelser.',
      summary: { votes: 5, voters: 5, rejected: 2, byKind: { BAD_PROOF: 2 }, passed: false },
    })

    expect(page).toMatch(/Godkända: 3/)
    expect(page).toMatch(/Underkända: 2/)
    expect(page).toContain('BAD_PROOF')
  })

  it.each(['in_progress', 'aborted', 'too_early'])('%s har inga fasta påståenden om fasen eller om valideringen', (status) => {
    const page = renderClose({ status, httpStatus: 409, message: 'Serverns eget besked.' })

    expect(page).toContain('Serverns eget besked.')
    expect(page).not.toMatch(/Godkända|Underkända/)
    expect(page).not.toContain('Ingenting har flyttats')
    expect(page).not.toContain('står i CLOSED')
  })

  it('visar kuvertroten och urnroten ur översikten när kopplingen är raderad, också utan ett nyss gjort anrop', () => {
    const page = renderClose(null, {
      phase: 'STRIPPED',
      linkCleared: true,
      envelopeRoot: 'e'.repeat(64),
      urnRoot: 'u'.repeat(64),
    })

    expect(page).toContain('e'.repeat(64))
    expect(page).toContain('u'.repeat(64))
  })
})

describe('slutkontrollens text', () => {
  it('lovar inte att kontrollen fortsätter utan villkor, och nämner huvudtråden', () => {
    const page = text(
      renderToStaticMarkup(
        createElement(CertifyStep, {
          overview: overview({ phase: 'TALLIED' }),
          job: { status: 'running', startedAt: '' },
          busy: false,
          onRunCheck: () => {},
          onCertify: () => {},
        }),
      ),
    )

    expect(page).toContain('så länge servern inte startas om eller skalas ned')
    expect(page).toContain('huvudtråd')
  })
})

describe('demovalets tider (ruling 136)', () => {
  it('öppnar vid dygnets början idag och stänger trettio dygn senare', () => {
    const { opensAt, closesAt } = demoElectionWindow(new Date('2026-10-02T19:18:25Z'))

    expect(opensAt.toISOString()).toBe('2026-10-02T00:00:00.000Z')
    expect(closesAt.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(DEMO_ELECTION_NAME).toBe('Valet 2026')
  })
})
